import { mainnet, base, arbitrum, polygon } from 'viem/chains';
import type { Chain } from 'viem';

export const SUPPORTED_CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
};

export const CHAIN_IDS = [1, 8453, 42161, 137] as const;
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
};

export const FALLBACK_RPC_URLS: Record<number, string> = {
  1: `https://mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  8453: `https://base-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  42161: `https://arbitrum-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
  137: `https://polygon-mainnet.infura.io/v3/${process.env['INFURA_API_KEY']}`,
};
