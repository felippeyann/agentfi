/**
 * S9 — the per-process verification state of each chain's AgentExecutor /
 * AgentPolicyModule and the gate every operation that gives them authority or
 * value consults (checks in `policy-stack-check.ts`, lifecycle in
 * `verification-state.ts` — the same as Q7's escrow verification).
 *
 * Written by the boot check and its background re-check
 * (`policy-stack-boot.runtime.ts`); read by:
 *  - the transaction routes: an executor-routed transaction answers
 *    `503 CONTRACTS_UNVERIFIED` before anything is written;
 *  - the pre-submit guard: a queued executor-routed transaction or a policy
 *    sync is DEFERRED (no attempt consumed, nothing failed) while unverified;
 *  - the policy sync (`POST /admin/agents/:id/policy/sync`, kill switch);
 *  - the Safe deployment (no module enablement unless verified);
 *  - `GET /admin/contracts/verification` (diagnostics).
 *
 * In memory, per process; a restart starts unverified.
 */

import { createHash } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { EXPECTED_CONTRACT_CODE_VERSION } from '../abi/contract-code.generated.js';
import { FEE_BPS } from '../services/transaction/executor.service.js';
import { CONTRACT_ADDRESSES, getContracts } from './contracts.js';
import { env } from './env.js';
import type { PolicyStackCheck, PolicyStackExpectation } from './policy-stack-check.js';
import {
  gateVerdict,
  nextVerificationState,
  verificationViewOf,
  type GateVerdict,
  type VerificationSettings,
  type VerificationState,
  type VerificationView,
  type VerificationWording,
} from './verification-state.js';

const WORDING: VerificationWording = {
  notConfigured: (chainId) => `no AgentExecutor / AgentPolicyModule is configured for chain ${chainId} in this process`,
  subject: (chainId) => `the AgentExecutor / AgentPolicyModule configuration of chain ${chainId}`,
  deployed: (chainId) => `the deployed AgentExecutor / AgentPolicyModule on chain ${chainId}`,
};

function configuredOperator(chainId: number): Address | null {
  const raw = (process.env[`POLICY_OPERATOR_ADDRESS_${chainId}`] ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? getAddress(raw) : null;
}

/** Every chain with an executor or a policy module configured in this process. */
export function policyStackExpectations(): PolicyStackExpectation[] {
  const expectations: PolicyStackExpectation[] = [];
  for (const chainId of Object.keys(CONTRACT_ADDRESSES).map(Number)) {
    const contracts = getContracts(chainId);
    const executor = contracts.executor ?? null;
    const policyModule = contracts.policyModule ?? null;
    if (!executor && !policyModule) continue;
    expectations.push({
      chainId,
      executor,
      policyModule,
      operator: configuredOperator(chainId),
      feeWallet: getAddress(env.OPERATOR_FEE_WALLET),
      feeBps: FEE_BPS,
    });
  }
  return expectations;
}

/** sha256 of the canonical expectation and the expected-code version of this build. */
export function policyStackFingerprint(expectation: PolicyStackExpectation): string {
  const lower = (value: string | null) => (value ? value.toLowerCase() : null);
  return createHash('sha256')
    .update(
      JSON.stringify([
        expectation.chainId,
        lower(expectation.executor),
        lower(expectation.policyModule),
        lower(expectation.operator),
        lower(expectation.feeWallet),
        expectation.feeBps.toString(),
        EXPECTED_CONTRACT_CODE_VERSION,
      ]),
    )
    .digest('hex');
}

export function policyStackVerificationSettings(): VerificationSettings {
  // Same cadence as the escrow verification (Q7): one TTL / re-check pair for the on-chain configuration.
  return { ttlSeconds: env.ESCROW_CONFIG_VERIFIED_TTL_SECONDS, recheckSeconds: env.ESCROW_CONFIG_RECHECK_SECONDS };
}

const states = new Map<number, VerificationState>();

export interface PolicyStackTransition {
  chainId: number;
  previous: VerificationState | undefined;
  current: VerificationState;
}

/** Records one read of each chain; returns the chains whose state KIND changed (log / alert once per change). */
export function recordPolicyStackChecks(
  checks: readonly PolicyStackCheck[],
  expectations: readonly PolicyStackExpectation[],
  now: Date = new Date(),
): PolicyStackTransition[] {
  const transitions: PolicyStackTransition[] = [];
  for (const check of checks) {
    const expectation = expectations.find((e) => e.chainId === check.chainId);
    if (!expectation) continue;
    const previous = states.get(check.chainId);
    const current = nextVerificationState(previous, check, policyStackFingerprint(expectation), now);
    states.set(check.chainId, current);
    if (previous?.kind !== current.kind) transitions.push({ chainId: check.chainId, previous, current });
  }
  return transitions;
}

/**
 * The gate: may an operation that gives the chain's executor / module
 * authority or value go ahead now? `not-configured` when the chain has
 * neither (callers that do not use them never ask).
 */
export function policyStackGate(chainId: number, now: Date = new Date()): GateVerdict {
  const expectation = policyStackExpectations().find((e) => e.chainId === chainId) ?? null;
  return gateVerdict({
    chainId,
    state: states.get(chainId),
    fingerprint: expectation ? policyStackFingerprint(expectation) : null,
    now,
    settings: policyStackVerificationSettings(),
    wording: WORDING,
  });
}

/** Every configured chain as diagnostics show it. */
export function policyStackSnapshot(opts: { withReason: boolean }, now: Date = new Date()): VerificationView[] {
  return policyStackExpectations().map((expectation) =>
    verificationViewOf(states.get(expectation.chainId), policyStackGate(expectation.chainId, now), opts),
  );
}

/** Testing hook. */
export function __resetPolicyStackVerificationForTests(): void {
  states.clear();
}
