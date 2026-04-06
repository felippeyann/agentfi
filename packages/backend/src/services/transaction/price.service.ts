/**
 * Price Service — ETH/token price lookups via CoinGecko (free tier).
 * Used to convert wei fee amounts to USD for accounting.
 */

import { formatEther, formatUnits, getAddress } from 'viem';

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
    if (!res.ok) {
      console.warn(`[price-service] CoinGecko returned ${res.status} for ${coingeckoId}`);
      return 0;
    }
    const data = (await res.json()) as Record<string, { usd: number }>;
    const price = data[coingeckoId]?.usd ?? 0;
    priceCache.set(coingeckoId, { price, ts: Date.now() });
    return price;
  } catch (err) {
    console.warn(`[price-service] CoinGecko fetch failed for ${coingeckoId}:`, err instanceof Error ? err.message : err);
    return 0;
  }
}

// CoinGecko platform IDs for token price lookup by contract address
const CHAIN_PLATFORM: Record<number, string> = {
  1:     'ethereum',
  8453:  'base',
  42161: 'arbitrum-one',
  137:   'polygon-pos',
};

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

  if (amountWei === 0n) return '0';
  const eth = parseFloat(formatEther(amountWei));
  return (eth * price).toFixed(6);
}

/**
 * Converts an ERC-20 token amount to a USD string.
 * Uses CoinGecko token price endpoint keyed by contract address.
 * Returns '0' if price lookup fails — caller treats it as unchecked (graceful degradation).
 */
export async function tokenAmountToUsd(
  amountWei: bigint,
  tokenAddress: string,
  decimals: number,
  chainId: number,
): Promise<string> {
  if (amountWei === 0n) return '0';

  const platform = CHAIN_PLATFORM[chainId];
  if (!platform) return '0';

  const checksummed = getAddress(tokenAddress).toLowerCase();
  const cacheKey = `token:${platform}:${checksummed}`;
  const cached = priceCache.get(cacheKey);
  let price: number;

  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    price = cached.price;
  } else {
    try {
      const res = await fetch(
        `${COINGECKO_BASE}/simple/token_price/${platform}?contract_addresses=${checksummed}&vs_currencies=usd`,
      );
      if (!res.ok) {
        console.warn(`[price-service] CoinGecko token price returned ${res.status} for ${checksummed} on ${platform}`);
        return '0';
      }
      const data = (await res.json()) as Record<string, { usd?: number }>;
      price = data[checksummed]?.usd ?? 0;
      priceCache.set(cacheKey, { price, ts: Date.now() });
    } catch (err) {
      console.warn(`[price-service] CoinGecko token price fetch failed for ${checksummed}:`, err instanceof Error ? err.message : err);
      return '0';
    }
  }

  if (price === 0) return '0';
  const amount = parseFloat(formatUnits(amountWei, decimals));
  return (amount * price).toFixed(6);
}
