/**
 * Unit tests — FeeService
 *
 * Tests pure fee calculation logic and tx-limit checks.
 * Prisma is mocked to avoid a real database connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeeService, FEE_BPS, TX_LIMITS } from '../services/policy/fee.service.js';
import type { PrismaClient } from '@prisma/client';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockDb(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  return {
    agentBilling: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'billing-1' }),
      updateMany: vi.fn(),
    },
    feeEvent: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: {
      count: vi.fn().mockResolvedValue(0),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

// ── calculateFee ───────────────────────────────────────────────────────────

describe('FeeService.calculateFee', () => {
  let svc: FeeService;

  beforeEach(() => {
    process.env['OPERATOR_FEE_WALLET'] = '0x000000000000000000000000000000000000fEe1';
    svc = new FeeService(makeMockDb());
  });

  it('charges FREE tier at 30 bps', () => {
    const gross = 10_000n; // 10 000 wei
    const result = svc.calculateFee({ grossAmountWei: gross, tier: 'FREE' });
    expect(result.feeBps).toBe(30);
    expect(result.feeAmountWei).toBe(30n); // 10000 * 30 / 10000
    expect(result.netAmountWei).toBe(9970n);
  });

  it('charges PRO tier at 15 bps', () => {
    const gross = 10_000n;
    const result = svc.calculateFee({ grossAmountWei: gross, tier: 'PRO' });
    expect(result.feeBps).toBe(15);
    expect(result.feeAmountWei).toBe(15n);
    expect(result.netAmountWei).toBe(9985n);
  });

  it('charges ENTERPRISE tier at 5 bps', () => {
    const gross = 10_000n;
    const result = svc.calculateFee({ grossAmountWei: gross, tier: 'ENTERPRISE' });
    expect(result.feeBps).toBe(5);
    expect(result.feeAmountWei).toBe(5n);
    expect(result.netAmountWei).toBe(9995n);
  });

  it('fee + net = gross for all tiers', () => {
    const gross = 1_234_567_890n;
    for (const tier of ['FREE', 'PRO', 'ENTERPRISE'] as const) {
      const r = svc.calculateFee({ grossAmountWei: gross, tier });
      expect(r.feeAmountWei + r.netAmountWei).toBe(gross);
    }
  });

  it('returns the configured operator fee wallet address', () => {
    const r = svc.calculateFee({ grossAmountWei: 1n, tier: 'FREE' });
    expect(r.feeWallet).toBe('0x000000000000000000000000000000000000fEe1');
  });

  it('handles zero gross amount without throwing', () => {
    const r = svc.calculateFee({ grossAmountWei: 0n, tier: 'PRO' });
    expect(r.feeAmountWei).toBe(0n);
    expect(r.netAmountWei).toBe(0n);
  });

  it('throws if OPERATOR_FEE_WALLET env var is missing', () => {
    delete process.env['OPERATOR_FEE_WALLET'];
    expect(() => new FeeService(makeMockDb())).toThrow('OPERATOR_FEE_WALLET');
  });
});

// ── checkTxLimit ───────────────────────────────────────────────────────────

describe('FeeService.checkTxLimit', () => {
  beforeEach(() => {
    process.env['OPERATOR_FEE_WALLET'] = '0x000000000000000000000000000000000000fEe1';
  });

  it('ENTERPRISE tier always returns true (no limit)', async () => {
    const db = makeMockDb();
    const svc = new FeeService(db);
    const allowed = await svc.checkTxLimit('agent-1', 'ENTERPRISE');
    expect(allowed).toBe(true);
    // should not have queried the DB
    expect((db.agentBilling as any).findUnique).not.toHaveBeenCalled();
  });

  it('allows when count is below limit', async () => {
    const db = makeMockDb();
    (db.agentBilling as any).findUnique.mockResolvedValue({ txCountThisPeriod: 50 });
    const svc = new FeeService(db);
    expect(await svc.checkTxLimit('agent-1', 'FREE')).toBe(true); // 50 < 100
  });

  it('blocks when count equals limit', async () => {
    const db = makeMockDb();
    (db.agentBilling as any).findUnique.mockResolvedValue({
      txCountThisPeriod: TX_LIMITS.FREE, // 100
    });
    const svc = new FeeService(db);
    expect(await svc.checkTxLimit('agent-1', 'FREE')).toBe(false); // 100 >= 100
  });

  it('allows when billing record does not exist yet (new agent)', async () => {
    const db = makeMockDb();
    (db.agentBilling as any).findUnique.mockResolvedValue(null);
    const svc = new FeeService(db);
    expect(await svc.checkTxLimit('brand-new-agent', 'PRO')).toBe(true);
  });
});

// ── FEE_BPS constants ──────────────────────────────────────────────────────

describe('FEE_BPS constants', () => {
  it('FREE > PRO > ENTERPRISE (higher tier = lower fee)', () => {
    expect(FEE_BPS.FREE).toBeGreaterThan(FEE_BPS.PRO);
    expect(FEE_BPS.PRO).toBeGreaterThan(FEE_BPS.ENTERPRISE);
  });
});
