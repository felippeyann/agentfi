/**
 * Route-level tests — admin kill switch (A3 / A3b):
 *   POST /admin/agents/:id/pause   (toggle)
 *   POST /admin/agents/:id/resume  (explicit, idempotent)
 *
 * Prisma is mocked with a small in-memory state so the real route handlers,
 * the real PolicyService and the worker's pre-submit guard run end to end:
 *
 *  - pause                       → agent + policy inactive, policy stamped,
 *                                  guard FAILs a queued tx; response unchanged
 *  - pause → resume              → policy active again, stamp cleared, guard proceeds
 *  - policy inactive before pause → resume leaves it inactive and says so
 *  - resume of an unpaused agent → no-op with a clear response
 *  - no policy row / expired     → resume reports it / restores the expired state
 *  - syncOnChain                 → emergencyPause(safe) / resume(safe) calldata
 *                                  decodes against the AgentPolicyModule ABI
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
  // config/contracts.ts reads the policy module addresses at module load:
  // Base has one, Arbitrum deliberately has none.
  process.env['POLICY_MODULE_ADDRESS_8453'] = '0x00000000000000000000000000000000000000a1';
  delete process.env['POLICY_MODULE_ADDRESS_42161'];
});

const { mockDb, finalizeMock } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn(), update: vi.fn() },
    agentPolicy: { findUnique: vi.fn(), updateMany: vi.fn() },
    transaction: { findUnique: vi.fn(), update: vi.fn() },
  } as any,
  finalizeMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));

// admin.ts constructs these at module load; none of them take part in the
// kill-switch routes. The BullMQ queue would otherwise open a Redis connection.
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: { add: vi.fn() },
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
// The pre-submit guard pulls in the A2A finalizer (db singleton + escrow queues).
vi.mock('../services/job/payment-finalizer.service.js', () => ({
  finalizeA2APaymentJob: finalizeMock,
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { decodeFunctionData, toFunctionSelector } from 'viem';

type AdminModule = typeof import('../api/routes/admin.js');
type GuardModule = typeof import('../services/transaction/pre-submit-guard.js');
type OnChainModule = typeof import('../services/policy/onchain-policy.service.js');
type PolicyModule = typeof import('../services/policy/policy.service.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
const AGENT_ID = 'agent-1';
const SAFE = '0x1111111111111111111111111111111111111111';
const POLICY_MODULE = '0x00000000000000000000000000000000000000a1';
const TX_ID = 'tx-1';

type AgentRow = {
  id: string;
  active: boolean;
  safeAddress: string;
  walletId: string;
  chainIds: number[];
  tier: 'FREE';
};
type PolicyRow = {
  agentId: string;
  active: boolean;
  expiresAt: Date | null;
  pausedByOperatorAt: Date | null;
};

let state: { agent: AgentRow | null; policy: PolicyRow | null };

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return { id: AGENT_ID, active: true, safeAddress: SAFE, walletId: 'w-1', chainIds: [8453], tier: 'FREE', ...overrides };
}
function policyRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return { agentId: AGENT_ID, active: true, expiresAt: null, pausedByOperatorAt: null, ...overrides };
}

/** Minimal Prisma `where` evaluator for the shapes the kill switch uses (`{ not: null }` included). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond !== null && typeof cond === 'object' && 'not' in (cond as object)) {
      if (row[key] === (cond as { not: unknown }).not) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

let adminRoutes: AdminModule['adminRoutes'];
let RESUME_POLICY_NOTES: AdminModule['RESUME_POLICY_NOTES'];
let preSubmitGuard: GuardModule['preSubmitGuard'];
let PAUSED_BEFORE_SUBMISSION: GuardModule['PAUSED_BEFORE_SUBMISSION'];
let POLICY_EXPIRED_BEFORE_SUBMISSION: GuardModule['POLICY_EXPIRED_BEFORE_SUBMISSION'];
let AGENT_POLICY_MODULE_ABI: OnChainModule['AGENT_POLICY_MODULE_ABI'];
let PolicyService: PolicyModule['PolicyService'];

beforeAll(async () => {
  ({ adminRoutes, RESUME_POLICY_NOTES } = await import('../api/routes/admin.js'));
  ({ preSubmitGuard, PAUSED_BEFORE_SUBMISSION, POLICY_EXPIRED_BEFORE_SUBMISSION } = await import(
    '../services/transaction/pre-submit-guard.js'
  ));
  ({ AGENT_POLICY_MODULE_ABI } = await import('../services/policy/onchain-policy.service.js'));
  ({ PolicyService } = await import('../services/policy/policy.service.js'));
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(adminRoutes);
  return app;
}

function post(app: FastifyInstance, path: string, body?: Record<string, unknown>, secret = ADMIN_SECRET) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-admin-secret': secret },
    ...(body ? { payload: body } : {}),
  });
}

const PAUSE = `/admin/agents/${AGENT_ID}/pause`;
const RESUME = `/admin/agents/${AGENT_ID}/resume`;

/** What the transaction worker would decide for a QUEUED tx of this agent right now. */
function workerDecision() {
  return preSubmitGuard(mockDb as unknown as PrismaClient, TX_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  state = { agent: agentRow(), policy: policyRow() };

  mockDb.agent.findUnique.mockImplementation(async ({ where }: any) =>
    state.agent && state.agent.id === where.id ? { ...state.agent } : null,
  );
  mockDb.agent.update.mockImplementation(async ({ where, data }: any) => {
    if (!state.agent || state.agent.id !== where.id) throw new Error('agent not found');
    Object.assign(state.agent, data);
    return { ...state.agent };
  });
  mockDb.agentPolicy.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (state.policy && matches(state.policy, where)) {
      Object.assign(state.policy, data);
      return { count: 1 };
    }
    return { count: 0 };
  });
  mockDb.agentPolicy.findUnique.mockImplementation(async ({ where }: any) =>
    state.policy && state.policy.agentId === where.agentId ? { ...state.policy } : null,
  );
  // The guard's single nested select: tx + agent + policy, read live from `state`.
  mockDb.transaction.findUnique.mockImplementation(async () => ({
    status: 'QUEUED',
    txHash: null,
    metadata: null,
    agent: {
      active: state.agent!.active,
      policy: state.policy ? { active: state.policy.active, expiresAt: state.policy.expiresAt } : null,
    },
  }));
  mockDb.transaction.update.mockResolvedValue({});
  finalizeMock.mockResolvedValue(undefined);
});

// ── Pause half of the toggle (contract unchanged by A3b) ───────────────────

describe('POST /admin/agents/:id/pause — pausing', () => {
  it('pauses the agent, deactivates + stamps the policy, and the worker guard rejects a queued tx', async () => {
    const app = await buildApp();

    const res = await post(app, PAUSE);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false, onChainSync: null });
    expect(state.agent!.active).toBe(false);
    expect(state.policy!.active).toBe(false);
    expect(state.policy!.pausedByOperatorAt).toBeInstanceOf(Date);
    expect(mockDb.agentPolicy.updateMany).toHaveBeenCalledWith({
      where: { agentId: AGENT_ID, active: true },
      data: { active: false, pausedByOperatorAt: expect.any(Date) },
    });

    await expect(workerDecision()).resolves.toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    await app.close();
  });

  it('leaves a policy that was already inactive untouched and unstamped', async () => {
    state.policy = policyRow({ active: false });
    const app = await buildApp();

    const res = await post(app, PAUSE);

    expect(res.json()).toEqual({ active: false, onChainSync: null });
    expect(state.policy!.active).toBe(false);
    expect(state.policy!.pausedByOperatorAt).toBeNull();
    await app.close();
  });

  it('syncOnChain returns emergencyPause(safe) calldata for the policy module of the primary chain', async () => {
    const app = await buildApp();

    const body = (await post(app, PAUSE, { syncOnChain: true })).json();

    expect(body.active).toBe(false);
    expect(body.onChainSync).toMatchObject({ to: POLICY_MODULE, chainId: 8453 });
    expect(body.onChainSync.actions).toHaveLength(1);
    const { to, value, data } = body.onChainSync.actions[0];
    expect(to).toBe(POLICY_MODULE);
    expect(value).toBe('0');
    expect(data.slice(0, 10)).toBe(toFunctionSelector('emergencyPause(address)'));
    expect(decodeFunctionData({ abi: AGENT_POLICY_MODULE_ABI, data })).toEqual({
      functionName: 'emergencyPause',
      args: [SAFE],
    });
    expect(body.onChainSync.notice).toMatch(/pause the on-chain policy/);
    await app.close();
  });
});

// ── Resume: toggle and explicit route ──────────────────────────────────────

describe('resume after an operator pause', () => {
  it('toggle: pause then pause again re-activates the policy and the worker guard proceeds', async () => {
    const app = await buildApp();
    await post(app, PAUSE);
    expect(state.policy!.active).toBe(false);

    const res = await post(app, PAUSE);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      active: true,
      agentReactivated: true,
      policyReactivated: true,
      policyNote: RESUME_POLICY_NOTES.reactivated,
      onChainSync: null,
    });
    expect(state.agent!.active).toBe(true);
    expect(state.policy!.active).toBe(true);
    expect(state.policy!.pausedByOperatorAt).toBeNull();

    await expect(workerDecision()).resolves.toEqual({ action: 'proceed' });
    expect(mockDb.transaction.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /resume after a pause re-activates the policy; a second /resume is a no-op', async () => {
    const app = await buildApp();
    await post(app, PAUSE);

    const first = await post(app, RESUME);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      active: true,
      agentReactivated: true,
      policyReactivated: true,
      policyNote: RESUME_POLICY_NOTES.reactivated,
      onChainSync: null,
    });
    await expect(workerDecision()).resolves.toEqual({ action: 'proceed' });

    const updatesBefore = mockDb.agent.update.mock.calls.length;
    const second = await post(app, RESUME);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      active: true,
      agentReactivated: false,
      policyReactivated: false,
      policyNote: RESUME_POLICY_NOTES.already_active,
      onChainSync: null,
    });
    // Idempotent: nothing was written the second time.
    expect(mockDb.agent.update.mock.calls.length).toBe(updatesBefore);
    expect(state.agent!.active).toBe(true);
    expect(state.policy!.active).toBe(true);
    await app.close();
  });

  it('does not re-activate a policy that was already inactive before the pause', async () => {
    state.policy = policyRow({ active: false });
    const app = await buildApp();
    await post(app, PAUSE);

    const res = await post(app, RESUME);

    expect(res.json()).toEqual({
      active: true,
      agentReactivated: true,
      policyReactivated: false,
      policyNote: RESUME_POLICY_NOTES.left_inactive,
      onChainSync: null,
    });
    expect(state.agent!.active).toBe(true);
    expect(state.policy!.active).toBe(false);
    // Agent is live but the policy still blocks — exactly what the note says.
    await expect(workerDecision()).resolves.toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });
    await app.close();
  });

  it('does not undo an agent soft-delete (emergencyPause) that landed during the pause', async () => {
    const app = await buildApp();
    await post(app, PAUSE);
    expect(state.policy!.pausedByOperatorAt).toBeInstanceOf(Date);

    // DELETE /v1/agents/:id path: independent deactivation clears the stamp.
    await new PolicyService(mockDb as unknown as PrismaClient).emergencyPause(AGENT_ID);
    expect(state.policy!.pausedByOperatorAt).toBeNull();

    const res = await post(app, RESUME);

    expect(res.json()).toMatchObject({
      active: true,
      policyReactivated: false,
      policyNote: RESUME_POLICY_NOTES.left_inactive,
    });
    expect(state.policy!.active).toBe(false);
    await app.close();
  });

  it('resume of an agent that was never paused is a no-op with a clear response', async () => {
    const app = await buildApp();

    const res = await post(app, RESUME);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      active: true,
      agentReactivated: false,
      policyReactivated: false,
      policyNote: RESUME_POLICY_NOTES.already_active,
      onChainSync: null,
    });
    expect(mockDb.agent.update).not.toHaveBeenCalled();
    expect(state.policy).toEqual(policyRow());
    await expect(workerDecision()).resolves.toEqual({ action: 'proceed' });
    await app.close();
  });

  it('agent without a policy row: resume says so and the guard proceeds (no policy = no restrictions)', async () => {
    state.policy = null;
    const app = await buildApp();
    await post(app, PAUSE);
    await expect(workerDecision()).resolves.toEqual({ action: 'fail', reason: PAUSED_BEFORE_SUBMISSION });

    const res = await post(app, RESUME);

    expect(res.json()).toEqual({
      active: true,
      agentReactivated: true,
      policyReactivated: false,
      policyNote: RESUME_POLICY_NOTES.no_policy,
      onChainSync: null,
    });
    await expect(workerDecision()).resolves.toEqual({ action: 'proceed' });
    await app.close();
  });

  it('restores an expired policy exactly as it was: active again, still expired', async () => {
    const past = new Date(Date.now() - 60_000);
    state.policy = policyRow({ expiresAt: past });
    const app = await buildApp();
    await post(app, PAUSE);
    expect(state.policy!.active).toBe(false);

    const res = await post(app, RESUME);

    expect(res.json()).toMatchObject({ policyReactivated: true });
    expect(state.policy).toEqual(policyRow({ expiresAt: past }));
    await expect(workerDecision()).resolves.toEqual({
      action: 'fail',
      reason: POLICY_EXPIRED_BEFORE_SUBMISSION,
    });
    await app.close();
  });
});

// ── On-chain calldata (encode-only; the backend never broadcasts) ──────────

describe('resume — syncOnChain', () => {
  it('returns resume(safe) calldata that decodes against the AgentPolicyModule ABI', async () => {
    const app = await buildApp();
    await post(app, PAUSE);

    const body = (await post(app, RESUME, { syncOnChain: true })).json();

    expect(body).toMatchObject({ active: true, agentReactivated: true, policyReactivated: true });
    expect(body.onChainSync).toMatchObject({ to: POLICY_MODULE, chainId: 8453 });
    expect(body.onChainSync.actions).toEqual([
      { to: POLICY_MODULE, value: '0', data: expect.stringMatching(/^0x[0-9a-f]+$/) },
    ]);
    const { data } = body.onChainSync.actions[0];
    expect(data.slice(0, 10)).toBe(toFunctionSelector('resume(address)'));
    expect(decodeFunctionData({ abi: AGENT_POLICY_MODULE_ABI, data })).toEqual({
      functionName: 'resume',
      args: [SAFE],
    });
    expect(body.onChainSync.notice).toMatch(/resume the on-chain policy/);
    expect(body.onChainSync.notice).toMatch(/has NOT broadcast/);
    await app.close();
  });

  it('is returned even on a no-op resume, so the chain can be re-synced on its own', async () => {
    const app = await buildApp();

    const body = (await post(app, RESUME, { syncOnChain: true })).json();

    expect(body.agentReactivated).toBe(false);
    expect(body.onChainSync.actions[0].data.slice(0, 10)).toBe(toFunctionSelector('resume(address)'));
    await app.close();
  });

  it('is null when the agent primary chain has no policy module configured', async () => {
    state.agent = agentRow({ chainIds: [42161] });
    const app = await buildApp();
    await post(app, PAUSE);

    const body = (await post(app, RESUME, { syncOnChain: true })).json();

    expect(body).toMatchObject({ active: true, policyReactivated: true, onChainSync: null });
    await app.close();
  });

  it('rejects a malformed body with 400 and changes nothing', async () => {
    const app = await buildApp();
    await post(app, PAUSE);

    const res = await post(app, RESUME, { syncOnChain: 'yes' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Invalid request body' });
    expect(state.agent!.active).toBe(false);
    expect(state.policy!.active).toBe(false);
    await app.close();
  });
});

// ── Guards ─────────────────────────────────────────────────────────────────

describe('resume — auth and lookup', () => {
  it('404 for an unknown agent', async () => {
    const app = await buildApp();

    const res = await post(app, '/admin/agents/nope/resume');

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('401 without the admin secret', async () => {
    const app = await buildApp();

    const res = await post(app, RESUME, undefined, 'wrong');

    expect(res.statusCode).toBe(401);
    expect(mockDb.agent.findUnique).not.toHaveBeenCalled();
    await app.close();
  });
});
