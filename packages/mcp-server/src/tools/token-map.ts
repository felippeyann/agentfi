type ChainTokenMap = Record<string, string>;

const TOKENS_BY_CHAIN: Record<number, ChainTokenMap> = {
  1: {
    ETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  8453: {
    ETH: '0x4200000000000000000000000000000000000006',
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  42161: {
    ETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x2f2a2543B76A4166549F7aAB2e75Bef0aefC5B0f',
  },
  137: {
    ETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDT: '0xc2132D05D31c914a87C6611C10748AaCbA3E5E91',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  },
};

function normalizeToken(token: string): string {
  return token.trim().toUpperCase();
}

export function resolveSwapToken(token: string, chainId: number): string {
  if (token.startsWith('0x')) return token;
  const symbol = normalizeToken(token);
  const byChain = TOKENS_BY_CHAIN[chainId] ?? {};
  const resolved = byChain[symbol];
  if (!resolved) {
    throw new Error(`Unsupported token symbol ${token} on chain ${chainId}. Use a token contract address.`);
  }
  return resolved;
}

export function resolveTransferToken(token: string, chainId: number): string {
  if (token.toUpperCase() === 'ETH') return 'ETH';
  return resolveSwapToken(token, chainId);
}

export function resolveAssetToken(token: string, chainId: number): string {
  return resolveSwapToken(token, chainId);
}
