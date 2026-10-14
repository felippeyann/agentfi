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
    maxValuePerTxUsd: '1.0',
    maxOutflowPerTxUsd: null,
    maxValueForAutoApprovalEth: '0.1',
    cooldownSeconds: 0,
    allowedContracts: [],
    allowedRecipients: [],
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
    // x402 spend (pay-resource, P6) counts from its ledger rows.
    resourcePayment: {
      findMany: vi.fn().mockResolvedValue([]),
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

  // ── recipient whitelist (Q8) ───────────────────────────────────────────

  it('Q8: a recipient outside a non-empty allowedRecipients is refused; listed (any case) is allowed', async () => {
    const recipient = '0x00000000000000000000000000000000000000b0';
    const svc = new PolicyService(makeMockDb(basePolicy({ allowedRecipients: [recipient] })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: USDC, recipient: recipient.toUpperCase().replace('0X', '0x') as `0x${string}`, valueEth: '0' }),
    ).resolves.toMatchObject({ allowed: true });
    const refused = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: USDC,
      recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      valueEth: '0',
    });
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.reason).toMatch(/allowed recipients whitelist/);
  });

  it('Q8: a malformed stored recipient entry never throws — it just does not match', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ allowedRecipients: ['not-an-address'] })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: USDC, recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', valueEth: '0' }),
    ).resolves.toMatchObject({ allowed: false });
  });

  // §5-6 — maxOutflowPerTxUsd (replaces the Q8 seam USD_PER_TX_CAP_APPLIES_TO_TRANSACTIONS)

  const priced = (usd: string) => ({ status: 'priced' as const, usd, source: 'oracle' as const });

  it('§5-6: maxValuePerTxUsd (the USDC x402 / escrow cap) never caps an ordinary outflow', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxUsd: '0', maxValuePerTxEth: '10', maxOutflowPerTxUsd: '5000' })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '1', valueUsd: '2500', pricing: priced('2500.000000'), outflow: true }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('§5-6: an outflow with maxOutflowPerTxUsd NULL → USD_CAP_NOT_CONFIGURED with a diagnostic naming the field', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '10', maxOutflowPerTxUsd: null })));
    const result = await svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '1', pricing: priced('2000.000000'), outflow: true });
    expect(result).toMatchObject({ allowed: false, code: 'USD_CAP_NOT_CONFIGURED', rule: 'maxOutflowPerTxUsd' });
    expect(result.reason).toMatch(/maxOutflowPerTxUsd/);
    expect(result.reason).toMatch(/operator/);
  });

  it('§5-6: the cap compares the priced USD: equal passes, one micro-dollar above is refused (rule + limit)', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '10', maxOutflowPerTxUsd: '25' })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: priced('25.000000'), outflow: true }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: priced('25.000001'), outflow: true }),
    ).resolves.toMatchObject({ allowed: false, code: 'POLICY_VIOLATION', rule: 'maxOutflowPerTxUsd', limit: '25' });
  });

  it('§5-6: with the cap set, an unpriced outflow is refused (PRICE_UNAVAILABLE) even without a daily limit', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxValuePerTxEth: '10', maxDailyVolumeUsd: '0', maxOutflowPerTxUsd: '100' })));
    await expect(
      svc.validateTransaction({
        agentId: 'agent-1',
        targetContract: UNISWAP_ROUTER,
        valueEth: '0',
        pricing: { status: 'unpriced', reason: 'Token X has no trusted price source' },
        outflow: true,
      }),
    ).resolves.toMatchObject({ allowed: false, code: 'PRICE_UNAVAILABLE', rule: 'maxOutflowPerTxUsd' });
    // No pricing at all counts as unpriced.
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', outflow: true }),
    ).resolves.toMatchObject({ allowed: false, code: 'PRICE_UNAVAILABLE' });
  });

  it('§5-6: nothing flows out (pricing zero) → no cap, even when NULL', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxOutflowPerTxUsd: null })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: { status: 'zero' }, outflow: true }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('§5-6: what is not marked an outflow (a withdrawal, a GMX close) is never capped, even when NULL', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxOutflowPerTxUsd: null })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: priced('99999.000000') }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('§5-6: a non-decimal stored cap reads as unlimited (same reading as every limit and the classifier); no policy row = no restrictions', async () => {
    const svc = new PolicyService(makeMockDb(basePolicy({ maxOutflowPerTxUsd: 'unlimited' })));
    await expect(
      svc.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: priced('1000000.000000'), outflow: true }),
    ).resolves.toMatchObject({ allowed: true });
    const none = new PolicyService(makeMockDb(null));
    await expect(
      none.validateTransaction({ agentId: 'agent-1', targetContract: UNISWAP_ROUTER, valueEth: '0', pricing: priced('1000000.000000'), outflow: true }),
    ).resolves.toMatchObject({ allowed: true });
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
    // Committed today: 500 (read-only pre-check, A6); incoming 400 → 900
    (db as any).dailyVolume.findUnique.mockResolvedValue({ volumeUsd: '500' });
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
    // Committed today: 800; incoming 300 → 1100 > 1000
    (db as any).dailyVolume.findUnique.mockResolvedValue({ volumeUsd: '800' });
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
    // No DailyVolume row yet (findUnique → null): 0 + 200 < 500
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '200', // 0 + 200 < 500
    });
    expect(result.allowed).toBe(true);
  });

  it("counts today's x402 spend (pay-resource ledger rows) against the same daily limit (P6)", async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '500' }));
    // No DailyVolume yet. x402 today: 350 USDC.
    (db as any).resourcePayment.findMany.mockResolvedValue([{ amount: '300000000' }, { amount: '50000000' }]);
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '200', // 0 + 350 (x402) + 200 = 550 > 500
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Daily volume limit of 500 USD would be exceeded. Current: 350\.00, requested: 200\.00/);
    // The rows queried are the agent's counted ones reserved since midnight UTC.
    const where = (db as any).resourcePayment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ agentId: 'agent-1', reservedAt: { gte: expect.any(Date) } });
    expect(where.OR).toEqual(expect.arrayContaining([{ status: { in: ['reserved', 'pending', 'settled', 'unknown'] } }]));
    // A6: the pre-check writes nothing, so there is nothing to roll back.
    expect((db as any).$executeRaw).not.toHaveBeenCalled();
    expect((db as any).$queryRaw).not.toHaveBeenCalled();
  });

  it('A6: an allowed transaction reserves nothing here (the reservation is made with the row)', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '1000' }));
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '400',
    });
    expect(result.allowed).toBe(true);
    expect((db as any).$queryRaw).not.toHaveBeenCalled();
    expect((db as any).$executeRaw).not.toHaveBeenCalled();
    expect((db as any).dailyVolume.findUnique).toHaveBeenCalledWith({
      where: { agentId_date: { agentId: 'agent-1', date: new Date().toISOString().slice(0, 10) } },
      select: { volumeUsd: true },
    });
  });

  it('A6: dailyVolumeAccounted (legacy A2A payment, counted by its Job) skips the daily pre-check', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '100' }));
    (db as any).dailyVolume.findUnique.mockResolvedValue({ volumeUsd: '100' }); // the Job's own reservation
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0',
      valueUsd: '100',
      dailyVolumeAccounted: true,
    });
    expect(result.allowed).toBe(true);
    expect((db as any).dailyVolume.findUnique).not.toHaveBeenCalled();
  });

  it('A6: a cooldown refusal is decided before the daily volume is read', async () => {
    const db = makeMockDb(basePolicy({ maxDailyVolumeUsd: '1000', cooldownSeconds: 3600 }));
    const svc = new PolicyService(db);
    const result = await svc.validateTransaction({
      agentId: 'agent-1',
      targetContract: UNISWAP_ROUTER,
      valueEth: '0.1',
      valueUsd: '10',
      lastTxTimestamp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Cooldown/);
    expect((db as any).dailyVolume.findUnique).not.toHaveBeenCalled();
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
