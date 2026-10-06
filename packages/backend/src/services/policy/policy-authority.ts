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

/** Fields of `AgentPolicy` an API caller may patch, in canonical order. */
export const POLICY_PATCH_FIELDS = [
  'maxValuePerTxEth',
  'maxDailyVolumeUsd',
  'allowedContracts',
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

/** A non-numeric limit never blocks anything (`value > NaN` is false), so it is unlimited. */
function effectiveMaxValuePerTx(raw: string | undefined): number {
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** PolicyService only enforces the daily limit when it is > 0, so 0 / negative / NaN = unlimited. */
function effectiveDailyLimit(raw: string | undefined): number {
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
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
 * A field LOOSENS when:
 *   - `maxValuePerTxEth` increases
 *   - `maxDailyVolumeUsd` increases (`"0"` means *no limit* and therefore loosens any positive limit)
 *   - `allowedContracts` / `allowedTokens` go from non-empty to empty, or gain an address
 *     not in the current list (compared case-insensitively)
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

  if (
    patch.maxValuePerTxEth !== undefined &&
    effectiveMaxValuePerTx(patch.maxValuePerTxEth) > effectiveMaxValuePerTx(current?.maxValuePerTxEth)
  ) {
    loosenedFields.push('maxValuePerTxEth');
  }

  if (
    patch.maxDailyVolumeUsd !== undefined &&
    effectiveDailyLimit(patch.maxDailyVolumeUsd) > effectiveDailyLimit(current?.maxDailyVolumeUsd)
  ) {
    loosenedFields.push('maxDailyVolumeUsd');
  }

  if (
    patch.allowedContracts !== undefined &&
    whitelistLoosens(current?.allowedContracts ?? [], patch.allowedContracts)
  ) {
    loosenedFields.push('allowedContracts');
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
