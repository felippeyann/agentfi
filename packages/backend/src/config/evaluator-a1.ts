/**
 * C3g-A1 configuration parsing (pure; `config/env.ts` applies it at boot).
 *
 *  - The recovery caps (plan P1–P16, spec §8.5): every value is REQUIRED and
 *    has NO default in code. A chain with no cap configured → `null` → every
 *    recovery execution is refused (dry-run only). A chain with some caps but
 *    not all → `null` too, reported as incomplete. A value that is present but
 *    malformed → an error (boot refuses: a typo must not silently mean
 *    "no cap" or "another cap").
 *  - The proof tag (D-g): `latest | safe | finalized | latest-K`.
 * The plan's Base Sepolia numbers live only as COMMENTED examples in
 * `.env.example` ("proposal, not authorised for pilot/mainnet").
 */
import { capsProblem, type RecoveryCaps } from '../services/escrow/evaluator-candidates.js';
import type { EvaluatorProofTag } from '../services/escrow/evaluator-rpc.js';

/** Per-chain cap variables: `<NAME>_<chainId>`. */
export const RECOVERY_CAP_CHAIN_VARS = {
  maxGasLimit: 'EVALUATOR_RECOVERY_MAX_GAS_LIMIT', // P1
  maxFeePerGasWei: 'EVALUATOR_RECOVERY_MAX_FEE_PER_GAS_WEI', // P2
  maxPriorityFeePerGasWei: 'EVALUATOR_RECOVERY_MAX_PRIORITY_FEE_PER_GAS_WEI', // P3
  minPriorityFeePerGasWei: 'EVALUATOR_RECOVERY_MIN_PRIORITY_FEE_PER_GAS_WEI', // P7 floor
  maxCostPerTxWei: 'EVALUATOR_RECOVERY_MAX_COST_WEI', // P11
  maxCostPerIncidentWei: 'EVALUATOR_RECOVERY_MAX_INCIDENT_COST_WEI', // P12
  maxCost24hWei: 'EVALUATOR_RECOVERY_MAX_DAILY_COST_WEI', // P13
  reserveWei: 'EVALUATOR_RECOVERY_RESERVE_WEI', // P14
  l1MarginWei: 'EVALUATOR_RECOVERY_L1_MARGIN_WEI', // P15
} as const;

/** Chain-independent cap variables. */
export const RECOVERY_CAP_GLOBAL_VARS = {
  multipliers: 'EVALUATOR_RECOVERY_BASE_FEE_MULTIPLIERS', // P4, comma-separated integers
  relativeBaseMultiplier: 'EVALUATOR_RECOVERY_MAX_BASE_FEE_MULTIPLE', // P5
  bumpBps: 'EVALUATOR_RECOVERY_REPLACEMENT_BUMP_BPS', // P6
  maxReplacementsPerNonce: 'EVALUATOR_RECOVERY_MAX_REPLACEMENTS_PER_NONCE', // P8
  minIntervalSeconds: 'EVALUATOR_RECOVERY_MIN_INTERVAL_SECONDS', // P9
  maxNoncesPerPlan: 'EVALUATOR_RECOVERY_MAX_RANGE_NONCES', // P16
} as const;

export type RecoveryCapsParse =
  | { kind: 'absent' }
  | { kind: 'incomplete'; missing: string[] }
  | { kind: 'invalid'; problems: string[] }
  | { kind: 'ok'; caps: RecoveryCaps };

type Source = Record<string, string | undefined>;

const val = (src: Source, name: string): string | undefined => {
  const v = src[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

/** Parses the recovery caps of `chainId`. Never invents a value. */
export function parseRecoveryCaps(src: Source, chainId: number): RecoveryCapsParse {
  const problems: string[] = [];
  const missing: string[] = [];
  let present = 0;
  const big = (name: string): bigint | null => {
    const v = val(src, name);
    if (v === undefined) {
      missing.push(name);
      return null;
    }
    present++;
    if (!/^\d+$/.test(v)) {
      problems.push(`${name} must be a non-negative integer (wei / gas), got "${v}"`);
      return null;
    }
    return BigInt(v);
  };
  const int = (name: string): number | null => {
    const b = big(name);
    if (b === null) return null;
    if (b > BigInt(Number.MAX_SAFE_INTEGER)) {
      problems.push(`${name} is too large`);
      return null;
    }
    return Number(b);
  };
  const chain = (k: keyof typeof RECOVERY_CAP_CHAIN_VARS) => `${RECOVERY_CAP_CHAIN_VARS[k]}_${chainId}`;
  const g = RECOVERY_CAP_GLOBAL_VARS;

  const perChain = {
    maxGasLimit: big(chain('maxGasLimit')),
    maxFeePerGasWei: big(chain('maxFeePerGasWei')),
    maxPriorityFeePerGasWei: big(chain('maxPriorityFeePerGasWei')),
    minPriorityFeePerGasWei: big(chain('minPriorityFeePerGasWei')),
    maxCostPerTxWei: big(chain('maxCostPerTxWei')),
    maxCostPerIncidentWei: big(chain('maxCostPerIncidentWei')),
    maxCost24hWei: big(chain('maxCost24hWei')),
    reserveWei: big(chain('reserveWei')),
    l1MarginWei: big(chain('l1MarginWei')),
  };
  const chainPresent = present;
  let multipliers: bigint[] | null = null;
  const rawMult = val(src, g.multipliers);
  if (rawMult === undefined) missing.push(g.multipliers);
  else {
    const parts = rawMult.split(',').map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) problems.push(`${g.multipliers} must be comma-separated integers, got "${rawMult}"`);
    else multipliers = parts.map((p) => BigInt(p));
  }
  const relativeBaseMultiplier = big(g.relativeBaseMultiplier);
  const bumpBps = int(g.bumpBps);
  const maxReplacementsPerNonce = int(g.maxReplacementsPerNonce);
  const minIntervalSeconds = int(g.minIntervalSeconds);
  const maxNoncesPerPlan = int(g.maxNoncesPerPlan);

  if (problems.length > 0) return { kind: 'invalid', problems };
  // No per-chain cap at all: the chain is simply not configured for recovery (the globals alone authorise nothing).
  if (chainPresent === 0) return { kind: 'absent' };
  if (missing.length > 0) return { kind: 'incomplete', missing };
  const caps: RecoveryCaps = {
    maxGasLimit: perChain.maxGasLimit!,
    maxFeePerGasWei: perChain.maxFeePerGasWei!,
    maxPriorityFeePerGasWei: perChain.maxPriorityFeePerGasWei!,
    minPriorityFeePerGasWei: perChain.minPriorityFeePerGasWei!,
    maxCostPerTxWei: perChain.maxCostPerTxWei!,
    maxCostPerIncidentWei: perChain.maxCostPerIncidentWei!,
    maxCost24hWei: perChain.maxCost24hWei!,
    reserveWei: perChain.reserveWei!,
    l1MarginWei: perChain.l1MarginWei!,
    multipliers: multipliers!,
    relativeBaseMultiplier: relativeBaseMultiplier!,
    bumpBps: bumpBps!,
    maxReplacementsPerNonce: maxReplacementsPerNonce!,
    minIntervalMs: minIntervalSeconds! * 1000,
    maxNoncesPerPlan: maxNoncesPerPlan!,
  };
  const problem = capsProblem(caps);
  if (problem) return { kind: 'invalid', problems: [`recovery caps of chain ${chainId}: ${problem.reason}${problem.detail ? ` (${problem.detail})` : ''}`] };
  return { kind: 'ok', caps };
}

/**
 * A1 review P2-2: a `safe` / `finalized` proof tag on an Anvil node (local chain or fork) never advances on
 * its own — Anvil mines only when a transaction arrives and reports `safe = latest − 32` /
 * `finalized = latest − 64` — so every A3 finalization and every proof-depth gate would wait forever.
 * Refused at boot UNLESS `EVALUATOR_PROOF_TAG` was set explicitly (the operator's choice, e.g. `latest`
 * for a rehearsal). The `safe` default stays for real chains; which tag production uses is the owner's
 * decision D-g. Returns the refusal text, or null.
 */
export function proofTagNodeProblem(input: { chainId: number; proofTag: EvaluatorProofTag; explicit: boolean; clientVersion: string | null }): string | null {
  if (input.explicit) return null;
  if (input.proofTag !== 'safe' && input.proofTag !== 'finalized') return null;
  if (!input.clientVersion || !/anvil/i.test(input.clientVersion)) return null;
  return (
    `FATAL: chain ${input.chainId} is served by an Anvil node (${input.clientVersion}) and EVALUATOR_PROOF_TAG is not set: ` +
    `the default proof tag "${String(input.proofTag)}" never advances on Anvil (it mines only on demand; safe = latest − 32), ` +
    'so no evaluator settlement would ever be finalized in the DB and every contest / resolve would wait. Set ' +
    'EVALUATOR_PROOF_TAG explicitly (e.g. EVALUATOR_PROOF_TAG=latest for a local / fork rehearsal), or run Anvil with --block-time.'
  );
}

/** `EVALUATOR_PROOF_TAG`: `latest | safe | finalized | latest-K` (K a non-negative integer of blocks). Null when malformed. */
export function parseProofTag(raw: string): EvaluatorProofTag | null {
  const v = raw.trim().toLowerCase();
  if (v === 'latest' || v === 'safe' || v === 'finalized') return v;
  const m = /^latest-(\d+)$/.exec(v);
  return m ? BigInt(m[1]!) : null;
}
