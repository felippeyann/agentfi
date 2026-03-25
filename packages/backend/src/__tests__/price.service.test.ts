/**
 * Unit tests — PriceService (weiToUsd)
 *
 * Uses vi.resetModules() + dynamic import per-test to reset the module-level
 * priceCache (60s TTL) between tests, avoiding cross-test contamination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

type WeiToUsd = (amountWei: bigint, chainId: number) => Promise<string>;

function mockCoinGeckoPrice(mockFetch: ReturnType<typeof vi.fn>, usdPrice: number) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ethereum: { usd: usdPrice }, 'matic-network': { usd: usdPrice } }),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('weiToUsd', () => {
  let weiToUsd: WeiToUsd;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset module registry so the priceCache Map starts fresh each test
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const mod = await import('../services/transaction/price.service.js');
    weiToUsd = mod.weiToUsd;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts 1 ETH at $2000 to "2000.000000"', async () => {
    mockCoinGeckoPrice(mockFetch, 2000);
    const oneEthInWei = 1_000_000_000_000_000_000n;
    const result = await weiToUsd(oneEthInWei, 1);
    expect(parseFloat(result)).toBeCloseTo(2000, 2);
  });

  it('converts 0.5 ETH at $3000 to "1500.000000"', async () => {
    mockCoinGeckoPrice(mockFetch, 3000);
    const halfEthInWei = 500_000_000_000_000_000n;
    const result = await weiToUsd(halfEthInWei, 1);
    expect(parseFloat(result)).toBeCloseTo(1500, 2);
  });

  it('returns "0.000000" for zero wei', async () => {
    mockCoinGeckoPrice(mockFetch, 2000);
    const result = await weiToUsd(0n, 1);
    expect(result).toBe('0.000000');
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
      vi.resetModules();
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      const mod = await import('../services/transaction/price.service.js');
      weiToUsd = mod.weiToUsd;

      mockCoinGeckoPrice(mockFetch, 1800);
      const result = await weiToUsd(oneEth, chainId);
      expect(parseFloat(result)).toBeGreaterThan(0);
    }
  });
});
