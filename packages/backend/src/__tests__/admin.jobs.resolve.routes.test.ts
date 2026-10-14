/**
 * Route-level tests — operator review of ERC-8183 jobs (C3d, decision D9):
 *   POST /admin/jobs/:id/resolve   pay | refund [+ quality-rejected] | payout-blocked
 *   POST /admin/jobs/:id/reconcile refuses a live ERC-8183 job (USE_RESOLVE)
 *
 * The orchestrator (`resolveJob` in the runtime) is mocked: the decision
 * logic is covered by escrow-erc8183.service.test.ts and the Postgres suite;
 * here: auth, body validation, the decision mapping, who decided, and the
 * HTTP mapping of every outcome.
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

const { mockDb, resolveJobMock, reputationMock } = vi.hoisted(() => ({
  mockDb: { job: { findUnique: vi.fn(), update: vi.fn() } } as any,
  resolveJobMock: vi.fn(),
  reputationMock: { recordJobOutcome: vi.fn() },
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock('../services/policy/reputation.service.js', () => ({ ReputationService: vi.fn().mockImplementation(() => reputationMock) }));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/billing/operator.service.js', () => ({ OperatorService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ resolveJob: resolveJobMock }));
vi.mock('../services/policy/escrow.service.js', () => ({ releaseJobEscrow: vi.fn() }));
// Q7: this API process's verification state (GET /admin/escrow/verification).
vi.mock('../config/escrow-verification.runtime.js', () => ({
  escrowVerificationSettings: () => ({ ttlSeconds: 600, recheckSeconds: 120 }),
  escrowVerificationSnapshot: (opts: { withReason: boolean }) => [
    { chainId: 84532, state: 'unverified', allowed: false, verifiedAt: null, validUntil: null, since: '2026-10-14T10:00:00.000Z', ...(opts.withReason ? { reason: 'the chain could not be read: timed out' } : {}) },
  ],
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
let adminRoutes: typeof import('../api/routes/admin.js')['adminRoutes'];

beforeAll(async () => {
  ({ adminRoutes } = await import('../api/routes/admin.js'));
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(adminRoutes);
  return app;
}

function resolve(app: FastifyInstance, body: Record<string, unknown>, secret = ADMIN_SECRET) {
  return app.inject({ method: 'POST', url: '/admin/jobs/job-1/resolve', headers: { 'x-admin-secret': secret }, payload: body });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveJobMock.mockResolvedValue({ outcome: 'scheduled', resolution: 'pay', previousStatus: 'PAYMENT_PENDING', previousOnChainStatus: 'CONTESTED', queued: true });
});

describe('POST /admin/jobs/:id/resolve', () => {
  it('requires the admin secret', async () => {
    const app = await buildApp();
    const res = await resolve(app, { decision: 'pay', note: 'looks right' }, 'wrong-secret-wrong-secret-wrong-secret!!');
    expect(res.statusCode).toBe(401);
    expect(resolveJobMock).not.toHaveBeenCalled();
  });

  it('is local-only like every admin route: a remote caller with the right secret is refused (403), also behind a spoofed X-Forwarded-For', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    await app.register(adminRoutes);
    const body = { decision: 'pay', note: 'looks right' };
    for (const req of [
      { remoteAddress: '203.0.113.9', headers: {} },
      { remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } },
      { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/jobs/job-1/resolve',
        remoteAddress: req.remoteAddress,
        headers: { 'x-admin-secret': ADMIN_SECRET, ...req.headers },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining('local-only') });
    }
    expect(resolveJobMock).not.toHaveBeenCalled();
    // The loopback control: the same request from 127.0.0.1 is accepted.
    expect((await app.inject({ method: 'POST', url: '/admin/jobs/job-1/resolve', remoteAddress: '127.0.0.1', headers: { 'x-admin-secret': ADMIN_SECRET }, payload: body })).statusCode).toBe(202);
    await app.close();
  });

  it('pay → 202 with the decision; the operator defaults to "admin-api" and the note is required', async () => {
    const app = await buildApp();
    const res = await resolve(app, { decision: 'pay', note: '  deliverable matches the brief  ' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: 'job-1', resolution: 'pay', previousStatus: 'PAYMENT_PENDING', previousOnChainStatus: 'CONTESTED', queued: true });
    expect(resolveJobMock).toHaveBeenCalledWith({ jobId: 'job-1', decision: 'pay', note: 'deliverable matches the brief', operator: 'admin-api' });

    const missing = await resolve(app, { decision: 'pay' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().details).toHaveProperty('note');
  });

  it('refund + verdict "quality-rejected" is the quality-rejected decision (the only one that rates 0); the UI user is recorded', async () => {
    resolveJobMock.mockResolvedValue({ outcome: 'scheduled', resolution: 'quality-rejected', previousStatus: 'PAYMENT_PENDING', previousOnChainStatus: 'CONTESTED', queued: true });
    const app = await buildApp();
    const res = await resolve(app, { decision: 'refund', verdict: 'quality-rejected', note: 'off-brief', operator: 'alice@ops' });
    expect(res.statusCode).toBe(202);
    expect(resolveJobMock).toHaveBeenCalledWith({ jobId: 'job-1', decision: 'quality-rejected', note: 'off-brief', operator: 'alice@ops' });

    await resolve(app, { decision: 'refund', note: 'requester right' });
    expect(resolveJobMock).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'refund' }));
    await resolve(app, { decision: 'payout-blocked', note: 'USDC blacklisted the provider' });
    expect(resolveJobMock).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'payout-blocked' }));
  });

  it('a verdict is only valid with "refund"; unknown decisions are refused', async () => {
    const app = await buildApp();
    for (const body of [
      { decision: 'pay', verdict: 'quality-rejected', note: 'x y z' },
      { decision: 'payout-blocked', verdict: 'quality-rejected', note: 'x y z' },
      { decision: 'refund', verdict: 'bad', note: 'x y z' },
      { decision: 'complete', note: 'x y z' },
    ]) {
      expect((await resolve(app, body)).statusCode).toBe(400);
    }
    expect(resolveJobMock).not.toHaveBeenCalled();
  });

  it('maps the orchestrator refusals: 404 NOT_FOUND, 409 with the state, 503 when the chain cannot be read', async () => {
    const app = await buildApp();
    resolveJobMock.mockResolvedValueOnce({ outcome: 'refused', code: 'NOT_FOUND', message: 'Job not found' });
    expect((await resolve(app, { decision: 'pay', note: 'x y z' })).statusCode).toBe(404);

    for (const code of ['NOT_ESCROW_JOB', 'NOT_RESOLVABLE', 'SETTLEMENT_IN_PROGRESS', 'CHAIN_NOT_SUBMITTED']) {
      resolveJobMock.mockResolvedValueOnce({ outcome: 'refused', code, message: 'no', status: 'ACCEPTED', onChainStatus: 'FUNDED' });
      const res = await resolve(app, { decision: 'refund', note: 'x y z' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: code, message: 'no', status: 'ACCEPTED', onChainStatus: 'FUNDED' });
    }

    resolveJobMock.mockResolvedValueOnce({ outcome: 'unverifiable', message: 'The on-chain job status could not be read; retry' });
    const down = await resolve(app, { decision: 'refund', note: 'x y z' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: 'CHAIN_UNREADABLE' });
  });
});

describe('POST /admin/jobs/:id/reconcile on ERC-8183 jobs', () => {
  const reconcile = (app: FastifyInstance) =>
    app.inject({
      method: 'POST',
      url: '/admin/jobs/job-1/reconcile',
      headers: { 'x-admin-secret': ADMIN_SECRET },
      payload: { action: 'force_completed', reason: 'checked off-system' },
    });

  it('refuses a job whose budget may still be on-chain: decide it with /resolve instead (USE_RESOLVE)', async () => {
    mockDb.job.findUnique.mockResolvedValue({ id: 'job-1', status: 'PAYMENT_PENDING', escrowKind: 'erc8183', onChainStatus: 'CONTESTED', reservationStatus: 'PENDING' });
    const app = await buildApp();
    const res = await reconcile(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'USE_RESOLVE', message: expect.stringContaining('/admin/jobs/job-1/resolve') });
    expect(mockDb.job.update).not.toHaveBeenCalled();
  });

  it('still reconciles an ERC-8183 job whose chain state is final, and legacy jobs', async () => {
    const app = await buildApp();
    for (const row of [
      { id: 'job-1', status: 'PAYMENT_PENDING', escrowKind: 'erc8183', onChainStatus: 'COMPLETED', reservationStatus: 'RELEASED', providerId: 'p', requesterId: 'r' },
      { id: 'job-1', status: 'PAYMENT_PENDING', escrowKind: null, onChainStatus: null, reservationStatus: 'RELEASED', providerId: 'p', requesterId: 'r' },
    ]) {
      mockDb.job.findUnique.mockResolvedValueOnce(row);
      expect((await reconcile(app)).statusCode).toBe(200);
    }
  });
});

describe('GET /admin/escrow/verification (Q7)', () => {
  it('requires the admin secret', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/escrow/verification', headers: { 'x-admin-secret': 'wrong-secret-wrong-secret-wrong-secret!!' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns the API process state of each escrow chain WITH the reason, and the TTL / re-check settings', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/escrow/verification', headers: { 'x-admin-secret': ADMIN_SECRET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      process: 'api',
      ttlSeconds: 600,
      recheckSeconds: 120,
      chains: [expect.objectContaining({ chainId: 84532, state: 'unverified', allowed: false, reason: expect.stringContaining('could not be read') })],
    });
  });
});
