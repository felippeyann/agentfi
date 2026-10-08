/**
 * Boot check of the deployed ERC-8183 escrow + ReputationHook (task C3d,
 * second adversarial review 2026-10-08).
 *
 * The backend trusts the addresses in `AGENT_JOB_ESCROW_ADDRESS_<id>` /
 * `REPUTATION_HOOK_ADDRESS_<id>` blindly: nothing verified that the hook was
 * deployed for THIS escrow, THIS evaluator key and the registries the backend
 * mints identities in. Each mismatch fails differently and late:
 *
 *   hook.acp() ≠ escrow                    every hooked call reverts (OnlyACP) — submit,
 *                                          complete and reject included; funds wait for expiry
 *   hook.trustedEvaluator() ≠ evaluator    every settlement skips feedback ("untrusted-evaluator")
 *   hook.identityRegistry() ≠ configured   providers are minted in one registry, verified in
 *                                          another: no canonical id, feedback skipped forever
 *   hook.reputationRegistry() ≠ configured feedback lands in a registry nobody reads
 *   escrow.token() ≠ USDC of the chain     budgets priced at 1 USD are not USDC
 *
 * So at backend and worker boot, for every chain with both addresses, the
 * five values are read and compared with the configuration. A mismatch is
 * FATAL in production / staging (the process refuses to boot) and a loud
 * error in development / test. A chain whose contracts cannot be read (RPC
 * down) is an error, never silently "ok"; the runtime re-checks it in the
 * background and applies the same rule once it can read it.
 *
 * Pure apart from `checkEscrowDeployments`, which takes the contract reader
 * as a parameter, so every rule is unit-testable without an RPC.
 */

import { getAddress, type Abi, type Address } from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';
import { PRODUCTION_LIKE } from './env-guards.js';

/** What the backend is configured with for one escrow chain. */
export interface EscrowChainExpectation {
  chainId: number;
  escrow: Address;
  hook: Address;
  /** Address of ESCROW_EVALUATOR_PRIVATE_KEY (null: escrow disabled, nothing to compare). */
  evaluator: Address | null;
  /** IDENTITY_REGISTRY_ADDRESS_<id> or the official default (null: none configured). */
  identityRegistry: Address | null;
  /** REPUTATION_REGISTRY_ADDRESS_<id> or the official default (null: none configured). */
  reputationRegistry: Address | null;
  /** USDC of the chain in the token registry (null: none registered). */
  usdc: Address | null;
}

/** What the chain says. */
export interface EscrowChainReading {
  token: Address;
  acp: Address;
  trustedEvaluator: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
}

export interface EscrowChainCheck {
  chainId: number;
  escrow: Address;
  hook: Address;
  /** Mismatches between the chain and the configuration. */
  problems: string[];
  /** Values that could not be compared (nothing configured to compare with). */
  notes: string[];
  /** Set when the contracts could not be read; `problems` is then empty. */
  unreadable: string | null;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Compares one chain's reading with its expectation. Pure. */
export function compareEscrowDeployment(
  expected: EscrowChainExpectation,
  reading: EscrowChainReading,
): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const label = `chain ${expected.chainId}`;

  if (!same(reading.acp, expected.escrow)) {
    problems.push(
      `${label}: ReputationHook ${expected.hook}.acp() is ${reading.acp}, not AGENT_JOB_ESCROW_ADDRESS_${expected.chainId}=${expected.escrow} ` +
        '(every hooked submit / complete / reject would revert with OnlyACP)',
    );
  }
  if (expected.evaluator === null) {
    notes.push(`${label}: no ESCROW_EVALUATOR_PRIVATE_KEY — hook.trustedEvaluator() (${reading.trustedEvaluator}) not compared`);
  } else if (!same(reading.trustedEvaluator, expected.evaluator)) {
    problems.push(
      `${label}: hook.trustedEvaluator() is ${reading.trustedEvaluator}, but the backend evaluator (ESCROW_EVALUATOR_PRIVATE_KEY) is ` +
        `${expected.evaluator} (every settlement would skip feedback: untrusted-evaluator)`,
    );
  }
  if (expected.identityRegistry === null) {
    notes.push(`${label}: no Identity Registry configured — hook.identityRegistry() (${reading.identityRegistry}) not compared`);
  } else if (!same(reading.identityRegistry, expected.identityRegistry)) {
    problems.push(
      `${label}: hook.identityRegistry() is ${reading.identityRegistry}, but the backend mints identities in ${expected.identityRegistry} ` +
        `(IDENTITY_REGISTRY_ADDRESS_${expected.chainId} or the official default; bindings would never verify)`,
    );
  }
  if (expected.reputationRegistry === null) {
    notes.push(`${label}: no Reputation Registry configured — hook.reputationRegistry() (${reading.reputationRegistry}) not compared`);
  } else if (!same(reading.reputationRegistry, expected.reputationRegistry)) {
    problems.push(
      `${label}: hook.reputationRegistry() is ${reading.reputationRegistry}, expected ${expected.reputationRegistry} ` +
        `(REPUTATION_REGISTRY_ADDRESS_${expected.chainId} or the official default)`,
    );
  }
  if (expected.usdc === null) {
    notes.push(`${label}: no USDC in the token registry — escrow.token() (${reading.token}) not compared`);
  } else if (!same(reading.token, expected.usdc)) {
    problems.push(
      `${label}: AgentJobEscrow ${expected.escrow}.token() is ${reading.token}, not the chain's USDC ${expected.usdc} ` +
        '(budgets are priced as USDC at 1.00 USD and approved on the registry USDC)',
    );
  }
  return { problems, notes };
}

/** `readContract` of one chain (a viem public client satisfies it). */
export type ContractReader = (params: { address: Address; abi: Abi; functionName: string }) => Promise<unknown>;

async function readOnce(read: ContractReader, expected: EscrowChainExpectation): Promise<EscrowChainReading> {
  const hookCall = (functionName: string) => read({ address: expected.hook, abi: REPUTATION_HOOK_ABI as unknown as Abi, functionName });
  const [token, acp, trustedEvaluator, identityRegistry, reputationRegistry] = await Promise.all([
    read({ address: expected.escrow, abi: AGENT_JOB_ESCROW_ABI as unknown as Abi, functionName: 'token' }),
    hookCall('acp'),
    hookCall('trustedEvaluator'),
    hookCall('identityRegistry'),
    hookCall('reputationRegistry'),
  ]);
  return {
    token: getAddress(token as string),
    acp: getAddress(acp as string),
    trustedEvaluator: getAddress(trustedEvaluator as string),
    identityRegistry: getAddress(identityRegistry as string),
    reputationRegistry: getAddress(reputationRegistry as string),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

/**
 * Reads and compares every chain. A chain that cannot be read within
 * `timeoutMs` (per attempt, `attempts` tries) is reported `unreadable`.
 */
export async function checkEscrowDeployments(params: {
  chains: readonly EscrowChainExpectation[];
  reader: (chainId: number) => ContractReader;
  timeoutMs?: number;
  attempts?: number;
}): Promise<EscrowChainCheck[]> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const attempts = Math.max(1, params.attempts ?? 2);
  return Promise.all(
    params.chains.map(async (expected): Promise<EscrowChainCheck> => {
      let lastError = 'unknown error';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const reading = await withTimeout(readOnce(params.reader(expected.chainId), expected), timeoutMs);
          return { chainId: expected.chainId, escrow: expected.escrow, hook: expected.hook, ...compareEscrowDeployment(expected, reading), unreadable: null };
        } catch (err) {
          lastError = (err as Error)?.message?.split('\n')[0] ?? String(err);
        }
      }
      return { chainId: expected.chainId, escrow: expected.escrow, hook: expected.hook, problems: [], notes: [], unreadable: lastError };
    }),
  );
}

export interface EscrowBootVerdict {
  /** Set in production / staging when any chain has a mismatch: the process must not boot. */
  fatal: string | null;
  /** Mismatches outside production (loud), and unreadable chains (every environment). */
  errors: string[];
  /** Values that could not be compared. */
  warnings: string[];
  /** Chains whose deployment matched the configuration. */
  verified: number[];
  /** Chains that could not be read (re-checked in the background by the runtime). */
  unreadable: number[];
}

/** Turns the checks into what the process does. Pure. */
export function escrowBootVerdict(nodeEnv: string, checks: readonly EscrowChainCheck[]): EscrowBootVerdict {
  const problems = checks.flatMap((check) => check.problems);
  const strict = PRODUCTION_LIKE.has(nodeEnv);
  const unreadable = checks.filter((check) => check.unreadable !== null);
  return {
    fatal:
      strict && problems.length > 0
        ? `FATAL: the deployed ERC-8183 escrow / ReputationHook does not match the backend configuration with NODE_ENV=${nodeEnv}: ` +
          `${problems.join('; ')}. Fix the addresses / ESCROW_EVALUATOR_PRIVATE_KEY / registry overrides, or redeploy the hook with ` +
          'script/DeployEscrow.s.sol (docs/operations/contract-deployment.md, "ERC-8183 escrow and ERC-8004 hook").'
        : null,
    errors: [
      ...(strict ? [] : problems.map((problem) => `ERC-8183 deployment mismatch (would be FATAL in production/staging): ${problem}`)),
      ...unreadable.map(
        (check) =>
          `ERC-8183 deployment on chain ${check.chainId} could not be verified (escrow ${check.escrow}, hook ${check.hook}): ${check.unreadable} — ` +
          're-checked in the background',
      ),
    ],
    warnings: checks.flatMap((check) => check.notes),
    verified: checks.filter((check) => check.unreadable === null && check.problems.length === 0).map((check) => check.chainId),
    unreadable: unreadable.map((check) => check.chainId),
  };
}
