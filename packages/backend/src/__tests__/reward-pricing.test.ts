import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { resolveRewardUsd } from '../services/billing/reward-pricing.js';
import { clearPriceCache } from '../services/transaction/price.service.js';

const mockFetch = vi.fn();

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';

function stubPrices(prices: Record<string, number>): void {
  mockFetch.mockImplementation(async (input: string | URL | Request) => {
    const url = input.toString();

    if (url.includes('/simple/price')) {
      return {
        ok: true,
        json: async () => ({
          ethereum: { usd: prices.ethereum ?? 0 },
          'matic-network': { usd: prices['matic-network'] ?? 0 },
        }),
      };
    }

    if (url.includes('/simple/token_price/')) {
      const parsed = new URL(url);
      const requestedAddress =
        parsed.searchParams.get('contract_addresses')?.toLowerCase() ?? '';
      return {
        ok: true,
        json: async () => ({
          [requestedAddress]: { usd: prices[requestedAddress] ?? 0 },
        }),
      };
    }

    return { ok: false, json: async () => ({}) };
  });
}

describe('resolveRewardUsd', () => {
  beforeEach(() => {
    clearPriceCache();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prices native ETH rewards with 18 decimals', async () => {
    stubPrices({ ethereum: 2500 });

    const result = await resolveRewardUsd({
      amount: '0.01',
      token: 'ETH',
      chainId: 1,
    });

    expect(result.resolved).toBe(true);
    expect(parseFloat(result.usd)).toBeCloseTo(25, 6);
    expect(parseFloat(result.priceUsd)).toBeCloseTo(2500, 6);
  });

  it('prices known USDC rewards with the chain-local 6 decimal registry entry', async () => {
    stubPrices({ [getAddress(BASE_USDC).toLowerCase()]: 1 });

    const result = await resolveRewardUsd({
      amount: '12.34',
      token: 'USDC',
      chainId: 8453,
    });

    expect(result.resolved).toBe(true);
    expect(parseFloat(result.usd)).toBeCloseTo(12.34, 6);
    expect(parseFloat(result.priceUsd)).toBeCloseTo(1, 6);
  });

  it('prices known WETH address rewards without the old 6-decimal precision cap', async () => {
    stubPrices({ [getAddress(BASE_WETH).toLowerCase()]: 2000 });

    const result = await resolveRewardUsd({
      amount: '0.0000001',
      token: BASE_WETH,
      chainId: 8453,
    });

    expect(result.resolved).toBe(true);
    expect(parseFloat(result.usd)).toBeCloseTo(0.0002, 6);
    expect(parseFloat(result.priceUsd)).toBeCloseTo(2000, 6);
  });

  it('does not guess decimals for unknown non-native reward tokens', async () => {
    stubPrices({
      '0x1111111111111111111111111111111111111111': 1,
    });

    const result = await resolveRewardUsd({
      amount: '10',
      token: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
    });

    expect(result).toEqual({
      usd: '0',
      priceUsd: '0',
      resolved: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
