/**
 * Price Service — ETH/token price lookups via CoinGecko (free tier).
 * Used to convert wei fee amounts to USD for accounting.
 */

import { formatEther } from 'viem';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// Cache prices for 60 seconds to avoid rate-limiting
const priceCache = new Map<string, { price: number; ts: number }>();
const CACHE_TTL_MS = 60_000;

async function fetchPrice(coingeckoId: string): Promise<number> {
  const cached = priceCache.get(coingeckoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price;

  try {
    const res = await fetch(
      `${COINGECKO_BASE}/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
    );
    if (!res.ok) return 0;
    const data = (await res.json()) as Record<string, { usd: number }>;
    const price = data[coingeckoId]?.usd ?? 0;
    priceCache.set(coingeckoId, { price, ts: Date.now() });
    return price;
  } catch {
    return 0;
  }
}

const CHAIN_NATIVE_TOKEN: Record<number, string> = {
  1: 'ethereum',
  8453: 'ethereum',   // Base uses ETH
  42161: 'ethereum',  // Arbitrum uses ETH
  137: 'matic-network',
};

/** Clears the in-process price cache. Used in tests to avoid cross-test contamination. */
export function clearPriceCache(): void {
  priceCache.clear();
}

/**
 * Converts a wei amount (bigint) to a USD string.
 * Returns '0' if price lookup fails — fee accounting degrades gracefully.
 */
export async function weiToUsd(amountWei: bigint, chainId: number): Promise<string> {
  const tokenId = CHAIN_NATIVE_TOKEN[chainId] ?? 'ethereum';
  const price = await fetchPrice(tokenId);
  if (price === 0) return '0';

  const eth = parseFloat(formatEther(amountWei));
  return (eth * price).toFixed(6);
}
