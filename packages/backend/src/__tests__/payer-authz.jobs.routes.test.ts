/**
 * Payer authorization audit (docs/architecture/payer-authorization.md) —
 * the JOB routes, as called with a PAYER credential: an agent key that is the
 * PROVIDER of an ACCEPTED job (it pays x402 resources with
 * POST /v1/jobs/:id/pay-resource).
 *
 * The server is the boundary, not the MCP tool filter: these tests drive the
 * real route handlers (Prisma and the escrow runtime mocked) with the caller
 * identity an agent key resolves to, and prove what the agent can NOT do —
 * touch a job it is not part of, take the other party's transitions, rewrite
 * the budget (`reward`), or mint its own budget by naming itself as provider.
 *
 *   - JOBS-1  a stranger gets 403 on read / PATCH / contest; nothing written
 *   - JOBS-2  the requester cannot accept / complete / fail (provider-only)
 *   - JOBS-3  the provider's PATCH writes `status` / `result` only: `reward`,
 *             `providerId`, `requesterId`, reservation fields in the body are
 *             never part of the write (the budget is the x402 cap)
 *   - JOBS-4  the provider cannot contest (requester-only)
 *   - JOBS-5  a paid job that names its own requester as provider is 400
 *             JOB_PROVIDER_IS_REQUESTER on a non-escrow chain (self-minted
 *             budget); a free self job and a paid job for ANOTHER provider
 *             still work (the operator-facing flow is unchanged)
 *   - JOBS-6  inbox / outbox list only the caller's own jobs
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

const { mockDb, escrowMock, runtimeMock } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn() },
    job: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  } as any,
  escrowMock: {
    reserveJobEscrow: vi.fn(),
    reserveEscrowJobSpend: vi.fn(),
    releaseJobEscrow: vi.fn(),
    markEscrowReleased: vi.fn(),
    queueOnChainEscrowLock: vi.fn(),
  },
  runtimeMock: {
    isErc8183Enabled: vi.fn(),
    getEscrowToken: vi.fn(),
    startEscrow: vi.fn(),
    enqueueSubmit: vi.fn(),
    requestCancellationReject: vi.fn(),
    contestJob: vi.fn(),
    erc8183Config: { evaluatorAddress: '0x000000000000000000000000000000000000Ea1D', jobTtlSeconds: 604_800 },
  },
}));

vi.mock('../config/escrow-verification.runtime.js', () => ({
  escrowConfigGate: (chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }),
}));
vi.mock('../db/client.js', () => ({ db: mockDb }));
vi.mock('../services/policy/escrow.service.js', () => escrowMock);
vi.mock('../services/job/escrow-erc8183.runtime.js', () => runtimeMock);
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({ recordJobOutcome: vi.fn() })),
}));
vi.mock('../api/routes/transactions.js', () => ({ executeA2APayment: vi.fn().mockResolvedValue({ transactionId: 't', status: 'QUEUED' }) }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));

import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../api/errors/handler.js';

type JobsModule = typeof import('../api/routes/jobs.js');

const CHAIN_ID = 84532;
// A chain with no escrow contract: the legacy DB-reservation path.
const LEGACY_CHAIN_ID = 8453;
const REQUESTER = 'cl0000000000000000000req01';
const PAYER = 'cl00000000000000000payer01'; // the PROVIDER of the job: holds only its own agent key
const STRANGER = 'cl000000000000000000strg01';

let jobRoutes: JobsModule['jobRoutes'];
beforeAll(async () => {
  ({ jobRoutes } = await import('../api/routes/jobs.js'));
});

async function appFor(agentId: string) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('preHandler', async (request: any) => {
    request.agentId = agentId;
    request.agentTier = 'FREE';
  });
  await app.register(jobRoutes);
  return app;
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    requesterId: REQUESTER,
    providerId: PAYER,
    status: 'ACCEPTED',
    payload: { task: 'x' },
    reward: { amount: '5.0', token: 'USDC', chainId: CHAIN_ID },
    result: null,
    reservationStatus: 'PENDING',
    escrowKind: null,
    escrowChainId: null,
    onChainStatus: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMock.isErc8183Enabled.mockImplementation((chainId: number) => chainId === CHAIN_ID);
  runtimeMock.contestJob.mockResolvedValue({ outcome: 'held', contestedAt: new Date() });
  escrowMock.reserveJobEscrow.mockResolvedValue({ success: true, reservedValueUsd: '5' });
  escrowMock.queueOnChainEscrowLock.mockResolvedValue(null);
  mockDb.job.findUnique.mockResolvedValue(job());
  mockDb.job.updateMany.mockResolvedValue({ count: 1 });
  mockDb.job.findMany.mockResolvedValue([]);
  mockDb.job.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'job-new', ...data, escrowKind: null }));
});

describe('JOBS-1: a stranger holding an agent key cannot touch a job it is not part of', () => {
  it('GET /v1/jobs/:id is 403', async () => {
    const res = await (await appFor(STRANGER)).inject({ method: 'GET', url: '/v1/jobs/job-1' });
    expect(res.statusCode).toBe(403);
  });

  it.each(['ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED'])('PATCH /v1/jobs/:id status %s is 403 and writes nothing', async (status) => {
    const res = await (await appFor(STRANGER)).inject({ method: 'PATCH', url: '/v1/jobs/job-1', payload: { status } });
    expect(res.statusCode).toBe(403);
    expect(mockDb.job.updateMany).not.toHaveBeenCalled();
    expect(mockDb.job.update).not.toHaveBeenCalled();
  });

  it('POST /v1/jobs/:id/contest is 403', async () => {
    const res = await (await appFor(STRANGER)).inject({ method: 'POST', url: '/v1/jobs/job-1/contest', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(runtimeMock.contestJob).not.toHaveBeenCalled();
  });
});

describe('JOBS-2: the requester cannot take the provider-only transitions', () => {
  it.each(['ACCEPTED', 'COMPLETED', 'FAILED'])('PATCH status %s by the requester is 403 and writes nothing', async (status) => {
    const res = await (await appFor(REQUESTER)).inject({ method: 'PATCH', url: '/v1/jobs/job-1', payload: { status } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Only provider can update this status' });
    expect(mockDb.job.updateMany).not.toHaveBeenCalled();
  });
});

describe('JOBS-3: the payer (provider) PATCH cannot rewrite the budget or the parties', () => {
  it('only `status` and `result` reach the write, whatever else the body carries', async () => {
    const res = await (await appFor(PAYER)).inject({
      method: 'PATCH',
      url: '/v1/jobs/job-1',
      payload: {
        status: 'COMPLETED',
        result: { done: true },
        reward: { amount: '999999', token: 'USDC', chainId: CHAIN_ID },
        providerId: STRANGER,
        requesterId: PAYER,
        reservedAmount: '999999',
        budgetAmount: '999999000000',
        escrowKind: null,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(mockDb.job.updateMany).toHaveBeenCalledTimes(1);
    const { data } = mockDb.job.updateMany.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual(['result', 'status']);
    expect(data).not.toHaveProperty('reward');
  });

  it('a reward-only PATCH is a 400 (status is required) and writes nothing', async () => {
    const res = await (await appFor(PAYER)).inject({
      method: 'PATCH',
      url: '/v1/jobs/job-1',
      payload: { reward: { amount: '999999', token: 'USDC', chainId: CHAIN_ID } },
    });
    expect(res.statusCode).toBe(400);
    expect(mockDb.job.updateMany).not.toHaveBeenCalled();
  });

  it('a terminal job cannot be moved again (no re-opening a budget)', async () => {
    mockDb.job.findUnique.mockResolvedValue(job({ status: 'COMPLETED' }));
    const res = await (await appFor(PAYER)).inject({ method: 'PATCH', url: '/v1/jobs/job-1', payload: { status: 'ACCEPTED' } });
    expect(res.statusCode).toBe(400);
    expect(mockDb.job.updateMany).not.toHaveBeenCalled();
  });
});

describe('JOBS-4: the provider cannot contest', () => {
  it('POST /v1/jobs/:id/contest by the provider is 403', async () => {
    mockDb.job.findUnique.mockResolvedValue(job({ escrowKind: 'erc8183', status: 'PAYMENT_PENDING' }));
    const res = await (await appFor(PAYER)).inject({ method: 'POST', url: '/v1/jobs/job-1/contest', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(runtimeMock.contestJob).not.toHaveBeenCalled();
  });
});

describe('JOBS-5: an agent cannot mint its own budget by naming itself as provider', () => {
  const post = (agentId: string, body: Record<string, unknown>) =>
    appFor(agentId).then((app) => app.inject({ method: 'POST', url: '/v1/jobs', payload: { payload: { t: 1 }, ...body } }));

  it('a paid job on a non-escrow chain with provider == requester is 400 JOB_PROVIDER_IS_REQUESTER; nothing reserved or created', async () => {
    mockDb.agent.findUnique.mockResolvedValue({ id: PAYER, active: true, safeAddress: '0x3333333333333333333333333333333333333333' });
    const res = await post(PAYER, { providerId: PAYER, reward: { amount: '100000', token: 'USDC', chainId: LEGACY_CHAIN_ID } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'JOB_PROVIDER_IS_REQUESTER' });
    expect(escrowMock.reserveJobEscrow).not.toHaveBeenCalled();
    expect(mockDb.job.create).not.toHaveBeenCalled();
  });

  it('a paid job for ANOTHER provider on the same chain is unchanged (201)', async () => {
    mockDb.agent.findUnique.mockResolvedValue({ id: STRANGER, active: true, safeAddress: '0x4444444444444444444444444444444444444444' });
    const res = await post(PAYER, { providerId: STRANGER, reward: { amount: '5', token: 'USDC', chainId: LEGACY_CHAIN_ID } });
    expect(res.statusCode).toBe(201);
    expect(mockDb.job.create).toHaveBeenCalledTimes(1);
  });

  it('a FREE job (no budget) to oneself is not affected', async () => {
    mockDb.agent.findUnique.mockResolvedValue({ id: PAYER, active: true, safeAddress: '0x3333333333333333333333333333333333333333' });
    const res = await post(PAYER, { providerId: PAYER });
    expect(res.statusCode).toBe(201);
  });
});

describe('JOBS-6: inbox / outbox list only the caller\'s own jobs', () => {
  it('inbox filters on providerId = caller, outbox on requesterId = caller', async () => {
    const app = await appFor(PAYER);
    await app.inject({ method: 'GET', url: '/v1/jobs/inbox' });
    await app.inject({ method: 'GET', url: '/v1/jobs/outbox' });
    expect(mockDb.job.findMany.mock.calls[0][0].where).toEqual({ providerId: PAYER });
    expect(mockDb.job.findMany.mock.calls[1][0].where).toEqual({ requesterId: PAYER });
  });
});
