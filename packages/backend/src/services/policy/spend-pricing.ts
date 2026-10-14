/**
 * Spend pricing (Q9) — the USD value of a spend for policy and daily-volume
 * accounting. Every policy / accounting path prices through here; fees, P&L
 * and revenue keep `price.service.ts` and NEVER see a synthetic price.
 *
 * The old price service answers the string "0" both for "the amount is 0"
 * and for "no price" (oracle down, unknown token, unsupported chain), and its
 * native price defaulted to the MAINNET ETH price on any chain it did not
 * map — Base Sepolia included. A spend nobody could price therefore counted
 * as 0 against the daily limit. This module answers a discriminated result:
 *
 *   { status: 'priced', usd, source }   source: 'oracle' (mainnet chains),
 *                                       'synthetic' (testnet, configured),
 *                                       'usdc-peg' (USDC at exactly 1.00 —
 *                                       escrow / x402, set by their callers)
 *   { status: 'zero' }                  the amount is 0
 *   { status: 'unpriced', reason }      no trusted price
 *
 * Where a price may come from:
 *   - a testnet chain (`TESTNET_CHAIN_IDS`, config/chains.ts): ONLY an
 *     explicitly configured synthetic price (`SYNTHETIC_TEST_PRICES_USD`,
 *     config/synthetic-prices.ts). No oracle, no mainnet proxy. Anything not
 *     configured is unpriced. In production / staging synthetic prices are
 *     never read (boot refuses the variable there anyway);
 *   - a mainnet chain (`MAINNET_CHAIN_IDS`): ONLY the oracle; a failed or
 *     zero price is unpriced. The synthetic table is never consulted;
 *   - any other chain: unpriced.
 *
 * The rule built on it (`PolicyService.validateTransaction`,
 * `createTransactionWithVolume`, `reserveJobEscrow`): while the agent's policy
 * has a daily limit, a spend with an unpriced component is refused (503
 * PRICE_UNAVAILABLE) before anything is simulated or reserved. Without a
 * daily limit nothing changes (nothing to count).
 *
 * USD strings have 6 decimals. A synthetic value is rounded UP to the micro
 * dollar (spent money is never under-counted); oracle values keep
 * `price.service.ts`'s `toFixed(6)`.
 */
import { formatUnits } from 'viem';
import { logger } from '../../api/middleware/logger.js';
import { isMainnetChain, isTestnetChain, TESTNET_CHAIN_IDS } from '../../config/chains.js';
import { isProductionLikeEnv } from '../../config/runtime-env.js';
import {
  NATIVE_ASSET,
  SYNTHETIC_PRICES_ENV,
  parseSyntheticTestPrices,
  syntheticPriceKey,
  type SyntheticPriceTable,
} from '../../config/synthetic-prices.js';
import { tokenAmountToUsd, weiToUsd } from '../transaction/price.service.js';

export type SpendPriceSource = 'oracle' | 'synthetic' | 'usdc-peg';

export type SpendPricing =
  | { status: 'priced'; usd: string; source: SpendPriceSource }
  | { status: 'zero' }
  | { status: 'unpriced'; reason: string };

export const SPEND_PRICE_SOURCES: readonly SpendPriceSource[] = ['oracle', 'synthetic', 'usdc-peg'];

const ZERO: SpendPricing = { status: 'zero' };
const EMPTY_TABLE: SyntheticPriceTable = new Map();

let cached: { raw: string | undefined; table: SyntheticPriceTable } | null = null;

/**
 * The synthetic table in force: empty in production / staging, and empty when
 * the variable is malformed (boot refuses a malformed value; this is the
 * belt to that). Read on every call so tests and a process that changes the
 * variable see the current value; parsed once per distinct value.
 */
export function syntheticTestPrices(source: Readonly<Record<string, string | undefined>> = process.env): SyntheticPriceTable {
  if (isProductionLikeEnv(source['NODE_ENV'] ?? 'development')) return EMPTY_TABLE;
  const raw = source[SYNTHETIC_PRICES_ENV];
  if (cached && cached.raw === raw) return cached.table;
  const parsed = parseSyntheticTestPrices(raw, TESTNET_CHAIN_IDS);
  const table = parsed.ok ? parsed.prices : EMPTY_TABLE;
  cached = { raw, table };
  return table;
}

/** amount (base units) × price (USD per whole unit, plain decimal) → USD with 6 decimals, rounded UP. */
export function syntheticUsd(amount: bigint, decimals: number, price: string): string {
  const [whole = '0', fraction = ''] = price.split('.');
  const priceScaled = BigInt(whole + fraction);
  const denominator = 10n ** BigInt(decimals + fraction.length);
  const numerator = amount * priceScaled * 1_000_000n;
  const micro = (numerator + denominator - 1n) / denominator;
  return formatMicro6(micro);
}

function formatMicro6(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

/** "12.345678" (≤ 6 decimals, as produced here and by price.service) → micro-USD, rounded up beyond 6 decimals. */
function usdToMicro(usd: string): bigint {
  const [whole = '0', fraction = ''] = usd.split('.');
  let micro = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6));
  if (/[1-9]/.test(fraction.slice(6))) micro += 1n;
  return micro;
}

function synthetic(chainId: number, asset: string, amount: bigint, decimals: number, label: string): SpendPricing {
  const price = syntheticTestPrices().get(syntheticPriceKey(chainId, asset));
  if (price === undefined) {
    return {
      status: 'unpriced',
      reason:
        `${label} on testnet chain ${chainId} has no configured synthetic test price ` +
        `(${SYNTHETIC_PRICES_ENV}, key ${syntheticPriceKey(chainId, asset)}); testnet assets are never priced by an oracle`,
    };
  }
  const usd = syntheticUsd(amount, decimals, price);
  logger.info({ chainId, asset, amount: amount.toString(), priceUsd: price, usd }, 'Spend priced at a SYNTHETIC test price (testnet only, not a market price)');
  return { status: 'priced', usd, source: 'synthetic' };
}

function noSource(chainId: number, label: string): SpendPricing {
  return { status: 'unpriced', reason: `${label} on chain ${chainId} has no trusted price source` };
}

/** USD value of `amountWei` of the chain's native asset. */
export async function priceNativeSpend(amountWei: bigint, chainId: number): Promise<SpendPricing> {
  if (amountWei <= 0n) return ZERO;
  if (isTestnetChain(chainId)) return synthetic(chainId, NATIVE_ASSET, amountWei, 18, 'The native asset');
  if (!isMainnetChain(chainId)) return noSource(chainId, 'The native asset');
  const usd = await weiToUsd(amountWei, chainId);
  // weiToUsd answers exactly "0" when the oracle failed; a priced dust amount is "0.000000".
  if (usd === '0') return { status: 'unpriced', reason: `The oracle has no price for the native asset of chain ${chainId} right now` };
  return { status: 'priced', usd, source: 'oracle' };
}

/** USD value of `amount` base units of the ERC-20 `token` (with `decimals`). */
export async function priceTokenSpend(amount: bigint, token: string, decimals: number, chainId: number): Promise<SpendPricing> {
  if (amount <= 0n) return ZERO;
  if (isTestnetChain(chainId)) return synthetic(chainId, token, amount, decimals, `Token ${token}`);
  if (!isMainnetChain(chainId)) return noSource(chainId, `Token ${token}`);
  const usd = await tokenAmountToUsd(amount, token, decimals, chainId);
  if (usd === '0') {
    return { status: 'unpriced', reason: `The oracle has no price for token ${token} on chain ${chainId} (unknown token or oracle unavailable)` };
  }
  return { status: 'priced', usd, source: 'oracle' };
}

/** USDC at exactly 1.00 USD (escrow budgets, x402 — an earlier owner decision); `amount` in 6-decimal base units. */
export function usdcPegSpend(amount: bigint): SpendPricing {
  if (amount <= 0n) return ZERO;
  return { status: 'priced', usd: formatUnits(amount, 6), source: 'usdc-peg' };
}

/** An amount that cannot be known before execution (e.g. a `max` withdraw). */
export function unknownAmountSpend(reason: string): SpendPricing {
  return { status: 'unpriced', reason };
}

/**
 * Sum of several components of one operation. Any unpriced component makes
 * the whole unpriced (its reason is kept); all zero is zero. The source of a
 * sum is `synthetic` when any component is synthetic, else `oracle` when any
 * is, else `usdc-peg`.
 */
export function sumSpendPricings(parts: readonly SpendPricing[]): SpendPricing {
  const unpriced = parts.find((p): p is Extract<SpendPricing, { status: 'unpriced' }> => p.status === 'unpriced');
  if (unpriced) return unpriced;
  const priced = parts.filter((p): p is Extract<SpendPricing, { status: 'priced' }> => p.status === 'priced');
  if (priced.length === 0) return ZERO;
  const micro = priced.reduce((sum, p) => sum + usdToMicro(p.usd), 0n);
  const sources = new Set(priced.map((p) => p.source));
  const source: SpendPriceSource = sources.has('synthetic') ? 'synthetic' : sources.has('oracle') ? 'oracle' : 'usdc-peg';
  return { status: 'priced', usd: formatMicro6(micro), source };
}

/** The USD to count: the priced value, "0" for zero or unpriced (an unpriced spend is refused while a limit applies). */
export function countedUsd(pricing: SpendPricing): string {
  return pricing.status === 'priced' ? pricing.usd : '0';
}

/** The source to record next to a reservation (null when nothing is priced). */
export function priceSourceOf(pricing: SpendPricing): SpendPriceSource | null {
  return pricing.status === 'priced' ? pricing.source : null;
}
