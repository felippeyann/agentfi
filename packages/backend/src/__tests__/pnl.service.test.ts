/**
 * Unit tests — PnLService
 *
 * Validates profit & loss computation:
 *  - earnings from A2A jobs as provider
 *  - costs: protocol fees + A2A rewards paid + gas (v2)
 *  - gas cost computed from gasUsed * effectiveGasPriceWei per CONFIRMED/REVERTED tx
 *  - rows with missing gasUsed/effectiveGasPriceWei are skipped with a note
 *
 * Prisma is mocked; CoinGecko is stubbed via `fetch` at ETH=$2000.
 */
import { vi } from 'vitest';

// config/env.ts calls process.exit() on missing required env vars at module
// load time. Hoisted-stub the ones the logger import chain transitively
// requires so this test runs cleanly outside CI.
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PnLService } from '../services/billing/pnl.service.js';
import { clearPriceCache } from '../services/transaction/price.service.js';
import type { PrismaClient } from '@prisma/client';

const ETH_USD = 2000;
const mockFetch = vi.fn();

function stubPrice() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      ethereum: { usd: ETH_USD },
      'matic-network': { usd: ETH_USD },
    }),
  });
}

interface MockOpts {
  jobsAsProvider?: Array<{ reward: unknown; rewardUsd?: string | null }>;
  jobsAsRequester?: Array<{ reward: unknown; rewardUsd?: string | null }>;
  feeEvents?: Array<{ feeUsd: string }>;
  transactions?: Array<{
    chainId: number;
    gasUsed: string | null;
    effectiveGasPriceWei: string | null;
  }>;
}

function makeMockDb(opts: MockOpts = {}): PrismaClient {
  return {
    agent: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'agent-1',
        name: 'Test Agent',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    },
    job: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { providerId?: string; requesterId?: string } }) => {
        if (where.providerId) return Promise.resolve(opts.jobsAsProvider ?? []);
        if (where.requesterId) return Promise.resolve(opts.jobsAsRequester ?? []);
        return Promise.resolve([]);
      }),
    },
    feeEvent: {
      findMany: vi.fn().mockResolvedValue(opts.feeEvents ?? []),
    },
    transaction: {
      findMany: vi.fn().mockResolvedValue(opts.transactions ?? []),
    },
  } as unknown as PrismaClient;
}

describe('PnLService.computeAgentPnL', () => {
  beforeEach(() => {
    clearPriceCache();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    stubPrice();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns zero P&L for an agent with no activity', async () => {
    const svc = new PnLService(makeMockDb());
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(result.agentId).toBe('agent-1');
    expect(result.earnings.totalEarningsUsd).toBe('0.000000');
    expect(result.costs.totalCostsUsd).toBe('0.000000');
    expect(result.costs.gas.count).toBe(0);
    expect(result.costs.gas.usd).toBe('0.000000');
    expect(result.netPnlUsd).toBe('0.000000');
    expect(result.breakEven).toBe(true);
    expect(result.profitable).toBe(false);
  });

  it('counts gas cost from gasUsed * effectiveGasPriceWei for a CONFIRMED tx', async () => {
    // gasUsed=100_000, effectiveGasPrice=30 gwei → 3e15 wei → 0.003 ETH → $6 at $2000/ETH
    const db = makeMockDb({
      transactions: [
        {
          chainId: 1,
          gasUsed: '100000',
          effectiveGasPriceWei: '30000000000', // 30 gwei
        },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(result.costs.gas.count).toBe(1);
    expect(parseFloat(result.costs.gas.usd)).toBeCloseTo(6, 2);
    expect(parseFloat(result.costs.totalCostsUsd)).toBeCloseTo(6, 2);
    expect(parseFloat(result.netPnlUsd)).toBeCloseTo(-6, 2);
    expect(result.profitable).toBe(false);
  });

  it('counts gas for REVERTED tx too (gas still burns)', async () => {
    const db = makeMockDb({
      transactions: [
        {
          chainId: 1,
          gasUsed: '50000',
          effectiveGasPriceWei: '20000000000', // 20 gwei → 0.001 ETH → $2
        },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(result.costs.gas.count).toBe(1);
    expect(parseFloat(result.costs.gas.usd)).toBeCloseTo(2, 2);
  });

  it('skips txs missing gasUsed or effectiveGasPriceWei and adds a note', async () => {
    const db = makeMockDb({
      transactions: [
        { chainId: 1, gasUsed: null, effectiveGasPriceWei: '20000000000' },
        { chainId: 1, gasUsed: '50000', effectiveGasPriceWei: null },
        { chainId: 1, gasUsed: '100000', effectiveGasPriceWei: '30000000000' },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(result.costs.gas.count).toBe(1);
    expect(parseFloat(result.costs.gas.usd)).toBeCloseTo(6, 2);
    expect(result.notes.some((n) => n.includes('2 tx(s) skipped'))).toBe(true);
  });

  it('sums all cost categories into totalCostsUsd', async () => {
    const db = makeMockDb({
      feeEvents: [{ feeUsd: '1.50' }, { feeUsd: '2.50' }],
      jobsAsRequester: [
        { reward: { amount: '0.01', token: 'ETH', chainId: 1 } }, // $20
      ],
      transactions: [
        { chainId: 1, gasUsed: '100000', effectiveGasPriceWei: '30000000000' }, // $6
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.costs.protocolFees.usd)).toBeCloseTo(4, 2);
    expect(parseFloat(result.costs.a2aJobsAsRequester.usd)).toBeCloseTo(20, 2);
    expect(parseFloat(result.costs.gas.usd)).toBeCloseTo(6, 2);
    expect(parseFloat(result.costs.totalCostsUsd)).toBeCloseTo(30, 2);
  });

  it('marks profitable=true when earnings exceed costs', async () => {
    const db = makeMockDb({
      jobsAsProvider: [
        { reward: { amount: '0.05', token: 'ETH', chainId: 1 } }, // $100
      ],
      transactions: [
        { chainId: 1, gasUsed: '100000', effectiveGasPriceWei: '30000000000' }, // $6
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.earnings.totalEarningsUsd)).toBeCloseTo(100, 2);
    expect(parseFloat(result.netPnlUsd)).toBeCloseTo(94, 2);
    expect(result.profitable).toBe(true);
    expect(result.breakEven).toBe(true);
  });

  it('handles invalid gasUsed/effectiveGasPriceWei without throwing', async () => {
    const db = makeMockDb({
      transactions: [
        { chainId: 1, gasUsed: 'not-a-number', effectiveGasPriceWei: '30000000000' },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    // BigInt('not-a-number') throws → caught → counted as missing
    expect(result.costs.gas.count).toBe(0);
    expect(result.notes.some((n) => n.includes('skipped'))).toBe(true);
  });

  // --- Phase 2/3 of #71 — revenue snapshot priority + unresolved warnings ---

  it('uses persisted rewardUsd snapshot instead of live oracle for earnings', async () => {
    // Stub the live oracle to a wildly different price so we can prove the
    // snapshot was actually consulted (and that we did NOT silently fall
    // through to live pricing).
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 9999 } }),
    });

    const db = makeMockDb({
      jobsAsProvider: [
        // Live price would say $99.99; snapshot locks it at $42.
        { reward: { amount: '0.01', token: 'ETH', chainId: 1 }, rewardUsd: '42.000000' },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.earnings.totalEarningsUsd)).toBeCloseTo(42, 2);
    // No "priced live" note because the snapshot was used.
    expect(result.notes.some((n) => n.includes('priced live'))).toBe(false);
  });

  it('falls back to live pricing for COMPLETED rows with no snapshot AND adds a note', async () => {
    const db = makeMockDb({
      jobsAsProvider: [
        // No rewardUsd → live fallback. ETH_USD=2000, 0.01 ETH = $20.
        { reward: { amount: '0.01', token: 'ETH', chainId: 1 }, rewardUsd: null },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.earnings.totalEarningsUsd)).toBeCloseTo(20, 2);
    expect(
      result.notes.some(
        (n) => n.includes('1 earning job') && n.includes('priced live'),
      ),
    ).toBe(true);
    // Live fallback resolved successfully → no "unresolved" tail in the note.
    expect(result.notes.some((n) => n.includes('unresolved'))).toBe(false);
  });

  it('flags unresolved snapshots so $0 rows are visible to operators (no silent zero)', async () => {
    // Live oracle returns 0 → the historical-zero bug from #71. PnLService
    // must keep the row counted as $0 (graceful degradation) BUT surface a
    // warning naming the unresolved count, so the dashboard can flag it.
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 0 } }),
    });

    const db = makeMockDb({
      jobsAsProvider: [
        { reward: { amount: '0.01', token: 'ETH', chainId: 1 }, rewardUsd: null },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.earnings.totalEarningsUsd)).toBeCloseTo(0, 2);
    expect(
      result.notes.some(
        (n) =>
          n.includes('1 earning job') &&
          n.includes('1 unresolved') &&
          n.includes('understate true revenue'),
      ),
    ).toBe(true);
  });

  it('mixes snapshot and live-fallback rows in the same call', async () => {
    const db = makeMockDb({
      jobsAsProvider: [
        // Snapshot: locked at $50 regardless of live price.
        { reward: { amount: '0.025', token: 'ETH', chainId: 1 }, rewardUsd: '50.000000' },
        // Live fallback: 0.01 ETH @ $2000 = $20.
        { reward: { amount: '0.01', token: 'ETH', chainId: 1 }, rewardUsd: null },
      ],
    });
    const svc = new PnLService(db);
    const result = await svc.computeAgentPnL({ agentId: 'agent-1' });

    expect(parseFloat(result.earnings.totalEarningsUsd)).toBeCloseTo(70, 2);
    expect(result.notes.some((n) => n.includes('1 earning job'))).toBe(true);
  });

  it('throws when agent does not exist', async () => {
    const db = {
      agent: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const svc = new PnLService(db);

    await expect(svc.computeAgentPnL({ agentId: 'missing' })).rejects.toThrow(
      /not found/,
    );
  });
});
