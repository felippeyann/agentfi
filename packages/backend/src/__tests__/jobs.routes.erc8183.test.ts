/**
 * Route-level tests — `api/routes/jobs.ts` on an ERC-8183 chain (C3).
 *
 * Prisma, the legacy escrow service, the A2A payment path and the ERC-8183
 * runtime are mocked; the real route handlers run against them:
 *
 *  - POST /v1/jobs: USDC-only (400 ERC8183_USDC_ONLY), provider == requester
 *    (400), happy path reserves + creates + startEscrow and answers with
 *    `escrow`, startEscrow failure → FAILED + release + 503, legacy chain untouched
 *  - PATCH: ACCEPTED requires onChainStatus FUNDED (409 ESCROW_NOT_FUNDED),
 *    paid COMPLETED → PAYMENT_PENDING + submit (no executeA2APayment),
 *    CANCELLED / FAILED schedule the evaluator reject
 *  - POST /v1/jobs/:id/contest guards
 *  - GET /v1/jobs/:id/feedback.json: 404 until generated, public (no API key),
 *    byte-stable: keccak256(body) == feedbackHashOf(stored file)
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

const { mockDb, escrowMock, runtimeMock, reputationMock, paymentMock } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn(), findFirst: vi.fn() },
    job: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  } as any,
  escrowMock: {
    reserveJobEscrow: vi.fn(),
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
    erc8183Config: { evaluatorAddress: '0x000000000000000000000000000000000000Ea1D' },
  },
  reputationMock: { recordJobOutcome: vi.fn() },
  paymentMock: { executeA2APayment: vi.fn() },
}));

vi.mock('../db/client.js', () => ({ db: mockDb }));
vi.mock('../services/policy/escrow.service.js', () => escrowMock);
vi.mock('../services/job/escrow-erc8183.runtime.js', () => runtimeMock);
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => reputationMock),
}));
vi.mock('../api/routes/transactions.js', () => paymentMock);
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));

import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { feedbackHashOf, serializeFeedbackFile, type FeedbackFile } from '../services/job/escrow-erc8183.service.js';

type JobsModule = typeof import('../api/routes/jobs.js');
type AuthModule = typeof import('../api/middleware/auth.js');

const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ESCROW = '0x00000000000000000000000000000000000E5C20';
const REQUESTER = { id: 'cl0000000000000000000req01', walletId: 'wallet-req', safeAddress: '0x1111111111111111111111111111111111111111' };
const PROVIDER = { id: 'cl0000000000000000000prov1', walletId: 'wallet-prov', safeAddress: '0x2222222222222222222222222222222222222222', active: true };

let jobRoutes: JobsModule['jobRoutes'];
let authMiddleware: AuthModule['authMiddleware'];

beforeAll(async () => {
  ({ jobRoutes } = await import('../api/routes/jobs.js'));
  ({ authMiddleware } = await import('../api/middleware/auth.js'));
});

async function buildApp(agentId = REQUESTER.id) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = agentId;
    request.agentTier = 'FREE';
  });
  await app.register(jobRoutes);
  return app;
}

function escrowJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    requesterId: REQUESTER.id,
    providerId: PROVIDER.id,
    status: 'PENDING',
    payload: { task: 'x' },
    reward: { amount: '12.5', token: 'USDC', chainId: CHAIN_ID },
    result: null,
    reservationStatus: 'PENDING',
    escrowKind: 'erc8183',
    escrowChainId: CHAIN_ID,
    escrowContract: ESCROW,
    onChainJobId: '7',
    onChainStatus: 'FUNDED',
    evaluator: runtimeMock.erc8183Config.evaluatorAddress,
    budgetToken: USDC,
    budgetAmount: '12500000',
    expiresAt: new Date('2026-10-13T12:00:00.000Z'),
    deliverableHash: null,
    settleTxHash: null,
    platformFeeAmount: null,
    feedbackStatus: null,
    feedbackFile: null,
    contestedAt: null,
    contestReason: null,
    escrowError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMock.isErc8183Enabled.mockImplementation((chainId: number) => chainId === CHAIN_ID);
  runtimeMock.getEscrowToken.mockResolvedValue(USDC);
  runtimeMock.startEscrow.mockResolvedValue(undefined);
  runtimeMock.enqueueSubmit.mockResolvedValue(undefined);
  runtimeMock.requestCancellationReject.mockResolvedValue(true);
  escrowMock.reserveJobEscrow.mockResolvedValue({ success: true, reservedValueUsd: '12.5' });
  escrowMock.releaseJobEscrow.mockResolvedValue(undefined);
  escrowMock.markEscrowReleased.mockResolvedValue(undefined);
  escrowMock.queueOnChainEscrowLock.mockResolvedValue(null);
  reputationMock.recordJobOutcome.mockResolvedValue(undefined);
  mockDb.job.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => escrowJob(data));
  mockDb.job.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'job-1', ...data, escrowKind: null }));
});

// ── POST /v1/jobs ──────────────────────────────────────────────────────────

describe('POST /v1/jobs on an ERC-8183 chain', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, reward: Record<string, unknown>, providerId = PROVIDER.id) =>
    app.inject({ method: 'POST', url: '/v1/jobs', payload: { providerId, payload: { task: 'x' }, reward } });

  it('rejects a non-USDC reward with 400 ERC8183_USDC_ONLY before reserving or creating anything', async () => {
    mockDb.agent.findUnique.mockResolvedValueOnce(PROVIDER);
    const app = await buildApp();

    const res = await post(app, { amount: '0.01', token: 'ETH', chainId: CHAIN_ID });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'ERC8183_USDC_ONLY', chainId: CHAIN_ID, escrowToken: USDC });
    expect(escrowMock.reserveJobEscrow).not.toHaveBeenCalled();
    expect(mockDb.job.create).not.toHaveBeenCalled();
    expect(runtimeMock.startEscrow).not.toHaveBeenCalled();
  });

  it('rejects provider == requester with 400 ERC8183_PROVIDER_IS_REQUESTER', async () => {
    mockDb.agent.findUnique.mockResolvedValueOnce({ ...PROVIDER, id: REQUESTER.id });
    const app = await buildApp();

    const res = await post(app, { amount: '12.5', token: 'USDC', chainId: CHAIN_ID }, REQUESTER.id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'ERC8183_PROVIDER_IS_REQUESTER' });
    expect(mockDb.job.create).not.toHaveBeenCalled();
  });

  it('accepts USDC by symbol or by the escrow token address: reserves, creates, starts the escrow and returns `escrow`', async () => {
    for (const token of ['USDC', USDC.toLowerCase()]) {
      vi.clearAllMocks();
      runtimeMock.isErc8183Enabled.mockReturnValue(true);
      runtimeMock.getEscrowToken.mockResolvedValue(USDC);
      runtimeMock.startEscrow.mockResolvedValue(undefined);
      escrowMock.reserveJobEscrow.mockResolvedValue({ success: true });
      mockDb.agent.findUnique.mockResolvedValueOnce(PROVIDER).mockResolvedValueOnce(REQUESTER);
      mockDb.job.create.mockResolvedValue({ id: 'job-1', status: 'PENDING', escrowKind: null });
      mockDb.job.findUnique.mockResolvedValue(escrowJob({ onChainStatus: 'CREATING', onChainJobId: null }));
      const app = await buildApp();

      const res = await post(app, { amount: '12.5', token, chainId: CHAIN_ID });

      expect(res.statusCode).toBe(201);
      expect(escrowMock.reserveJobEscrow).toHaveBeenCalledWith({
        requesterId: REQUESTER.id,
        reward: { amount: '12.5', token, chainId: CHAIN_ID },
      });
      expect(mockDb.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', reservedAmount: '12.5', reservedToken: token, reservedChainId: CHAIN_ID, reservationStatus: 'PENDING' }),
        }),
      );
      expect(runtimeMock.startEscrow).toHaveBeenCalledWith({
        job: { id: 'job-1' },
        requester: REQUESTER,
        provider: { safeAddress: PROVIDER.safeAddress },
        amount: '12.5',
        chainId: CHAIN_ID,
      });
      expect(escrowMock.queueOnChainEscrowLock).not.toHaveBeenCalled();
      const body = res.json();
      expect(body.escrow).toMatchObject({ kind: 'erc8183', chainId: CHAIN_ID, contract: ESCROW, onChainStatus: 'CREATING', budgetAmount: '12500000', budgetToken: USDC });
      expect(body).not.toHaveProperty('feedbackFile');
      expect(body).not.toHaveProperty('onChainStatus');
    }
  });

  it('startEscrow failure → job FAILED, reservation released, 503 ERC8183_START_FAILED', async () => {
    mockDb.agent.findUnique.mockResolvedValueOnce(PROVIDER).mockResolvedValueOnce(REQUESTER);
    mockDb.job.create.mockResolvedValue({ id: 'job-1', status: 'PENDING' });
    runtimeMock.startEscrow.mockRejectedValue(new Error('rpc down'));
    const app = await buildApp();

    const res = await post(app, { amount: '12.5', token: 'USDC', chainId: CHAIN_ID });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'ERC8183_START_FAILED', jobId: 'job-1', reason: 'rpc down' });
    expect(mockDb.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'FAILED', onChainStatus: 'FAILED', escrowError: expect.stringContaining('rpc down') }),
    });
    expect(escrowMock.releaseJobEscrow).toHaveBeenCalledWith('job-1');
  });

  it('keeps the legacy path on a chain without the escrow (DB reservation + EscrowModule lock, no startEscrow, escrow: null)', async () => {
    mockDb.agent.findUnique.mockResolvedValueOnce(PROVIDER);
    mockDb.job.create.mockResolvedValue({ id: 'job-2', status: 'PENDING', reward: { amount: '0.01', token: 'ETH', chainId: 1 }, escrowKind: null });
    const app = await buildApp();

    const res = await post(app, { amount: '0.01', token: 'ETH', chainId: 1 });

    expect(res.statusCode).toBe(201);
    expect(runtimeMock.getEscrowToken).not.toHaveBeenCalled();
    expect(runtimeMock.startEscrow).not.toHaveBeenCalled();
    expect(escrowMock.queueOnChainEscrowLock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-2', token: 'ETH', chainId: 1 }));
    expect(res.json().escrow).toBeNull();
  });
});

// ── PATCH /v1/jobs/:id ─────────────────────────────────────────────────────

describe('PATCH /v1/jobs/:id on an ERC-8183 job', () => {
  const patch = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/v1/jobs/job-1', payload });

  it('ACCEPTED is refused with 409 ESCROW_NOT_FUNDED until the budget is locked on-chain', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ onChainStatus: 'BUDGET_SET', escrowError: null }));
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'ACCEPTED' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'ESCROW_NOT_FUNDED', onChainStatus: 'BUDGET_SET' });
    expect(mockDb.job.update).not.toHaveBeenCalled();
  });

  it('ACCEPTED succeeds once FUNDED', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ onChainStatus: 'FUNDED' }));
    mockDb.job.update.mockResolvedValue(escrowJob({ status: 'ACCEPTED' }));
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'ACCEPTED' });

    expect(res.statusCode).toBe(200);
    expect(mockDb.job.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACCEPTED' } }));
  });

  it('paid COMPLETED → PAYMENT_PENDING + provider submit; the legacy direct transfer is never fired', async () => {
    const result = { answer: 42 };
    mockDb.job.findUnique
      .mockResolvedValueOnce(escrowJob({ status: 'ACCEPTED' }))
      .mockResolvedValueOnce(escrowJob({ status: 'PAYMENT_PENDING', result }));
    mockDb.job.update.mockResolvedValue(escrowJob({ status: 'PAYMENT_PENDING', result }));
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'COMPLETED', result });

    expect(res.statusCode).toBe(200);
    expect(mockDb.job.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'PAYMENT_PENDING', result } });
    expect(runtimeMock.enqueueSubmit).toHaveBeenCalledWith({ jobId: 'job-1', result });
    expect(paymentMock.executeA2APayment).not.toHaveBeenCalled();
    expect(escrowMock.markEscrowReleased).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ status: 'PAYMENT_PENDING', escrow: { onChainStatus: 'FUNDED' } });
  });

  it('a submit that cannot be enqueued returns the job to ACCEPTED and answers 503', async () => {
    mockDb.job.findUnique.mockResolvedValueOnce(escrowJob({ status: 'ACCEPTED' }));
    runtimeMock.enqueueSubmit.mockRejectedValue(new Error('no on-chain id'));
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'COMPLETED', result: {} });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'ESCROW_SUBMIT_FAILED' });
    expect(mockDb.job.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'ACCEPTED', escrowError: expect.stringContaining('no on-chain id') },
    });
  });

  it('requester CANCELLED while FUNDED → reservation released now, evaluator reject scheduled', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ status: 'ACCEPTED', onChainStatus: 'FUNDED' }));
    const app = await buildApp(REQUESTER.id);

    const res = await patch(app, { status: 'CANCELLED' });

    expect(res.statusCode).toBe(200);
    expect(escrowMock.releaseJobEscrow).toHaveBeenCalledWith('job-1');
    expect(runtimeMock.requestCancellationReject).toHaveBeenCalledWith({ jobId: 'job-1', reason: 'cancelled' });
  });

  it('provider FAILED while ACCEPTED → reputation hit + reject with provider-failed', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ status: 'ACCEPTED', onChainStatus: 'FUNDED' }));
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'FAILED', error: 'could not do it' });

    expect(res.statusCode).toBe(200);
    expect(reputationMock.recordJobOutcome).toHaveBeenCalledWith(PROVIDER.id, false);
    expect(runtimeMock.requestCancellationReject).toHaveBeenCalledWith({ jobId: 'job-1', reason: 'provider-failed' });
  });

  it('legacy paid COMPLETED still goes through executeA2APayment', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ status: 'ACCEPTED', escrowKind: null, reward: { amount: '0.01', token: 'ETH', chainId: 1 } }));
    mockDb.agent.findUnique.mockResolvedValue({ safeAddress: PROVIDER.safeAddress });
    paymentMock.executeA2APayment.mockResolvedValue({ transactionId: 'tx-1', status: 'QUEUED' });
    const app = await buildApp(PROVIDER.id);

    const res = await patch(app, { status: 'COMPLETED', result: {} });

    expect(res.statusCode).toBe(200);
    expect(paymentMock.executeA2APayment).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', intentId: 'a2a-payment:job-1' }));
    expect(runtimeMock.enqueueSubmit).not.toHaveBeenCalled();
    expect(runtimeMock.requestCancellationReject).not.toHaveBeenCalled();
  });
});

// ── POST /v1/jobs/:id/contest ──────────────────────────────────────────────

describe('POST /v1/jobs/:id/contest', () => {
  const contest = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/v1/jobs/job-1/contest', payload });

  it('only the requester may contest', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' }));
    const app = await buildApp(PROVIDER.id);
    const res = await contest(app, { reason: 'wrong' });
    expect(res.statusCode).toBe(403);
    expect(mockDb.job.updateMany).not.toHaveBeenCalled();
  });

  it('refuses legacy jobs with 409 NOT_ESCROW_JOB', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ escrowKind: null, status: 'PAYMENT_PENDING' }));
    const app = await buildApp();
    const res = await contest(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'NOT_ESCROW_JOB' });
  });

  it('refuses with 409 CONTEST_NOT_ALLOWED once settlement was claimed (conditional update matched nothing)', async () => {
    mockDb.job.findUnique.mockResolvedValue(escrowJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SETTLING' }));
    mockDb.job.updateMany.mockResolvedValue({ count: 0 });
    const app = await buildApp();
    const res = await contest(app, { reason: 'late' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'CONTEST_NOT_ALLOWED', status: 'PAYMENT_PENDING', onChainStatus: 'SETTLING' });
    expect(mockDb.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', contestedAt: null },
      data: { contestedAt: expect.any(Date), contestReason: 'late' },
    });
  });

  it('records contestedAt + reason while PAYMENT_PENDING and SUBMITTED', async () => {
    const contestedAt = new Date('2026-10-06T13:00:00.000Z');
    mockDb.job.findUnique
      .mockResolvedValueOnce(escrowJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' }))
      .mockResolvedValueOnce(escrowJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', contestedAt, contestReason: 'wrong answer' }));
    mockDb.job.updateMany.mockResolvedValue({ count: 1 });
    const app = await buildApp();

    const res = await contest(app, { reason: 'wrong answer' });

    expect(res.statusCode).toBe(200);
    expect(res.json().escrow).toMatchObject({ onChainStatus: 'SUBMITTED', contestedAt: contestedAt.toISOString(), contestReason: 'wrong answer' });
  });
});

// ── GET /v1/jobs/:id/feedback.json ─────────────────────────────────────────

describe('GET /v1/jobs/:id/feedback.json', () => {
  const file: FeedbackFile = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
    jobId: 'job-1',
    escrow: { chainId: CHAIN_ID, contract: ESCROW as `0x${string}`, onChainJobId: 7 },
    proofOfPayment: {
      chainId: CHAIN_ID,
      txHash: '0xf00d000000000000000000000000000000000000000000000000000000000001',
      fromAddress: REQUESTER.safeAddress as `0x${string}`,
      toAddress: ESCROW as `0x${string}`,
    },
    outcome: 'completed',
    deliverableHash: null,
    evaluator: runtimeMock.erc8183Config.evaluatorAddress as `0x${string}`,
    issuedAt: '2026-10-06T12:00:00.000Z',
  };

  it('is 404 until the settlement worker generated the file', async () => {
    mockDb.job.findUnique.mockResolvedValue({ feedbackFile: null });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/jobs/job-1/feedback.json' });
    expect(res.statusCode).toBe(404);
  });

  it('serves the stored file byte-for-byte: keccak256(body) equals the hash committed on-chain, even after a jsonb key reorder', async () => {
    // Postgres jsonb does not preserve key order — hand the route a reordered copy.
    const reordered = { issuedAt: file.issuedAt, outcome: file.outcome, jobId: file.jobId, type: file.type, evaluator: file.evaluator, deliverableHash: null, proofOfPayment: { toAddress: file.proofOfPayment.toAddress, txHash: file.proofOfPayment.txHash, chainId: CHAIN_ID, fromAddress: file.proofOfPayment.fromAddress }, escrow: { onChainJobId: 7, chainId: CHAIN_ID, contract: ESCROW } };
    mockDb.job.findUnique.mockResolvedValue({ feedbackFile: reordered });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/v1/jobs/job-1/feedback.json' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.body).toBe(serializeFeedbackFile(file));
    expect(keccak256(toBytes(res.body))).toBe(feedbackHashOf(file));
    expect(JSON.parse(res.body)).toEqual(file);
  });

  it('is public: the auth middleware lets it through without an API key', async () => {
    mockDb.job.findUnique.mockResolvedValue({ feedbackFile: file });
    const app = Fastify({ logger: false });
    await app.register(authMiddleware);
    await app.register(jobRoutes);

    const open = await app.inject({ method: 'GET', url: '/v1/jobs/job-1/feedback.json' });
    expect(open.statusCode).toBe(200);

    const protectedRoute = await app.inject({ method: 'GET', url: '/v1/jobs/job-1' });
    expect(protectedRoute.statusCode).toBe(401);
  });
});
