/**
 * `maxOutflowPerTxUsd` — the USD per-transaction cap on ORDINARY outflows
 * (execution plan §5 question 6; owner decision 2026-10-14: "new field; null =
 * blocked"; migration 0025).
 *
 * What it caps: the value an ordinary operation sends out of the agent's
 * wallet, at its priced USD value (D15 pricing, `spend-pricing.ts`) —
 * `/v1/transactions/*` transfers (native and ERC-20), the input of a Uniswap
 * or Curve swap, Aave / Compound / ERC-4626 deposits, GMX collateral, a
 * batch's native value plus its recognised ERC-20 transfers, and the legacy
 * A2A payment (and its reward at job creation). Not: withdrawals (explicit or
 * max) and a GMX close, whose value comes back to the agent; USDC x402
 * payments and ERC-8183 escrow budgets, capped by `maxValuePerTxUsd` (D14).
 *
 * The verdict, in order:
 *   - no policy row → no restrictions (as everywhere: `validateTransaction`);
 *   - nothing flows out (pricing `zero`) → nothing to cap;
 *   - the field is NULL → refused, `USD_CAP_NOT_CONFIGURED`, with a diagnostic
 *     telling the operator to set it (no value is ever inferred);
 *   - the stored value is not a plain decimal → unlimited (the same reading
 *     as every other limit and as the authority classifier; the API never
 *     writes one);
 *   - the spend has no trusted price → refused, `PRICE_UNAVAILABLE` (D15: a
 *     cap that cannot be checked must not pass);
 *   - priced USD (rounded up to the micro-dollar) > cap (rounded down) →
 *     refused, rule `maxOutflowPerTxUsd`.
 */
import type { AgentPolicy } from '@prisma/client';
import { policyDecimalToMicro, usdTextToMicroCeil } from './usdc-spend-policy.js';
import type { SpendPricing } from './spend-pricing.js';

export const OUTFLOW_CAP_FIELD = 'maxOutflowPerTxUsd' as const;

export type OutflowCapVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** 403 / 503 / 403 in the routes. */
      code: 'USD_CAP_NOT_CONFIGURED' | 'PRICE_UNAVAILABLE' | 'POLICY_VIOLATION';
      rule: typeof OUTFLOW_CAP_FIELD;
      reason: string;
      /** The stored cap, when one is configured. */
      limit?: string;
    };

/** The diagnostic for a NULL cap — says what to set, and who can. */
export const USD_CAP_NOT_CONFIGURED_REASON =
  'This agent\'s policy has no maxOutflowPerTxUsd (the USD per-transaction cap on ordinary outflows: transfers, swaps, ' +
  'deposits, GMX collateral, batches, A2A payments), so ordinary outflows are blocked until the operator configures it. ' +
  'Operator: PATCH /v1/agents/<id>/policy with { "maxOutflowPerTxUsd": "<USD>" } and the operator credential ' +
  '(setting it from "not configured" is a loosening). Nothing is inferred from maxValuePerTxEth or maxValuePerTxUsd.';

export function judgeOutflowCap(
  policy: Pick<AgentPolicy, 'maxOutflowPerTxUsd'> | null,
  /** The outflow's pricing; absent counts as unpriced. */
  pricing: SpendPricing | undefined,
): OutflowCapVerdict {
  if (!policy) return { allowed: true };
  if (pricing?.status === 'zero') return { allowed: true };

  const raw = policy.maxOutflowPerTxUsd;
  if (raw === null || raw === undefined) {
    return { allowed: false, code: 'USD_CAP_NOT_CONFIGURED', rule: OUTFLOW_CAP_FIELD, reason: USD_CAP_NOT_CONFIGURED_REASON };
  }
  const capMicro = policyDecimalToMicro(raw);
  if (capMicro === null) return { allowed: true };

  if (!pricing || pricing.status === 'unpriced') {
    const why = pricing?.status === 'unpriced' ? pricing.reason : 'The outflow has no trusted USD price';
    return {
      allowed: false,
      code: 'PRICE_UNAVAILABLE',
      rule: OUTFLOW_CAP_FIELD,
      reason: `${why}. The per-transaction cap maxOutflowPerTxUsd of ${raw} USD cannot be checked, so the outflow is refused.`,
      limit: raw,
    };
  }
  const usdMicro = usdTextToMicroCeil(pricing.usd);
  if (usdMicro > capMicro) {
    return {
      allowed: false,
      code: 'POLICY_VIOLATION',
      rule: OUTFLOW_CAP_FIELD,
      reason: `Outflow of ${pricing.usd} USD exceeds the policy's per-transaction limit of ${raw} USD (maxOutflowPerTxUsd)`,
      limit: raw,
    };
  }
  return { allowed: true };
}
