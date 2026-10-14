/**
 * Q7 (owner decision, 2026-10-14): no new escrow signature or fund movement
 * while the on-chain configuration is unverified.
 *
 * C3d's boot check (`escrow-boot-check.ts`) reads, per chain, `escrow.token()`
 * and — with a hook — the hook's `acp / trustedEvaluator / identityRegistry /
 * reputationRegistry`; Q7 adds `eth_chainId`. Its result becomes a
 * per-process, per-chain VERIFICATION STATE, and every escrow-dependent
 * signature consults it through `escrowGateVerdict`:
 *
 *   verified   { at, fingerprint }   the last read matched the configuration
 *   unverified { reason, since }     not read yet, or the last read failed (RPC down, timeout)
 *   mismatch   { problems, since }   the chain answered something else (FATAL in production / staging)
 *
 * Validity rules (pure, unit-tested):
 *  - a verification authorises for `ttlSeconds` after `at`; past it the
 *    chain is unverified again ("expired") until a fresh read succeeds;
 *  - ANY failed read replaces the state at once: a success never survives a
 *    later failure;
 *  - the state is bound to the fingerprint of the expectation it verified
 *    (chainId, escrow, hook, evaluator, both registries, USDC): a different
 *    expectation is unverified ("config-changed");
 *  - no state at all (the process has not finished its first read, or the
 *    chain has no escrow in this process) is unverified.
 *
 * Kept per process on purpose (no Redis cache): the API and the worker each
 * verify with their own environment, and a restart with a new environment
 * starts unverified. Pure: no env, no clock, no I/O.
 */

import { createHash } from 'node:crypto';
import type { EscrowChainCheck, EscrowChainExpectation } from './escrow-boot-check.js';

export type EscrowVerificationState =
  | { kind: 'verified'; at: Date; fingerprint: string }
  | { kind: 'unverified'; reason: string; since: Date }
  | { kind: 'mismatch'; problems: string[]; since: Date };

/** Why the gate refuses. */
export type EscrowGateBlock = 'not-configured' | 'not-verified-yet' | 'unverified' | 'mismatch' | 'expired' | 'config-changed';

export type EscrowGateVerdict =
  | { allowed: true; chainId: number; verifiedAt: Date; validUntil: Date }
  | { allowed: false; chainId: number; block: EscrowGateBlock; reason: string; retryAfterSeconds: number };

export interface EscrowVerificationSettings {
  /** ESCROW_CONFIG_VERIFIED_TTL_SECONDS */
  ttlSeconds: number;
  /** ESCROW_CONFIG_RECHECK_SECONDS (also the Retry-After / deferral delay). */
  recheckSeconds: number;
}

const lower = (value: string | null) => (value ? value.toLowerCase() : null);

/** sha256 of the canonical expectation (addresses lowercased, fixed field order). */
export function expectationFingerprint(expectation: EscrowChainExpectation): string {
  const canonical = JSON.stringify([
    expectation.chainId,
    lower(expectation.escrow),
    lower(expectation.hook),
    lower(expectation.evaluator),
    lower(expectation.identityRegistry),
    lower(expectation.reputationRegistry),
    lower(expectation.usdc),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The state after one read of `expectation`. A mismatch or a failed read
 * keeps the `since` of a state of the same kind (an ongoing outage), and
 * otherwise starts now; a success is stamped now with the expectation's
 * fingerprint.
 */
export function stateAfterCheck(
  previous: EscrowVerificationState | undefined,
  check: Pick<EscrowChainCheck, 'problems' | 'unreadable'>,
  expectation: EscrowChainExpectation,
  now: Date,
): EscrowVerificationState {
  if (check.problems.length > 0) {
    return { kind: 'mismatch', problems: [...check.problems], since: previous?.kind === 'mismatch' ? previous.since : now };
  }
  if (check.unreadable !== null) {
    return {
      kind: 'unverified',
      reason: `the chain could not be read: ${check.unreadable}`,
      since: previous?.kind === 'unverified' ? previous.since : now,
    };
  }
  return { kind: 'verified', at: now, fingerprint: expectationFingerprint(expectation) };
}

/**
 * May an escrow-dependent signature on `chainId` go ahead now? Allowed only
 * for a verified state younger than the TTL whose fingerprint is the current
 * expectation's. Every refusal carries a reason and how long to wait (the
 * re-check interval: the soonest the state can change).
 */
export function escrowGateVerdict(params: {
  chainId: number;
  state: EscrowVerificationState | undefined;
  /** What this process is configured with for the chain now (null: no escrow on it). */
  expectation: EscrowChainExpectation | null;
  now: Date;
  settings: EscrowVerificationSettings;
}): EscrowGateVerdict {
  const { chainId, state, expectation, now, settings } = params;
  const retryAfterSeconds = Math.max(1, Math.ceil(settings.recheckSeconds));
  const refuse = (block: EscrowGateBlock, reason: string): EscrowGateVerdict => ({ allowed: false, chainId, block, reason, retryAfterSeconds });

  if (!expectation) {
    return refuse('not-configured', `no ERC-8183 escrow is configured for chain ${chainId} in this process`);
  }
  if (!state) {
    return refuse('not-verified-yet', `the ERC-8183 configuration of chain ${chainId} has not been verified yet`);
  }
  if (state.kind === 'mismatch') {
    return refuse('mismatch', `the deployed ERC-8183 escrow / hook on chain ${chainId} does not match the configuration: ${state.problems.join('; ')}`);
  }
  if (state.kind === 'unverified') {
    return refuse('unverified', `the ERC-8183 configuration of chain ${chainId} is unverified since ${state.since.toISOString()}: ${state.reason}`);
  }
  if (state.fingerprint !== expectationFingerprint(expectation)) {
    return refuse('config-changed', `the ERC-8183 configuration of chain ${chainId} changed since it was verified at ${state.at.toISOString()}`);
  }
  const validUntil = new Date(state.at.getTime() + settings.ttlSeconds * 1000);
  if (now.getTime() >= validUntil.getTime()) {
    return refuse(
      'expired',
      `the verification of the ERC-8183 configuration of chain ${chainId} (at ${state.at.toISOString()}) expired at ${validUntil.toISOString()} without a successful re-check`,
    );
  }
  return { allowed: true, chainId, verifiedAt: state.at, validUntil };
}

/** One chain as `/health/ready` (public: no reasons, no addresses) and the admin view (with reasons) show it. */
export interface EscrowVerificationView {
  chainId: number;
  state: 'verified' | EscrowGateBlock;
  /** May new escrow signatures go ahead on this chain right now. */
  allowed: boolean;
  verifiedAt: string | null;
  validUntil: string | null;
  /** Start of the current unverified / mismatch period. */
  since: string | null;
  /** Operator-facing explanation (omitted from the public view). */
  reason?: string;
}

/** The view of one chain from its state and the gate verdict. */
export function verificationView(
  state: EscrowVerificationState | undefined,
  verdict: EscrowGateVerdict,
  opts: { withReason: boolean },
): EscrowVerificationView {
  const verifiedAt = state?.kind === 'verified' ? state.at.toISOString() : null;
  const since = state && state.kind !== 'verified' ? state.since.toISOString() : null;
  if (verdict.allowed) {
    return { chainId: verdict.chainId, state: 'verified', allowed: true, verifiedAt, validUntil: verdict.validUntil.toISOString(), since: null };
  }
  return {
    chainId: verdict.chainId,
    state: verdict.block,
    allowed: false,
    verifiedAt,
    validUntil: null,
    since,
    ...(opts.withReason ? { reason: verdict.reason } : {}),
  };
}
