/**
 * Route-level tests — POST /v1/jobs/:id/pay-resource (task P2, with the P5
 * ledger state machine).
 *
 * The real route, ResourcePaymentService and X402ClientService run against
 * the P1 fake-facilitator resource server (`helpers/x402-fixture.ts`); the
 * provider's wallet is an ephemeral viem key behind the `TypedDataSigner`
 * surface that `toClientSigner` needs, so every EIP-712 signature is real
 * and counted. Prisma is replaced by an in-memory `ResourcePayment` table
 * that enforces the `(jobId, paymentId)` unique index.
 *
 * What the fake facilitator does NOT prove is listed in the P1 test header:
 * no signature/balance/nonce checks, no USDC moves, no real deduplication.
 * These tests prove the route's control flow and the ledger transitions.
 */
import { vi } from 'vitest';

// config/env.ts calls process.exit() on missing required env vars at module
// load time. Hoisted-stub the ones the route import chain requires.
vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

interface LedgerRow {
  id: string;
  jobId: string;
  agentId: string;
  paymentId: string;
  url: string;
  method: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  status: string;
  authorizationNonce: string | null;
  receipt: unknown;
  receiptVerified: boolean | null;
  settlementTxHash: string | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const { mockDb, ledger } = vi.hoisted(() => {
  // In-memory ResourcePayment table with the (jobId, paymentId) unique index.
  const rows = new Map<string, LedgerRow>();
  let seq = 0;
  const byKey = (jobId: string, paymentId: string) =>
    [...rows.values()].find((r) => r.jobId === jobId && r.paymentId === paymentId);

  const create = async ({ data }: any): Promise<LedgerRow> => {
    if (byKey(data.jobId, data.paymentId)) {
      const err = new Error('Unique constraint failed on the fields: (`jobId`,`paymentId`)') as Error & {
        code: string;
      };
      err.code = 'P2002';
      throw err;
    }
    const row: LedgerRow = {
      id: `rp-${++seq}`,
      authorizationNonce: null,
      receipt: null,
      receiptVerified: null,
      settlementTxHash: null,
      responseStatus: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    rows.set(row.id, row);
    return { ...row };
  };
  const update = async ({ where, data }: any): Promise<LedgerRow> => {
    const row = rows.get(where.id);
    if (!row) throw new Error(`row ${where.id} not found`);
    Object.assign(row, data, { updatedAt: new Date() });
    return { ...row };
  };

  const resourcePayment = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.id) return rows.get(where.id) ? { ...rows.get(where.id)! } : null;
      const key = where.jobId_paymentId;
      const hit = byKey(key.jobId, key.paymentId);
      return hit ? { ...hit } : null;
    }),
    findMany: vi.fn(async ({ where }: any) =>
      [...rows.values()]
        .filter((r) => r.jobId === where.jobId && (!where.status || where.status.in.includes(r.status)))
        .map((r) => ({ amount: r.amount })),
    ),
    create: vi.fn(create),
    update: vi.fn(update),
    upsert: vi.fn(async ({ where, create: createData, update: updateData }: any): Promise<LedgerRow> => {
      const key = where.jobId_paymentId;
      const existing = byKey(key.jobId, key.paymentId);
      if (existing) return update({ where: { id: existing.id }, data: updateData });
      return create({ data: createData });
    }),
  };

  const mockDb: any = {
    job: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    resourcePayment,
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
  };

  return {
    mockDb,
    ledger: {
      rows,
      all: () => [...rows.values()],
      reset: () => {
        rows.clear();
        seq = 0;
      },
    },
  };
});

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));
vi.mock('../api/middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The route builds a default service from the wallet factory only when none
// is injected; the factory must still import cleanly.
vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({}),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { logger } from '../api/middleware/logger.js';
import { resourcePaymentRoutes } from '../api/routes/resource-payments.js';
import { ResourcePaymentService } from '../services/payments/resource-payment.service.js';
import { X402ClientService } from '../services/payments/x402-client.service.js';
import type { TypedDataSigner } from '../services/wallet/signer.js';
import {
  BASE_MAINNET,
  NETWORK,
  NONCE_32,
  USDC_BASE_SEPOLIA,
  fake402,
  loopbackOnly,
  neverFetch,
  startResourceServer,
  withoutPaymentResponse,
  type FixtureOptions,
} from './helpers/x402-fixture.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROVIDER = 'agent-provider';
const REQUESTER = 'agent-requester';
const JOB_ID = 'job-1';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TX_HASH = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    providerId: PROVIDER,
    requesterId: REQUESTER,
    status: 'ACCEPTED',
    reward: { amount: '1', token: 'USDC', chainId: 84532 },
    ...overrides,
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROVIDER,
    active: true,
    walletId: 'wallet-provider',
    policy: { active: true, expiresAt: null },
    ...overrides,
  };
}

/** The provider's wallet: an ephemeral key behind the surface `toClientSigner` needs. Counts signatures. */
const payer = privateKeyToAccount(generatePrivateKey());
const wallet: TypedDataSigner & { signatures: number } = {
  signatures: 0,
  async getWalletAddress() {
    return payer.address;
  },
  async signTypedData({ typedData }) {
    wallet.signatures++;
    const signature = await payer.signTypedData(typedData as unknown as TypedDataDefinition);
    return { signature, address: payer.address };
  },
};

let caller = PROVIDER;
const open: Array<() => Promise<void>> = [];

interface AppOptions {
  base?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = caller;
    request.agentTier = 'FREE';
  });
  const client = new X402ClientService({
    fetch: options.fetch ?? (options.base ? loopbackOnly(options.base) : neverFetch()),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  await app.register(resourcePaymentRoutes, {
    service: new ResourcePaymentService({ db: mockDb, wallet, client }),
  });
  open.push(() => app.close());
  return app;
}

async function fixture(options?: FixtureOptions) {
  const server = await startResourceServer(options);
  open.push(server.close);
  return server;
}

function pay(app: FastifyInstance, payload: Record<string, unknown>, jobId = JOB_ID) {
  return app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/pay-resource`, payload });
}

const PAYMENT_ID = 'retry_0123456789abcdef';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /v1/jobs/:id/pay-resource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledger.reset();
    wallet.signatures = 0;
    caller = PROVIDER;
    mockDb.job.findUnique.mockResolvedValue(jobRow());
    mockDb.agent.findUnique.mockResolvedValue(agentRow());
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  describe('happy path', () => {
    it('pays within the budget, records a settled row with the URL stripped of its query string, and never echoes the authorization', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: `${f.url}?api_key=SECRET123&x=1` });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment).toMatchObject({
        jobId: JOB_ID,
        agentId: PROVIDER,
        status: 'settled',
        method: 'GET',
        network: NETWORK,
        amount: '400000',
        receiptVerified: null,
        responseStatus: 200,
        error: null,
      });
      expect(body.payment.url).toBe(f.url);
      expect(body.payment.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(body.payment.payTo.toLowerCase()).toBe(f.seller.address.toLowerCase());
      expect(body.payment.paymentId).toMatch(UUID);
      expect(body.payment.authorizationNonce).toMatch(NONCE_32);
      expect(body.payment.settlementTxHash).toMatch(TX_HASH);
      expect(body.remainingBudget).toMatchObject({
        symbol: 'USDC',
        network: NETWORK,
        total: '1000000',
        spent: '400000',
        remaining: '600000',
        remainingFormatted: '0.6',
      });
      expect(body.resource.status).toBe(200);
      expect(body.resource.body).toEqual({ quote: 42, sequence: 1 });
      expect(body.resource.headers['content-type']).toBe('application/json');
      expect(body.resource.headers['payment-response']).toBeUndefined();

      // The API key stays in the request, out of the ledger and the response;
      // the signed payload never comes back either.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('SECRET123');
      expect(serialized).not.toMatch(/signature|PAYMENT-SIGNATURE|validBefore/);
      expect(body.payment.authorization).toBeUndefined();

      expect(wallet.signatures).toBe(1);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
      expect(ledger.all()).toHaveLength(1);
    });

    it('returns a free resource with payment: null and writes no row', async () => {
      const f = await fixture();
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: `${f.base}/free` });

      expect(res.statusCode).toBe(200);
      expect(res.json().payment).toBeNull();
      expect(res.json().resource.body).toEqual({ free: true });
      expect(res.json().remainingBudget.remaining).toBe('1000000');
      expect(wallet.signatures).toBe(0);
      expect(ledger.all()).toHaveLength(0);
    });

    it('honours a caller maxAmount below the remaining budget (lower of the two applies)', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      const refused = await pay(app, { url: f.url, maxAmount: '0.30' });
      expect(refused.statusCode).toBe(402);
      expect(refused.json()).toMatchObject({
        code: 'BUDGET_EXCEEDED',
        price: '400000',
        remaining: '1000000',
        cap: '300000',
        capFormatted: '0.3',
      });
      expect(wallet.signatures).toBe(0);

      const paid = await pay(app, { url: f.url, maxAmount: '0.50' });
      expect(paid.statusCode).toBe(200);
      expect(paid.json().payment.status).toBe('settled');
      expect(wallet.signatures).toBe(1);
    });
  });

  describe('budget', () => {
    it('refuses a price above the remaining budget before any signature; the row is failed_before_signing', async () => {
      mockDb.job.findUnique.mockResolvedValue(jobRow({ reward: { amount: '0.30', token: 'USDC', chainId: 84532 } }));
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: f.url });

      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body).toMatchObject({
        code: 'BUDGET_EXCEEDED',
        price: '400000',
        priceFormatted: '0.4',
        remaining: '300000',
        remainingFormatted: '0.3',
      });
      expect(body.paymentId).toMatch(UUID);
      expect(body.payment).toMatchObject({ status: 'failed_before_signing', amount: '400000', network: NETWORK });
      expect(body.payment.url).toBe(f.url);

      expect(wallet.signatures).toBe(0);
      expect(f.counts).toEqual({ verify: 0, settle: 0, deliver: 0 });
      const [row] = ledger.all();
      expect(row).toMatchObject({ status: 'failed_before_signing', authorizationNonce: null });
      expect(row?.error).toMatch(/above the cap/);
    });

    it('counts settled and unknown rows against the budget, not refused ones', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      expect((await pay(app, { url: f.url })).statusCode).toBe(200);
      expect((await pay(app, { url: f.url })).statusCode).toBe(200);
      // 0.80 spent of 1.00: a third $0.40 payment no longer fits.
      const third = await pay(app, { url: f.url });
      expect(third.statusCode).toBe(402);
      expect(third.json()).toMatchObject({ code: 'BUDGET_EXCEEDED', remaining: '200000' });
      expect(wallet.signatures).toBe(2);
      expect(f.counts.settle).toBe(2);
    });

    it('refuses with price: null when the budget is already exhausted, without fetching', async () => {
      mockDb.job.findUnique.mockResolvedValue(jobRow({ reward: { amount: '0.000001', token: 'USDC', chainId: 84532 } }));
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid', maxAmount: '0' });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ code: 'BUDGET_EXCEEDED', price: null, cap: '0', payment: null });
      expect(ledger.all()).toHaveLength(0);
    });

    it('rejects a job whose reward is not denominated in USDC (no oracle conversion)', async () => {
      mockDb.job.findUnique.mockResolvedValue(jobRow({ reward: { amount: '0.01', token: 'ETH', chainId: 84532 } }));
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_BUDGET_TOKEN', token: 'ETH', chainId: 84532 });
    });
  });

  describe('idempotency (payment-identifier)', () => {
    it('returns the existing row on a retry with the same paymentId — one payment only', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      const first = await pay(app, { url: f.url, paymentId: PAYMENT_ID });
      const second = await pay(app, { url: f.url, paymentId: PAYMENT_ID });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().replayed).toBe(true);
      expect(second.json().resource).toBeNull();
      expect(second.json().payment.id).toBe(first.json().payment.id);
      expect(second.json().payment.status).toBe('settled');
      expect(second.json().payment.paymentId).toBe(PAYMENT_ID);
      expect(second.json().remainingBudget.remaining).toBe('600000');

      expect(wallet.signatures).toBe(1);
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
      expect(ledger.all()).toHaveLength(1);
    });

    it('retries a failed_before_signing row as a fresh attempt on the same row', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      const refused = await pay(app, { url: f.url, paymentId: PAYMENT_ID, maxAmount: '0.30' });
      expect(refused.statusCode).toBe(402);
      const rowId = refused.json().payment.id;

      const paid = await pay(app, { url: f.url, paymentId: PAYMENT_ID });
      expect(paid.statusCode).toBe(200);
      expect(paid.json().replayed).toBeUndefined();
      expect(paid.json().payment.id).toBe(rowId);
      expect(paid.json().payment.status).toBe('settled');
      expect(paid.json().payment.error).toBeNull();
      expect(ledger.all()).toHaveLength(1);
      expect(wallet.signatures).toBe(1);
    });

    it('refuses to reuse a paymentId for a different resource (409 PAYMENT_ID_CONFLICT)', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ base: f.base });

      expect((await pay(app, { url: f.url, paymentId: PAYMENT_ID })).statusCode).toBe(200);
      const other = await pay(app, { url: `${f.base}/free`, paymentId: PAYMENT_ID });

      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ code: 'PAYMENT_ID_CONFLICT', paymentId: PAYMENT_ID, url: f.url });
      expect(wallet.signatures).toBe(1);
    });

    it('sends the paymentId to the server through the payment-identifier extension (server-side dedup)', async () => {
      const f = await fixture({ price: '$0.40', idempotencyCache: true });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: f.url, paymentId: PAYMENT_ID });
      expect(res.statusCode).toBe(200);
      // The server cache is keyed by the id it received inside the signed payload.
      expect(res.json().payment.paymentId).toBe(PAYMENT_ID);
      expect(f.counts.settle).toBe(1);
    });
  });

  describe('receipts (offer-receipt)', () => {
    it('stores a verified receipt and its transaction', async () => {
      const f = await fixture({ price: '$0.40', receipts: 'valid' });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: f.url });

      expect(res.statusCode).toBe(200);
      const payment = res.json().payment;
      expect(payment.status).toBe('settled');
      expect(payment.receiptVerified).toBe(true);
      expect(payment.receipt).toMatchObject({ format: 'eip712', payload: { resourceUrl: f.url, network: NETWORK } });
      expect(payment.settlementTxHash).toBe(payment.receipt.payload.transaction);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('marks a mismatching receipt as unverified (settled, receiptVerified=false) and warns the operator', async () => {
      const f = await fixture({ price: '$0.40', receipts: 'tampered' });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: f.url });

      expect(res.statusCode).toBe(200);
      const payment = res.json().payment;
      expect(payment.status).toBe('settled');
      expect(payment.receipt).toBeDefined();
      expect(payment.receiptVerified).toBe(false);
      expect(payment.settlementTxHash).toMatch(TX_HASH);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: JOB_ID, receiptVerified: false }),
        expect.stringMatching(/marked unverified/),
      );
      expect(res.json().remainingBudget.spent).toBe('400000');
    });
  });

  describe('outcomes after signing', () => {
    it('a timeout after signing is unknown: 502 with the paymentId and nonce, counted against the budget, never retried', async () => {
      const f = await fixture({ price: '$0.40', stall: 'paid' });
      const app = await buildApp({ base: f.base, requestTimeoutMs: 250 });

      const res = await pay(app, { url: f.url, paymentId: PAYMENT_ID });

      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
      expect(body.paymentId).toBe(PAYMENT_ID);
      expect(body.timedOut).toBe(true);
      expect(body.authorization).toMatchObject({ method: 'eip3009' });
      expect(body.authorization.nonce).toMatch(NONCE_32);
      expect(body.payment).toMatchObject({ status: 'unknown', amount: '400000', paymentId: PAYMENT_ID });
      expect(body.payment.authorizationNonce).toBe(body.authorization.nonce);
      expect(JSON.stringify(body)).not.toMatch(/"signature"/);
      expect(wallet.signatures).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: JOB_ID, paymentId: PAYMENT_ID, nonce: body.authorization.nonce }),
        expect.stringMatching(/UNKNOWN.*no automatic retry/),
      );

      // No automatic retry: the same id comes back from the ledger, still
      // unknown, still reserved against the budget, and nothing is re-signed.
      const retry = await pay(app, { url: f.url, paymentId: PAYMENT_ID });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ replayed: true, resource: null });
      expect(retry.json().payment.status).toBe('unknown');
      expect(retry.json().warning).toMatch(/UNKNOWN/);
      expect(retry.json().remainingBudget).toMatchObject({ spent: '400000', remaining: '600000' });
      expect(wallet.signatures).toBe(1);
      expect(ledger.all()).toHaveLength(1);
    });

    it('a 2xx without PAYMENT-RESPONSE is recorded as unknown and returned with a warning', async () => {
      const f = await fixture({ price: '$0.40' });
      const app = await buildApp({ fetch: withoutPaymentResponse(loopbackOnly(f.base)) });

      const res = await pay(app, { url: f.url });

      expect(res.statusCode).toBe(200);
      expect(res.json().payment.status).toBe('unknown');
      expect(res.json().payment.authorizationNonce).toMatch(NONCE_32);
      expect(res.json().warning).toMatch(/UNKNOWN/);
      expect(res.json().resource.body).toEqual({ quote: 42, sequence: 1 });
      expect(res.json().remainingBudget.spent).toBe('400000');
      expect(logger.error).toHaveBeenCalled();
      // The server did settle; only its report was lost in transit.
      expect(f.counts).toEqual({ verify: 1, settle: 1, deliver: 1 });
    });

    it('a server that rejects the signed payment is refused (402 PAYMENT_REFUSED), does not count against the budget, and may be retried on the same row', async () => {
      const f = await fixture({ price: '$0.40', facilitator: 'reject-verify' });
      const app = await buildApp({ base: f.base });

      const res = await pay(app, { url: f.url, paymentId: PAYMENT_ID });

      expect(res.statusCode).toBe(402);
      const body = res.json();
      expect(body).toMatchObject({ code: 'PAYMENT_REFUSED', paymentId: PAYMENT_ID, responseStatus: 402 });
      expect(body.reason).toContain('insufficient_funds');
      expect(body.payment).toMatchObject({ status: 'refused', responseStatus: 402 });
      expect(body.payment.authorizationNonce).toMatch(NONCE_32);
      expect(wallet.signatures).toBe(1);

      const retry = await pay(app, { url: f.url, paymentId: PAYMENT_ID });
      expect(retry.statusCode).toBe(402);
      expect(retry.json().payment.id).toBe(body.payment.id);
      expect(retry.json().payment.status).toBe('refused');
      expect(retry.json().payment.authorizationNonce).not.toBe(body.payment.authorizationNonce);
      expect(wallet.signatures).toBe(2);
      expect(ledger.all()).toHaveLength(1);
      expect(retry.json().remainingBudget).toBeUndefined();

      const free = await pay(app, { url: `${f.base}/free` });
      expect(free.json().remainingBudget.remaining).toBe('1000000');
    });
  });

  describe('asset and network', () => {
    it('refuses a 402 that prices the resource in something other than USDC with 400 UNSUPPORTED_ASSET (nothing signed)', async () => {
      const url = 'http://127.0.0.1:1/usdt';
      const notUsdc: PaymentRequirements = {
        scheme: 'exact',
        network: NETWORK,
        asset: '0x0000000000000000000000000000000000000abc',
        amount: '400000',
        payTo: payer.address,
        maxTimeoutSeconds: 300,
        extra: { name: 'Tether', version: '1' },
      };
      const app = await buildApp({ fetch: fake402(url, [notUsdc]) });

      const res = await pay(app, { url });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'UNSUPPORTED_ASSET',
        required: { network: NETWORK, symbol: 'USDC' },
        offered: [expect.objectContaining({ asset: notUsdc.asset })],
      });
      expect(res.json().required.asset.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase());
      expect(res.json().payment).toMatchObject({ status: 'failed_before_signing', asset: notUsdc.asset });
      expect(wallet.signatures).toBe(0);
    });

    it('refuses a 402 that only accepts another chain (Base mainnet for a Base Sepolia job)', async () => {
      const url = 'http://127.0.0.1:1/mainnet-only';
      const mainnet: PaymentRequirements = {
        scheme: 'exact',
        network: BASE_MAINNET,
        asset: USDC_BASE_MAINNET,
        amount: '400000',
        payTo: payer.address,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      };
      const app = await buildApp({ fetch: fake402(url, [mainnet]) });

      const res = await pay(app, { url });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'UNSUPPORTED_ASSET', required: { network: NETWORK } });
      expect(wallet.signatures).toBe(0);
    });
  });

  describe('guards', () => {
    it('the requester cannot pay from the job budget (403 NOT_PROVIDER); nothing is fetched', async () => {
      caller = REQUESTER;
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'NOT_PROVIDER' });
      expect(res.json().error).toMatch(/requester/);
      expect(wallet.signatures).toBe(0);
      expect(ledger.all()).toHaveLength(0);
    });

    it('an agent not involved in the job is 403 as well', async () => {
      caller = 'agent-stranger';
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('NOT_PROVIDER');
    });

    it('a job that is not ACCEPTED is 409 JOB_NOT_ACTIVE', async () => {
      mockDb.job.findUnique.mockResolvedValue(jobRow({ status: 'PENDING' }));
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'JOB_NOT_ACTIVE', status: 'PENDING' });
    });

    it('an unknown job is 404', async () => {
      mockDb.job.findUnique.mockResolvedValue(null);
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' }, 'job-missing');
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('JOB_NOT_FOUND');
    });

    it('a paused or expired policy is 403 POLICY_PAUSED', async () => {
      const app = await buildApp({ fetch: neverFetch() });

      mockDb.agent.findUnique.mockResolvedValue(agentRow({ policy: { active: false, expiresAt: null } }));
      const paused = await pay(app, { url: 'http://127.0.0.1:1/paid' });
      expect(paused.statusCode).toBe(403);
      expect(paused.json().code).toBe('POLICY_PAUSED');

      mockDb.agent.findUnique.mockResolvedValue(
        agentRow({ policy: { active: true, expiresAt: new Date(Date.now() - 60_000) } }),
      );
      const expired = await pay(app, { url: 'http://127.0.0.1:1/paid' });
      expect(expired.statusCode).toBe(403);
      expect(expired.json().code).toBe('POLICY_PAUSED');
      expect(expired.json().error).toMatch(/expired/);
    });

    it('a deactivated agent is 403 AGENT_INACTIVE', async () => {
      mockDb.agent.findUnique.mockResolvedValue(agentRow({ active: false }));
      const app = await buildApp({ fetch: neverFetch() });

      const res = await pay(app, { url: 'http://127.0.0.1:1/paid' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('AGENT_INACTIVE');
    });

    it('validates the body: GET with a body, a relative URL, a bad maxAmount and a short paymentId are 400', async () => {
      const app = await buildApp({ fetch: neverFetch() });
      const url = 'http://127.0.0.1:1/paid';

      for (const payload of [
        { url, body: { q: 1 } },
        { url, maxAmount: '0.1234567' },
        { url, maxAmount: '$1' },
        { url, paymentId: 'short' },
        { url, method: 'DELETE' },
        {},
      ]) {
        const res = await pay(app, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }

      const relative = await pay(app, { url: '/paid' });
      expect(relative.statusCode).toBe(400);
      expect(relative.json().code).toBe('INVALID_URL');

      const ftp = await pay(app, { url: 'ftp://127.0.0.1/paid' });
      expect(ftp.statusCode).toBe(400);
      expect(ftp.json().code).toBe('INVALID_URL');

      expect(wallet.signatures).toBe(0);
    });
  });
});
