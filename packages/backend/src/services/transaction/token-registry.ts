import { getAddress } from 'viem';

export interface KnownToken {
  chainId: number;
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

const KNOWN_TOKENS: KnownToken[] = [
  // Ethereum mainnet
  { chainId: 1, symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { chainId: 1, symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  { chainId: 1, symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  { chainId: 1, symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },

  // Base
  { chainId: 8453, symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { chainId: 8453, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },

  // Base Sepolia
  { chainId: 84532, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },

  // Arbitrum One
  { chainId: 42161, symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  { chainId: 42161, symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  { chainId: 42161, symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },

  // Polygon
  { chainId: 137, symbol: 'USDC', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
  { chainId: 137, symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },

  // Kept for the legacy transaction decimals map. Optimism is not a supported
  // AgentFi chain today, but this address was already present before the
  // registry consolidation.
  { chainId: 10, symbol: 'WBTC', address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8 },
];

const TOKENS_BY_CHAIN_AND_SYMBOL = new Map<string, KnownToken>();
const TOKENS_BY_CHAIN_AND_ADDRESS = new Map<string, KnownToken>();

for (const token of KNOWN_TOKENS) {
  TOKENS_BY_CHAIN_AND_SYMBOL.set(
    `${token.chainId}:${token.symbol.toUpperCase()}`,
    token,
  );
  TOKENS_BY_CHAIN_AND_ADDRESS.set(
    `${token.chainId}:${token.address.toLowerCase()}`,
    token,
  );
}

export function isNativeTokenSymbol(token: string): boolean {
  return token.toUpperCase() === 'ETH';
}

export function getKnownTokenByAddress(
  tokenAddress: string,
  chainId: number,
): KnownToken | undefined {
  try {
    const checksummed = getAddress(tokenAddress);
    return TOKENS_BY_CHAIN_AND_ADDRESS.get(`${chainId}:${checksummed.toLowerCase()}`);
  } catch {
    return undefined;
  }
}

export function getKnownTokenBySymbol(
  symbol: string,
  chainId: number,
): KnownToken | undefined {
  return TOKENS_BY_CHAIN_AND_SYMBOL.get(`${chainId}:${symbol.toUpperCase()}`);
}

export function getKnownTokenDecimals(
  tokenAddress: string,
  chainId: number,
): number | undefined {
  return getKnownTokenByAddress(tokenAddress, chainId)?.decimals;
}

export function resolveKnownPricedToken(
  token: string,
  chainId: number,
): KnownToken | undefined {
  return getKnownTokenByAddress(token, chainId) ?? getKnownTokenBySymbol(token, chainId);
}
