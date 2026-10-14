/**
 * Policy authority — decides whether a policy patch tightens or loosens an
 * agent's operational policy.
 *
 * Authority model ("tighten-only for agents, operator may loosen"):
 *   - An agent may only TIGHTEN its own policy. A compromised or
 *     prompt-injected agent must never be able to raise its own limits.
 *   - The operator (`x-api-key: <API_SECRET>`) may loosen any agent's policy.
 *
 * This module is pure (no I/O) so the rules are unit-testable in isolation
 * and reusable by any code path that writes to `AgentPolicy`.
 */
import type { AgentPolicy } from '@prisma/client';
import { isPolicyDecimal, parsePolicyDecimal } from './policy-numbers.js';

/** Fields of `AgentPolicy` an API caller may patch, in canonical order. */
export const POLICY_PATCH_FIELDS = [
  'maxValuePerTxEth',
  'maxValuePerTxUsd',
  'maxOutflowPerTxUsd',
  'maxDailyVolumeUsd',
  'allowedContracts',
  'allowedRecipients',
  'allowedTokens',
  'cooldownSeconds',
  'active',
  'expiresAt',
] as const;

export type PolicyPatchField = (typeof POLICY_PATCH_FIELDS)[number];

/**
 * A partial policy update. A missing key means "leave unchanged".
 * `expiresAt: null` clears an existing expiry (makes the policy permanent).
 */
export type PolicyPatch = Partial<Pick<AgentPolicy, PolicyPatchField>>;

/** Loosely-typed input (e.g. a parsed request body) where absent fields may be `undefined`. */
export type PolicyPatchInput = { [K in PolicyPatchField]?: PolicyPatch[K] | undefined };

export interface PolicyChangeClassification {
  /** `true` when no field loosens — the patch only tightens or leaves the policy unchanged. */
  tightens: boolean;
  /** Fields whose new value is more permissive than the current one. Empty when `tightens` is true. */
  loosenedFields: PolicyPatchField[];
}

// ── Effective-value helpers ────────────────────────────────────────────────
//
// Each helper maps a raw stored/patched value to the constraint PolicyService
// actually enforces, so "more permissive" can be decided with a plain `>`/`<`.
// `undefined` means "no policy row exists", which PolicyService treats as
// "no restrictions" — the fully open baseline.
//
// Decimal limits (#185 review): a patch loosens a limit when ANY enforcer of
// that limit, reading it its own way, sees the new value as more permissive.
// Comparing JS numbers alone was a tighten-only bypass: at 2^33 a raise by one
// micro-dollar (or one wei) is invisible to `Number` but visible to the
// micro-USD / wei enforcers; and a positive daily limit below one micro-dollar
// read as a tightening while the micro-USD enforcers (x402, escrow) read it as
// NO limit. Each reading mirrors one enforcer exactly:
//   float     `parsePolicyDecimal` → number (validateTransaction, the A6
//             reservation, the legacy job reservation);
//   micro     6-decimal fixed point rounded down, as `policyDecimalToMicro`
//             (x402 / escrow `evaluateUsdcSpend`, `judgeOutflowCap`, the
//             escrow daily limit);
//   wei       18-decimal fixed point (the on-chain sync stores wei).
// A value no reading parses (`""`, `"1e3"`, `"0x10"`, `"unlimited"`, …) is
// unlimited, so it always counts as loosening and an agent can never write it.
// A patch the enforcers cannot tell from the current value is neutral.

/** A limit as one enforcer reads it. */
type Level = { kind: 'blocked' } | { kind: 'value'; v: number | bigint } | { kind: 'unlimited' };
/** One enforcer's reading; `rowExists: false` = no policy row = no restrictions. */
type Reading = (raw: string | null | undefined, rowExists: boolean) => Level;

const UNLIMITED: Level = { kind: 'unlimited' };
const BLOCKED: Level = { kind: 'blocked' };

function levelRank(level: Level): number {
  return level.kind === 'blocked' ? 0 : level.kind === 'value' ? 1 : 2;
}

/** True when `next` permits more than `current` (same reading, so `v` has one type). */
function isLooser(next: Level, current: Level): boolean {
  if (levelRank(next) !== levelRank(current)) return levelRank(next) > levelRank(current);
  return next.kind === 'value' && current.kind === 'value' && next.v > current.v;
}

/** Fixed point at `decimals`, rounded down. Only called on a well-formed policy decimal. */
function fixedPoint(raw: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = raw.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
}

function fixedReading(decimals: number, opts: { zeroIsUnlimited?: boolean; nullIsBlocked?: boolean } = {}): Reading {
  return (raw, rowExists) => {
    if (!rowExists) return UNLIMITED;
    if (raw === null || raw === undefined) return opts.nullIsBlocked ? BLOCKED : UNLIMITED;
    if (!isPolicyDecimal(raw)) return UNLIMITED;
    const v = fixedPoint(raw, decimals);
    return opts.zeroIsUnlimited && v === 0n ? UNLIMITED : { kind: 'value', v };
  };
}

function floatReading(opts: { zeroIsUnlimited?: boolean } = {}): Reading {
  return (raw, rowExists) => {
    if (!rowExists || raw === null || raw === undefined) return UNLIMITED;
    const n = parsePolicyDecimal(raw);
    if (n === null) return UNLIMITED;
    return opts.zeroIsUnlimited && !(n > 0) ? UNLIMITED : { kind: 'value', v: n };
  };
}

/** The readings of every decimal limit, one per enforcer that reads it. */
const DECIMAL_LIMIT_READINGS = {
  /** validateTransaction (float) and the on-chain sync (wei). */
  maxValuePerTxEth: [floatReading(), fixedReading(18)],
  /** x402 and escrow budgets: `evaluateUsdcSpend` (micro-USD). */
  maxValuePerTxUsd: [fixedReading(6)],
  /** §5-6 `judgeOutflowCap` (micro-USD); NULL ("not configured") blocks every outflow — the most restrictive value. */
  maxOutflowPerTxUsd: [fixedReading(6, { nullIsBlocked: true })],
  /** "0" = no daily limit for every enforcer: the float ones (transactions, legacy jobs) and the micro-USD ones (x402, escrow). */
  maxDailyVolumeUsd: [floatReading({ zeroIsUnlimited: true }), fixedReading(6, { zeroIsUnlimited: true })],
} as const satisfies Record<string, readonly Reading[]>;

type DecimalLimitField = keyof typeof DECIMAL_LIMIT_READINGS;

/** A decimal limit loosens when any of its enforcers reads the patched value as more permissive than the current one. */
function decimalLimitLoosens(field: DecimalLimitField, current: AgentPolicy | null, next: string | null): boolean {
  const currentRaw = current ? (current[field] as string | null | undefined) : undefined;
  return DECIMAL_LIMIT_READINGS[field].some((read) => isLooser(read(next, true), read(currentRaw, current !== null)));
}

/** Cooldowns <= 0 are not enforced, so they are equivalent to 0. */
function effectiveCooldown(raw: number | undefined): number {
  if (raw === undefined) return 0;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Expiry as epoch milliseconds; "no expiry" (or an invalid date, which never expires) is +Infinity. */
function effectiveExpiry(raw: Date | null | undefined): number {
  if (!raw) return Number.POSITIVE_INFINITY;
  const t = raw.getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Addresses are compared case-insensitively so checksummed and lowercased forms match. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * A whitelist loosens when it stops restricting (non-empty → empty) or when it
 * admits an address the current list does not. An empty current list means
 * "no restriction", so introducing a whitelist against it always tightens.
 */
function whitelistLoosens(current: readonly string[], next: readonly string[]): boolean {
  if (current.length === 0) return false;
  if (next.length === 0) return true;
  const allowed = new Set(current.map(normalizeAddress));
  return next.some((address) => !allowed.has(normalizeAddress(address)));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Classifies a patch against the current policy (`null` = no policy row yet).
 *
 * A field LOOSENS when (decimal limits: as ANY of their enforcers reads them —
 * float, micro-USD or wei, see DECIMAL_LIMIT_READINGS):
 *   - `maxValuePerTxEth` or `maxValuePerTxUsd` increases (a non-decimal value is unlimited,
 *     so it loosens any limit)
 *   - `maxOutflowPerTxUsd` increases, where NULL ("not configured", every ordinary outflow
 *     blocked) is the most restrictive value: setting any value from NULL loosens
 *   - `maxDailyVolumeUsd` increases (`"0"` means *no limit* and therefore loosens any positive limit)
 *   - `allowedContracts` / `allowedRecipients` / `allowedTokens` go from non-empty to empty, or
 *     gain an address not in the current list (compared case-insensitively)
 *   - `cooldownSeconds` decreases
 *   - `active` goes false → true
 *   - `expiresAt` is cleared (`null`) or moved later while one existed
 *
 * With no current policy, the baseline is "no restrictions": any patch that sets a
 * limit tightens, `active: true` / `expiresAt: null` are neutral. Everything else
 * is tightening or neutral. Fields absent from the patch are never loosening.
 */
export function classifyPolicyChange(
  current: AgentPolicy | null,
  patch: PolicyPatch,
): PolicyChangeClassification {
  const loosenedFields: PolicyPatchField[] = [];

  // Decimal limits, in canonical order (#185 review: every enforcer's reading,
  // see DECIMAL_LIMIT_READINGS). With no policy row the baseline is "no
  // restrictions", so any value tightens.
  for (const field of ['maxValuePerTxEth', 'maxValuePerTxUsd', 'maxOutflowPerTxUsd', 'maxDailyVolumeUsd'] as const) {
    const next = patch[field];
    if (next !== undefined && decimalLimitLoosens(field, current, next)) loosenedFields.push(field);
  }

  if (
    patch.allowedContracts !== undefined &&
    whitelistLoosens(current?.allowedContracts ?? [], patch.allowedContracts)
  ) {
    loosenedFields.push('allowedContracts');
  }

  if (
    patch.allowedRecipients !== undefined &&
    whitelistLoosens(current?.allowedRecipients ?? [], patch.allowedRecipients)
  ) {
    loosenedFields.push('allowedRecipients');
  }

  if (
    patch.allowedTokens !== undefined &&
    whitelistLoosens(current?.allowedTokens ?? [], patch.allowedTokens)
  ) {
    loosenedFields.push('allowedTokens');
  }

  if (
    patch.cooldownSeconds !== undefined &&
    effectiveCooldown(patch.cooldownSeconds) < effectiveCooldown(current?.cooldownSeconds)
  ) {
    loosenedFields.push('cooldownSeconds');
  }

  // No policy row = active by default, so `active: true` against null is neutral.
  if (patch.active === true && (current?.active ?? true) === false) {
    loosenedFields.push('active');
  }

  if (
    patch.expiresAt !== undefined &&
    effectiveExpiry(patch.expiresAt) > effectiveExpiry(current?.expiresAt)
  ) {
    loosenedFields.push('expiresAt');
  }

  return { tightens: loosenedFields.length === 0, loosenedFields };
}

/**
 * Builds a `PolicyPatch` from loosely-typed input, dropping keys whose value is
 * `undefined` so "not provided" never reaches Prisma as an explicit `undefined`
 * and never counts as a change. Unknown keys are ignored.
 */
export function toPolicyPatch(input: PolicyPatchInput): PolicyPatch {
  const patch: Partial<Record<PolicyPatchField, unknown>> = {};
  for (const field of POLICY_PATCH_FIELDS) {
    const value = input[field];
    if (value !== undefined) patch[field] = value;
  }
  return patch as PolicyPatch;
}

/** Fields the patch actually changes (present with a value), in canonical order — for audit logs. */
export function changedPolicyFields(patch: PolicyPatch): PolicyPatchField[] {
  return POLICY_PATCH_FIELDS.filter((field) => patch[field] !== undefined);
}
