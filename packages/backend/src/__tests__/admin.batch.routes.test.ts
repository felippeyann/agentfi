/**
 * Route-level tests — POST /admin/transactions/batch must sign with the
 * agent the operator names (G1 review, 2026-10-14).
 *
 * Before the fix a request without `agentId` fell back to
 * `db.agent.findFirst()`: the batch was queued for whatever agent the
 * database returned first, signed by that agent's wallet and executed from
 * its Safe. The admin "Sync policy" button sent no `agentId`, so every sync
 * ran from an arbitrary agent's Safe.
 *
 * Prisma and the BullMQ queue are mocked; the real route handler runs.
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
  process.env['EXECUTOR_ADDRESS_8453'] = '0x00000000000000000000000000000000000000E1';
});

const { mockDb, queueAdd, contractsGate } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn(), findFirst: vi.fn() },
    transaction: { create: vi.fn() },
  } as any,
  queueAdd: vi.fn(),
  contractsGate: vi.fn(),
}));

// S9: the executor's verification (real checks run on Anvil in contract-identity.*.anvil.ts).
vi.mock('../config/policy-stack-verification.runtime.js', () => ({ policyStackGate: contractsGate }));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: { add: queueAdd },
}));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/billing/pnl.service.js', () => ({
  PnLService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/billing/operator.service.js', () => ({
  OperatorService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/job/payment-finalizer.service.js', () => ({
  finalizeA2APaymentJob: vi.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type AdminModule = typeof import('../api/routes/admin.js');

const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
const POLICY_MODULE = '0x00000000000000000000000000000000000000a1';
const ACTIONS = [{ to: POLICY_MODULE, value: '0', data: '0x12345678' }];

const named = { id: 'agent-named', walletId: 'w-named', safeAddress: '0x2222222222222222222222222222222222222222', tier: 'FREE' };
const other = { id: 'agent-first', walletId: 'w-first', safeAddress: '0x1111111111111111111111111111111111111111', tier: 'FREE' };

let adminRoutes: AdminModule['adminRoutes'];

beforeAll(async () => {
  ({ adminRoutes } = await import('../api/routes/admin.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.agent.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === named.id ? named : null));
  mockDb.agent.findFirst.mockResolvedValue(other);
  mockDb.transaction.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tx-1', ...data }));
  queueAdd.mockResolvedValue({ id: 'job-1' });
  contractsGate.mockImplementation((chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }));
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(adminRoutes);
  return app;
}

function post(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/admin/transactions/batch',
    headers: { 'x-admin-secret': ADMIN_SECRET },
    payload: body,
  });
}

describe('POST /admin/transactions/batch — the signing agent is always named', () => {
  it('refuses a batch without agentId (400) and queues nothing — never falls back to an arbitrary agent', async () => {
    const app = await buildApp();
    const res = await post(app, { chainId: 8453, actions: ACTIONS });
    expect(res.statusCode).toBe(400);
    expect(mockDb.agent.findFirst).not.toHaveBeenCalled();
    expect(mockDb.transaction.create).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses an empty agentId (400)', async () => {
    const app = await buildApp();
    const res = await post(app, { chainId: 8453, actions: ACTIONS, agentId: '' });
    expect(res.statusCode).toBe(400);
    expect(mockDb.transaction.create).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 404 for an unknown agentId and queues nothing', async () => {
    const app = await buildApp();
    const res = await post(app, { chainId: 8453, actions: ACTIONS, agentId: 'agent-missing' });
    expect(res.statusCode).toBe(404);
    expect(mockDb.agent.findFirst).not.toHaveBeenCalled();
    expect(mockDb.transaction.create).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
    await app.close();
  });

  it('queues the batch for the named agent, signed by its wallet from its Safe', async () => {
    const app = await buildApp();
    const res = await post(app, { chainId: 8453, actions: ACTIONS, agentId: named.id });
    expect(res.statusCode).toBeLessThan(300);
    expect(mockDb.transaction.create).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction.create.mock.calls[0][0].data.agentId).toBe(named.id);
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [, data] = queueAdd.mock.calls[0];
    expect(data).toMatchObject({ agentId: named.id, walletId: named.walletId, from: named.safeAddress });
    await app.close();
  });
});

describe('POST /admin/transactions/batch — S9: only through a verified executor', () => {
  it.each(['not-verified-yet', 'unverified', 'mismatch', 'expired'] as const)(
    'gate %s → 503 CONTRACTS_UNVERIFIED with Retry-After; nothing written or queued',
    async (block) => {
      contractsGate.mockReturnValue({ allowed: false, chainId: 8453, block, reason: `executor ${block}`, retryAfterSeconds: 120 });
      const app = await buildApp();
      const res = await post(app, { chainId: 8453, actions: ACTIONS, agentId: named.id });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('120');
      expect(res.json()).toMatchObject({ code: 'CONTRACTS_UNVERIFIED', chainId: 8453, state: block });
      expect(contractsGate).toHaveBeenCalledWith(8453);
      expect(mockDb.transaction.create).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
      await app.close();
    },
  );
});
