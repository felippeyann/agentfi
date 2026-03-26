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
    cooldownSeconds: 0,
    allowedContracts: [],
    allowedTokens: [],
    maxDailyVolumeUsd: '0', // 0 = no daily limit
    expiresAt: null,
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
    },
    dailyVolume: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaClient;
}

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
    (db.dailyVolume as any).findUnique.mockResolvedValue({ volumeUsd: '500' });
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
    (db.dailyVolume as any).findUnique.mockResolvedValue({ volumeUsd: '800' });
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
    (db.dailyVolume as any).findUnique.mockResolvedValue(null); // no row yet
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
