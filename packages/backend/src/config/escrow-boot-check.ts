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
 * So at backend and worker boot, for every chain with an escrow address, the
 * values are read and compared with the configuration (escrow.token() always,
 * the four hook views when a hook is configured). A mismatch is FATAL in
 * production / staging (the process refuses to boot) and a loud error in
 * development / test. An address with no code, a view that reverts or returns
 * zero / undecodable data is a mismatch too ("no ReputationHook at X": a typo
 * or the wrong chain), not "unreadable". Only a transport error or a timeout
 * (RPC down) makes a chain unreadable: an error, never silently "ok"; the
 * runtime re-checks it in the background and applies the same rule once it
 * can read it.
 *
 * Pure apart from `checkEscrowDeployments`, which takes the contract reader
 * as a parameter, so every rule is unit-testable without an RPC.
 */

import { getAddress, type Abi, type Address } from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';
import { sanitizeText } from '../api/errors/sanitize.js';
import { PRODUCTION_LIKE } from './env-guards.js';

/** What the backend is configured with for one escrow chain. */
export interface EscrowChainExpectation {
  chainId: number;
  escrow: Address;
  /** REPUTATION_HOOK_ADDRESS_<id>, or null: only the escrow is checked. */
  hook: Address | null;
  /** Address of ESCROW_EVALUATOR_PRIVATE_KEY (null: escrow disabled, nothing to compare). */
  evaluator: Address | null;
  /** IDENTITY_REGISTRY_ADDRESS_<id> or the official default (null: none configured). */
  identityRegistry: Address | null;
  /** REPUTATION_REGISTRY_ADDRESS_<id> or the official default (null: none configured). */
  reputationRegistry: Address | null;
  /** USDC of the chain in the token registry (null: none registered). */
  usdc: Address | null;
}

/** What the chain says (the hook views are absent when no hook is configured). */
export interface EscrowChainReading {
  token: Address;
  acp?: Address;
  trustedEvaluator?: Address;
  identityRegistry?: Address;
  reputationRegistry?: Address;
}

export interface EscrowChainCheck {
  chainId: number;
  escrow: Address;
  hook: Address | null;
  /** Mismatches between the chain and the configuration (incl. "no contract at the address"). */
  problems: string[];
  /** Values that could not be compared (nothing configured to compare with). */
  notes: string[];
  /** Set when the RPC could not be reached (transport error, timeout); `problems` is then empty. */
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

  const hook =
    reading.acp && reading.trustedEvaluator && reading.identityRegistry && reading.reputationRegistry
      ? {
          acp: reading.acp,
          trustedEvaluator: reading.trustedEvaluator,
          identityRegistry: reading.identityRegistry,
          reputationRegistry: reading.reputationRegistry,
        }
      : null;
  if (expected.hook === null || !hook) {
    notes.push(`${label}: no REPUTATION_HOOK_ADDRESS_${expected.chainId} — only escrow.token() checked (no ERC-8004 feedback on this chain)`);
  } else {
    if (!same(hook.acp, expected.escrow)) {
      problems.push(
        `${label}: ReputationHook ${expected.hook}.acp() is ${hook.acp}, not AGENT_JOB_ESCROW_ADDRESS_${expected.chainId}=${expected.escrow} ` +
          '(every hooked submit / complete / reject would revert with OnlyACP)',
      );
    }
    if (expected.evaluator === null) {
      notes.push(`${label}: no ESCROW_EVALUATOR_PRIVATE_KEY — hook.trustedEvaluator() (${hook.trustedEvaluator}) not compared`);
    } else if (!same(hook.trustedEvaluator, expected.evaluator)) {
      problems.push(
        `${label}: hook.trustedEvaluator() is ${hook.trustedEvaluator}, but the backend evaluator (ESCROW_EVALUATOR_PRIVATE_KEY) is ` +
          `${expected.evaluator} (every settlement would skip feedback: untrusted-evaluator)`,
      );
    }
    if (expected.identityRegistry === null) {
      notes.push(`${label}: no Identity Registry configured — hook.identityRegistry() (${hook.identityRegistry}) not compared`);
    } else if (!same(hook.identityRegistry, expected.identityRegistry)) {
      problems.push(
        `${label}: hook.identityRegistry() is ${hook.identityRegistry}, but the backend mints identities in ${expected.identityRegistry} ` +
          `(IDENTITY_REGISTRY_ADDRESS_${expected.chainId} or the official default; bindings would never verify)`,
      );
    }
    if (expected.reputationRegistry === null) {
      notes.push(`${label}: no Reputation Registry configured — hook.reputationRegistry() (${hook.reputationRegistry}) not compared`);
    } else if (!same(hook.reputationRegistry, expected.reputationRegistry)) {
      problems.push(
        `${label}: hook.reputationRegistry() is ${hook.reputationRegistry}, expected ${expected.reputationRegistry} ` +
          `(REPUTATION_REGISTRY_ADDRESS_${expected.chainId} or the official default)`,
      );
    }
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

/** `eth_chainId` of one chain's RPC (viem `getChainId`). Q7. */
export type ChainIdReader = () => Promise<number>;

/**
 * viem errors that are an ANSWER from the chain, not a failure to reach it:
 * the call executed and reverted, or returned no / undecodable data (no code
 * at the address, or a contract without that function — typo, wrong chain,
 * wrong contract). A deployment like that is a mismatch, never "unreadable".
 */
const DEFINITIVE_ERROR_NAMES = new Set([
  'ContractFunctionZeroDataError',
  'ContractFunctionRevertedError',
  'ExecutionRevertedError',
  'AbiDecodingZeroDataError',
  'AbiDecodingDataSizeTooSmallError',
  'AbiDecodingDataSizeInvalidError',
  'PositionOutOfBoundsError',
  'InvalidAddressError',
]);

/** True when `err` (or anything in its cause chain) says the contract answered "no". */
export function isDefinitiveContractError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth++) {
    const e = current as { name?: string; message?: string; shortMessage?: string; cause?: unknown };
    if (e.name && DEFINITIVE_ERROR_NAMES.has(e.name)) return true;
    if (/returned no data \("0x"\)|execution reverted/i.test(`${e.shortMessage ?? ''} ${e.message ?? ''}`)) return true;
    current = e.cause;
  }
  return false;
}

/** A contract at a configured address that answered "not me" (no code, revert, bad data). */
class DeploymentMismatchError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function firstLine(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | null;
  return sanitizeText((e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0] ?? '') || 'unknown error';
}

async function readOnce(read: ContractReader, expected: EscrowChainExpectation, readChainId?: ChainIdReader): Promise<EscrowChainReading> {
  // Q7: the RPC must serve the configured chain — every read below and every
  // signature would otherwise go to another network. A different answer is a
  // mismatch (RPC_URL_<id> / the provider points elsewhere); a failure to ask
  // is a transport error like any other.
  if (readChainId) {
    const served = await readChainId();
    if (Number(served) !== expected.chainId) {
      throw new DeploymentMismatchError([
        `chain ${expected.chainId}: the RPC answers eth_chainId ${String(served)}, not ${expected.chainId} ` +
          `(RPC_URL_${expected.chainId} or the provider serves another network; every read and signature would go there)`,
      ]);
    }
  }
  const calls: Array<{ contract: 'escrow' | 'hook'; address: Address; abi: Abi; functionName: string }> = [
    { contract: 'escrow', address: expected.escrow, abi: AGENT_JOB_ESCROW_ABI as unknown as Abi, functionName: 'token' },
    ...(expected.hook
      ? (['acp', 'trustedEvaluator', 'identityRegistry', 'reputationRegistry'] as const).map((functionName) => ({
          contract: 'hook' as const,
          address: expected.hook!,
          abi: REPUTATION_HOOK_ABI as unknown as Abi,
          functionName,
        }))
      : []),
  ];
  const settled = await Promise.allSettled(calls.map((call) => read({ address: call.address, abi: call.abi, functionName: call.functionName })));

  const values = new Map<string, Address>();
  const broken = new Map<'escrow' | 'hook', string>();
  let transport: unknown = null;
  settled.forEach((outcome, i) => {
    const call = calls[i]!;
    const key = `${call.contract}.${call.functionName}`;
    if (outcome.status === 'fulfilled') {
      try {
        values.set(key, getAddress(outcome.value as string));
      } catch {
        if (!broken.has(call.contract)) broken.set(call.contract, `${call.functionName}() returned ${JSON.stringify(outcome.value)}`);
      }
    } else if (isDefinitiveContractError(outcome.reason)) {
      if (!broken.has(call.contract)) broken.set(call.contract, `${call.functionName}() ${firstLine(outcome.reason)}`);
    } else {
      transport ??= outcome.reason;
    }
  });

  // A contract that answered "not me" is conclusive even if another call hit a transport error.
  if (broken.size > 0) {
    const label = `chain ${expected.chainId}`;
    throw new DeploymentMismatchError(
      [...broken].map(([contract, why]) =>
        contract === 'escrow'
          ? `${label}: no AgentJobEscrow at AGENT_JOB_ESCROW_ADDRESS_${expected.chainId}=${expected.escrow} (${why} — no code, wrong address or wrong chain)`
          : `${label}: no ReputationHook at REPUTATION_HOOK_ADDRESS_${expected.chainId}=${expected.hook} (${why} — no code, wrong address or wrong chain; ` +
            'every hooked createJob would fail)',
      ),
    );
  }
  if (transport) throw transport;
  return {
    token: values.get('escrow.token')!,
    ...(expected.hook
      ? {
          acp: values.get('hook.acp')!,
          trustedEvaluator: values.get('hook.trustedEvaluator')!,
          identityRegistry: values.get('hook.identityRegistry')!,
          reputationRegistry: values.get('hook.reputationRegistry')!,
        }
      : {}),
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
 * Reads and compares every chain. Only a transport failure or a timeout
 * (`timeoutMs` per attempt, `attempts` tries) makes a chain `unreadable`; a
 * configured address that reverts, has no code or returns undecodable data is
 * a definitive mismatch (C3d review).
 */
export async function checkEscrowDeployments(params: {
  chains: readonly EscrowChainExpectation[];
  reader: (chainId: number) => ContractReader;
  /** Q7: `eth_chainId` of each chain's RPC; checked first when given. */
  chainIdReader?: (chainId: number) => ChainIdReader;
  timeoutMs?: number;
  attempts?: number;
}): Promise<EscrowChainCheck[]> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const attempts = Math.max(1, params.attempts ?? 2);
  return Promise.all(
    params.chains.map(async (expected): Promise<EscrowChainCheck> => {
      const base = { chainId: expected.chainId, escrow: expected.escrow, hook: expected.hook };
      let lastError = 'unknown error';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const reading = await withTimeout(
            readOnce(params.reader(expected.chainId), expected, params.chainIdReader?.(expected.chainId)),
            timeoutMs,
          );
          return { ...base, ...compareEscrowDeployment(expected, reading), unreadable: null };
        } catch (err) {
          if (err instanceof DeploymentMismatchError) return { ...base, problems: err.problems, notes: [], unreadable: null };
          lastError = firstLine(err);
        }
      }
      return { ...base, problems: [], notes: [], unreadable: lastError };
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
          `ERC-8183 deployment on chain ${check.chainId} could not be verified (escrow ${check.escrow}, hook ${check.hook ?? 'none'}): ${check.unreadable} — ` +
          're-checked in the background',
      ),
    ],
    warnings: checks.flatMap((check) => check.notes),
    verified: checks.filter((check) => check.unreadable === null && check.problems.length === 0).map((check) => check.chainId),
    unreadable: unreadable.map((check) => check.chainId),
  };
}
