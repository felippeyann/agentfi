/**
 * Unit tests — PolicyService
 *
 * Validates off-chain policy checks:
 *  - no policy → allow
 *  - kill switch → block
 *  - maxValuePerTxEth
 *  - contract whitelist
 *  - token whitelist
 *  - daily volume limit
 *  - cooldown
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyService } from '../services/policy/policy.service.js';
import type { PrismaClient, AgentPolicy } from '@prisma/client';

// ── Fixtures ───────────────────────────────────────────────────────────────

const UNISWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function basePolicy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    id: 'policy-1',
    agentId: 'agent-1',
    active: true,
    maxValuePerTxEth: '1.0',
    maxValueForAutoApprovalEth: '0.1',
    cooldownSeconds: 0,
    allowedContracts: [],
    allowedTokens: [],
    maxDailyVolumeUsd: '0', // 0 = no daily limit
    expiresAt: null,
    pausedByOperatorAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockDb(policy: AgentPolicy | null = basePolicy()): PrismaClient {
  return {
    agentPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: policy ? 1 : 0 }),
    },
    dailyVolume: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // Atomic volume check uses raw SQL
    $queryRaw: vi.fn().mockResolvedValue([{ volumeUsd: '0' }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  } as unknown as PrismaClient;
}

// ── Admin pause / resume bookkeeping (A3b) ─────────────────────────────────
//
// `pausedByOperatorAt` records that the admin kill switch flipped an active
// policy, so that resume undoes exactly that flip and nothing else.

describe('PolicyService.pauseByOperator / resumeByOperator', () => {
  const NOW = new Date('2026-10-06T12:00:00Z');

  it('pauseByOperator deactivates only an active policy and stamps it', async () => {
    const db = makeMockDb();
    const svc = new PolicyService(db);

    await expect(svc.pauseByOperator('agent-1', NOW)).resolves.toBe(true);
    expect(db.agentPolicy.updateMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', active: true },
      data: { active: false, pausedByOperatorAt: NOW },
    });
  });

  it('pauseByOperator reports false when no active policy matched (already inactive / no row)', async () => {
    const db = makeMockDb(null);
    const svc = new PolicyService(db);

    await expect(svc.pauseByOperator('agent-1', NOW)).resolves.toBe(false);
  });

  it('resumeByOperator re-activates only a stamped inactive policy, clearing the stamp', async () => {
    const db = makeMockDb(basePolicy({ active: false, pausedByOperatorAt: NOW }));
    const svc = new PolicyService(db);

    await expect(svc.resumeByOperator('agent-1')).resolves.toBe('reactivated');
    expect(db.agentPolicy.updateMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', active: false, pausedByOperatorAt: { not: null } },
      data: { active: true, pausedByOperatorAt: null },
    });
    // The outcome came from the conditional write itself — no read needed.
    expect(db.agentPolicy.findUnique).not.toHaveBeenCalled();
  });

  it('resumeByOperator → left_inactive when the policy is inactive without a stamp', async () => {
    const db = makeMockDb(basePolicy({ active: false, pausedByOperatorAt: null }));
    (db.agentPolicy.updateMany as any).mockResolvedValue({ count: 0 });
    const svc = new PolicyService(db);

    await expect(svc.resumeByOperator('agent-1')).resolves.toBe('left_inactive');
  });

  it('resumeByOperator → already_active when the policy is active', async () => {
    const db = makeMockDb(basePolicy({ active: true }));
    (db.agentPolicy.updateMany as any).mockResolvedValue({ count: 0 });
    const svc = new PolicyService(db);

    await expect(svc.resumeByOperator('agent-1')).resolves.toBe('already_active');
  });

  it('resumeByOperator → no_policy when the agent has no policy row', async () => {
    const db = makeMockDb(null);
    const svc = new PolicyService(db);

    await expect(svc.resumeByOperator('agent-1')).resolves.toBe('no_policy');
  });

  it('emergencyPause (independent deactivation) clears the stamp', async () => {
    const db = makeMockDb();
    const svc = new PolicyService(db);

    await svc.emergencyPause('agent-1');
    expect(db.agentPolicy.updateMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-1' },
      data: { active: false, pausedByOperatorAt: null },
    });
  });

  it('setPolicy clears the stamp on an explicit `active` write, and only then', async () => {
    const db = makeMockDb();
    (db.agentPolicy.upsert as any).mockImplementation(async ({ update }: any) => basePolicy(update));
    const svc = new PolicyService(db);

    await svc.setPolicy('agent-1', { active: false });
    expect((db.agentPolicy.upsert as any).mock.calls[0][0]).toEqual({
      where: { agentId: 'agent-1' },
      create: { agentId: 'agent-1', active: false, pausedByOperatorAt: null },
      update: { active: false, pausedByOperatorAt: null },
    });

    await svc.setPolicy('agent-1', { maxValuePerTxEth: '0.5' });
    expect((db.agentPolicy.upsert as any).mock.calls[1][0]).toEqual({
      where: { agentId: 'agent-1' },
      create: { agentId: 'agent-1', maxValuePerTxEth: '0.5' },
      update: { maxValuePerTxEth: '0.5' },
    });
  });
});

// ── Core allow/block scenarios ─────────────────────────────────────────────

describe('PolicyService.validateTransaction', () => {
  it('allows when no policy is configured', async () => {
    const svc = new PolicyService(makeMockDb(null));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '100',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks when kill switch is active (active = false)', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ active: false })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/kill switch/i);
  });

  // ── maxValuePerTx ──────────────────────────────────────────────────────

  it('allows when value is exactly at the limit', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '1.0' })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '1.0',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks when value exceeds the limit', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '1.0' })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '1.001',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/exceeds policy limit/i);
  });

  // ── contract whitelist ─────────────────────────────────────────────────

  it('allows any contract when whitelist is empty', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ allowedContracts: [] })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: '0x1234567890123456789012345678901234567890',
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows whitelisted contract', async () => {
    const svc = new PolicyService(
      makeMockDb(basePolicy({ allowedContracts: [UNISWAP_ROUTER] })),
    );
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.5',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks non-whitelisted contract', async () => {
    const svc = new PolicyService(
      makeMockDb(basePolicy({ allowedContracts: [UNISWAP_ROUTER] })),
    );
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/whitelist/i);
  });

  it('normalizes checksummed vs lowercase contract addresses', async () => {
    const lower = UNISWAP_ROUTER.toLowerCase();
    const svc = new PolicyService(
      makeMockDb(basePolicy({ allowedContracts: [lower] })),
    );
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER, // checksummed
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(true);
  });

  // ── token whitelist ────────────────────────────────────────────────────

  it('allows when no token whitelist and token provided', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ allowedTokens: [] })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      tokenAddress: USDC,
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks token not in whitelist', async () => {
    const svc = new PolicyService(
      makeMockDb(basePolicy({ allowedTokens: [USDC] })),
    );
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      tokenAddress: WETH,
      valueEth: '0.1',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/token.*whitelist/i);
  });

  // ── daily volume limit ─────────────────────────────────────────────────

  it('allows when daily limit is 0 (no limit configured)', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '0' }));
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.5',
      valueUsd: '999999',
    });
    expect(result.allowed).toBe(true);
  });

  it('allows when projected volume stays under the daily limit', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '1000' }));
    // $queryRaw returns the post-upsert volume (existing 500 + incoming 400 = 900)
    (db as any).$queryRaw.mockResolvedValue([{ volumeUsd: '900' }]);
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '400', // 500 + 400 = 900 < 1000
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks when projected volume exceeds the daily limit', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '1000' }));
    // $queryRaw returns post-upsert volume (800 + 300 = 1100 > 1000)
    (db as any).$queryRaw.mockResolvedValue([{ volumeUsd: '1100' }]);
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '300', // 800 + 300 = 1100 > 1000
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily volume limit/i);
  });

  it('first tx of the day allowed when no DailyVolume row exists yet', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '500' }));
    // $queryRaw returns the newly inserted volume (0 + 200 = 200)
    (db as any).$queryRaw.mockResolvedValue([{ volumeUsd: '200' }]);
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '200', // 0 + 200 < 500
    });
    expect(result.allowed).toBe(true);
  });

  // ── cooldown ───────────────────────────────────────────────────────────

  it('allows when cooldown is 0 regardless of lastTxTimestamp', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ cooldownSeconds: 0 })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      lastTxTimestamp: Math.floor(Date.now() / 1000) - 1, // 1 second ago
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks during active cooldown', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ cooldownSeconds: 60 })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      lastTxTimestamp: Math.floor(Date.now() / 1000) - 10, // 10s ago, limit is 60s
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cooldown/i);
  });

  it('allows after cooldown has elapsed', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ cooldownSeconds: 60 })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      lastTxTimestamp: Math.floor(Date.now() / 1000) - 61, // 61s ago
    });
    expect(result.allowed).toBe(true);
  });

  it('allows when no lastTxTimestamp is provided even with cooldown', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ cooldownSeconds: 60 })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      // no lastTxTimestamp
    });
    expect(result.allowed).toBe(true);
  });
});

// ── Stored limit parsing (shared with the authority classifier) ────────────

describe('PolicyService.validateTransaction — stored limit parsing', () => {
  // Values the API edge rejects, but which could sit in a hand-edited row.
  // Both the classifier and the enforcer must read them the same way
  // (unlimited); the enforcer must never turn one into "0" (`parseFloat("0x10")`)
  // or compare against NaN.
  const UNPARSABLE = ['', '   ', '1e3', '0x10', '5abc', 'unlimited'];

  it.each(UNPARSABLE)(
    'maxValuePerTxEth %j is unlimited for enforcement — and loosening for the classifier',
    async (raw) => {
      const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: raw })));
      const result = await svc.validateTransaction({
        agentId: 'agent-1',
        targetContract: UNISWAP_ROUTER,
        valueEth: '0.5',
      });
      expect(result.allowed).toBe(true);

      // Same string, same parser: an agent could never have written it.
      const { classifyPolicyChange } = await import('../services/policy/policy-authority.js');
      expect(classifyPolicyChange(basePolicy(), { maxValuePerTxEth: raw }).tightens).toBe(false);
    },
  );

  it('"0x10" no longer blocks everything (parseFloat read it as 0)', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '0x10' })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.001',
    });
    expect(result.allowed).toBe(true);
  });

  it('a well-formed limit is still enforced exactly', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '0.5' })));
    const blocked = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.6',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/exceeds policy limit of 0.5 ETH/);

    const allowed = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.5',
    });
    expect(allowed.allowed).toBe(true);
  });

  it.each(UNPARSABLE)('maxDailyVolumeUsd %j means no daily limit (no reservation attempted)', async (raw) => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: raw }));
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '1000000',
    });
    expect(result.allowed).toBe(true);
    expect((db as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });

  it('an unparsable auto-approval threshold never requires approval (unchanged behaviour, shared parser)', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValueForAutoApprovalEth: '' })));
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.9',
    });
    expect(result).toEqual({ allowed: true, requiresApproval: false });
  });
});
