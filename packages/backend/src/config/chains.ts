import { mainnet, base, arbitrum, polygon, baseSepolia } from 'viem/chains';
import type { Chain } from 'viem';

export const SUPPORTED_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
  84532: baseSepolia,
};

export const CHAIN_IDS = [1, 8453, 42161, 137, 84532] as const;
export type SupportedChainId = (typeof CHAIN_IDS)[number];

export function getChain(chainId: number): Chain {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}

export const RPC_URLS: Record<number, string> = {
  1: `https://eth-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  8453: `https://base-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  42161: `https://arb-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  137: `https://polygon-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
  84532: `https://base-sepolia.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY']}`,
};

/** Infura-based fallback (used when INFURA_API_KEY is set). */
export const FALLBACK_RPC_URLS: Record<number, string> = {
  1: `https://mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  8453: `https://base-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  42161: `https://arbitrum-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  137: `https://polygon-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
};

/** Public (keyless) RPC fallbacks — used when Alchemy is unavailable or rate-limited. */
export const PUBLIC_RPC_URLS: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  137: 'https://polygon-rpc.com',
  84532: 'https://sepolia.base.org',
};

/**
 * Returns an RPC URL for the given chain, falling back to a public endpoint
 * if the primary Alchemy call fails (network error or rate-limit HTTP 429).
 *
 * Usage:
 *   const url = await getRpcUrl(chainId, async (url) => {
 *     const client = createPublicClient({ transport: http(url) });
 *     return await client.someCall();
 *   });
 */
export async function withFallbackRpc<T>(
  chainId: number,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const primaryUrl = RPC_URLS[chainId];
  if (!primaryUrl) throw new Error(`No RPC URL for chain ${chainId}`);

  try {
    return await fn(primaryUrl);
  } catch (err) {
    const isNetworkOrRateLimit =
      err instanceof Error &&
      (err.message.includes('429') ||
        err.message.toLowerCase().includes('rate limit') ||
        err.message.toLowerCase().includes('network') ||
        err.message.toLowerCase().includes('fetch failed') ||
        err.message.toLowerCase().includes('econnrefused') ||
        err.message.toLowerCase().includes('etimedout'));

    if (!isNetworkOrRateLimit) throw err;

    const publicUrl = PUBLIC_RPC_URLS[chainId];
    if (!publicUrl) throw err; // no public fallback for this chain

    return await fn(publicUrl);
  }
}
