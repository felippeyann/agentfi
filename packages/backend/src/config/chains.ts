import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import { mainnet, base, arbitrum, polygon, baseSepolia } from 'viem/chains';

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
export const FALLBACK_RPC_URLS: Partial<Record<number, string>> = {
  1: process.env['INFURA_API_KEY']
    ? `https://mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`
    : undefined,
  8453: process.env['INFURA_API_KEY']
    ? `https://base-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`
    : undefined,
  42161: process.env['INFURA_API_KEY']
    ? `https://arbitrum-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`
    : undefined,
  137: process.env['INFURA_API_KEY']
    ? `https://polygon-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`
    : undefined,
};

/** Public (keyless) RPC fallbacks — used when Alchemy is unavailable or rate-limited. */
export const PUBLIC_RPC_URLS: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  137: 'https://polygon-rpc.com',
  84532: 'https://sepolia.base.org',
};

function isUsableRpcUrl(url: string | undefined): url is string {
  return Boolean(url && !url.includes('undefined') && !url.includes('null'));
}

/** Returns ordered RPC candidates for a chain: primary -> fallback -> public. */
export function getRpcCandidates(chainId: number): string[] {
  const unique = new Set<string>();

  const candidates = [
    RPC_URLS[chainId],
    FALLBACK_RPC_URLS[chainId],
    PUBLIC_RPC_URLS[chainId],
  ];

  for (const candidate of candidates) {
    if (isUsableRpcUrl(candidate)) unique.add(candidate);
  }

  const urls = Array.from(unique);
  if (urls.length === 0) {
    throw new Error(`No RPC URL candidates configured for chain ${chainId}`);
  }
  return urls;
}

/** Best-effort primary URL, used by SDKs that only accept one endpoint string. */
export function getPrimaryRpcUrl(chainId: number): string {
  return getRpcCandidates(chainId)[0]!;
}

/** Secondary URL if available (typically Infura or public fallback). */
export function getSecondaryRpcUrl(chainId: number): string | undefined {
  return getRpcCandidates(chainId)[1];
}

/**
 * Creates a viem PublicClient with transport-level fallback across providers.
 * This is preferred for read paths (getBalance/readContract/getReceipt).
 */
export function createChainPublicClient(chainId: number): PublicClient {
  const chain = getChain(chainId);
  const transports = getRpcCandidates(chainId).map((url) => http(url));

  return createPublicClient({
    chain,
    transport:
      transports.length === 1
        ? transports[0]!
        : fallback(transports),
  });
}

function isNetworkOrRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('etimedout')
  );
}

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
  const urls = getRpcCandidates(chainId);

  for (let index = 0; index < urls.length; index++) {
    const url = urls[index]!;
    try {
      return await fn(url);
    } catch (err) {
      const isLastCandidate = index === urls.length - 1;
      if (isLastCandidate || !isNetworkOrRateLimitError(err)) {
        throw err;
      }
    }
  }

  throw new Error(`RPC fallback exhausted for chain ${chainId}`);
}
