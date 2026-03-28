/**
 * Unit tests — PriceService (weiToUsd)
 *
 * Uses clearPriceCache() between tests to reset the module-level
 * priceCache (60s TTL), avoiding cross-test contamination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { weiToUsd, clearPriceCache } from '../services/transaction/price.service.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

function mockCoinGeckoPrice(usdPrice: number) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      ethereum: { usd: usdPrice },
      'matic-network': { usd: usdPrice },
    }),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('weiToUsd', () => {
  beforeEach(() => {
    clearPriceCache();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts 1 ETH at $2000 to ~2000', async () => {
    mockCoinGeckoPrice(2000);
    const oneEthInWei = 1_000_000_000_000_000_000n;
    const result = await weiToUsd(oneEthInWei, 1);
    expect(parseFloat(result)).toBeCloseTo(2000, 2);
  });

  it('converts 0.5 ETH at $3000 to ~1500', async () => {
    mockCoinGeckoPrice(3000);
    const halfEthInWei = 500_000_000_000_000_000n;
    const result = await weiToUsd(halfEthInWei, 1);
    expect(parseFloat(result)).toBeCloseTo(1500, 2);
  });

  it('returns "0" for zero wei', async () => {
    mockCoinGeckoPrice(2000);
    const result = await weiToUsd(0n, 1);
    expect(result).toBe('0');
  });

  it('returns "0" when fetch fails (graceful fallback)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const result = await weiToUsd(1_000_000_000_000_000_000n, 1);
    expect(result).toBe('0');
  });

  it('returns "0" when CoinGecko returns non-ok status', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    const result = await weiToUsd(1_000_000_000_000_000_000n, 1);
    expect(result).toBe('0');
  });

  it('works for supported chains (Base = 8453, Arbitrum = 42161, Polygon = 137)', async () => {
    const oneEth = 1_000_000_000_000_000_000n;
    for (const chainId of [8453, 42161, 137]) {
      clearPriceCache();
      mockFetch.mockReset();
      mockCoinGeckoPrice(1800);
      const result = await weiToUsd(oneEth, chainId);
      expect(parseFloat(result)).toBeGreaterThan(0);
    }
  });

  it('caches price within TTL — only one fetch call for two conversions', async () => {
    mockCoinGeckoPrice(2500);
    await weiToUsd(1_000_000_000_000_000_000n, 1);
    await weiToUsd(500_000_000_000_000_000n, 1);
    // Both calls use the same ETH price — fetch should only be called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
