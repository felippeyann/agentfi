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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  jobsAsProvider?: Array<{ reward: unknown }>;
  jobsAsRequester?: Array<{ reward: unknown }>;
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
