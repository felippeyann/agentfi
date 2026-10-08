/**
 * The orchestrator dependencies the C3c regression suite is currently
 * running with. The suite mocks `escrow-erc8183.runtime.js` with functions
 * that call the real orchestrator through `simDeps()`, so the real routes,
 * the real transaction processor and the real payment-recovery tick all
 * reach the orchestrator bound to the per-test fake chain and fake queues.
 *
 * Kept free of imports from the code under test so the runtime mock can load
 * it without an import cycle.
 */

import type { Erc8183Config, Erc8183Deps } from '../../services/job/escrow-erc8183.service.js';

let current: Erc8183Deps | null = null;

export function setSimDeps(deps: Erc8183Deps | null): void {
  current = deps;
}

export function simDeps(): Erc8183Deps {
  if (!current) throw new Error('escrow simulation deps are not set (setSimDeps in beforeEach)');
  return current;
}

type Repoll = (opts?: { olderThanMs?: number; dropAfterMs?: number; limit?: number }) => Promise<unknown>;
let repoll: Repoll | null = null;

/** The suite's `repollSubmittedTransactionsNow` (real re-poll bound to the fake chain). */
export function setSimRepoll(fn: Repoll | null): void {
  repoll = fn;
}

export function simRepoll(): Repoll {
  if (!repoll) throw new Error('escrow simulation re-poll is not set');
  return repoll;
}

/** Static config (addresses must match fake-escrow-chain.ts). */
export const SIM_EVALUATOR = '0x000000000000000000000000000000000000EA1d' as const;

export const simConfig: Erc8183Config = {
  evaluatorAddress: SIM_EVALUATOR,
  jobTtlSeconds: 3600,
  evaluationDelaySeconds: 0,
  backendPublicUrl: 'https://api.sim.test',
  chain: (chainId) =>
    chainId === 84532
      ? { chainId, escrow: '0x00000000000000000000000000000000000e5c20', hook: '0x000000000000000000000000000000000000400C' }
      : null,
  identityRegistry: (chainId) => (chainId === 84532 ? '0x8004A818BFB912233c491871b3d84c89A494BD9e' : null),
  evaluatorMinBalanceWei: 5n * 10n ** 14n,
};
