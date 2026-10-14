/**
 * Agent policy for USDC spend that does not go through `/v1/transactions`
 * (task P6; reused by the ERC-8183 escrow path at `POST /v1/jobs` — C3d,
 * `reserveEscrowJobSpend` in escrow.service.ts, which adds the cooldown).
 *
 * `PolicyService.validateTransaction` judges a transaction the backend builds
 * and submits. An x402 payment (`POST /v1/jobs/:id/pay-resource`) is different:
 * the agent signs an EIP-3009 authorization and the resource server's
 * facilitator submits it. Before P6 that path only checked that the policy was
 * active and unexpired, so a prompt-injected provider could spend up to a job
 * reward from its own wallet regardless of the operator's limits. This module
 * applies the same policy row to such a spend, with USDC priced at exactly
 * 1 USD (no oracle — a payment gate must not depend on one):
 *
 *   active / expiresAt   paused or expired policy refuses (as everywhere).
 *   maxValuePerTxUsd     the per-spend cap in USD (Q8, migration 0021): the
 *                        whole USDC amount (1 USDC = 1 USD) must not exceed
 *                        it. Until Q8 this read the number stored in
 *                        `maxValuePerTxEth` as USD; that field is now native
 *                        ETH only and is never read here. Rows that existed
 *                        before 0021 were backfilled with the ETH number, so
 *                        their verdicts did not change.
 *   maxDailyVolume       `spentToday + amount ≤ maxDailyVolumeUsd`, where the
 *                        caller supplies everything the agent already
 *                        committed today in USD (DailyVolume + counted x402
 *                        rows for pay-resource). `"0"` = no daily limit.
 *   allowedTokens        when non-empty, the USDC contract must be listed.
 *   allowedRecipients    when non-empty, the RECIPIENT — the address that
 *                        receives the USDC (x402 `payTo`; for an ERC-8183
 *                        escrow job, C3d, the provider's wallet, where the
 *                        budget ends on `complete` — not the escrow contract,
 *                        which is the operator's own custody) — must be
 *                        listed (Q8). Until Q8 `allowedContracts` was read as
 *                        this payee list; it is now only the call target of
 *                        ordinary transactions and is never read here (the
 *                        agent never calls the USDC contract itself in an
 *                        x402 payment — the server's facilitator submits the
 *                        authorization — and the escrow contract is fixed by
 *                        the operator).
 *
 * Limits are parsed with `policy-numbers.ts` (S1): a value that is not a plain
 * decimal is unlimited — exactly what the authority classifier assumes, so
 * tighten-only semantics stay consistent. Amounts are compared exactly in
 * micro-USD (bigint); a limit with more than 6 decimals is rounded DOWN
 * (stricter).
 *
 * Not applied: `maxValueForAutoApprovalEth` (an x402 payment cannot wait for a
 * human approval) and `cooldownSeconds` (an agent pays several resources in a
 * row). See docs/architecture/x402-payments.md §10.
 */

import { isPolicyDecimal } from './policy-numbers.js';

/** The policy fields this check reads (a Prisma `AgentPolicy` row satisfies it). */
export interface UsdcSpendPolicy {
  active: boolean;
  expiresAt: Date | null;
  maxValuePerTxUsd: string;
  maxDailyVolumeUsd: string;
  allowedTokens: string[];
  allowedRecipients: string[];
}

export interface UsdcSpendRequest {
  /** USDC base units (6 decimals). USDC is priced at exactly 1 USD. */
  amount: bigint;
  /** USDC contract address. */
  token: string;
  /** Address that receives the USDC (x402 `payTo`, or the escrow job's provider wallet). */
  recipient: string;
  /** USD the agent already committed today, in micro-USD, NOT including `amount`. */
  spentTodayMicroUsd: bigint;
  now?: Date;
}

/** Refusal rules; named after the policy field that refused (Q8 renamed `maxValuePerTx` / `allowedContracts`). */
export type UsdcSpendRule =
  | 'policyPaused'
  | 'policyExpired'
  | 'maxValuePerTxUsd'
  | 'maxDailyVolume'
  | 'allowedTokens'
  | 'allowedRecipients';

export type UsdcSpendVerdict =
  | { allowed: true }
  | {
      allowed: false;
      rule: UsdcSpendRule;
      reason: string;
      /** The policy value that refused, as stored (`maxValuePerTxUsd`, `maxDailyVolume`). */
      limit?: string;
    };

const MICRO = 6;

/**
 * Plain policy decimal → micro-USD, rounded down; `null` when the value is
 * not a plain decimal (= unlimited, `parsePolicyDecimal` semantics).
 */
export function policyDecimalToMicro(raw: string | null | undefined): bigint | null {
  if (!isPolicyDecimal(raw)) return null;
  const [whole = '0', fraction = ''] = raw.split('.');
  return BigInt(whole + fraction.padEnd(MICRO, '0').slice(0, MICRO));
}

/** Micro-USD → `"1.25"`-style string (trailing zeros trimmed). */
export function formatMicroUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(MICRO, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A stored USD volume (`DailyVolume.volumeUsd`, numeric text) → micro-USD,
 * rounded UP (spent money is never under-counted). An unreadable value
 * throws: a daily limit must not silently pass on a corrupt total.
 */
export function usdTextToMicroCeil(raw: string | null | undefined): bigint {
  if (raw === null || raw === undefined || raw === '') return 0n;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!match) throw new Error(`Unreadable USD volume ${JSON.stringify(raw)}`);
  const [, sign, whole = '0', fraction = ''] = match;
  // A negative running total (an over-eager rollback elsewhere) means nothing spent.
  if (sign === '-') return 0n;
  let micro = BigInt(whole + fraction.padEnd(MICRO, '0').slice(0, MICRO));
  if (/[1-9]/.test(fraction.slice(MICRO))) micro += 1n;
  return micro;
}

function listed(list: readonly string[] | undefined, address: string): boolean {
  const target = address.toLowerCase();
  return (list ?? []).some((entry) => entry.toLowerCase() === target);
}

/**
 * Judges one USDC spend against the agent's policy. `policy === null` means
 * the agent has no policy row: no restrictions (same as `validateTransaction`).
 */
export function evaluateUsdcSpend(policy: UsdcSpendPolicy | null, request: UsdcSpendRequest): UsdcSpendVerdict {
  if (!policy) return { allowed: true };
  const now = request.now ?? new Date();
  const amountUsd = formatMicroUsd(request.amount);

  if (!policy.active) {
    return { allowed: false, rule: 'policyPaused', reason: 'Agent policy is paused (kill switch active)' };
  }
  if (policy.expiresAt && policy.expiresAt < now) {
    return {
      allowed: false,
      rule: 'policyExpired',
      reason: `Agent policy expired at ${policy.expiresAt.toISOString()}. Update the policy to continue.`,
    };
  }

  if ((policy.allowedTokens?.length ?? 0) > 0 && !listed(policy.allowedTokens, request.token)) {
    return {
      allowed: false,
      rule: 'allowedTokens',
      reason: `Token ${request.token} (USDC) is not in the agent's allowed tokens whitelist`,
    };
  }

  if ((policy.allowedRecipients?.length ?? 0) > 0 && !listed(policy.allowedRecipients, request.recipient)) {
    return {
      allowed: false,
      rule: 'allowedRecipients',
      reason: `Recipient ${request.recipient} is not in the agent's allowed recipients whitelist`,
    };
  }

  const perTx = policyDecimalToMicro(policy.maxValuePerTxUsd);
  if (perTx !== null && request.amount > perTx) {
    return {
      allowed: false,
      rule: 'maxValuePerTxUsd',
      reason: `Payment of ${amountUsd} USDC exceeds the policy's per-transaction limit of ${policy.maxValuePerTxUsd} USD (maxValuePerTxUsd)`,
      limit: policy.maxValuePerTxUsd,
    };
  }

  // "0" (or unparsable) = no daily limit, exactly as validateTransaction reads it.
  const daily = policyDecimalToMicro(policy.maxDailyVolumeUsd);
  if (daily !== null && daily > 0n && request.spentTodayMicroUsd + request.amount > daily) {
    return {
      allowed: false,
      rule: 'maxDailyVolume',
      reason:
        `Daily volume limit of ${policy.maxDailyVolumeUsd} USD would be exceeded. ` +
        `Already committed today: ${formatMicroUsd(request.spentTodayMicroUsd)}, requested: ${amountUsd}`,
      limit: policy.maxDailyVolumeUsd,
    };
  }

  return { allowed: true };
}
