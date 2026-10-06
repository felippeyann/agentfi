/**
 * Policy numeric limits — one parser for every place that reads
 * `AgentPolicy.maxValuePerTxEth` / `maxDailyVolumeUsd`.
 *
 * Both columns are decimal *strings*. Before this module existed the authority
 * classifier used `Number(raw)` and the enforcer used `parseFloat(raw)`, which
 * disagree on the edge cases (`Number("") === 0`, `parseFloat("") is NaN`,
 * `Number("0x10") === 16`, `parseFloat("0x10") === 0`). An agent could send
 * `maxValuePerTxEth: ""` — classified as *tightening* to 0, enforced as *no
 * limit*. Everything now goes through `parsePolicyDecimal`, and the API edge
 * only accepts strings that match `POLICY_DECIMAL_PATTERN`.
 */

/** Plain non-negative decimal: digits, optionally a dot and more digits. No sign, exponent, hex, or whitespace. */
export const POLICY_DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** Human-readable form of the pattern for zod / OpenAPI error messages. */
export const POLICY_DECIMAL_MESSAGE = 'must be a plain decimal string such as "0.5" or "10000"';

/** True when `raw` is a well-formed policy decimal (see `POLICY_DECIMAL_PATTERN`). */
export function isPolicyDecimal(raw: unknown): raw is string {
  return typeof raw === 'string' && POLICY_DECIMAL_PATTERN.test(raw);
}

/**
 * Parses a stored or patched policy limit.
 *
 * Returns `null` for anything that is not a plain finite decimal — empty or
 * whitespace strings, exponents, hex, trailing garbage, words. Callers treat
 * `null` as **unlimited**: the authority classifier therefore flags a bad
 * value as loosening (an agent can never write one), and the enforcer never
 * compares against `NaN`. Values that reach storage must already have passed
 * the edge validation, so `null` only ever comes from a hand-edited row.
 */
export function parsePolicyDecimal(raw: string | null | undefined): number | null {
  if (!isPolicyDecimal(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
