/**
 * C3f item 4 — the worker's Q7 verification state seen from the API process,
 * on a real Redis (REDIS_URL; CI's Backend Tests job has one).
 *
 * Q7 verifies each chain in every process on its own (in memory). The worker
 * is the process that signs evaluator settlements and sends the queued escrow
 * steps, but `GET /admin/escrow/verification` answered with the API process's
 * state only ("the worker's state is in its logs and ESCROW_ALERT
 * notifications"): an operator could not tell, from the admin API, whether
 * settlements were deferred because the WORKER's verification had lapsed.
 * Each process now publishes its snapshot to Redis after every check (key
 * `agentfi:escrow-verification:<role>`, expiring after three re-check
 * periods) and the endpoint returns the worker's report next to its own.
 *
 * Skipped (with a warning) when Redis is unreachable; on CI it fails instead.
 */
import { vi } from 'vitest';

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

const { mockDb } = vi.hoisted(() => ({ mockDb: { job: { findUnique: vi.fn(), update: vi.fn() } } as any }));

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock('../services/policy/reputation.service.js', () => ({ ReputationService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/billing/operator.service.js', () => ({ OperatorService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ resolveJob: vi.fn() }));
vi.mock('../services/policy/escrow.service.js', () => ({ releaseJobEscrow: vi.fn() }));
// This API process: verified (the worker's lapsed verification is what the operator must see).
vi.mock('../config/escrow-verification.runtime.js', () => ({
  escrowVerificationSettings: () => ({ ttlSeconds: 600, recheckSeconds: 120 }),
  escrowVerificationSnapshot: () => [
    { chainId: 84532, state: 'verified', allowed: true, verifiedAt: '2026-10-17T09:00:00.000Z', validUntil: '2026-10-17T09:10:00.000Z', since: null },
  ],
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REDIS_URL = process.env['REDIS_URL']!;
const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
const WORKER_KEY = 'agentfi:escrow-verification:worker';

async function redisReady(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, enableReadyCheck: false });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const REDIS_READY = await redisReady();
if (!REDIS_READY) {
  if (process.env['CI']) throw new Error(`Redis is required for ${import.meta.url} on CI (REDIS_URL=${REDIS_URL})`);
  console.warn(`[escrow-verification-report] Redis unreachable at ${REDIS_URL} — suite skipped`);
}
const describeRedis = REDIS_READY ? describe : describe.skip;

describeRedis('C3f item 4 — the worker\'s Q7 verification state in GET /admin/escrow/verification (real Redis)', () => {
  let redis: Redis;
  let app: FastifyInstance;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const { adminRoutes } = await import('../api/routes/admin.js');
    app = Fastify({ logger: false });
    await app.register(adminRoutes);
  });
  beforeEach(async () => {
    await redis.del(WORKER_KEY);
  });
  afterAll(async () => {
    await redis.del(WORKER_KEY);
    redis.disconnect();
    await app?.close();
    const runtime = await import('../config/escrow-verification-report.runtime.js').catch(() => null);
    runtime?.__closeEscrowVerificationReportForTests();
  });

  it('the worker publishes its snapshot after a check: reasons sanitized, readable for three re-check periods', async () => {
    const { publishEscrowVerificationReport } = await import('../config/escrow-verification-report.runtime.js');
    const keyedRpc = 'https://base-sepolia.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz012345';
    const written = await publishEscrowVerificationReport(
      'worker',
      [{ chainId: 84532, state: 'unverified', allowed: false, verifiedAt: null, validUntil: null, since: '2026-10-17T08:50:00.000Z', reason: `HTTP request failed. URL: ${keyedRpc}` }] as never,
      { ttlSeconds: 600, recheckSeconds: 120 },
    );
    expect(written).toBe(true);
    const ttl = await redis.ttl(WORKER_KEY);
    expect(ttl).toBeGreaterThan(350);
    expect(ttl).toBeLessThanOrEqual(360);
    const stored = await redis.get(WORKER_KEY);
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    const body = (await get()).json();
    expect(body.worker).toMatchObject({ state: 'reported', role: 'worker', stale: false, recheckSeconds: 120, chains: [expect.objectContaining({ chainId: 84532, state: 'unverified' })] });
  });

  const get = () => app.inject({ method: 'GET', url: '/admin/escrow/verification', headers: { 'x-admin-secret': ADMIN_SECRET } });

  it('shows the report the worker published: its chains (with the reason), when, and how old it is', async () => {
    const publishedAt = new Date(Date.now() - 30_000).toISOString();
    await redis.set(
      WORKER_KEY,
      JSON.stringify({
        role: 'worker',
        host: 'worker-1',
        publishedAt,
        ttlSeconds: 600,
        recheckSeconds: 120,
        chains: [
          { chainId: 84532, state: 'unverified', allowed: false, verifiedAt: null, validUntil: null, since: '2026-10-17T08:50:00.000Z', reason: 'the chain could not be read: timed out' },
        ],
      }),
      'EX',
      360,
    );
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.process).toBe('api');
    expect(body.chains).toEqual([expect.objectContaining({ chainId: 84532, state: 'verified', allowed: true })]);
    expect(body.worker).toMatchObject({
      state: 'reported',
      host: 'worker-1',
      publishedAt,
      stale: false,
      chains: [expect.objectContaining({ chainId: 84532, state: 'unverified', allowed: false, reason: expect.stringContaining('could not be read') })],
    });
    expect(body.worker.ageSeconds).toBeGreaterThanOrEqual(29);
  });

  it('says so when the worker has not reported (never started, or silent for three re-check periods: the key expired)', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().worker).toMatchObject({ state: 'missing' });
  });

  it('marks a report older than two re-check periods as stale (the worker missed its re-checks)', async () => {
    const publishedAt = new Date(Date.now() - 300_000).toISOString();
    await redis.set(WORKER_KEY, JSON.stringify({ role: 'worker', host: 'worker-1', publishedAt, ttlSeconds: 600, recheckSeconds: 120, chains: [] }), 'EX', 360);
    expect((await get()).json().worker).toMatchObject({ state: 'reported', stale: true });
  });
});
