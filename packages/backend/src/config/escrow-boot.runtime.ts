/**
 * Boot-time wiring of the C3d checks for `index.ts` (API) and
 * `worker-process.ts` (worker): the escrow / hook deployment check
 * (`escrow-boot-check.ts`), Q7's per-process verification state with its
 * background re-check (`escrow-verification.runtime.ts`), and the
 * per-process capabilities with the API ↔ worker drift comparison
 * (`process-capabilities.ts`).
 *
 * Tests mock THIS module; the rules live in the pure modules above.
 */

import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { logger } from '../api/middleware/logger.js';
import { sanitizeText } from '../api/errors/sanitize.js';
import { notificationService } from '../services/notification.service.js';
import { createChainPublicClient } from './chains.js';
import { getContracts } from './contracts.js';
import * as envModule from './env.js';
import { configuredEscrowChainIds, env, escrowEvaluatorAddress } from './env.js';
import { proofTagNodeProblem } from './evaluator-a1.js';
import type { EvaluatorProofTag } from '../services/escrow/evaluator-rpc.js';
import {
  checkEscrowDeployments,
  escrowBootVerdict,
  type ChainIdReader,
  type CodeReader,
  type ContractReader,
  type EscrowBootVerdict,
} from './escrow-boot-check.js';
import {
  escrowExpectations,
  escrowVerificationSettings,
  escrowVerificationSnapshot,
  recordEscrowChecks,
  type VerificationTransition,
} from './escrow-verification.runtime.js';
import { publishEscrowVerificationReport } from './escrow-verification-report.runtime.js';
import {
  capabilityDrift,
  describeCapabilities,
  type EscrowChainCapability,
  type ProcessCapabilities,
  type ProcessRole,
} from './process-capabilities.js';

export { escrowExpectations } from './escrow-verification.runtime.js';

function reader(chainId: number): ContractReader {
  const client = createChainPublicClient(chainId);
  return (params) => client.readContract(params as never);
}

function chainIdReader(chainId: number): ChainIdReader {
  const client = createChainPublicClient(chainId);
  return () => client.getChainId();
}

/** S9: `eth_getCode` — the escrow and hook must run this build's code. */
export function codeReader(chainId: number): CodeReader {
  const client = createChainPublicClient(chainId);
  return (address) => client.getCode({ address });
}

function applyVerdict(role: ProcessRole, verdict: EscrowBootVerdict, opts: { quietUnreadable?: boolean } = {}): void {
  for (const warning of verdict.warnings) logger.warn({ role }, `ERC-8183 boot check: ${warning}`);
  for (const error of verdict.errors) {
    if (opts.quietUnreadable && error.includes('could not be verified')) continue;
    logger.error({ role }, error);
  }
  if (verdict.verified.length > 0) {
    logger.info({ role, chainIds: verdict.verified }, 'ERC-8183 boot check: escrow (+ ReputationHook where configured) match the configuration');
  }
  if (verdict.fatal) {
    console.error(verdict.fatal);
    logger.fatal?.({ role }, verdict.fatal);
    process.exit(1);
  }
}

/**
 * Q7: one log line and one operator alert per chain and per state change
 * (never one per re-check). The first verification of a healthy boot is only
 * logged; a boot that starts unverified or mismatched is alerted.
 */
async function reportTransitions(role: ProcessRole, transitions: readonly VerificationTransition[]): Promise<void> {
  for (const { chainId, previous, current } of transitions) {
    if (current.kind === 'verified') {
      logger.info({ role, chainId, verifiedAt: current.at.toISOString() }, 'ERC-8183 configuration verified — escrow signatures allowed on this chain');
      if (!previous) continue; // a healthy boot: nothing to tell the operator
    }
    const message =
      current.kind === 'verified'
        ? `ERC-8183 configuration of chain ${chainId} is verified again in the ${role} process: deferred escrow transactions and settlements resume.`
        : current.kind === 'unverified'
          ? `ERC-8183 configuration of chain ${chainId} is UNVERIFIED in the ${role} process since ${current.since.toISOString()} (${current.reason}). ` +
            'New escrow jobs answer 503 ESCROW_CONFIG_UNVERIFIED and queued escrow transactions and evaluator settlements wait until it ' +
            'verifies; confirmations and the reconciliation of already broadcast transactions continue.'
          : `ERC-8183 configuration of chain ${chainId} does NOT match the chain in the ${role} process: ${current.problems.join('; ')}. ` +
            'Every escrow signature on this chain is blocked.';
    const clean = sanitizeText(message);
    if (current.kind === 'verified') logger.warn({ role, chainId }, clean);
    else logger.error({ role, chainId, state: current.kind }, clean);
    try {
      await notificationService.notify({
        type: 'ESCROW_ALERT',
        agentId: 'escrow',
        agentName: 'ERC-8183 escrow',
        message: clean,
        metadata: { kind: `escrow-config-${current.kind}`, chainId, role },
      });
    } catch (err) {
      logger.warn({ role, chainId, err: (err as Error)?.message ?? String(err) }, 'Escrow configuration alert could not be delivered');
    }
  }
}

/**
 * C3f item 4: after every check, this process's verification state goes to
 * Redis, so `GET /admin/escrow/verification` on the API can show the
 * worker's (the process that signs settlements and sends escrow steps).
 * Published under every role this process plays: its boot role and, in the
 * single-process topology (`index.ts` with TRANSACTION_WORKER_ENABLED=true),
 * `worker` once the settlement worker is started (`alsoPublishAs`).
 * Best effort, never awaited by the gate.
 */
const publishRoles = new Set<ProcessRole>();
let checkedOnce = false;

function publishState(): void {
  checkedOnce = true;
  const chains = escrowVerificationSnapshot({ withReason: true });
  const settings = escrowVerificationSettings();
  for (const role of publishRoles) {
    void publishEscrowVerificationReport(role, chains, settings).catch(() => undefined);
  }
}

/**
 * #193 finding 2: the API process that also hosts the escrow settlement
 * worker (TRANSACTION_WORKER_ENABLED=true) publishes the same verification
 * state as `worker` too — at once, and at every later re-check — so
 * `GET /admin/escrow/verification` does not report the worker `missing`.
 * Call it only once the settlement worker has actually started. The gate and
 * the separate worker process are unchanged.
 */
export function alsoPublishAs(role: ProcessRole): void {
  if (publishRoles.has(role)) return;
  publishRoles.add(role);
  if (checkedOnce) {
    void publishEscrowVerificationReport(role, escrowVerificationSnapshot({ withReason: true }), escrowVerificationSettings()).catch(() => undefined);
  }
}

let recheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Q7: re-reads every configured chain every ESCROW_CONFIG_RECHECK_SECONDS,
 * forever (C3d stopped after 30 tries and only for unreadable chains). Each
 * read refreshes the verification (TTL) or revokes it at once; a mismatch
 * found later is FATAL in production / staging like at boot. One read at a
 * time per process; each read is bounded by the re-check interval.
 */
function startRecheckLoop(role: ProcessRole): void {
  if (recheckTimer) return;
  const intervalMs = escrowVerificationSettings().recheckSeconds * 1000;
  let running = false;
  recheckTimer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const chains = escrowExpectations();
      const checks = await checkEscrowDeployments({
        chains,
        reader,
        chainIdReader,
        codeReader,
        attempts: 1,
        timeoutMs: Math.min(10_000, intervalMs),
      });
      const transitions = recordEscrowChecks(checks, chains);
      publishState();
      applyVerdict(role, escrowBootVerdict(env.NODE_ENV, checks), { quietUnreadable: true });
      for (const check of checks) {
        if (check.unreadable) logger.warn({ role, chainId: check.chainId, err: check.unreadable }, 'ERC-8183 configuration re-check failed — chain unverified');
      }
      await reportTransitions(role, transitions);
    })()
      .catch((err: unknown) => logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'ERC-8183 configuration re-check crashed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  recheckTimer.unref?.();
}

/**
 * C3d + Q7: verifies the deployed escrow / hook (and the RPC's eth_chainId)
 * of every configured chain against this process's configuration, records
 * the per-chain verification state the escrow gate reads, and starts the
 * background re-check. FATAL (exit 1) on a mismatch in production / staging,
 * loud error in development / test (and every escrow signature on the chain
 * stays blocked). An unreadable chain is an error, never fatal: it stays
 * unverified — new escrow operations wait — until a re-check reads it.
 * Never throws.
 */
/**
 * A1 review P2-2: refuses to boot (exit 1) when an escrow chain is served by an Anvil node and the proof tag
 * is the implicit `safe` / `finalized` default — it would never advance there. An explicit
 * EVALUATOR_PROOF_TAG passes. A node whose client version cannot be read is not refused (real chains).
 */
export async function checkEvaluatorProofTag(
  chainIds: readonly number[],
  opts: {
    proofTag?: EvaluatorProofTag;
    explicit?: boolean;
    clientVersion?: (chainId: number) => Promise<string | null>;
    exit?: (message: string) => never;
  } = {},
): Promise<void> {
  let proofTag: EvaluatorProofTag;
  let explicit: boolean;
  try {
    proofTag = opts.proofTag ?? envModule.evaluatorProofTag;
    explicit = opts.explicit ?? envModule.evaluatorProofTagExplicit;
  } catch {
    return; // a test environment without the A1 settings
  }
  if (proofTag === undefined) return;
  const readVersion =
    opts.clientVersion ??
    (async (chainId: number) => {
      try {
        return (await createChainPublicClient(chainId).request({ method: 'web3_clientVersion' } as never)) as string;
      } catch {
        return null;
      }
    });
  for (const chainId of chainIds) {
    const problem = proofTagNodeProblem({ chainId, proofTag, explicit, clientVersion: await readVersion(chainId) });
    if (!problem) continue;
    if (opts.exit) opts.exit(problem);
    console.error(problem);
    logger.fatal?.({ chainId }, problem);
    process.exit(1);
  }
}

export async function runEscrowBootCheck(role: ProcessRole): Promise<EscrowBootVerdict | null> {
  const chains = escrowExpectations();
  if (chains.length === 0) return null;
  if (escrowEvaluatorAddress) await checkEvaluatorProofTag(chains.map((c) => c.chainId));
  publishRoles.add(role);
  let verdict: EscrowBootVerdict;
  try {
    const checks = await checkEscrowDeployments({ chains, reader, chainIdReader, codeReader });
    verdict = escrowBootVerdict(env.NODE_ENV, checks);
    const transitions = recordEscrowChecks(checks, chains);
    publishState();
    applyVerdict(role, verdict);
    await reportTransitions(role, transitions);
  } catch (err) {
    logger.error({ role, err: (err as Error)?.message ?? String(err) }, 'ERC-8183 boot check crashed — deployment NOT verified (escrow signatures blocked until a re-check succeeds)');
    startRecheckLoop(role);
    return null;
  }
  startRecheckLoop(role);
  return verdict;
}

/**
 * A1 §8.2 / R2-P3-7 (the recovery script): ONE full verification of the deployed escrow / hook of
 * `chainId` in this process — `checkEscrowDeployments` + `recordEscrowChecks`, no re-check loop — then
 * the gate's verdict. Run after the operator's confirmation, before the lane.
 */
export async function verifyEscrowConfigOnce(chainId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  const chains = escrowExpectations().filter((c) => c.chainId === chainId);
  if (chains.length === 0) return { ok: false, reason: `no AGENT_JOB_ESCROW_ADDRESS_${chainId} configured in this process` };
  try {
    const checks = await checkEscrowDeployments({ chains, reader, chainIdReader, codeReader, attempts: 1 });
    recordEscrowChecks(checks, chains);
    const verdict = escrowBootVerdict(env.NODE_ENV, checks);
    if (verdict.errors.length > 0 || !verdict.verified.includes(chainId)) {
      return { ok: false, reason: verdict.errors.join('; ') || `chain ${chainId} not verified` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `verification crashed: ${(err as Error)?.message ?? String(err)}` };
  }
}

/** Testing hook: stops the background re-check and forgets the published roles. */
export function __stopEscrowRecheckForTests(): void {
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  publishRoles.clear();
  checkedOnce = false;
}

/** This process's capabilities from its environment and what it started. */
export function processCapabilities(
  role: ProcessRole,
  started: { transactionWorker: boolean; paymentRecovery: boolean; settlementWorker: boolean },
): ProcessCapabilities {
  const escrowChains: EscrowChainCapability[] = [];
  for (const chainId of configuredEscrowChainIds) {
    try {
      const contracts = getContracts(chainId);
      if (contracts.agentJobEscrow) escrowChains.push({ chainId, escrow: contracts.agentJobEscrow, hook: contracts.reputationHook ?? null });
    } catch {
      // no contract table for the chain
    }
  }
  return {
    role,
    nodeEnv: env.NODE_ENV,
    ...started,
    escrowChains,
    evaluator: escrowEvaluatorAddress,
    bootedAt: new Date().toISOString(),
  };
}

const CAPABILITIES_KEY = (role: ProcessRole) => `agentfi:process-capabilities:${role}`;
const CAPABILITIES_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Logs what this process enables, publishes it to Redis and compares it with
 * the last capabilities the other role published (C3d: silent config drift
 * between the API and the worker). Best effort — Redis problems are logged,
 * never fatal.
 */
export async function announceProcessCapabilities(caps: ProcessCapabilities): Promise<string[]> {
  logger.info({ ...caps, host: hostname() }, describeCapabilities(caps));
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false, connectTimeout: 5_000 });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.set(CAPABILITIES_KEY(caps.role), JSON.stringify({ ...caps, host: hostname() }), 'EX', CAPABILITIES_TTL_SECONDS);
    const peerRole: ProcessRole = caps.role === 'api' ? 'worker' : 'api';
    const raw = await redis.get(CAPABILITIES_KEY(peerRole));
    if (!raw) return [];
    const peer = JSON.parse(raw) as ProcessCapabilities;
    const drift = capabilityDrift(caps, peer);
    for (const message of drift) {
      logger.error({ role: caps.role, peerRole, peerBootedAt: peer.bootedAt }, `CONFIG DRIFT between the API and the worker: ${message}`);
    }
    return drift;
  } catch (err) {
    logger.warn({ role: caps.role, err: (err as Error)?.message ?? String(err) }, 'Process capabilities not exchanged through Redis (drift check skipped)');
    return [];
  } finally {
    redis.disconnect();
  }
}
