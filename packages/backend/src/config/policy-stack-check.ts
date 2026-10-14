/**
 * S9 (owner decision 2026-10-14) — verification of the AgentExecutor /
 * AgentPolicyModule a chain is configured with, BEFORE they get authority or
 * value: executor-routed transactions (the executor receives their value),
 * the on-chain policy sync (S8: the agent wallet writes its policy to the
 * module), the Safe module enablement (a Safe module may move everything the
 * Safe holds).
 *
 * Per chain, in this order (each step is conclusive when it fails):
 *   1. `eth_chainId` of the RPC is the configured chain;
 *   2. the executor's runtime code is this build's AgentExecutor
 *      (`contract-identity.ts`; an EOA, a foreign contract, a lookalike, a
 *      proxy or a legacy build fail);
 *   3. its bindings (views of OUR code, so they are its immutables):
 *      `feeWallet()` = OPERATOR_FEE_WALLET, `feeBps()` = the fee the backend
 *      adds to `msg.value`, `policyModule()` = POLICY_MODULE_ADDRESS_<id>
 *      when configured (otherwise the policy the backend syncs would never be
 *      enforced — reproduced on Anvil);
 *   4. the module (the configured one, else the executor's) runs this build's
 *      AgentPolicyModule, and `operator()` = POLICY_OPERATOR_ADDRESS_<id>
 *      (required in production / staging when a module is configured).
 * A code or view that answers "not me" is a MISMATCH (FATAL in production /
 * staging); only a transport error or a timeout is UNREADABLE (operations
 * wait, nothing fails).
 *
 * Pure apart from `checkPolicyStacks`, which takes the readers as parameters.
 */
import { getAddress, type Abi, type Address } from 'viem';
import { AGENT_EXECUTOR_ABI } from '../abi/AgentExecutor.abi.js';
import { AGENT_POLICY_MODULE_ABI_FULL } from '../abi/AgentPolicyModule.abi.js';
import { sanitizeText } from '../api/errors/sanitize.js';
import { PRODUCTION_LIKE } from './env-guards.js';
import {
  codeIdentityProblems,
  isDefinitiveContractError,
  type ChainIdReader,
  type CodeReader,
  type ContractReader,
} from './escrow-boot-check.js';

/** What the backend is configured with for one chain's executor / module. */
export interface PolicyStackExpectation {
  chainId: number;
  /** EXECUTOR_ADDRESS_<id> (a known legacy address resolves to null). */
  executor: Address | null;
  /** POLICY_MODULE_ADDRESS_<id>. */
  policyModule: Address | null;
  /** POLICY_OPERATOR_ADDRESS_<id> — the module's expected `operator()` (null: not compared, a note). */
  operator: Address | null;
  /** OPERATOR_FEE_WALLET — the executor's expected `feeWallet()`. */
  feeWallet: Address;
  /** The fee the backend adds to `msg.value` (executor.service.ts FEE_BPS) — the executor's expected `feeBps()`. */
  feeBps: bigint;
}

export interface PolicyStackCheck {
  chainId: number;
  executor: Address | null;
  policyModule: Address | null;
  problems: string[];
  notes: string[];
  unreadable: string | null;
}

class StackMismatchError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function firstLine(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | null;
  return sanitizeText((e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0] ?? '') || 'unknown error';
}

async function view(read: ContractReader, address: Address, abi: Abi, functionName: string, label: string): Promise<unknown> {
  try {
    return await read({ address, abi, functionName });
  } catch (err) {
    if (isDefinitiveContractError(err)) throw new StackMismatchError([`${label}.${functionName}() ${firstLine(err)}`]);
    throw err;
  }
}

async function readOnce(
  read: ContractReader,
  readCode: CodeReader,
  expected: PolicyStackExpectation,
  readChainId: ChainIdReader,
): Promise<{ notes: string[] }> {
  const label = `chain ${expected.chainId}`;
  const notes: string[] = [];
  const served = await readChainId();
  if (Number(served) !== expected.chainId) {
    throw new StackMismatchError([
      `${label}: the RPC answers eth_chainId ${String(served)}, not ${expected.chainId} (RPC_URL_${expected.chainId} or the provider serves another network)`,
    ]);
  }

  let module = expected.policyModule;
  if (expected.executor) {
    const identity = await codeIdentityProblems(readCode, [
      { name: 'AgentExecutor', address: expected.executor, label: `${label}: EXECUTOR_ADDRESS_${expected.chainId}` },
    ]);
    if (identity.length > 0) throw new StackMismatchError(identity);

    const executorAbi = AGENT_EXECUTOR_ABI as unknown as Abi;
    const [boundModule, feeWallet, feeBps] = await Promise.all([
      view(read, expected.executor, executorAbi, 'policyModule', 'executor'),
      view(read, expected.executor, executorAbi, 'feeWallet', 'executor'),
      view(read, expected.executor, executorAbi, 'feeBps', 'executor'),
    ]);
    const problems: string[] = [];
    const bound = getAddress(String(boundModule));
    if (!same(String(feeWallet), expected.feeWallet)) {
      problems.push(`${label}: executor.feeWallet() is ${String(feeWallet)}, not OPERATOR_FEE_WALLET=${expected.feeWallet} (fees would be recorded for a wallet that never receives them)`);
    }
    if (BigInt(feeBps as bigint) !== expected.feeBps) {
      problems.push(`${label}: executor.feeBps() is ${String(feeBps)}, the backend adds ${expected.feeBps} bps to msg.value (every fee-bearing call would revert or overpay)`);
    }
    if (expected.policyModule && !same(bound, expected.policyModule)) {
      problems.push(
        `${label}: the executor enforces AgentPolicyModule ${bound}, not POLICY_MODULE_ADDRESS_${expected.chainId}=${expected.policyModule} ` +
          '(a policy synced to the configured module would never be enforced)',
      );
    }
    if (problems.length > 0) throw new StackMismatchError(problems);
    if (!expected.policyModule) {
      notes.push(`${label}: no POLICY_MODULE_ADDRESS_${expected.chainId} — the executor's module ${bound} is verified, the on-chain policy sync is unavailable`);
    }
    module ??= bound;
  }

  if (module) {
    const moduleLabel = expected.policyModule ? `POLICY_MODULE_ADDRESS_${expected.chainId}` : 'executor.policyModule()';
    const identity = await codeIdentityProblems(readCode, [{ name: 'AgentPolicyModule', address: module, label: `${label}: ${moduleLabel}` }]);
    if (identity.length > 0) throw new StackMismatchError(identity);
    const operator = await view(read, module, AGENT_POLICY_MODULE_ABI_FULL as unknown as Abi, 'operator', 'policyModule');
    if (expected.operator === null) {
      notes.push(`${label}: no POLICY_OPERATOR_ADDRESS_${expected.chainId} — the module's operator() (${String(operator)}) is not compared`);
    } else if (!same(String(operator), expected.operator)) {
      throw new StackMismatchError([
        `${label}: the policy module's operator() is ${String(operator)}, not POLICY_OPERATOR_ADDRESS_${expected.chainId}=${expected.operator} ` +
          '(another key could set every agent\'s on-chain policy)',
      ]);
    }
  }
  return { notes };
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

/** Reads and compares every chain (`attempts` tries of `timeoutMs` each; only a transport failure makes a chain unreadable). */
export async function checkPolicyStacks(params: {
  chains: readonly PolicyStackExpectation[];
  reader: (chainId: number) => ContractReader;
  codeReader: (chainId: number) => CodeReader;
  chainIdReader: (chainId: number) => ChainIdReader;
  timeoutMs?: number;
  attempts?: number;
}): Promise<PolicyStackCheck[]> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const attempts = Math.max(1, params.attempts ?? 2);
  return Promise.all(
    params.chains.map(async (expected): Promise<PolicyStackCheck> => {
      const base = { chainId: expected.chainId, executor: expected.executor, policyModule: expected.policyModule };
      let lastError = 'unknown error';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const { notes } = await withTimeout(
            readOnce(params.reader(expected.chainId), params.codeReader(expected.chainId), expected, params.chainIdReader(expected.chainId)),
            timeoutMs,
          );
          return { ...base, problems: [], notes, unreadable: null };
        } catch (err) {
          if (err instanceof StackMismatchError) return { ...base, problems: err.problems, notes: [], unreadable: null };
          lastError = firstLine(err);
        }
      }
      return { ...base, problems: [], notes: [], unreadable: lastError };
    }),
  );
}

export interface PolicyStackBootVerdict {
  fatal: string | null;
  errors: string[];
  warnings: string[];
  verified: number[];
  unreadable: number[];
}

/** Turns the checks into what the process does (FATAL on a mismatch in production / staging). Pure. */
export function policyStackBootVerdict(nodeEnv: string, checks: readonly PolicyStackCheck[]): PolicyStackBootVerdict {
  const problems = checks.flatMap((check) => check.problems);
  const strict = PRODUCTION_LIKE.has(nodeEnv);
  const unreadable = checks.filter((check) => check.unreadable !== null);
  return {
    fatal:
      strict && problems.length > 0
        ? `FATAL: the deployed AgentExecutor / AgentPolicyModule does not match this build and configuration with NODE_ENV=${nodeEnv}: ` +
          `${problems.join('; ')}. Deploy from this repository's build (script/Deploy.s.sol) and fix EXECUTOR_ADDRESS_<id> / ` +
          'POLICY_MODULE_ADDRESS_<id> / POLICY_OPERATOR_ADDRESS_<id> / OPERATOR_FEE_WALLET (docs/operations/contract-deployment.md).'
        : null,
    errors: [
      ...(strict ? [] : problems.map((problem) => `AgentExecutor / AgentPolicyModule mismatch (would be FATAL in production/staging): ${problem}`)),
      ...unreadable.map(
        (check) =>
          `AgentExecutor / AgentPolicyModule on chain ${check.chainId} could not be verified (executor ${check.executor ?? 'none'}, module ` +
          `${check.policyModule ?? 'none'}): ${check.unreadable} — re-checked in the background`,
      ),
    ],
    warnings: checks.flatMap((check) => check.notes),
    verified: checks.filter((check) => check.unreadable === null && check.problems.length === 0).map((check) => check.chainId),
    unreadable: unreadable.map((check) => check.chainId),
  };
}
