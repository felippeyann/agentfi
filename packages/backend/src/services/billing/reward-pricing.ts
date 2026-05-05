/**
 * Reward pricing — shared helper for converting an A2A `reward` JSON spec
 * into a USD value, with explicit "resolved vs unresolved" reporting.
 *
 * Used by:
 *   - `payment-finalizer.service.ts` to capture a per-job revenue snapshot
 *     at the moment the on-chain payment confirms (Phase 2 of #71).
 *   - `pnl.service.ts` as the live-pricing fallback when a Job has no
 *     stored snapshot (Phase 3 of #71).
 *
 * Why a small wrapper around `weiToUsd` / `tokenAmountToUsd`:
 *   The price service returns the literal string '0' for both "the oracle
 *   was unreachable" and "the value is genuinely zero". That ambiguity is
 *   exactly what produced the silent-zero PnL bug described in #71. This
 *   helper distinguishes the two cases by returning `resolved: false` only
 *   when the oracle could not produce a price. Callers can then choose
 *   their behavior:
 *     - Finalizer writes NULL (skip snapshot — try again next time on
 *       a different code path, or just stay with live fallback forever).
 *     - PnLService skips the row from the snapshot-priority path and
 *       counts it as "unresolved" in the breakdown notes.
 */

import { parseEther, parseUnits } from 'viem';
import { weiToUsd, tokenAmountToUsd } from '../transaction/price.service.js';

export interface RewardJson {
  amount?: string;
  token?: string;
  chainId?: number;
}

export interface RewardPriceResult {
  /** USD total for the reward (e.g. "20.000000"). */
  usd: string;
  /** Price-per-token-unit in USD as a string (e.g. ETH/USD = "2000.000000"). */
  priceUsd: string;
  /** True if the oracle returned a real price; false on any failure or unknown token. */
  resolved: boolean;
}

const ZERO_RESULT: RewardPriceResult = {
  usd: '0',
  priceUsd: '0',
  resolved: false,
};

/**
 * Resolve a reward spec to a USD snapshot.
 *
 * Returns `resolved: false` when:
 *   - The reward is null or has no amount (nothing to price).
 *   - The reward amount is malformed (parseEther/parseUnits throws).
 *   - The price oracle returns '0' (its "unresolved" sentinel).
 *
 * On success, both `usd` and `priceUsd` are non-zero strings.
 *
 * Note: the underlying price service shares a 60s in-process cache. Callers
 * making back-to-back calls for the same chain/token pay only one network
 * round-trip per minute, so calling this from per-row PnL loops is fine.
 */
export async function resolveRewardUsd(
  reward: RewardJson | null | undefined,
): Promise<RewardPriceResult> {
  if (!reward || !reward.amount) return ZERO_RESULT;

  const token = reward.token ?? 'ETH';
  const chainId = reward.chainId ?? 1;
  const isEth = token.toUpperCase() === 'ETH';

  try {
    if (isEth) {
      const wei = parseEther(reward.amount);
      const usd = await weiToUsd(wei, chainId);
      if (usd === '0') return ZERO_RESULT;
      // Recover the unit price by dividing total USD by the human-readable
      // amount. This avoids a second oracle call and stays consistent with
      // whatever value `weiToUsd` actually used (incl. cache).
      const amountFloat = parseFloat(reward.amount);
      const priceUsd =
        amountFloat > 0
          ? (parseFloat(usd) / amountFloat).toFixed(6)
          : '0';
      return { usd, priceUsd, resolved: true };
    }

    // Non-ETH path. MVP assumption (matches existing PnL behavior): treat
    // the token symbol field as a 6-decimal contract address (USDC/USDT
    // shape). Long-term this should consult a token registry — out of
    // scope for #71 Phase 2/3.
    const units = parseUnits(reward.amount, 6);
    const usd = await tokenAmountToUsd(units, token, 6, chainId);
    if (usd === '0') return ZERO_RESULT;
    const amountFloat = parseFloat(reward.amount);
    const priceUsd =
      amountFloat > 0
        ? (parseFloat(usd) / amountFloat).toFixed(6)
        : '0';
    return { usd, priceUsd, resolved: true };
  } catch {
    return ZERO_RESULT;
  }
}
