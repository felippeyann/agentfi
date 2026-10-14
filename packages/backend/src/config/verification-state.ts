/**
 * The verification lifecycle shared by every on-chain configuration the
 * backend must verify before using it (Q7 escrow / hook; S9 executor /
 * policy module). Pure: no env, no clock, no I/O.
 *
 *   verified   { at, fingerprint }   the last read matched the configuration
 *   unverified { reason, since }     not read yet, or the last read failed (RPC down, timeout)
 *   mismatch   { problems, since }   the chain answered something else (FATAL in production / staging)
 *
 *  - a verification authorises for `ttlSeconds` after `at`; past it the chain
 *    is unverified again ("expired") until a fresh read succeeds;
 *  - ANY failed read replaces the state at once: a success never survives a
 *    later failure;
 *  - the state is bound to the fingerprint of the expectation it verified: a
 *    different expectation is unverified ("config-changed");
 *  - no state at all (the process has not finished its first read) is
 *    unverified.
 */

export type VerificationState =
  | { kind: 'verified'; at: Date; fingerprint: string }
  | { kind: 'unverified'; reason: string; since: Date }
  | { kind: 'mismatch'; problems: string[]; since: Date };

/** Why a gate refuses. */
export type GateBlock = 'not-configured' | 'not-verified-yet' | 'unverified' | 'mismatch' | 'expired' | 'config-changed';

export type GateVerdict =
  | { allowed: true; chainId: number; verifiedAt: Date; validUntil: Date }
  | { allowed: false; chainId: number; block: GateBlock; reason: string; retryAfterSeconds: number };

export interface VerificationSettings {
  /** How long a successful read authorises. */
  ttlSeconds: number;
  /** The re-check interval (also the Retry-After / deferral delay). */
  recheckSeconds: number;
}

/** The words a gate's refusals use for one kind of configuration. */
export interface VerificationWording {
  /** e.g. "no ERC-8183 escrow is configured for chain 84532 in this process". */
  notConfigured(chainId: number): string;
  /** e.g. "the ERC-8183 configuration of chain 84532". */
  subject(chainId: number): string;
  /** e.g. "the deployed ERC-8183 escrow / hook on chain 84532". */
  deployed(chainId: number): string;
}

/** The outcome of one read, as the state machine needs it. */
export interface CheckOutcome {
  problems: readonly string[];
  unreadable: string | null;
}

/**
 * The state after one read. A mismatch or a failed read keeps the `since` of
 * a state of the same kind (an ongoing outage), and otherwise starts now; a
 * success is stamped now with the expectation's fingerprint.
 */
export function nextVerificationState(
  previous: VerificationState | undefined,
  check: CheckOutcome,
  fingerprint: string,
  now: Date,
): VerificationState {
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
  return { kind: 'verified', at: now, fingerprint };
}

/**
 * May an operation that depends on this configuration go ahead now? Allowed
 * only for a verified state younger than the TTL whose fingerprint is the
 * current expectation's (`fingerprint` null: nothing configured). Every
 * refusal carries a reason and how long to wait (the re-check interval).
 */
export function gateVerdict(params: {
  chainId: number;
  state: VerificationState | undefined;
  fingerprint: string | null;
  now: Date;
  settings: VerificationSettings;
  wording: VerificationWording;
}): GateVerdict {
  const { chainId, state, fingerprint, now, settings, wording } = params;
  const retryAfterSeconds = Math.max(1, Math.ceil(settings.recheckSeconds));
  const refuse = (block: GateBlock, reason: string): GateVerdict => ({ allowed: false, chainId, block, reason, retryAfterSeconds });

  if (fingerprint === null) return refuse('not-configured', wording.notConfigured(chainId));
  if (!state) return refuse('not-verified-yet', `${wording.subject(chainId)} has not been verified yet`);
  if (state.kind === 'mismatch') {
    return refuse('mismatch', `${wording.deployed(chainId)} does not match the configuration: ${state.problems.join('; ')}`);
  }
  if (state.kind === 'unverified') {
    return refuse('unverified', `${wording.subject(chainId)} is unverified since ${state.since.toISOString()}: ${state.reason}`);
  }
  if (state.fingerprint !== fingerprint) {
    return refuse('config-changed', `${wording.subject(chainId)} changed since it was verified at ${state.at.toISOString()}`);
  }
  const validUntil = new Date(state.at.getTime() + settings.ttlSeconds * 1000);
  if (now.getTime() >= validUntil.getTime()) {
    return refuse(
      'expired',
      `the verification of ${wording.subject(chainId)} (at ${state.at.toISOString()}) expired at ${validUntil.toISOString()} without a successful re-check`,
    );
  }
  return { allowed: true, chainId, verifiedAt: state.at, validUntil };
}

/** One chain as `/health/ready` (public: no reasons) and the admin view (with reasons) show it. */
export interface VerificationView {
  chainId: number;
  state: 'verified' | GateBlock;
  /** May dependent operations go ahead on this chain right now. */
  allowed: boolean;
  verifiedAt: string | null;
  validUntil: string | null;
  /** Start of the current unverified / mismatch period. */
  since: string | null;
  /** Operator-facing explanation (omitted from the public view). */
  reason?: string;
}

export function verificationViewOf(state: VerificationState | undefined, verdict: GateVerdict, opts: { withReason: boolean }): VerificationView {
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
