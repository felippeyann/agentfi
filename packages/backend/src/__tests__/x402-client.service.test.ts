/**
 * Unit tests — X402ClientService (task P1, hardened in review R3)
 *
 * Harness: a real x402 v2 resource server (`@x402/core/server` +
 * `@x402/evm/exact/server`, driven from a raw `node:http` server the same way
 * `@x402/express` drives Express) and a real x402 client, with ephemeral
 * local keys and a FAKE facilitator. Follows the approach of the
 * maintainer's September lab (`~/agentfi-lab/baseline.mjs`). A few cases
 * use a hand-built 402 (`fake402`) where the server fixture cannot express
 * the offer (`upto`, an 18-decimal asset).
 *
 * What the fake facilitator does NOT prove
 * ----------------------------------------
 *  - `verify()` accepts every authorization: no signature, balance, nonce,
 *    validity-window or on-chain replay check is performed.
 *  - `settle()` returns a synthetic transaction hash: no USDC moves, no RPC
 *    is called, no block is awaited. `txHash` in the results is fabricated.
 *  - The idempotency cache lives in the test server only; the protocol's
 *    `payment-identifier` extension carries an id but does not deduplicate
 *    by itself, and the client signs a fresh authorization on every call.
 *  - Receipts are signed by an ephemeral seller key with no trust anchor:
 *    `receiptVerified: true` means "signed by whoever signed the offer and
 *    bound to it", not "a key we have any reason to trust".
 *  - No real facilitator auth (CDP key), rate limits or
 *    `settlement_pending` outcomes are exercised.
 *
 * Passing means the client-side control flow behaves as specified under
 * those assumptions, nothing more.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  generatePaymentId,
  paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  BudgetExceededError,
  MAX_AUTHORIZATION_WINDOW_SECONDS,
  NoAcceptableSchemeError,
  PaymentFailedError,
  X402ClientService,
  X402PaymentError,
} from '../services/payments/x402-client.service.js';
import type { ClientSigner } from '../services/wallet/signer.js';

// ── Fixture: x402 resource server with a fake facilitator ──────────────────

const NETWORK: Network = 'eip155:84532';
const BASE_MAINNET: Network = 'eip155:8453';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** `ExactEvmScheme.findDefaultAsset` entry with 18 decimals (Permit2 token). */
const MEGAETH: Network = 'eip155:4326';
const MEGA_USD = '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7';

interface Counts {
  verify: number;
  settle: number;
  deliver: number;
}

interface FixtureOptions {
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

async function startResourceServer(options: FixtureOptions = {}) {
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

interface CountingSigner extends ClientSigner {
  /** Number of EIP-712 signatures produced — one per authorization. */
  signatures: number;
}

/** Minimal signer from a viem account — what `toClientSigner` yields for a wallet — that counts signatures. */
function accountSigner(account: PrivateKeyAccount): CountingSigner {
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
function loopbackOnly(allowedBase: string): typeof fetch {
  return (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(allowedBase)) {
      return Promise.reject(new Error(`External network blocked: ${target}`));
    }
    return fetch(input, init);
  };
}

function isPaidRequest(input: RequestInfo | URL): boolean {
  return input instanceof Request && (input.headers.has('PAYMENT-SIGNATURE') || input.headers.has('X-PAYMENT'));
}

/** Transport that dies exactly when the signed payment is on its way out. */
function failAfterSigning(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    if (isPaidRequest(input)) return Promise.reject(new Error('socket hang up'));
    return inner(input, init);
  };
}

/** Transport that drops `PAYMENT-RESPONSE` from the paid reply (server accepted, reported nothing). */
function withoutPaymentResponse(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.headers.has('PAYMENT-RESPONSE')) return response;
    const headers = new Headers(response.headers);
    headers.delete('PAYMENT-RESPONSE');
    return new Response(await response.text(), { status: response.status, headers });
  };
}

/** Hand-built 402 for offers the server fixture cannot express; any paid request gets a bare 200. */
function fake402(url: string, accepts: PaymentRequirements[]): typeof fetch {
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

function neverFetch(): typeof fetch {
  return () => Promise.reject(new Error('must not fetch'));
}

async function rejection<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw new Error(`Expected ${type.name}, got ${error instanceof Error ? error.name : typeof error}: ${String(error)}`);
  }
  throw new Error(`Expected ${type.name}, but the promise resolved`);
}

const NONCE_32 = /^0x[0-9a-f]{64}$/;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('X402ClientService', () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const signer = accountSigner(buyer);
  const open: Array<() => Promise<void>> = [];

  async function fixture(options?: FixtureOptions, serviceOptions: ConstructorParameters<typeof X402ClientService>[0] = {}) {
    const server = await startResourceServer(options);
    open.push(server.close);
    const service = new X402ClientService({ fetch: loopbackOnly(server.base), ...serviceOptions });
    return { ...server, service };
  }

  /** Default job: $1 cap on Base Sepolia. */
  const job = { signer, maxAmountUsd: '$1', allowedNetworks: [NETWORK] };

  beforeEach(() => {
    signer.signatures = 0;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  describe('non-402 responses', () => {
    it('returns a free resource untouched with paid: false and no signing', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ ...job, url: `${f.base}/free` });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(false);
      expect(result.payment).toBeUndefined();
      expect(JSON.parse(result.body)).toEqual({ free: true });
      expect(result.headers['content-type']).toBe('application/json');
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('returns (never throws on) a non-402 error status', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ ...job, url: `${f.base}/boom` });

      expect(result.status).toBe(500);
      expect(result.paid).toBe(false);
      expect(result.body).toBe('kaboom');
      expect(f.counts.verify).toBe(0);
    });
  });

  describe('priced resource within the cap', () => {
    it('pays, reports the settled amount, payer, (fake) tx hash and the signed authorization', async () => {
      const f = await fixture({ price: '$0.40' });
      const before = Math.floor(Date.now() / 1000);
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(true);
      expect(JSON.parse(result.body)).toEqual({ quote: 42, sequence: 1 });
      expect(result.headers['payment-response']).toBeTruthy();

      const payment = result.payment!;
      expect(payment.paymentId).toMatch(/^agentfi_[0-9a-f]{32}$/);
      expect(payment.paymentIdSent).toBe(true);
      expect(payment.network).toBe(NETWORK);
      expect(payment.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(payment.amount).toBe('400000'); // $0.40 in 6-decimal USDC
      expect(payment.payer.toLowerCase()).toBe(buyer.address.toLowerCase());
      expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(payment.receipt).toBeUndefined();
      expect(payment.receiptVerified).toBeUndefined();

      // The authorization the server now holds: nonce + window, bounded by
      // the route's maxTimeoutSeconds (server default 300 ≤ our 600 limit).
      const auth = payment.authorization!;
      expect(auth).toMatchObject({ scheme: 'exact', method: 'eip3009', validAfter: '0' });
      expect(auth.nonce).toMatch(NONCE_32);
      expect(Number(auth.validBefore)).toBeGreaterThan(before);
      expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + 300 + 5);
      expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + MAX_AUTHORIZATION_WINDOW_SECONDS + 5);

      expect(signer.signatures).toBe(1);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('accepts a price exactly at the cap and plain-decimal caps', async () => {
      const f = await fixture({ price: '$0.50' });
      const result = await f.service.payResource({ ...job, url: f.url, maxAmountUsd: '0.50' });

      expect(result.paid).toBe(true);
      expect(result.payment?.amount).toBe('500000');
    });

    it('uses a caller-supplied paymentId', async () => {
      const f = await fixture();
      const paymentId = generatePaymentId('job_');
      const result = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(result.payment?.paymentId).toBe(paymentId);
      expect(result.payment?.paymentIdSent).toBe(true);
    });

    it('reports paymentIdSent: false when the 402 does not declare payment-identifier', async () => {
      const f = await fixture({ paymentIdentifier: false });
      const paymentId = generatePaymentId('job_');
      const result = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(result.paid).toBe(true);
      expect(result.payment?.paymentId).toBe(paymentId);
      expect(result.payment?.paymentIdSent).toBe(false);
    });
  });

  describe('spend controls (gate 1: preflight on the raw 402)', () => {
    it('refuses a price above maxAmountUsd before signing; the facilitator is never called', async () => {
      const f = await fixture({ price: '$0.60' });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );

      expect(error.code).toBe('BUDGET_EXCEEDED');
      expect(error).toBeInstanceOf(X402PaymentError);
      expect(error.details['maxAmountUsd']).toBe('$0.50');
      expect(error.details['cheapest']).toMatchObject({ usd: '0.6', amount: '600000', network: NETWORK });
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('refuses a network outside allowedNetworks with NoAcceptableScheme; nothing is signed', async () => {
      const f = await fixture();
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, allowedNetworks: [BASE_MAINNET] }),
        NoAcceptableSchemeError,
      );

      expect(error.code).toBe('NO_ACCEPTABLE_SCHEME');
      expect(error.details['allowedNetworks']).toEqual([BASE_MAINNET]);
      expect(error.details['offered']).toEqual([expect.objectContaining({ network: NETWORK, scheme: 'exact' })]);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('pays only on the allowed network when the server offers several (mainnet listed first)', async () => {
      const f = await fixture({ alsoAccept: [BASE_MAINNET] });

      const testnet = await f.service.payResource({ ...job, url: f.url, allowedNetworks: [NETWORK] });
      expect(testnet.paid).toBe(true);
      expect(testnet.payment?.network).toBe(NETWORK);
      expect(testnet.payment?.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());

      const mainnet = await f.service.payResource({ ...job, url: f.url, allowedNetworks: [BASE_MAINNET] });
      expect(mainnet.paid).toBe(true);
      expect(mainnet.payment?.network).toBe(BASE_MAINNET);
    });

    it('requires allowedNetworks and rejects wildcards unless allowWildcardNetworks is passed, before any request', async () => {
      const service = new X402ClientService({ fetch: neverFetch() });
      const base = { signer, url: 'http://127.0.0.1:1/paid', maxAmountUsd: '$1' };

      await expect(
        service.payResource({ ...base } as unknown as Parameters<typeof service.payResource>[0]),
      ).rejects.toThrow(/allowedNetworks is required/);
      await expect(service.payResource({ ...base, allowedNetworks: [] })).rejects.toThrow(/allowedNetworks is required/);
      await expect(service.payResource({ ...base, allowedNetworks: ['eip155:*'] })).rejects.toThrow(/wildcard/);
      await expect(service.payResource({ ...base, allowedNetworks: [NETWORK, 'eip155:*'] })).rejects.toThrow(/wildcard/);
      expect(signer.signatures).toBe(0);
    });

    it('honours a wildcard only with allowWildcardNetworks: true', async () => {
      const f = await fixture();
      const result = await f.service.payResource({
        ...job,
        url: f.url,
        allowedNetworks: ['eip155:*'],
        allowWildcardNetworks: true,
      });
      expect(result.paid).toBe(true);
      expect(result.payment?.network).toBe(NETWORK);
    });

    it('refuses an authorization window longer than MAX_AUTHORIZATION_WINDOW_SECONDS before signing', async () => {
      const f = await fixture({ maxTimeoutSeconds: 1e9 });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), NoAcceptableSchemeError);

      expect(error.code).toBe('NO_ACCEPTABLE_SCHEME');
      expect(error.details['maxAuthorizationWindowSeconds']).toBe(600);
      expect(error.details['rejected']).toEqual([
        expect.objectContaining({
          network: NETWORK,
          maxTimeoutSeconds: 1e9,
          reason: expect.stringMatching(/longer than the 600s limit/),
        }),
      ]);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('lets the caller widen the window explicitly (per call or per service)', async () => {
      const f = await fixture({ maxTimeoutSeconds: 900 });

      await rejection(f.service.payResource({ ...job, url: f.url }), NoAcceptableSchemeError);
      const perCall = await f.service.payResource({ ...job, url: f.url, maxAuthorizationWindowSeconds: 1000 });
      expect(perCall.paid).toBe(true);

      const wide = new X402ClientService({ fetch: loopbackOnly(f.base), maxAuthorizationWindowSeconds: 1000 });
      const perService = await wide.payResource({ ...job, url: f.url });
      expect(perService.paid).toBe(true);
    });

    it('rejects malformed caps, networks, payment ids and timeouts before any request', async () => {
      const service = new X402ClientService({ fetch: neverFetch() });
      const base = { ...job, url: 'http://127.0.0.1:1/paid' };

      await expect(service.payResource({ ...base, maxAmountUsd: '1 USDT' })).rejects.toThrow(/plain USD amount/);
      await expect(service.payResource({ ...base, maxAmountUsd: '$0' })).rejects.toThrow(/positive/);
      await expect(service.payResource({ ...base, allowedNetworks: ['base'] })).rejects.toThrow(/CAIP-2/);
      await expect(service.payResource({ ...base, paymentId: 'short' })).rejects.toThrow(/paymentId/);
      await expect(service.payResource({ ...base, requestTimeoutMs: 0 })).rejects.toThrow(/requestTimeoutMs/);
      await expect(service.payResource({ ...base, maxAuthorizationWindowSeconds: -1 })).rejects.toThrow(
        /maxAuthorizationWindowSeconds/,
      );
      expect(() => new X402ClientService({ requestTimeoutMs: Number.NaN })).toThrow(/requestTimeoutMs/);
    });

    it('rejects an `upto` offer (only `exact` is supported) without signing', async () => {
      const url = 'http://127.0.0.1:1/upto';
      const service = new X402ClientService({
        fetch: fake402(url, [
          {
            scheme: 'upto',
            network: NETWORK,
            asset: USDC_BASE_SEPOLIA,
            amount: '400000',
            payTo: buyer.address,
            maxTimeoutSeconds: 300,
            extra: { name: 'USDC', version: '2' },
          },
        ]),
      });
      const error = await rejection(service.payResource({ ...job, url }), NoAcceptableSchemeError);

      expect(error.message).toMatch(/scheme "exact"/);
      expect(error.details['offered']).toEqual([expect.objectContaining({ scheme: 'upto' })]);
      expect(signer.signatures).toBe(0);
    });

    it('converts the cap with the asset decimals (18-decimal MegaUSD), not a hard-coded 6', async () => {
      const url = 'http://127.0.0.1:1/mega';
      const sixTenthsOfADollar: PaymentRequirements = {
        scheme: 'exact',
        network: MEGAETH,
        asset: MEGA_USD,
        amount: '600000000000000000', // 0.6 × 10^18
        payTo: buyer.address,
        maxTimeoutSeconds: 300,
        extra: { name: 'MegaUSD', version: '1', assetTransferMethod: 'permit2' },
      };
      const service = new X402ClientService({ fetch: fake402(url, [sixTenthsOfADollar]) });
      const mega = { signer, url, allowedNetworks: [MEGAETH] };

      // Priced as 0.6 MegaUSD: above a $0.50 cap …
      const tooExpensive = await rejection(service.payResource({ ...mega, maxAmountUsd: '$0.50' }), BudgetExceededError);
      expect(tooExpensive.details['cheapest']).toMatchObject({ usd: '0.6', amount: sixTenthsOfADollar.amount });
      expect(signer.signatures).toBe(0);

      // … and within a $1 cap (6-decimal math would read it as $600 000 000 000).
      const paid = await service.payResource({ ...mega, maxAmountUsd: '$1' });
      expect(signer.signatures).toBe(1);
      expect(paid.paid).toBe(false); // bare 200, no PAYMENT-RESPONSE
      expect(paid.payment).toMatchObject({ amount: sixTenthsOfADollar.amount, network: MEGAETH });
      expect(paid.payment?.authorization).toMatchObject({ method: 'permit2' });
      expect(paid.payment?.authorization?.nonce).toMatch(/^\d+$/);
    });
  });

  describe('spend controls (gates 2 and 3, with gate 1 disabled through the test-only hook)', () => {
    it('gate 2 (x402 spendControls) refuses an over-cap option before signing when preflight is skipped', async () => {
      const f = await fixture({ price: '$0.60' }, { __testOnlyGates: { skipPreflight: true } });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        X402PaymentError,
      );

      expect(error.details['authorizationSent']).toBe(false);
      expect(error.details['stage']).toBe('payment-creation');
      expect(String(error.details['cause'])).toMatch(/spendControls/);
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('gate 3 (onBeforePaymentCreation re-check) aborts the signature when gates 1 and 2 are skipped', async () => {
      const f = await fixture(
        { price: '$0.60' },
        { __testOnlyGates: { skipPreflight: true, skipSpendControls: true } },
      );
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );

      expect(error.message).toMatch(/Refusing to sign/);
      expect(error.details['selected']).toMatchObject({ amount: '600000', network: NETWORK });
      expect(signer.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('gate 3 also refuses an over-long window the library would otherwise sign', async () => {
      const f = await fixture(
        { maxTimeoutSeconds: 1e9 },
        { __testOnlyGates: { skipPreflight: true, skipSpendControls: true } },
      );
      // The window policy (gate 2) filters the option out first; the hook
      // never runs. Either way nothing is signed.
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), X402PaymentError);
      expect(error.details['authorizationSent']).toBe(false);
      expect(signer.signatures).toBe(0);
    });

    it('the test-only hook is refused when NODE_ENV=production', () => {
      const previous = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => new X402ClientService({ __testOnlyGates: { skipPreflight: true } })).toThrow(/production/);
      } finally {
        process.env['NODE_ENV'] = previous;
      }
    });
  });

  describe('payment-identifier: the server may deduplicate, the client always re-signs', () => {
    it('signs a fresh authorization on every call; a server cache keyed by paymentId prevents the second settlement', async () => {
      const f = await fixture({ idempotencyCache: true });
      const paymentId = generatePaymentId('job_');

      const first = await f.service.payResource({ ...job, url: f.url, paymentId });
      const second = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(first.paid).toBe(true);
      expect(second.paid).toBe(true);
      expect(second.body).toBe(first.body);
      expect(second.payment?.txHash).toBe(first.payment?.txHash);
      expect(first.payment?.paymentIdSent).toBe(true);
      expect(second.payment?.paymentIdSent).toBe(true);

      // The id is only visible to the server inside a signed payment, so the
      // cache cannot short-circuit before the second signature exists: two
      // live authorizations, one settlement.
      expect(signer.signatures).toBe(2);
      expect(second.payment?.authorization?.nonce).not.toBe(first.payment?.authorization?.nonce);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('documents that the extension alone does not deduplicate (no server cache → settled twice)', async () => {
      const f = await fixture({ idempotencyCache: false });
      const paymentId = generatePaymentId('job_');

      const first = await f.service.payResource({ ...job, url: f.url, paymentId });
      const second = await f.service.payResource({ ...job, url: f.url, paymentId });

      expect(signer.signatures).toBe(2);
      expect(second.payment?.authorization?.nonce).not.toBe(first.payment?.authorization?.nonce);
      expect(f.counts.settle).toBe(2);
    });
  });

  describe('failures after signing carry the authorization', () => {
    it('throws PaymentFailed when the facilitator rejects verification', async () => {
      const f = await fixture({ facilitator: 'reject-verify' });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.code).toBe('PAYMENT_FAILED');
      expect(error.details['status']).toBe(402);
      expect(error.details['authorizationSent']).toBe(true);
      expect(error.details['paymentIdSent']).toBe(true);
      expect(error.details['reason']).toContain('insufficient_funds');
      expect(error.details['authorization']).toMatchObject({ method: 'eip3009' });
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(f.counts).toEqual({ verify: 1, settle: 0, deliver: 0 });
    });

    it('throws PaymentFailed with the nonce when settlement fails after delivery', async () => {
      const f = await fixture({ facilitator: 'fail-settle' });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.details['authorizationSent']).toBe(true);
      expect(String(error.details['reason'])).toContain('settle_failed');
      const auth = error.details['authorization'] as { nonce: string; validBefore: string };
      expect(auth.nonce).toMatch(NONCE_32);
      expect(Number(auth.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('a transport failure after signing is PaymentFailed with authorizationSent: true', async () => {
      const f = await fixture();
      const service = new X402ClientService({ fetch: failAfterSigning(loopbackOnly(f.base)) });
      const error = await rejection(service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message).toMatch(/during paid-request/);
      expect(error.details['stage']).toBe('paid-request');
      expect(error.details['authorizationSent']).toBe(true);
      expect(error.details['timedOut']).toBe(false);
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(signer.signatures).toBe(1);
      expect(f.counts.verify).toBe(0);
    });

    it('a 2xx without PAYMENT-RESPONSE is paid: false with the payment (and authorization) attached', async () => {
      const f = await fixture();
      const service = new X402ClientService({ fetch: withoutPaymentResponse(loopbackOnly(f.base)) });
      const result = await service.payResource({ ...job, url: f.url });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(false);
      expect(result.payment).toMatchObject({ amount: '400000', network: NETWORK, paymentIdSent: true });
      expect(result.payment?.txHash).toBeUndefined();
      expect(result.payment?.authorization?.nonce).toMatch(NONCE_32);
      // The server did settle; only its report was lost in transit.
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });
  });

  describe('request timeouts', () => {
    it('times out the plain request: PaymentFailed, timedOut, nothing signed', async () => {
      const f = await fixture({ stall: 'first' }, { requestTimeoutMs: 250 });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message).toMatch(/timed out after 250ms/);
      expect(error.details['timedOut']).toBe(true);
      expect(error.details['stage']).toBe('request');
      expect(error.details['authorizationSent']).toBe(false);
      expect(signer.signatures).toBe(0);
    });

    it('times out the paid request: authorizationSent: true with the nonce (per-call override)', async () => {
      const f = await fixture({ stall: 'paid' });
      const error = await rejection(
        f.service.payResource({ ...job, url: f.url, requestTimeoutMs: 250 }),
        PaymentFailedError,
      );

      expect(error.message).toMatch(/timed out after 250ms with a signed authorization already sent/);
      expect(error.details['timedOut']).toBe(true);
      expect(error.details['stage']).toBe('paid-request');
      expect(error.details['authorizationSent']).toBe(true);
      expect((error.details['authorization'] as { nonce: string }).nonce).toMatch(NONCE_32);
      expect(signer.signatures).toBe(1);
    });
  });

  describe('error-message hygiene', () => {
    it('keeps query strings out of messages (full URL only in details)', async () => {
      const f = await fixture({ price: '$0.60', facilitator: 'reject-verify' });
      const url = `${f.url}?api_key=SECRET123&x=1`;

      const budget = await rejection(
        f.service.payResource({ ...job, url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );
      expect(budget.message).not.toContain('SECRET123');
      expect(budget.message).toContain(f.url);
      expect(budget.details['url']).toBe(url);

      const scheme = await rejection(
        f.service.payResource({ ...job, url, allowedNetworks: [BASE_MAINNET] }),
        NoAcceptableSchemeError,
      );
      expect(scheme.message).not.toContain('SECRET123');

      const failed = await rejection(f.service.payResource({ ...job, url }), PaymentFailedError);
      expect(failed.message).not.toContain('SECRET123');
      expect(failed.details['url']).toBe(url);

      const transport = await rejection(
        new X402ClientService({ fetch: neverFetch() }).payResource({ ...job, url }),
        PaymentFailedError,
      );
      expect(transport.message).not.toContain('SECRET123');
    });

    it('caps server-supplied reasons at 200 characters', async () => {
      const f = await fixture({ facilitator: 'reject-verify', rejectReason: 'x'.repeat(5000) });
      const error = await rejection(f.service.payResource({ ...job, url: f.url }), PaymentFailedError);

      expect(error.message.length).toBeLessThan(400);
      expect(error.message).toMatch(/x{200}…$/);
      expect(String(error.details['reason']).length).toBe(201);
    });
  });

  describe('signed offer / receipt (offer-receipt extension)', () => {
    it('verifies a receipt signed by the offer issuer and bound to offer, payer and tx', async () => {
      const f = await fixture({ receipts: 'valid' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({
        format: 'eip712',
        payload: {
          resourceUrl: f.url,
          network: NETWORK,
          transaction: result.payment?.txHash,
        },
      });
      expect(result.payment?.receiptVerified).toBe(true);
    });

    it('marks a receipt altered after signing as unverified without failing the payment', async () => {
      const f = await fixture({ receipts: 'tampered' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toBeDefined();
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a validly signed receipt that names a different tx as unverified', async () => {
      const f = await fixture({ receipts: 'wrong-tx' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.txHash).not.toBe(`0x${'ff'.repeat(32)}`);
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt signed by a key other than the offer signer as unverified (payer untouched)', async () => {
      const f = await fixture({ receipts: 'foreign-key' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({ payload: { payer: buyer.address } });
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt bound to an offer for a different resource than the 402 named as unverified', async () => {
      const f = await fixture({ receipts: 'wrong-resource' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toMatchObject({ payload: { resourceUrl: expect.stringContaining('/other') } });
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a receipt bound to an offer that had expired before signing as unverified', async () => {
      const f = await fixture({ receipts: 'expired-offer' });
      const result = await f.service.payResource({ ...job, url: f.url });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toBeDefined();
      expect(result.payment?.receiptVerified).toBe(false);
    });
  });
});
