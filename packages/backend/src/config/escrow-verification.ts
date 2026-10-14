/**
 * Q7 (owner decision, 2026-10-14): no new escrow signature or fund movement
 * while the on-chain configuration is unverified.
 *
 * C3d's boot check (`escrow-boot-check.ts`) reads, per chain, `escrow.token()`
 * and — with a hook — the hook's `acp / trustedEvaluator / identityRegistry /
 * reputationRegistry`; Q7 adds `eth_chainId`; S9 adds the escrow's and the
 * hook's RUNTIME CODE, compared with this repository's build. Its result
 * becomes a per-process, per-chain VERIFICATION STATE, and every
 * escrow-dependent signature consults it through `escrowGateVerdict`.
 *
 * The lifecycle (verified / unverified / mismatch, TTL, revocation by any
 * failed read, fingerprint) is the shared one in `verification-state.ts`.
 * The fingerprint binds the expectation (chainId, escrow, hook, evaluator,
 * both registries, USDC) AND the expected-code version of this build.
 *
 * Kept per process on purpose (no Redis cache): the API and the worker each
 * verify with their own environment, and a restart with a new environment
 * starts unverified. Pure: no env, no clock, no I/O.
 */

import { createHash } from 'node:crypto';
import { EXPECTED_CONTRACT_CODE_VERSION } from '../abi/contract-code.generated.js';
import type { EscrowChainCheck, EscrowChainExpectation } from './escrow-boot-check.js';
import {
  gateVerdict,
  nextVerificationState,
  verificationViewOf,
  type GateBlock,
  type GateVerdict,
  type VerificationSettings,
  type VerificationState,
  type VerificationView,
  type VerificationWording,
} from './verification-state.js';

export type EscrowVerificationState = VerificationState;
export type EscrowGateBlock = GateBlock;
export type EscrowGateVerdict = GateVerdict;
export type EscrowVerificationSettings = VerificationSettings;
export type EscrowVerificationView = VerificationView;

const lower = (value: string | null) => (value ? value.toLowerCase() : null);

const ESCROW_WORDING: VerificationWording = {
  notConfigured: (chainId) => `no ERC-8183 escrow is configured for chain ${chainId} in this process`,
  subject: (chainId) => `the ERC-8183 configuration of chain ${chainId}`,
  deployed: (chainId) => `the deployed ERC-8183 escrow / hook on chain ${chainId}`,
};

/** sha256 of the canonical expectation (addresses lowercased, fixed field order) and the expected-code version. */
export function expectationFingerprint(expectation: EscrowChainExpectation): string {
  const canonical = JSON.stringify([
    expectation.chainId,
    lower(expectation.escrow),
    lower(expectation.hook),
    lower(expectation.evaluator),
    lower(expectation.identityRegistry),
    lower(expectation.reputationRegistry),
    lower(expectation.usdc),
    EXPECTED_CONTRACT_CODE_VERSION,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The state after one read of `expectation` (see `nextVerificationState`). */
export function stateAfterCheck(
  previous: EscrowVerificationState | undefined,
  check: Pick<EscrowChainCheck, 'problems' | 'unreadable'>,
  expectation: EscrowChainExpectation,
  now: Date,
): EscrowVerificationState {
  return nextVerificationState(previous, check, expectationFingerprint(expectation), now);
}

/**
 * May an escrow-dependent signature on `chainId` go ahead now? Allowed only
 * for a verified state younger than the TTL whose fingerprint is the current
 * expectation's.
 */
export function escrowGateVerdict(params: {
  chainId: number;
  state: EscrowVerificationState | undefined;
  /** What this process is configured with for the chain now (null: no escrow on it). */
  expectation: EscrowChainExpectation | null;
  now: Date;
  settings: EscrowVerificationSettings;
}): EscrowGateVerdict {
  return gateVerdict({
    chainId: params.chainId,
    state: params.state,
    fingerprint: params.expectation ? expectationFingerprint(params.expectation) : null,
    now: params.now,
    settings: params.settings,
    wording: ESCROW_WORDING,
  });
}

/** The view of one chain from its state and the gate verdict. */
export function verificationView(
  state: EscrowVerificationState | undefined,
  verdict: EscrowGateVerdict,
  opts: { withReason: boolean },
): EscrowVerificationView {
  return verificationViewOf(state, verdict, opts);
}
