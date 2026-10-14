type ChainTokenMap = Record<string, string>;

/**
 * The MCP server's token registry: symbol → ERC-20 contract per chain. `ETH`
 * is the WETH alias the swap / Aave tools need; `pay_agent` and
 * `transfer_token` read `ETH` as native ETH instead, and refuse it where the
 * native asset is not ETH (`nativeEthRefusal`). Every symbol the
 * backend's registry (`packages/backend/src/services/transaction/
 * token-registry.ts`) also knows must resolve to the same address
 * (`packages/backend/src/__tests__/mcp.token-map.sync.test.ts`).
 */
const TOKENS_BY_CHAIN: Readonly<Record<number, Readonly<ChainTokenMap>>> = {
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
  // Base Sepolia — the backend registry's entries (USDC = Circle's testnet
  // deployment, the ERC-8183 escrow token).
  84532: {
    ETH: '0x4200000000000000000000000000000000000006',
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  42161: {
    ETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    // Was mis-cased (…7aAB2e…, invalid EIP-55 checksum). Same address as
    // aave-dao/aave-address-book@6463b76 src/AaveV3Arbitrum.sol WBTC_UNDERLYING;
    // on-chain (2026-10-14): symbol WBTC, 8 decimals.
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },
  137: {
    ETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    // Was 0xc2132D05…10748AaCbA3E5E91 — a wrong tail (invalid EIP-55, no code on
    // Polygon). aave-dao/aave-address-book@6463b76 src/AaveV3Polygon.sol
    // USDT0_UNDERLYING; on-chain (2026-10-14): symbol USDT0, 6 decimals.
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  },
};

function normalizeToken(token: string): string {
  return token.trim().toUpperCase();
}

/**
 * Chains whose native asset is ETH. The transfer route reads token `"ETH"`
 * as the chain's NATIVE asset, so native `"ETH"` is only meaningful here:
 * on Polygon (137) the native asset is POL — a transfer asked for in ETH
 * would send POL (review of #181). Any chain not listed is refused too: its
 * native asset is not known to this server.
 */
const NATIVE_ETH_CHAIN_IDS: ReadonlySet<number> = new Set([1, 8453, 84532, 42161]);

/** Native asset of the chains this server knows whose native asset is not ETH. */
const NON_ETH_NATIVE_ASSETS: Readonly<Record<number, string>> = { 137: 'POL' };

/** True when `token` is the native-ETH literal (`"ETH"`, any case, surrounding spaces ignored). */
export function isNativeEthLiteral(token: string): boolean {
  return normalizeToken(token) === 'ETH';
}

/**
 * Why native `"ETH"` is refused on `chainId`, or undefined where the native
 * asset is ETH. The message names the chain's native asset when known and
 * the ERC-20 alternative (the chain's WETH) when the registry has one.
 */
export function nativeEthRefusal(chainId: number): string | undefined {
  if (NATIVE_ETH_CHAIN_IDS.has(chainId)) return undefined;
  const native = NON_ETH_NATIVE_ASSETS[chainId];
  const weth = TOKENS_BY_CHAIN[chainId]?.['WETH'];
  return (
    `"ETH" means the chain's native asset, and the native asset of chain ${chainId} is ` +
    `${native ?? 'not known to be ETH'}${native ? ', not ETH: the transfer would send ' + native : ''}. ` +
    `Native "ETH" is accepted on chains ${[...NATIVE_ETH_CHAIN_IDS].join(', ')} only.` +
    (weth ? ` To move ETH on chain ${chainId}, use WETH (the ERC-20 ${weth}).` : '')
  );
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

/**
 * A `transfer_token` token: `"ETH"` (native — only where the native asset is
 * ETH; the tool reports `nativeEthRefusal` as INVALID_INPUT first, this throw
 * is the backstop), a symbol of the chain's registry, or an address as given.
 */
export function resolveTransferToken(token: string, chainId: number): string {
  if (isNativeEthLiteral(token)) {
    const refusal = nativeEthRefusal(chainId);
    if (refusal) throw new Error(refusal);
    return 'ETH';
  }
  return resolveSwapToken(token, chainId);
}

export function resolveAssetToken(token: string, chainId: number): string {
  return resolveSwapToken(token, chainId);
}

/**
 * A payment token as `POST /v1/transactions/transfer` takes it, from a symbol
 * only: `"ETH"` (native, only on a chain whose native asset is ETH — see
 * `nativeEthRefusal`) or the registry's contract address for the symbol on
 * that chain. Undefined for anything else — an unknown symbol, a symbol of
 * another chain, an address, `"ETH"` on Polygon — so the caller refuses
 * instead of guessing (never the registry's `ETH` → WETH swap alias).
 */
export function resolvePaymentToken(symbol: string, chainId: number): string | undefined {
  const normalized = normalizeToken(symbol);
  if (normalized === 'ETH') return nativeEthRefusal(chainId) === undefined ? 'ETH' : undefined;
  const byChain = TOKENS_BY_CHAIN[chainId];
  return byChain && Object.hasOwn(byChain, normalized) ? byChain[normalized] : undefined;
}

/** The symbols `resolvePaymentToken` accepts on `chainId`, sorted (ETH only where it is the native asset). */
export function paymentTokenSymbols(chainId: number): string[] {
  const erc20 = Object.keys(TOKENS_BY_CHAIN[chainId] ?? {}).filter((symbol) => symbol !== 'ETH');
  return [...new Set([...(nativeEthRefusal(chainId) === undefined ? ['ETH'] : []), ...erc20])].sort();
}

/** Every (chain, symbol, address) entry, for the registry consistency test. */
export function tokenRegistryEntries(): Array<{ chainId: number; symbol: string; address: string }> {
  return Object.entries(TOKENS_BY_CHAIN).flatMap(([chainId, tokens]) =>
    Object.entries(tokens).map(([symbol, address]) => ({ chainId: Number(chainId), symbol, address })),
  );
}
