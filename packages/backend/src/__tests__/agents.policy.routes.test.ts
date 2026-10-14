/**
 * Route-level tests — PATCH /v1/agents/:id/policy authority guard.
 *
 * Prisma is mocked (hoisted) so the real route handler + PolicyService run
 * end-to-end against an in-memory stub. Two app flavours:
 *   1. a stub preHandler that sets request.agentId / request.isOperator
 *      directly (handler semantics: tighten-only for agents, operator may loosen);
 *   2. the real auth middleware, proving the operator API_SECRET is accepted
 *      on this route — and only this route.
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

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    agent: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    agentPolicy: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  } as any,
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));

// Heavy wallet/identity/billing services are constructed at module load by
// agents.ts; none of them participate in the policy route.
vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({}),
}));
vi.mock('../services/wallet/safe.service.js', () => ({
  SafeService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/identity/ens.service.js', () => ({
  EnsService: vi.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
vi.mock('../services/billing/pnl.service.js', () => ({
  PnLService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));

import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentPolicy } from '@prisma/client';

type AgentsModule = typeof import('../api/routes/agents.js');
type AuthModule = typeof import('../api/middleware/auth.js');

// ── Fixtures ───────────────────────────────────────────────────────────────

const UNISWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const PAYEE = '0x00000000000000000000000000000000000000b0';
const OTHER_PAYEE = '0x00000000000000000000000000000000000000c1';
const AGENT_KEY = 'agfi_live_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const LOOSENING_ERROR =
  'Policy can only be tightened by the agent. Loosening requires the operator credential.';

function basePolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    id: 'policy-1',
    agentId: 'agent-1',
    active: true,
    maxValuePerTxEth: '1.0',
    maxValuePerTxUsd: '1.0',
    maxOutflowPerTxUsd: null,
    maxValueForAutoApprovalEth: '0.1',
    maxDailyVolumeUsd: '10000',
    allowedContracts: [UNISWAP_ROUTER],
    allowedRecipients: [PAYEE],
    allowedTokens: [],
    cooldownSeconds: 60,
    expiresAt: null,
    pausedByOperatorAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

let agentRoutes: AgentsModule['agentRoutes'];
let authMiddleware: AuthModule['authMiddleware'];

beforeAll(async () => {
  ({ agentRoutes } = await import('../api/routes/agents.js'));
  ({ authMiddleware } = await import('../api/middleware/auth.js'));
});

/** App whose caller identity is injected directly — exercises handler semantics only. */
async function buildApp(caller: { agentId?: string; isOperator?: boolean }) {
  const app = Fastify({ logger: false });
  app.decorateRequest('agentId', '');
  app.decorateRequest('agentTier', 'FREE');
  app.decorateRequest('isOperator', false);
  app.addHook('preHandler', async (request) => {
    request.agentId = caller.agentId ?? '';
    request.isOperator = caller.isOperator ?? false;
  });
  await app.register(agentRoutes);
  return app;
}

/** App with the real auth middleware — exercises operator vs agent key resolution. */
async function buildAuthedApp() {
  const app = Fastify({ logger: false });
  await app.register(authMiddleware);
  await app.register(agentRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.agentPolicy.findUnique.mockResolvedValue(basePolicy());
  mockDb.agentPolicy.upsert.mockImplementation(
    async ({ update }: { update: Partial<AgentPolicy> }) => basePolicy(update),
  );
  mockDb.agent.findUnique.mockResolvedValue({ id: 'agent-1', active: true, tier: 'FREE' });
});

// ── Handler semantics ──────────────────────────────────────────────────────

describe('PATCH /v1/agents/:id/policy — agent caller', () => {
  it('rejects a loosening patch with 403 and names the loosened fields', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '5.0', allowedContracts: [UNISWAP_ROUTER, AAVE_POOL] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: LOOSENING_ERROR,
      loosenedFields: ['maxValuePerTxEth', 'allowedContracts'],
    });
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects a mixed patch that loosens any single field', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.1', cooldownSeconds: 0 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().loosenedFields).toEqual(['cooldownSeconds']);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it('applies a tightening patch', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.5', cooldownSeconds: 120, expiresAt: '2026-12-01T00:00:00.000Z' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);
    const call = mockDb.agentPolicy.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ agentId: 'agent-1' });
    expect(call.update).toEqual({
      maxValuePerTxEth: '0.5',
      cooldownSeconds: 120,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    // Body fields that were not sent must not reach Prisma as explicit undefined.
    expect(Object.keys(call.update)).toEqual(['maxValuePerTxEth', 'cooldownSeconds', 'expiresAt']);
    expect(res.json()).toMatchObject({ maxValuePerTxEth: '0.5', cooldownSeconds: 120, onChainSync: null });

    await app.close();
  });

  it('lets an agent without a policy row set its first limits', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(null);
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '100', active: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("still refuses to touch another agent's policy, even to tighten it", async () => {
    const app = await buildApp({ agentId: 'agent-2' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.1' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Access denied' });
    expect(mockDb.agentPolicy.findUnique).not.toHaveBeenCalled();
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('PATCH /v1/agents/:id/policy — operator caller', () => {
  it('may loosen any agent policy', async () => {
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '5.0', allowedContracts: [], active: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({
      maxValuePerTxEth: '5.0',
      allowedContracts: [],
      active: true,
      // An explicit `active` write clears the admin-pause stamp (A3b).
      pausedByOperatorAt: null,
    });

    await app.close();
  });

  it('creates the policy row for an existing agent that has none', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(null);
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxDailyVolumeUsd: '0' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agent.findUnique).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      select: { id: true },
    });
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns 404 for an unknown agent id', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(null);
    mockDb.agent.findUnique.mockResolvedValue(null);
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/no-such-agent/policy',
      payload: { maxValuePerTxEth: '5.0' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Agent not found' });
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });
});

// ── Q8: maxValuePerTxUsd and allowedRecipients ─────────────────────────────

// ── §5-6: maxOutflowPerTxUsd ────────────────────────────────────────────────

describe('PATCH /v1/agents/:id/policy — maxOutflowPerTxUsd (§5-6)', () => {
  it('agent: setting it while NULL (not configured) is 403 loosening — the operator configures it', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(basePolicy({ maxOutflowPerTxUsd: null }));
    const app = await buildApp({ agentId: 'agent-1' });
    const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { maxOutflowPerTxUsd: '0.01' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: LOOSENING_ERROR, loosenedFields: ['maxOutflowPerTxUsd'] });
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('operator: sets it from NULL', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(basePolicy({ maxOutflowPerTxUsd: null }));
    const app = await buildApp({ isOperator: true });
    const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { maxOutflowPerTxUsd: '250' } });
    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({ maxOutflowPerTxUsd: '250' });
    await app.close();
  });

  it('agent: may lower an existing value or set it back to null; may not raise it', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(basePolicy({ maxOutflowPerTxUsd: '250' }));
    const app = await buildApp({ agentId: 'agent-1' });
    const lower = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { maxOutflowPerTxUsd: '100' } });
    expect(lower.statusCode).toBe(200);
    const block = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { maxOutflowPerTxUsd: null } });
    expect(block.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls.map((c: any[]) => c[0].update)).toEqual([{ maxOutflowPerTxUsd: '100' }, { maxOutflowPerTxUsd: null }]);
    const raise = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { maxOutflowPerTxUsd: '251' } });
    expect(raise.statusCode).toBe(403);
    expect(raise.json().loosenedFields).toEqual(['maxOutflowPerTxUsd']);
    await app.close();
  });

  it('a non-decimal value is 400 (never stored)', async () => {
    const app = await buildApp({ isOperator: true });
    for (const payload of [{ maxOutflowPerTxUsd: 'unlimited' }, { maxOutflowPerTxUsd: '' }, { maxOutflowPerTxUsd: 25 }]) {
      const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /v1/agents/:id/policy — Q8 fields', () => {
  it('agent: raising maxValuePerTxUsd or adding a recipient is 403; lowering / narrowing applies', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const loosen = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxUsd: '50', allowedRecipients: [PAYEE, OTHER_PAYEE] },
    });
    expect(loosen.statusCode).toBe(403);
    expect(loosen.json()).toEqual({ error: LOOSENING_ERROR, loosenedFields: ['maxValuePerTxUsd', 'allowedRecipients'] });

    const cleared = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { allowedRecipients: [] } });
    expect(cleared.statusCode).toBe(403);
    expect(cleared.json().loosenedFields).toEqual(['allowedRecipients']);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    const tighten = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxUsd: '0.25', allowedRecipients: [PAYEE] },
    });
    expect(tighten.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({ maxValuePerTxUsd: '0.25', allowedRecipients: [PAYEE] });

    await app.close();
  });

  it('agent: a non-decimal maxValuePerTxUsd is 400 (never stored), a non-address recipient is 400', async () => {
    const app = await buildApp({ agentId: 'agent-1' });
    for (const payload of [{ maxValuePerTxUsd: 'unlimited' }, { maxValuePerTxUsd: '' }, { allowedRecipients: ['payee'] }]) {
      const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('existing row: patching allowedContracts alone leaves allowedRecipients unchanged (not in the write)', async () => {
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { allowedContracts: [AAVE_POOL] } });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({ allowedContracts: [AAVE_POOL] });
    expect(res.json()).toMatchObject({ allowedContracts: [AAVE_POOL], allowedRecipients: [PAYEE], maxValuePerTxUsd: '1.0' });

    await app.close();
  });

  it('no row yet: a PATCH that creates it with allowedContracts but no allowedRecipients is 400 (creation rule)', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(null);
    for (const caller of [{ agentId: 'agent-1' }, { isOperator: true }]) {
      const app = await buildApp(caller);
      const res = await app.inject({ method: 'PATCH', url: '/v1/agents/agent-1/policy', payload: { allowedContracts: [UNISWAP_ROUTER] } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'Validation failed',
        details: [expect.objectContaining({ path: ['allowedRecipients'], message: expect.stringMatching(/allowedRecipients is required/) })],
      });
      await app.close();
    }
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    const app = await buildApp({ agentId: 'agent-1' });
    const ok = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { allowedContracts: [UNISWAP_ROUTER], allowedRecipients: [] },
    });
    expect(ok.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].create).toEqual({
      agentId: 'agent-1',
      allowedContracts: [UNISWAP_ROUTER],
      allowedRecipients: [],
    });
    await app.close();
  });

  it('syncOnChain (S8): no calldata any more — the answer points at the operator sync and lists the off-chain-only fields', async () => {
    // The contract table is built at module load; point the testnet policy module at a dummy address.
    const { CONTRACT_ADDRESSES } = await import('../config/contracts.js');
    const previous = CONTRACT_ADDRESSES[84532]!.policyModule;
    CONTRACT_ADDRESSES[84532]!.policyModule = '0x00000000000000000000000000000000000000Aa';
    mockDb.agent.findUniqueOrThrow.mockResolvedValue({ safeAddress: '0x1111111111111111111111111111111111111111', chainIds: [84532] });
    try {
      const app = await buildApp({ isOperator: true });
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/agents/agent-1/policy',
        payload: { maxValuePerTxUsd: '20', allowedRecipients: [PAYEE, OTHER_PAYEE], syncOnChain: true },
      });
      expect(res.statusCode).toBe(200);
      const sync = res.json().onChainSync;
      expect(sync.status).toBe('operator-sync-required');
      expect(sync.offChainOnlyFields).toEqual(['maxValuePerTxUsd', 'maxOutflowPerTxUsd', 'allowedRecipients', 'maxDailyVolumeUsd']);
      expect(sync.notice).toMatch(/enforced off-chain only\): maxValuePerTxUsd, maxOutflowPerTxUsd, allowedRecipients/);
      expect(sync.notice).toMatch(/POST \/admin\/agents\/:id\/policy\/sync/);
      // The old answer's `actions` told the caller to run module calls through
      // execute_batch, where the executor is msg.sender: they always reverted.
      expect(sync).not.toHaveProperty('actions');
      expect(JSON.stringify(sync)).not.toMatch(/0x[0-9a-f]{64,}/i);
      await app.close();
    } finally {
      CONTRACT_ADDRESSES[84532]!.policyModule = previous;
    }
  });
});

// ── Strict decimal validation (S1 bypass) ──────────────────────────────────

describe('PATCH /v1/agents/:id/policy — strict decimal limits', () => {
  // The original repro was `{"maxValuePerTxEth": ""}` from the agent's own
  // key: classified as tightening (Number("") === 0) and enforced as no
  // limit (parseFloat("") is NaN). None of these may ever be 200.
  const BAD_LIMITS = ['', '   ', '\n', '1e3', ' 5', '0x10', '5abc', 'unlimited'];

  it.each(BAD_LIMITS)('agent: maxValuePerTxEth %j → 400, nothing written', async (raw) => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: raw },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'Validation failed',
      details: [expect.objectContaining({ path: ['maxValuePerTxEth'] })],
    });
    expect(mockDb.agentPolicy.findUnique).not.toHaveBeenCalled();
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it.each(BAD_LIMITS)('operator: maxDailyVolumeUsd %j → 400 too (bad values never reach storage)', async (raw) => {
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxDailyVolumeUsd: raw },
    });

    expect(res.statusCode).toBe(400);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects a numeric (non-string) limit with 400', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: 0.5 },
    });

    expect(res.statusCode).toBe(400);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it.each(['0', '0.5', '1', '1.00'])('agent: accepts the plain decimal %j (tightens or neutral vs 1.0)', async (raw) => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: raw },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({ maxValuePerTxEth: raw });

    await app.close();
  });

  it('operator: accepts plain decimals for both limits, including the loosening "0" daily limit', async () => {
    const app = await buildApp({ isOperator: true });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '10000', maxDailyVolumeUsd: '0' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert.mock.calls[0][0].update).toEqual({
      maxValuePerTxEth: '10000',
      maxDailyVolumeUsd: '0',
    });

    await app.close();
  });

  it('with an unparsable value stored, the agent may still tighten to a real limit', async () => {
    mockDb.agentPolicy.findUnique.mockResolvedValue(basePolicy({ maxValuePerTxEth: '' }));
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.5' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

// ── Audit `reason` ─────────────────────────────────────────────────────────

describe('PATCH /v1/agents/:id/policy — reason', () => {
  it('accepts an optional reason and never stores it', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.5', reason: 'mission-scoped limit' },
    });

    expect(res.statusCode).toBe(200);
    const call = mockDb.agentPolicy.upsert.mock.calls[0][0];
    expect(Object.keys(call.update)).toEqual(['maxValuePerTxEth']);
    expect(Object.keys(call.create)).not.toContain('reason');
    expect(res.json()).not.toHaveProperty('reason');

    await app.close();
  });

  it('rejects a reason longer than 500 characters', async () => {
    const app = await buildApp({ agentId: 'agent-1' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      payload: { maxValuePerTxEth: '0.5', reason: 'x'.repeat(501) },
    });

    expect(res.statusCode).toBe(400);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });
});

// ── Auth middleware integration ────────────────────────────────────────────

describe('PATCH /v1/agents/:id/policy — through the auth middleware', () => {
  const operatorSecret = () => process.env['API_SECRET']!;

  it('accepts the operator API_SECRET and lets it loosen', async () => {
    const app = await buildAuthedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      headers: { 'x-api-key': operatorSecret() },
      payload: { maxValuePerTxEth: '5.0' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);
    // Operator auth never resolves an agent by key hash.
    expect(mockDb.agent.findUnique).not.toHaveBeenCalled();

    await app.close();
  });

  it('resolves an agent key and applies the tighten-only rule', async () => {
    const app = await buildAuthedApp();

    const loosen = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      headers: { 'x-api-key': AGENT_KEY },
      payload: { maxValuePerTxEth: '5.0' },
    });
    expect(loosen.statusCode).toBe(403);
    expect(loosen.json()).toEqual({ error: LOOSENING_ERROR, loosenedFields: ['maxValuePerTxEth'] });

    const tighten = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      headers: { 'x-api-key': AGENT_KEY },
      payload: { maxValuePerTxEth: '0.5' },
    });
    expect(tighten.statusCode).toBe(200);
    expect(mockDb.agentPolicy.upsert).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects a wrong secret on the policy route with 401', async () => {
    const app = await buildAuthedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/agent-1/policy',
      headers: { 'x-api-key': 'not-the-operator-secret-and-not-an-agent-key' },
      payload: { maxValuePerTxEth: '5.0' },
    });

    expect(res.statusCode).toBe(401);
    expect(mockDb.agentPolicy.upsert).not.toHaveBeenCalled();

    await app.close();
  });

  it('does not accept the operator API_SECRET on other agent routes', async () => {
    const app = await buildAuthedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/agent-1',
      headers: { 'x-api-key': operatorSecret() },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid API key format' });

    await app.close();
  });
});
