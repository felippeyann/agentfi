/**
 * Q7 — the per-process verification state of each escrow chain and the gate
 * every escrow-dependent signature consults (rules in `escrow-verification.ts`).
 *
 * Written by the boot check and its background re-check
 * (`escrow-boot.runtime.ts`); read by:
 *  - the pre-submit guard (a queued escrow / ERC-8004 transaction is DEFERRED,
 *    never failed or unwound, while its chain is not verified);
 *  - the evaluator settlement (`Erc8183Deps.configGate`: deferred and
 *    rescheduled, not counted as a failure);
 *  - the job routes (`503 ESCROW_CONFIG_UNVERIFIED` before anything is written);
 *  - `/health/ready` and `GET /admin/escrow/verification` (diagnostics).
 *
 * In memory, per process: the API and the worker each verify their own
 * environment; a restart starts unverified. Tests mock this module.
 */

import type { Address } from 'viem';
import { getKnownTokenBySymbol } from '../services/transaction/token-registry.js';
import { getContracts, resolveIdentityRegistry, resolveReputationRegistry } from './contracts.js';
import { configuredEscrowChainIds, env, escrowEvaluatorAddress } from './env.js';
import type { EscrowChainCheck, EscrowChainExpectation } from './escrow-boot-check.js';
import {
  escrowGateVerdict,
  stateAfterCheck,
  verificationView,
  type EscrowGateVerdict,
  type EscrowVerificationSettings,
  type EscrowVerificationState,
  type EscrowVerificationView,
} from './escrow-verification.js';

/**
 * Every chain with an escrow address: what the deployment check verifies
 * (escrow.token() and eth_chainId always; the hook's wiring when a hook is
 * configured), and what a verification is bound to (its fingerprint).
 */
export function escrowExpectations(): EscrowChainExpectation[] {
  const expectations: EscrowChainExpectation[] = [];
  for (const chainId of configuredEscrowChainIds) {
    let contracts: ReturnType<typeof getContracts>;
    try {
      contracts = getContracts(chainId);
    } catch {
      continue;
    }
    if (!contracts.agentJobEscrow) continue;
    expectations.push({
      chainId,
      escrow: contracts.agentJobEscrow,
      hook: contracts.reputationHook ?? null,
      evaluator: escrowEvaluatorAddress,
      identityRegistry: resolveIdentityRegistry(chainId) ?? null,
      reputationRegistry: resolveReputationRegistry(chainId) ?? null,
      usdc: (getKnownTokenBySymbol('USDC', chainId)?.address as Address | undefined) ?? null,
    });
  }
  return expectations;
}

export function escrowVerificationSettings(): EscrowVerificationSettings {
  return { ttlSeconds: env.ESCROW_CONFIG_VERIFIED_TTL_SECONDS, recheckSeconds: env.ESCROW_CONFIG_RECHECK_SECONDS };
}

const states = new Map<number, EscrowVerificationState>();

export interface VerificationTransition {
  chainId: number;
  previous: EscrowVerificationState | undefined;
  current: EscrowVerificationState;
}

/**
 * Records the result of one read of each chain and returns the chains whose
 * state KIND changed (verified ↔ unverified ↔ mismatch, or a first state):
 * the caller logs / alerts once per change, not once per read.
 */
export function recordEscrowChecks(
  checks: readonly EscrowChainCheck[],
  expectations: readonly EscrowChainExpectation[],
  now: Date = new Date(),
): VerificationTransition[] {
  const transitions: VerificationTransition[] = [];
  for (const check of checks) {
    const expectation = expectations.find((e) => e.chainId === check.chainId);
    if (!expectation) continue;
    const previous = states.get(check.chainId);
    const current = stateAfterCheck(previous, check, expectation, now);
    states.set(check.chainId, current);
    if (previous?.kind !== current.kind) transitions.push({ chainId: check.chainId, previous, current });
  }
  return transitions;
}

/** The gate: may a NEW escrow-dependent signature on `chainId` go ahead now? */
export function escrowConfigGate(chainId: number, now: Date = new Date()): EscrowGateVerdict {
  return escrowGateVerdict({
    chainId,
    state: states.get(chainId),
    expectation: escrowExpectations().find((e) => e.chainId === chainId) ?? null,
    now,
    settings: escrowVerificationSettings(),
  });
}

/** Every configured chain as diagnostics show it (`withReason` only for authenticated operators). */
export function escrowVerificationSnapshot(opts: { withReason: boolean }, now: Date = new Date()): EscrowVerificationView[] {
  return escrowExpectations().map((expectation) =>
    verificationView(states.get(expectation.chainId), escrowConfigGate(expectation.chainId, now), opts),
  );
}

/** Testing hook. */
export function __resetEscrowVerificationForTests(): void {
  states.clear();
}
