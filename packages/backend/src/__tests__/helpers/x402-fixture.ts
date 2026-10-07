/**
 * Shared test harness — x402 v2 resource server with a FAKE facilitator.
 *
 * Extracted from the P1 client tests (`x402-client.service.test.ts`) so the
 * job-scoped payment tests (P2, `resource-payment.routes.test.ts`) drive the
 * same server. A real `@x402/core/server` + `@x402/evm/exact/server`
 * pipeline runs on raw `node:http` the way `@x402/express` drives Express;
 * only the facilitator is fake: it accepts every authorization and returns a
 * synthetic tx hash. See the P1 test header for the full list of what that
 * does NOT prove (no signature/balance/nonce checks, no USDC moves, no real
 * deduplication, no trust anchor for receipts).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, type PaymentOption } from '@x402/core/http';
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type RoutesConfig,
} from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme as ExactEvmServerScheme } from '@x402/evm/exact/server';
import {
  createEIP712OfferReceiptIssuer,
  createOfferReceiptExtension,
  declareOfferReceiptExtension,
  type OfferReceiptIssuer,
} from '@x402/extensions/offer-receipt';
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { ClientSigner } from '../../services/wallet/signer.js';

// ── Fixture: x402 resource server with a fake facilitator ──────────────────

export const NETWORK: Network = 'eip155:84532';
export const BASE_MAINNET: Network = 'eip155:8453';
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** `ExactEvmScheme.findDefaultAsset` entry with 18 decimals (Permit2 token). */
export const MEGAETH: Network = 'eip155:4326';
export const MEGA_USD = '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7';

export interface Counts {
  verify: number;
  settle: number;
  deliver: number;
}

export interface FixtureOptions {
  /** Route price as the server would configure it. Default `$0.40`. */
  price?: string;
  /** Extra networks offered in `accepts[]` BEFORE the default one (same price). */
  alsoAccept?: Network[];
  /** Route-level `maxTimeoutSeconds` (server default 300). */
  maxTimeoutSeconds?: number;
  /**
   * Offer/receipt extension: off, signed consistently, receipt altered after
   * signing, a consistently signed receipt naming a different tx hash, a
   * receipt signed by a key other than the offer's, offer + receipt signed
   * for a different resource URL, or an offer that had already expired.
   */
  receipts?: 'none' | 'valid' | 'tampered' | 'wrong-tx' | 'foreign-key' | 'wrong-resource' | 'expired-offer';
  /** Declare the `payment-identifier` extension on the route. Default true. */
  paymentIdentifier?: boolean;
  /** Server-side idempotency cache keyed by the payment-identifier id. */
  idempotencyCache?: boolean;
  /** Fake facilitator behaviour. */
  facilitator?: 'accept' | 'reject-verify' | 'fail-settle';
  /** `invalidReason` returned by `reject-verify`. Default `insufficient_funds`. */
  rejectReason?: string;
  /** Never answer the plain request, or never answer the paid request. */
  stall?: 'first' | 'paid';
}

interface CachedReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

class NodeAdapter implements HTTPAdapter {
  private readonly url: URL;

  constructor(
    private readonly req: IncomingMessage,
    base: string,
  ) {
    this.url = new URL(req.url ?? '/', base);
  }

  getHeader(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
  getMethod(): string {
    return this.req.method ?? 'GET';
  }
  getPath(): string {
    return this.url.pathname;
  }
  getUrl(): string {
    return this.url.toString();
  }
  getAcceptHeader(): string {
    return this.getHeader('accept') ?? '';
  }
  getUserAgent(): string {
    return this.getHeader('user-agent') ?? '';
  }
}

function payerOf(payload: PaymentPayload): string {
  const inner = payload.payload as { authorization?: { from?: string } };
  return inner.authorization?.from ?? '0x0000000000000000000000000000000000000000';
}

function fakeTxHash(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** Alters the receipt payload after it was signed — the signature no longer binds it. */
function tamperReceipts(issuer: OfferReceiptIssuer): OfferReceiptIssuer {
  return {
    ...issuer,
    async issueReceipt(resourceUrl, payer, network, transaction) {
      const receipt = await issuer.issueReceipt(resourceUrl, payer, network, transaction);
      if (receipt.format !== 'eip712') return receipt;
      return {
        ...receipt,
        payload: { ...receipt.payload, payer: '0x000000000000000000000000000000000000dEaD' },
      };
    },
  };
}

/** Signs an otherwise honest receipt that names a transaction the facilitator never reported. */
function wrongTxReceipts(issuer: OfferReceiptIssuer): OfferReceiptIssuer {
  return {
    ...issuer,
    issueReceipt: (resourceUrl, payer, network) =>
      issuer.issueReceipt(resourceUrl, payer, network, `0x${'ff'.repeat(32)}`),
  };
}

/** Offers signed by the seller, receipts signed by somebody else (payer untouched). */
function foreignKeyReceipts(issuer: OfferReceiptIssuer): OfferReceiptIssuer {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const other = createEIP712OfferReceiptIssuer(
    `did:pkh:${NETWORK}:${stranger.address}#key-1`,
    stranger.signTypedData.bind(stranger),
  );
  return { ...issuer, issueReceipt: other.issueReceipt };
}

/**
 * Offer AND receipt consistently signed for a different resource URL: the
 * library's receipt↔offer check passes, only the 402's own resource differs.
 */
function wrongResourceReceipts(issuer: OfferReceiptIssuer): OfferReceiptIssuer {
  const elsewhere = (url: string) => `${url}/../other`;
  return {
    ...issuer,
    issueOffer: (resourceUrl, input) => issuer.issueOffer(elsewhere(resourceUrl), input),
    issueReceipt: (resourceUrl, payer, network, transaction) =>
      issuer.issueReceipt(elsewhere(resourceUrl), payer, network, transaction),
  };
}

/** Offers whose `validUntil` lies a minute in the past. */
function expiredOffers(issuer: OfferReceiptIssuer): OfferReceiptIssuer {
  return {
    ...issuer,
    issueOffer: (resourceUrl, input) => issuer.issueOffer(resourceUrl, { ...input, offerValiditySeconds: -60 }),
  };
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

export async function startResourceServer(options: FixtureOptions = {}) {
  const seller = privateKeyToAccount(generatePrivateKey());
  const counts: Counts = { verify: 0, settle: 0, deliver: 0 };
  const mode = options.facilitator ?? 'accept';
  const networks: Network[] = [...(options.alsoAccept ?? []), NETWORK];

  const facilitator: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: networks.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
        extensions: [],
        signers: {},
      };
    },
    async verify(payload) {
      counts.verify++;
      if (mode === 'reject-verify') {
        return {
          isValid: false,
          invalidReason: options.rejectReason ?? 'insufficient_funds',
          payer: payerOf(payload),
        };
      }
      return { isValid: true, payer: payerOf(payload) };
    },
    async settle(payload) {
      counts.settle++;
      if (mode === 'fail-settle') {
        return {
          success: false,
          errorReason: 'settle_failed',
          payer: payerOf(payload),
          network: payload.accepted.network,
          transaction: '',
        };
      }
      return {
        success: true,
        payer: payerOf(payload),
        network: payload.accepted.network,
        transaction: fakeTxHash(counts.settle),
      };
    },
  };

  const core = new x402ResourceServer(facilitator).registerExtension(paymentIdentifierResourceServerExtension);
  for (const network of networks) core.register(network, new ExactEvmServerScheme());

  const extensions: Record<string, unknown> = {};
  if (options.paymentIdentifier !== false) {
    extensions['payment-identifier'] = declarePaymentIdentifierExtension(false);
  }
  if (options.receipts && options.receipts !== 'none') {
    let issuer = createEIP712OfferReceiptIssuer(
      `did:pkh:${NETWORK}:${seller.address}#key-1`,
      seller.signTypedData.bind(seller),
    );
    if (options.receipts === 'tampered') issuer = tamperReceipts(issuer);
    if (options.receipts === 'wrong-tx') issuer = wrongTxReceipts(issuer);
    if (options.receipts === 'foreign-key') issuer = foreignKeyReceipts(issuer);
    if (options.receipts === 'wrong-resource') issuer = wrongResourceReceipts(issuer);
    if (options.receipts === 'expired-offer') issuer = expiredOffers(issuer);
    core.registerExtension(createOfferReceiptExtension(issuer));
    Object.assign(extensions, declareOfferReceiptExtension({ includeTxHash: true }));
  }

  const accepts: PaymentOption[] = networks.map((network) => ({
    scheme: 'exact',
    network,
    price: options.price ?? '$0.40',
    payTo: seller.address,
    ...(options.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: options.maxTimeoutSeconds } : {}),
  }));
  const routes: RoutesConfig = { 'GET /paid': { accepts, extensions } };
  const http = new x402HTTPResourceServer(core, routes);
  await http.initialize();

  const cache = options.idempotencyCache ? new Map<string, CachedReply>() : undefined;
  let base = '';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const adapter = new NodeAdapter(req, base);
    const path = adapter.getPath();
    const paymentHeader = adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment');
    const context: HTTPRequestContext = {
      adapter,
      path,
      decodedPath: decodeURIComponent(path),
      method: adapter.getMethod(),
      ...(paymentHeader !== undefined ? { paymentHeader } : {}),
    };

    if (path === '/free') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ free: true }));
    if (path === '/boom') return send(res, 500, { 'content-type': 'text/plain' }, 'kaboom');
    if (!http.requiresPayment(context)) return send(res, 404, {}, 'not found');

    // Stalled phases are never answered; `close()` tears the sockets down.
    if (options.stall === 'first' && paymentHeader === undefined) return;
    if (options.stall === 'paid' && paymentHeader !== undefined) return;

    // Application-level idempotency: replay a delivered response for a known
    // payment id without touching the facilitator again. Note the id only
    // arrives WITH a signed payment — the plain request carries nothing.
    if (cache && paymentHeader) {
      const id = extractPaymentIdentifier(decodePaymentSignatureHeader(paymentHeader));
      const hit = id ? cache.get(id) : undefined;
      if (hit) return send(res, hit.status, hit.headers, hit.body);
    }

    const result = await http.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      const { response } = result;
      return send(res, response.status, response.headers, JSON.stringify(response.body ?? {}));
    }
    if (result.type === 'no-payment-required') return send(res, 500, {}, 'unexpected');

    counts.deliver++;
    const body = JSON.stringify({ quote: 42, sequence: counts.deliver });
    // @x402/core 2.28.0 quirk: `result.declaredExtensions` is the object the
    // 402 builder already overwrote with each extension's enrichment output
    // (`{ info: { offers }, schema }`), so `includeTxHash: true` is lost and
    // receipts come back without a transaction. `@x402/express` forwards that
    // same object. Passing the route-level declaration instead keeps the
    // receipt → settlement tx binding testable here.
    const settle = await http.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      extensions,
      { request: context, responseBody: Buffer.from(body), responseHeaders: { 'content-type': 'application/json' } },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settle.success) {
      const { response } = settle;
      return send(res, response.status, response.headers, JSON.stringify(response.body ?? {}));
    }
    const headers = { ...settle.headers, 'content-type': 'application/json' };
    if (cache) {
      const id = extractPaymentIdentifier(result.paymentPayload);
      if (id) cache.set(id, { status: 200, headers, body });
    }
    send(res, 200, headers, body);
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      send(res, 500, { 'content-type': 'text/plain' }, String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a port');
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    url: `${base}/paid`,
    seller,
    counts,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

// ── Fixture: buyer ─────────────────────────────────────────────────────────

export interface CountingSigner extends ClientSigner {
  /** Number of EIP-712 signatures produced — one per authorization. */
  signatures: number;
}

/** Minimal signer from a viem account — what `toClientSigner` yields for a wallet — that counts signatures. */
export function accountSigner(account: PrivateKeyAccount): CountingSigner {
  const signer: CountingSigner = {
    address: account.address as `0x${string}`,
    signatures: 0,
    signTypedData(typedData) {
      signer.signatures++;
      return account.signTypedData(typedData as unknown as TypedDataDefinition);
    },
  };
  return signer;
}

/** Only the local resource server may be reached from these tests. */
export function loopbackOnly(allowedBase: string): typeof fetch {
  return (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(allowedBase)) {
      return Promise.reject(new Error(`External network blocked: ${target}`));
    }
    return fetch(input, init);
  };
}

export function isPaidRequest(input: RequestInfo | URL): boolean {
  return input instanceof Request && (input.headers.has('PAYMENT-SIGNATURE') || input.headers.has('X-PAYMENT'));
}

/** Transport that dies exactly when the signed payment is on its way out. */
export function failAfterSigning(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    if (isPaidRequest(input)) return Promise.reject(new Error('socket hang up'));
    return inner(input, init);
  };
}

/** Transport that drops `PAYMENT-RESPONSE` from the paid reply (server accepted, reported nothing). */
export function withoutPaymentResponse(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.headers.has('PAYMENT-RESPONSE')) return response;
    const headers = new Headers(response.headers);
    headers.delete('PAYMENT-RESPONSE');
    return new Response(await response.text(), { status: response.status, headers });
  };
}

/** Hand-built 402 for offers the server fixture cannot express; any paid request gets a bare 200. */
export function fake402(url: string, accepts: PaymentRequirements[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (isPaidRequest(request)) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const paymentRequired: PaymentRequired = { x402Version: 2, resource: { url }, accepts };
    return new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) } });
  };
}

export function neverFetch(): typeof fetch {
  return () => Promise.reject(new Error('must not fetch'));
}

export async function rejection<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw new Error(`Expected ${type.name}, got ${error instanceof Error ? error.name : typeof error}: ${String(error)}`);
  }
  throw new Error(`Expected ${type.name}, but the promise resolved`);
}

export const NONCE_32 = /^0x[0-9a-f]{64}$/;
