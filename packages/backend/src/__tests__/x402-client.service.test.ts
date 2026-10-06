/**
 * Unit tests — X402ClientService (task P1)
 *
 * Harness: a real x402 v2 resource server (`@x402/core/server` +
 * `@x402/evm/exact/server`, driven from a raw `node:http` server the same way
 * `@x402/express` drives Express) and a real x402 client, with ephemeral
 * local keys and a FAKE facilitator. Follows the approach of the
 * maintainer's September lab (`~/agentfi-lab/baseline.mjs`).
 *
 * What the fake facilitator does NOT prove
 * ----------------------------------------
 *  - `verify()` accepts every authorization: no signature, balance, nonce,
 *    validity-window or on-chain replay check is performed.
 *  - `settle()` returns a synthetic transaction hash: no USDC moves, no RPC
 *    is called, no block is awaited. `txHash` in the results is fabricated.
 *  - The idempotency cache lives in the test server only; the protocol's
 *    `payment-identifier` extension carries an id but does not deduplicate
 *    by itself (case "without a cache" documents exactly that).
 *  - Receipts are signed by an ephemeral seller key with no trust anchor:
 *    `receiptVerified: true` means "signed by whoever signed the offer and
 *    bound to it", not "a key we have any reason to trust".
 *  - No real facilitator auth (CDP key), rate limits, timeouts or
 *    `settlement_pending` outcomes are exercised.
 *
 * Passing means the client-side control flow behaves as specified under
 * those assumptions, nothing more.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type RoutesConfig,
} from '@x402/core/server';
import type { Network, PaymentPayload } from '@x402/core/types';
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
  NoAcceptableSchemeError,
  PaymentFailedError,
  X402ClientService,
  X402PaymentError,
} from '../services/payments/x402-client.service.js';
import type { ClientSigner } from '../services/wallet/signer.js';

// ── Fixture: x402 resource server with a fake facilitator ──────────────────

const NETWORK: Network = 'eip155:84532';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

interface Counts {
  verify: number;
  settle: number;
  deliver: number;
}

interface FixtureOptions {
  /** Route price as the server would configure it. Default `$0.40`. */
  price?: string;
  /**
   * Offer/receipt extension: off, signed consistently, receipt altered after
   * signing, or a consistently signed receipt naming a different tx hash.
   */
  receipts?: 'none' | 'valid' | 'tampered' | 'wrong-tx';
  /** Server-side idempotency cache keyed by the payment-identifier id. */
  idempotencyCache?: boolean;
  /** Fake facilitator behaviour. */
  facilitator?: 'accept' | 'reject-verify' | 'fail-settle';
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

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

async function startResourceServer(options: FixtureOptions = {}) {
  const seller = privateKeyToAccount(generatePrivateKey());
  const counts: Counts = { verify: 0, settle: 0, deliver: 0 };
  const mode = options.facilitator ?? 'accept';

  const facilitator: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
        extensions: [],
        signers: {},
      };
    },
    async verify(payload) {
      counts.verify++;
      if (mode === 'reject-verify') {
        return { isValid: false, invalidReason: 'insufficient_funds', payer: payerOf(payload) };
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
          network: NETWORK,
          transaction: '',
        };
      }
      return {
        success: true,
        payer: payerOf(payload),
        network: NETWORK,
        transaction: fakeTxHash(counts.settle),
      };
    },
  };

  const core = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmServerScheme())
    .registerExtension(paymentIdentifierResourceServerExtension);

  const extensions: Record<string, unknown> = {
    'payment-identifier': declarePaymentIdentifierExtension(false),
  };
  if (options.receipts && options.receipts !== 'none') {
    let issuer = createEIP712OfferReceiptIssuer(
      `did:pkh:${NETWORK}:${seller.address}#key-1`,
      seller.signTypedData.bind(seller),
    );
    if (options.receipts === 'tampered') issuer = tamperReceipts(issuer);
    if (options.receipts === 'wrong-tx') issuer = wrongTxReceipts(issuer);
    core.registerExtension(createOfferReceiptExtension(issuer));
    Object.assign(extensions, declareOfferReceiptExtension({ includeTxHash: true }));
  }

  const routes: RoutesConfig = {
    'GET /paid': {
      accepts: [{ scheme: 'exact', network: NETWORK, price: options.price ?? '$0.40', payTo: seller.address }],
      extensions,
    },
  };
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

    // Application-level idempotency: replay a delivered response for a known
    // payment id without touching the facilitator again.
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// ── Fixture: buyer ─────────────────────────────────────────────────────────

/** Minimal signer from a viem account — what `toClientSigner` yields for a wallet. */
function accountSigner(account: PrivateKeyAccount): ClientSigner {
  return {
    address: account.address as `0x${string}`,
    signTypedData: (typedData) => account.signTypedData(typedData as unknown as TypedDataDefinition),
  };
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

async function rejection<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw new Error(`Expected ${type.name}, got ${error instanceof Error ? error.name : typeof error}: ${String(error)}`);
  }
  throw new Error(`Expected ${type.name}, but the promise resolved`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('X402ClientService', () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const signer = accountSigner(buyer);
  const open: Array<() => Promise<void>> = [];

  async function fixture(options?: FixtureOptions) {
    const server = await startResourceServer(options);
    open.push(server.close);
    const service = new X402ClientService({ fetch: loopbackOnly(server.base) });
    return { ...server, service };
  }

  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  describe('non-402 responses', () => {
    it('returns a free resource untouched with paid: false and no signing', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ signer, url: `${f.base}/free`, maxAmountUsd: '$1' });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(false);
      expect(result.payment).toBeUndefined();
      expect(JSON.parse(result.body)).toEqual({ free: true });
      expect(result.headers['content-type']).toBe('application/json');
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('returns (never throws on) a non-402 error status', async () => {
      const f = await fixture();
      const result = await f.service.payResource({ signer, url: `${f.base}/boom`, maxAmountUsd: '$1' });

      expect(result.status).toBe(500);
      expect(result.paid).toBe(false);
      expect(result.body).toBe('kaboom');
      expect(f.counts.verify).toBe(0);
    });
  });

  describe('priced resource within the cap', () => {
    it('pays, reports the settled amount, payer and (fake) tx hash', async () => {
      const f = await fixture({ price: '$0.40' });
      const result = await f.service.payResource({
        signer,
        url: f.url,
        maxAmountUsd: '$1',
        allowedNetworks: [NETWORK],
      });

      expect(result.status).toBe(200);
      expect(result.paid).toBe(true);
      expect(JSON.parse(result.body)).toEqual({ quote: 42, sequence: 1 });
      expect(result.headers['payment-response']).toBeTruthy();

      const payment = result.payment!;
      expect(payment.paymentId).toMatch(/^agentfi_[0-9a-f]{32}$/);
      expect(payment.network).toBe(NETWORK);
      expect(payment.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(payment.amount).toBe('400000'); // $0.40 in 6-decimal USDC
      expect(payment.payer.toLowerCase()).toBe(buyer.address.toLowerCase());
      expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(payment.receipt).toBeUndefined();
      expect(payment.receiptVerified).toBeUndefined();

      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('accepts a price exactly at the cap and plain-decimal caps', async () => {
      const f = await fixture({ price: '$0.50' });
      const result = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '0.50' });

      expect(result.paid).toBe(true);
      expect(result.payment?.amount).toBe('500000');
    });

    it('uses a caller-supplied paymentId', async () => {
      const f = await fixture();
      const paymentId = generatePaymentId('job_');
      const result = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', paymentId });

      expect(result.payment?.paymentId).toBe(paymentId);
    });
  });

  describe('spend controls', () => {
    it('refuses a price above maxAmountUsd before signing; the facilitator is never called', async () => {
      const f = await fixture({ price: '$0.60' });
      const error = await rejection(
        f.service.payResource({ signer, url: f.url, maxAmountUsd: '$0.50' }),
        BudgetExceededError,
      );

      expect(error.code).toBe('BUDGET_EXCEEDED');
      expect(error).toBeInstanceOf(X402PaymentError);
      expect(error.details['maxAmountUsd']).toBe('$0.50');
      expect(error.details['cheapest']).toMatchObject({ usd: '0.6', amount: '600000', network: NETWORK });
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('refuses a network outside allowedNetworks with NoAcceptableScheme; nothing is signed', async () => {
      const f = await fixture();
      const error = await rejection(
        f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', allowedNetworks: ['eip155:8453'] }),
        NoAcceptableSchemeError,
      );

      expect(error.code).toBe('NO_ACCEPTABLE_SCHEME');
      expect(error.details['allowedNetworks']).toEqual(['eip155:8453']);
      expect(error.details['offered']).toEqual([expect.objectContaining({ network: NETWORK, scheme: 'exact' })]);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
    });

    it('rejects malformed caps, networks and payment ids before any request', async () => {
      const service = new X402ClientService({
        fetch: () => Promise.reject(new Error('must not fetch')),
      });
      const base = { signer, url: 'http://127.0.0.1:1/paid' };

      await expect(service.payResource({ ...base, maxAmountUsd: '1 USDT' })).rejects.toThrow(/plain USD amount/);
      await expect(service.payResource({ ...base, maxAmountUsd: '$0' })).rejects.toThrow(/positive/);
      await expect(service.payResource({ ...base, maxAmountUsd: '$1', allowedNetworks: ['base'] })).rejects.toThrow(/CAIP-2/);
      await expect(service.payResource({ ...base, maxAmountUsd: '$1', paymentId: 'short' })).rejects.toThrow(/paymentId/);
    });
  });

  describe('idempotent retries via payment-identifier', () => {
    it('does not settle twice for the same paymentId when the server keeps a cache', async () => {
      const f = await fixture({ idempotencyCache: true });
      const paymentId = generatePaymentId('job_');

      const first = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', paymentId });
      const second = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', paymentId });

      expect(first.paid).toBe(true);
      expect(second.paid).toBe(true);
      expect(second.body).toBe(first.body);
      expect(second.payment?.txHash).toBe(first.payment?.txHash);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('documents that the extension alone does not deduplicate (no server cache → settled twice)', async () => {
      const f = await fixture({ idempotencyCache: false });
      const paymentId = generatePaymentId('job_');

      await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', paymentId });
      await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1', paymentId });

      expect(f.counts.settle).toBe(2);
    });
  });

  describe('server-side payment failures', () => {
    it('throws PaymentFailed when the facilitator rejects verification', async () => {
      const f = await fixture({ facilitator: 'reject-verify' });
      const error = await rejection(
        f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1' }),
        PaymentFailedError,
      );

      expect(error.code).toBe('PAYMENT_FAILED');
      expect(error.details['status']).toBe(402);
      expect(error.details['authorizationSent']).toBe(true);
      expect(error.details['reason']).toContain('insufficient_funds');
      expect(f.counts).toEqual({ verify: 1, settle: 0, deliver: 0 });
    });

    it('throws PaymentFailed when settlement fails after delivery', async () => {
      const f = await fixture({ facilitator: 'fail-settle' });
      const error = await rejection(
        f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1' }),
        PaymentFailedError,
      );

      expect(error.details['authorizationSent']).toBe(true);
      expect(String(error.details['reason'])).toContain('settle_failed');
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });
  });

  describe('signed offer / receipt (offer-receipt extension)', () => {
    it('verifies a receipt signed by the offer issuer and bound to offer, payer and tx', async () => {
      const f = await fixture({ receipts: 'valid' });
      const result = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1' });

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
      const result = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1' });

      expect(result.paid).toBe(true);
      expect(result.payment?.receipt).toBeDefined();
      expect(result.payment?.receiptVerified).toBe(false);
    });

    it('marks a validly signed receipt that names a different tx as unverified', async () => {
      const f = await fixture({ receipts: 'wrong-tx' });
      const result = await f.service.payResource({ signer, url: f.url, maxAmountUsd: '$1' });

      expect(result.paid).toBe(true);
      expect(result.payment?.txHash).not.toBe(`0x${'ff'.repeat(32)}`);
      expect(result.payment?.receiptVerified).toBe(false);
    });
  });
});
