/**
 * C3g-A1 — manual recovery of a stuck evaluator key (spec `2026-10-21-spec-c3g-a1.md` §8, R2-P2-1,
 * R2-P2-4, R2-P3-5, R2-P3-7; plan `2026-10-21-plano-a1-parametros.md` §1.1, §3, §5, §6).
 *
 *   npm run evaluator:recover -- --chain <id>                                  (dry-run: the default)
 *   npm run evaluator:recover -- --chain <id> --execute speed-up --nonce N --operator <name> --note "<why>"
 *   npm run evaluator:recover -- --chain <id> --execute speed-up --nonces N..M --operator … --note …
 *   npm run evaluator:recover -- --chain <id> --execute cancel --nonce N [--acknowledge-foreign <hash>|nonce:<N>] …
 *   npm run evaluator:recover -- --chain <id> --execute rebroadcast --nonce N …
 *
 * Runs WHERE THE KEY ALREADY IS (the owner's machine, or a one-off command in the worker's service), with
 * the backend's own env, DB and Redis. The key is never printed or logged. No HTTP route, no automatic
 * action: every execution needs `--operator`, `--note`, a TTY and the typed phrase, and is refused without
 * configured caps (`EVALUATOR_RECOVERY_*`, no defaults).
 *
 * What it never does: finalize a job, release a reservation, touch DailyVolume, change a D9 decision. It
 * only records SCRIPT candidates (the ledger is the only writer) and sends them; the existing path
 * (`reconcileEvaluatorCandidates` → the job's own action → `reconcileTerminal`) mirrors the chain.
 */
import type { PrismaClient } from '@prisma/client';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import {
  CANCEL_DOES_NOT_SETTLE,
  admissibleOperations,
  budgetCheck,
  capsProblem,
  classifyHead,
  expiryPosture,
  headCheck,
  isLiveStatus,
  planFingerprint,
  proposeReplacementFees,
  rangePlanCheck,
  rebroadcastAllowed,
  replacementLimitCheck,
  type Allowed,
  type ExpiryPosture,
  type ExpiryThresholds,
  type HeadClass,
  type NodeView,
  type RecoveryCaps,
} from '../services/escrow/evaluator-candidates.js';
import * as ledger from '../services/escrow/evaluator-ledger.js';
import type { EvaluatorExplicitTx, EvaluatorReceipt, EvaluatorSendRawOutcome, PreparedEvaluatorTx } from '../services/escrow/evaluator-signer.js';
import type { EvaluatorNodeRead } from '../services/escrow/evaluator-rpc.js';
import { evaluatorLaneKey, type LaneLease, type LeaseLock } from '../services/transaction/wallet-lane.js';
import { singleClientNodeReads, toNodeViews, type LedgerCandidate } from '../services/job/escrow-evaluator-a1.js';
import { AGENT_JOB_ESCROW_ABI as AGENT_JOB_ESCROW_ABI_FOR_RECOVERY } from '../abi/AgentJobEscrow.abi.js';
import {
  CHAIN_JOB_STATUS,
  FINAL_ON_CHAIN_STATUSES,
  raiseEscrowAlert,
  reconcileEvaluatorCandidates,
  type Erc8183Deps,
} from '../services/job/escrow-erc8183.service.js';

// ── Dependencies ─────────────────────────────────────────────────────────────

/** The signer surface the script needs (F2 `EvaluatorA1Signer`). */
export interface RecoverySigner {
  readonly address: Address;
  readonly chainId: number;
  signExplicit(input: EvaluatorExplicitTx): Promise<PreparedEvaluatorTx>;
  sendRaw(raw: Hex, opts: { lease: LaneLease; minLeaseMs: number }): Promise<EvaluatorSendRawOutcome>;
  waitForTransactionReceipt(hash: Hex): Promise<EvaluatorReceipt>;
}

/** `acquireEvaluatorRecoveryLock` (Redis, SET NX with owner + PID) in production. */
export interface RecoveryLockLike {
  release(): Promise<unknown>;
}

export interface RecoveryDeps {
  /** The orchestrator deps of this process: db, read client, per-node reads, proof tag, lanes, Q7 gate, alerts, caps. */
  erc8183: Erc8183Deps;
  signer: RecoverySigner;
  /** One recovery per chain at a time (§7.1). Throws when busy (`RecoveryLockBusyError`). */
  acquireRecoveryLock(chainId: number, owner: string): Promise<RecoveryLockLike>;
  /** §8.2-2 / R2-P3-7: the FULL Q7 verification, once, in this process. Absent → the gate's current verdict. */
  verifyConfig?(chainId: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `eth_chainId` of the RPC. Absent → the read client's `getChainId`. */
  rpcChainId?(chainId: number): Promise<number>;
  /** Base fee of the latest block and the p90 priority fee (`eth_feeHistory`). Absent → the read client. */
  fees?(chainId: number): Promise<{ baseFee: bigint; priorityP90: bigint }>;
  /** Native balance of the evaluator now. Absent → the read client's `getBalance`. */
  balance?(chainId: number, address: Address): Promise<bigint>;
  /** Plan P18–P20 (H, URGENT, hand-to-owner). */
  thresholds: ExpiryThresholds;
  /** The operator's terminal. `isTTY: false` (stdin redirected) → every execution is refused. */
  tty: { isTTY: boolean; ask(prompt: string): Promise<string> };
  print?(line: string): void;
  now?(): Date;
  /** Plan P10: how long the receipt is awaited after the send, OUTSIDE the lane. */
  receiptWaitMs?: number;
}

export interface RecoveryResult {
  /** 0 done / dry-run, 1 error, 2 refused (nothing signed), 3 aborted inside the critical section (nothing sent). */
  exitCode: 0 | 1 | 2 | 3;
  output: string;
}

type Operation = 'speed-up' | 'cancel' | 'rebroadcast';

interface Args {
  chainId: number;
  execute: Operation | null;
  nonces: number[] | null;
  range: boolean;
  operator: string | null;
  note: string | null;
  acknowledgeForeign: string[];
}

class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode: 2 | 3 = 2,
    readonly alert = false,
  ) {
    super(reason);
  }
}

// ── Argument parsing ─────────────────────────────────────────────────────────

const OPS: readonly Operation[] = ['speed-up', 'cancel', 'rebroadcast'];

export function parseRecoveryArgs(argv: readonly string[]): Args {
  const args: Args = { chainId: NaN, execute: null, nonces: null, range: false, operator: null, note: null, acknowledgeForeign: [] };
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Refused(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--chain':
        args.chainId = Number(take(i++, a));
        break;
      case '--execute': {
        const op = take(i++, a) as Operation;
        if (!OPS.includes(op)) throw new Refused(`--execute must be one of ${OPS.join(' | ')}`);
        args.execute = op;
        break;
      }
      case '--nonce': {
        const n = Number(take(i++, a));
        if (!Number.isSafeInteger(n) || n < 0) throw new Refused('--nonce must be a non-negative integer');
        args.nonces = [n];
        break;
      }
      case '--nonces': {
        const m = /^(\d+)\.\.(\d+)$/.exec(take(i++, a));
        if (!m || Number(m[2]) < Number(m[1])) throw new Refused('--nonces must be N..M with M ≥ N');
        args.nonces = [];
        for (let n = Number(m[1]); n <= Number(m[2]); n++) args.nonces.push(n);
        args.range = true;
        break;
      }
      case '--operator':
        args.operator = take(i++, a).trim();
        break;
      case '--note':
        args.note = take(i++, a).trim();
        break;
      case '--acknowledge-foreign':
        args.acknowledgeForeign.push(take(i++, a).trim().toLowerCase());
        break;
      default:
        throw new Refused(`unknown argument ${a}`);
    }
  }
  if (!Number.isSafeInteger(args.chainId) || args.chainId <= 0) throw new Refused('--chain <chainId> is required');
  if (args.execute) {
    if (!args.nonces) throw new Refused('--execute needs --nonce N (or --nonces N..M for a speed-up range)');
    if (args.range && args.execute !== 'speed-up') throw new Refused('a range (--nonces) is for speed-up only; cancel and rebroadcast go one nonce at a time');
    if (!args.operator) throw new Refused('--operator <name> is required with --execute');
    if (!args.note) throw new Refused('--note "<reason>" is required with --execute');
  }
  return args;
}

// ── Reading the situation ────────────────────────────────────────────────────

const CLAIM_REFUND_WARNING =
  'After expiresAt anyone can call claimRefund on a Funded or Submitted job and refund the requester in full, also for work already delivered; the provider is then unpaid. complete/reject are still valid after expiresAt only while the job is still Submitted (first mined wins).';

const STATUS_NAME: Record<number, string> = { 0: 'Open', 1: 'Funded', 2: 'Submitted', 3: 'Completed', 4: 'Rejected', 5: 'Expired' };
const DELIVERED = ['SUBMITTED', 'CONTESTED', 'SETTLING'];
const CANCEL_GAS = 21_000n;
const STUCK_BLOCKS_THRESHOLD = 30;

interface JobInfo {
  id: string;
  status: string;
  onChainStatus: string | null;
  onChainJobId: string | null;
  escrowContract: string | null;
  resolution: string | null;
  contestedAt: Date | null;
  expiresAt: Date | null;
  evaluator: string | null;
}

interface NoncePlan {
  nonce: number;
  rows: LedgerCandidate[];
  live: LedgerCandidate[];
  /** Our decision candidate at the nonce (the most expensive live non-CANCEL row), or null. */
  ours: LedgerCandidate | null;
  job: JobInfo | null;
  chainStatus: number | null;
  simulation: boolean | null;
  ops: { speedUp: Allowed; cancel: Allowed; rebroadcast: Allowed };
  fees: { speedUp: FeeProposal; cancel: FeeProposal };
  limit: ReturnType<typeof replacementLimitCheck>;
  budget: { speedUp: ReturnType<typeof budgetCheck> | null; cancel: ReturnType<typeof budgetCheck> | null };
  fingerprint: Record<Operation, string>;
}

type FeeProposal = ReturnType<typeof proposeReplacementFees>;

interface Situation {
  chainId: number;
  evaluator: Address;
  views: NodeView[];
  reads: EvaluatorNodeRead[];
  latest: number | null;
  pending: number | null;
  proof: number | null;
  queue: number[];
  plans: Map<number, NoncePlan>;
  headClass: HeadClass;
  baseFee: bigint | null;
  priorityP90: bigint | null;
  balance: bigint | null;
  blockTime: Date;
  blockTimeSource: 'block' | 'process clock';
  delivered: JobInfo[];
  otherLive: JobInfo[];
  earliestDelivered: JobInfo | null;
  posture: ExpiryPosture;
  payDecisionAffected: boolean;
  unackedExternal: LedgerCandidate[];
  caps: RecoveryCaps | null;
  gateOpen: boolean;
  problems: string[];
}

function maxBig(xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b > a ? b : a), 0n);
}

function db(deps: RecoveryDeps): PrismaClient {
  return deps.erc8183.db;
}

function nowOf(deps: RecoveryDeps): Date {
  return deps.now?.() ?? new Date();
}

async function readNodes(deps: RecoveryDeps, chainId: number, evaluator: Address, hashes: string[]): Promise<EvaluatorNodeRead[]> {
  const list = [...new Set(hashes.map((h) => h.toLowerCase() as Hex))];
  try {
    if (deps.erc8183.readNodeViews) return await deps.erc8183.readNodeViews(chainId, evaluator, list);
    return await singleClientNodeReads(deps.erc8183.publicClient(chainId) as never, evaluator, list);
  } catch (err) {
    return [{ node: '#? reader', index: 0, ok: false, error: (err as Error)?.message ?? String(err) }];
  }
}

function consensus(reads: EvaluatorNodeRead[], key: 'nonceLatest' | 'noncePending' | 'nonceAtTag'): number | null {
  if (reads.length === 0 || reads.some((r) => !r.ok || r[key] === undefined)) return null;
  const vals = reads.map((r) => r[key]!);
  if (key === 'noncePending') return Math.max(...vals);
  return vals.every((v) => v === vals[0]) ? vals[0]! : null;
}

async function jobInfo(deps: RecoveryDeps, jobId: string | null): Promise<JobInfo | null> {
  if (!jobId) return null;
  return db(deps).job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, onChainStatus: true, onChainJobId: true, escrowContract: true, resolution: true, contestedAt: true, expiresAt: true, evaluator: true },
  });
}

async function chainStatusOf(deps: RecoveryDeps, chainId: number, job: JobInfo | null): Promise<number | null> {
  if (!job?.onChainJobId || !job.escrowContract) return null;
  try {
    const raw = (await deps.erc8183.publicClient(chainId).readContract({
      address: getAddress(job.escrowContract),
      abi: AGENT_JOB_ESCROW_ABI_FOR_RECOVERY,
      functionName: 'getJob',
      args: [BigInt(job.onChainJobId)],
    } as never)) as { status: number };
    return Number(raw.status);
  } catch {
    return null;
  }
}

async function simulate(deps: RecoveryDeps, chainId: number, evaluator: Address, c: LedgerCandidate): Promise<boolean | null> {
  const client = deps.erc8183.publicClient(chainId);
  if (!client.call || !c.toAddress || c.calldata === null) return null;
  try {
    await client.call({ account: evaluator, to: getAddress(c.toAddress), data: c.calldata as Hex, value: c.valueWei } as never);
    return true;
  } catch {
    return false;
  }
}

async function fees(deps: RecoveryDeps, chainId: number): Promise<{ baseFee: bigint; priorityP90: bigint } | null> {
  try {
    if (deps.fees) return await deps.fees(chainId);
    const { readBaseFeeAndPriorityP90 } = await import('../services/escrow/evaluator-rpc.js');
    const r = await readBaseFeeAndPriorityP90(chainId, 20, { client: deps.erc8183.publicClient(chainId) as never });
    return { baseFee: r.baseFee, priorityP90: r.priorityP90 };
  } catch {
    return null;
  }
}

async function balanceOf(deps: RecoveryDeps, chainId: number, address: Address): Promise<bigint | null> {
  try {
    if (deps.balance) return await deps.balance(chainId, address);
    const client = deps.erc8183.publicClient(chainId);
    return client.getBalance ? await client.getBalance({ address }) : null;
  } catch {
    return null;
  }
}

async function blockTimeOf(deps: RecoveryDeps, chainId: number): Promise<{ at: Date; source: 'block' | 'process clock' }> {
  try {
    const client = deps.erc8183.publicClient(chainId);
    if (client.getBlock) {
      const b = await client.getBlock({ blockTag: 'latest' });
      if (typeof b.timestamp === 'bigint') return { at: new Date(Number(b.timestamp) * 1000), source: 'block' };
    }
  } catch {
    // the process clock below
  }
  return { at: nowOf(deps), source: 'process clock' };
}

/** SCRIPT rows of the key: highest reserved cost per nonce (incident, 24 h, live) — what the ledger re-checks under its lock. */
async function costMaps(deps: RecoveryDeps, chainId: number, evaluator: Address, incidentId: string | null) {
  const rows = await db(deps).evaluatorTransaction.findMany({
    where: { chainId, evaluator, origin: 'SCRIPT', nonce: { not: null } },
    select: { nonce: true, gasLimit: true, maxFeePerGas: true, status: true, incidentId: true, createdAt: true },
  });
  const since = nowOf(deps).getTime() - 24 * 3_600_000;
  const incident = new Map<number, bigint>();
  const day = new Map<number, bigint>();
  const live = new Map<number, bigint>();
  const put = (m: Map<number, bigint>, n: number, v: bigint) => m.set(n, (m.get(n) ?? 0n) > v ? m.get(n)! : v);
  for (const r of rows) {
    const cost = BigInt(r.gasLimit ?? '0') * BigInt(r.maxFeePerGas ?? '0');
    if (incidentId && r.incidentId === incidentId) put(incident, r.nonce!, cost);
    if (r.createdAt.getTime() > since) put(day, r.nonce!, cost);
    if (['SIGNED', 'SENT', 'SEND_UNCONFIRMED'].includes(r.status)) put(live, r.nonce!, cost);
  }
  return { incident, day, live };
}

function isPayDecision(job: JobInfo): boolean {
  return job.resolution === 'pay' || (job.resolution === null && job.status === 'PAYMENT_PENDING' && job.contestedAt === null);
}

async function readSituation(deps: RecoveryDeps, args: Args): Promise<Situation> {
  const chainId = args.chainId;
  const evaluator = getAddress(deps.signer.address);
  const problems: string[] = [];
  const caps = (deps.erc8183.recoveryCaps?.(chainId) ?? null) as RecoveryCaps | null;

  const liveRows = await ledger.liveCandidates(db(deps), chainId, evaluator);
  const firstReads = await readNodes(deps, chainId, evaluator, liveRows.map((c) => c.txHash));
  const latest = consensus(firstReads, 'nonceLatest');
  const pending = consensus(firstReads, 'noncePending');
  const proof = consensus(firstReads, 'nonceAtTag');
  if (latest === null) problems.push('the RPC nodes do not agree on (or cannot read) the key\'s `latest` nonce');
  const queueSet = new Set<number>();
  if (latest !== null && pending !== null) for (let n = latest; n < pending; n++) queueSet.add(n);
  for (const c of liveRows) if (c.nonce !== null && (latest === null || c.nonce >= latest)) queueSet.add(c.nonce);
  const queue = [...queueSet].sort((a, b) => a - b);

  const rowsByNonce = new Map<number, LedgerCandidate[]>();
  for (const n of queue) rowsByNonce.set(n, await ledger.candidatesAtNonce(db(deps), chainId, evaluator, n));
  const reads = await readNodes(deps, chainId, evaluator, [...rowsByNonce.values()].flat().map((c) => c.txHash));
  const views = toNodeViews(reads);

  const fee = await fees(deps, chainId);
  if (!fee) problems.push('the network fees could not be read (eth_feeHistory)');
  const balance = await balanceOf(deps, chainId, evaluator);
  if (balance === null) problems.push('the evaluator balance could not be read');
  const { at: blockTime, source: blockTimeSource } = await blockTimeOf(deps, chainId);
  const incident = await ledger.getOpenIncident(db(deps), chainId, evaluator);
  const costs = await costMaps(deps, chainId, evaluator, incident?.id ?? null);

  // Jobs: those with candidates in the queue + delivered jobs waiting on the key; then the other live jobs.
  const jobIds = new Set<string>();
  for (const rows of rowsByNonce.values()) for (const r of rows) if (r.jobId) jobIds.add(r.jobId);
  const liveJobs = await db(deps).job.findMany({
    where: { escrowKind: 'erc8183', escrowChainId: chainId, onChainStatus: { notIn: [...FINAL_ON_CHAIN_STATUSES] } },
    select: { id: true, status: true, onChainStatus: true, onChainJobId: true, escrowContract: true, resolution: true, contestedAt: true, expiresAt: true, evaluator: true },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
  });
  const delivered = liveJobs.filter((j) => jobIds.has(j.id) || DELIVERED.includes(j.onChainStatus ?? ''));
  const otherLive = liveJobs.filter((j) => !delivered.includes(j));
  const earliestDelivered = delivered.filter((j) => j.expiresAt).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())[0] ?? null;
  const posture = expiryPosture(earliestDelivered?.expiresAt ?? null, blockTime, deps.thresholds);
  const payDecisionAffected = delivered.some(isPayDecision);
  const unackedExternal = await ledger.unacknowledgedExternal(db(deps), chainId, evaluator);

  const plans = new Map<number, NoncePlan>();
  for (const nonce of queue) {
    const rows = rowsByNonce.get(nonce) ?? [];
    const live = rows.filter((r) => isLiveStatus(r.status));
    const ours =
      live
        .filter((r) => r.kind !== 'CANCEL' && r.kind !== 'EXTERNAL' && r.calldata !== null)
        .sort((a, b) => (b.maxFeePerGas > a.maxFeePerGas ? 1 : b.maxFeePerGas < a.maxFeePerGas ? -1 : 0))[0] ?? null;
    const jobId = ours?.jobId ?? live.find((r) => r.jobId)?.jobId ?? null;
    const job = await jobInfo(deps, jobId);
    const chainStatus = await chainStatusOf(deps, chainId, job);
    const sim = ours ? await simulate(deps, chainId, evaluator, ours) : null;
    const terminal = chainStatus !== null && chainStatus >= CHAIN_JOB_STATUS.Completed;
    // §4.3: a foreign head is acknowledged by `nonce:<N>` or by the hash of the EXTERNAL row at that nonce.
    const ackForeign =
      args.acknowledgeForeign.includes(`nonce:${nonce}`) ||
      rows.some((r) => r.kind === 'EXTERNAL' && args.acknowledgeForeign.includes(r.txHash.toLowerCase()));
    const admissible = admissibleOperations({
      ourCandidate: ours !== null,
      jobTerminalOnChain: terminal,
      simulationPasses: sim,
      foreignAcknowledged: ackForeign,
      payDecisionAffected,
      posture,
    });
    const replacements = replacementLimitCheck({ rowsAtNonce: rows, caps, now: nowOf(deps) });
    const attempt = 'replacementsSoFar' in replacements ? replacements.replacementsSoFar + 1 : rows.filter((r) => r.kind === 'SPEED_UP' || r.kind === 'CANCEL').length + 1;
    const prevMaxFee = maxBig(live.map((r) => r.maxFeePerGas));
    const prevPrio = maxBig(live.map((r) => r.maxPriorityFeePerGas));
    const proposal = (): FeeProposal =>
      fee
        ? proposeReplacementFees({ prevMaxFee, prevPrio, baseFee: fee.baseFee, prioP90: fee.priorityP90, attempt, caps })
        : { ok: false, reason: 'INVALID_INPUT', detail: 'network fees unreadable' };
    const speedUpFees = proposal();
    const cancelFees = proposal();
    const budgetFor = (gas: bigint, p: FeeProposal) =>
      p.ok && balance !== null
        ? budgetCheck({ caps, nonce, gasLimit: gas, maxFeePerGas: p.maxFeePerGas, incidentMaxByNonce: costs.incident, dayMaxByNonce: costs.day, liveMaxByNonce: costs.live, balanceWei: balance })
        : null;
    const rebroadcast: Allowed = ours
      ? (() => {
          const r = rebroadcastAllowed({ candidate: ours, candidatesAtNonce: rows, views, hasRawTx: !!ours.rawTx, simulationOk: sim === true, gateOpen: gateOpen(deps, chainId) });
          return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
        })()
      : { ok: false, reason: 'NO_OWN_CANDIDATE' };
    const fp = (operation: Operation, p: FeeProposal | null) =>
      planFingerprint({
        chainId,
        evaluator,
        nonce,
        candidates: rows.map((r) => ({ txHash: r.txHash, status: r.status })),
        jobOnChainStatus: chainStatus === null ? null : (STATUS_NAME[chainStatus] ?? String(chainStatus)),
        operation,
        proposedFees: p && p.ok ? { maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas } : null,
      });
    plans.set(nonce, {
      nonce,
      rows,
      live,
      ours,
      job,
      chainStatus,
      simulation: sim,
      ops: { speedUp: admissible.speedUp, cancel: admissible.cancel, rebroadcast },
      fees: { speedUp: speedUpFees, cancel: cancelFees },
      limit: replacements,
      budget: { speedUp: ours ? budgetFor(ours.gasLimit, speedUpFees) : null, cancel: budgetFor(CANCEL_GAS, cancelFees) },
      fingerprint: { 'speed-up': fp('speed-up', speedUpFees), cancel: fp('cancel', cancelFees), rebroadcast: fp('rebroadcast', null) },
    });
  }

  const head = latest !== null ? plans.get(latest) : undefined;
  const headClass = classifyHead({
    candidates: head?.live ?? [],
    views,
    backlog: pending !== null && latest !== null && pending > latest,
    baseFee: fee?.baseFee ?? 0n,
    blocksStuck: null,
    stuckBlocksThreshold: STUCK_BLOCKS_THRESHOLD,
  });

  return {
    chainId, evaluator, views, reads, latest, pending, proof, queue, plans, headClass,
    baseFee: fee?.baseFee ?? null, priorityP90: fee?.priorityP90 ?? null, balance, blockTime, blockTimeSource,
    delivered, otherLive, earliestDelivered, posture, payDecisionAffected, unackedExternal, caps, gateOpen: gateOpen(deps, chainId), problems,
  };
}

function gateOpen(deps: RecoveryDeps, chainId: number): boolean {
  const v = deps.erc8183.configGate?.(chainId);
  return !v || v.allowed;
}

// ── Dry-run output ───────────────────────────────────────────────────────────

const SUGGESTION: Record<HeadClass, string> = {
  'price-stuck': 'price-stuck → speed-up',
  'lost-send': 'lost-send → identical rebroadcast (no node knows the head)',
  'known-not-mined': 'known-not-mined → speed-up allowed; it is not the price: check the sequencer / RPC',
  foreign: 'foreign → incident: cancel only, after --acknowledge-foreign',
  none: 'none → nothing stuck at the head (or the nodes cannot tell)',
};

const fmtAllowed = (a: Allowed) => (a.ok ? `allowed${a.requiresAfterExpiryPhrase ? ' (AFTER EXPIRY phrase)' : ''}` : `refused: ${a.reason}${a.detail ? ` (${a.detail})` : ''}`);
const fmtFee = (p: FeeProposal) =>
  p.ok
    ? `maxFeePerGas ${p.maxFeePerGas} wei, priority ${p.maxPriorityFeePerGas} wei (effective cap ${p.effectiveCapWei})`
    : `refused: ${p.reason}${'needed' in p && p.needed !== undefined ? ` — would need ${p.needed}, cap ${p.cap}` : ''}${p.detail ? ` (${p.detail})` : ''}`;
const fmtBudget = (b: ReturnType<typeof budgetCheck> | null) =>
  !b ? 'n/a' : b.ok ? `max cost ${b.costWei} wei; reserved after it ${b.reservedWei} wei` : `refused: ${b.reason}${'needed' in b && b.needed !== undefined ? ` — would need ${b.needed}, cap / available ${b.cap}` : ''}`;

function describe(s: Situation, print: (l: string) => void): void {
  print(`Evaluator recovery — DRY-RUN (nothing signed)`);
  print(`  chain ${s.chainId} · evaluator ${s.evaluator} · balance ${s.balance ?? 'unreadable'} wei`);
  print(`  nonces: latest ${s.latest ?? '?'} · pending ${s.pending ?? '?'} · proof tag ${s.proof ?? '?'}`);
  print(`  config gate (Q7, this process): ${s.gateOpen ? 'verified' : 'NOT VERIFIED — execution refused'} · RPC nodes: ${s.reads.map((r) => `${r.node} ${r.ok ? 'ok' : `ERROR (${r.error ?? '?'})`}`).join(', ')}`);
  print(`  network: base fee ${s.baseFee ?? '?'} wei · p90 priority ${s.priorityP90 ?? '?'} wei`);
  print(`  caps: ${s.caps ? 'configured' : 'NONE CONFIGURED — dry-run only, every --execute is refused (fail closed)'}`);
  for (const p of s.problems) print(`  ! ${p}`);
  print(`  head classification: ${SUGGESTION[s.headClass]}`);
  if (s.unackedExternal.length > 0) {
    print(`  ! EXTERNAL transaction(s) of this key not acknowledged (§4.3 — possible key compromise): ${s.unackedExternal.map((e) => e.txHash).join(', ')}`);
  }
  print(`Queue [latest, pending):${s.queue.length === 0 ? ' empty' : ''}`);
  for (const nonce of s.queue) {
    const p = s.plans.get(nonce)!;
    print(`  nonce ${nonce}${nonce === s.latest ? ' (HEAD)' : ''}:`);
    if (p.rows.length === 0) print(`    head transaction not recorded — foreign or unknown`);
    for (const r of p.rows) {
      const known = s.reads.map((n) => `${n.node}:${n.ok ? (n.known?.[r.txHash.toLowerCase() as Hex] ? 'known' : n.receipts?.[r.txHash.toLowerCase() as Hex] ? 'mined' : 'not found') : 'error'}`).join(' ');
      const age = Math.round((Date.now() - r.createdAt.getTime()) / 1000);
      print(
        `    ${r.txHash} ${r.kind}/${r.origin} job ${r.jobId ?? '-'} ${r.action} ${r.decision ?? ''} calldataHash ${r.calldataHash || '?'} gas ${r.gasLimit} ` +
          `fees ${r.maxFeePerGas}/${r.maxPriorityFeePerGas} ${r.status}${r.proofLevel ? `@${r.proofLevel}` : ''} age ${age}s · ${known}`,
      );
    }
    if (p.job) {
      print(
        `    job ${p.job.id}: ${p.job.status} / ${p.job.onChainStatus} · getJob ${p.chainStatus === null ? 'unreadable' : STATUS_NAME[p.chainStatus]} · ` +
          `decision ${p.job.resolution ?? (isPayDecision(p.job) ? 'pay (automatic)' : 'none')} · contested ${p.job.contestedAt ? 'yes' : 'no'} · expiresAt ${p.job.expiresAt?.toISOString() ?? '?'}`,
      );
    }
    print(`    simulation of our calldata: ${p.simulation === null ? 'n/a' : p.simulation ? 'passes' : 'REVERTS'}`);
    print(`    speed-up: ${fmtAllowed(p.ops.speedUp)} · fees ${fmtFee(p.fees.speedUp)} · ${fmtBudget(p.budget.speedUp)}`);
    print(`    cancel:   ${fmtAllowed(p.ops.cancel)} · fees ${fmtFee(p.fees.cancel)} · ${fmtBudget(p.budget.cancel)}`);
    print(`    rebroadcast: ${fmtAllowed(p.ops.rebroadcast)}`);
    print(`    replacements at this nonce: ${p.limit.ok ? `${p.limit.replacementsSoFar} so far` : `refused: ${p.limit.reason}${'retryAt' in p.limit && p.limit.retryAt ? ` (retry at ${p.limit.retryAt.toISOString()})` : ''}`}`);
    print(`    fingerprint speed-up ${p.fingerprint['speed-up']} · cancel ${p.fingerprint.cancel} · rebroadcast ${p.fingerprint.rebroadcast}`);
  }
  print(`Affected jobs (delivered, waiting on the key): ${s.delivered.length}`);
  for (const j of s.delivered) print(`  ${j.id} ${j.status}/${j.onChainStatus} decision ${j.resolution ?? (isPayDecision(j) ? 'pay (automatic)' : 'none')} expiresAt ${j.expiresAt?.toISOString() ?? '?'}`);
  print(`Other live escrow jobs: ${s.otherLive.length}`);
  for (const j of s.otherLive) print(`  ${j.id} ${j.status}/${j.onChainStatus} expiresAt ${j.expiresAt?.toISOString() ?? '?'}`);
  if (s.earliestDelivered?.expiresAt) {
    const passed = s.earliestDelivered.expiresAt.getTime() <= s.blockTime.getTime();
    print(
      `Earliest delivered expiresAt: ${s.earliestDelivered.expiresAt.toISOString()} (job ${s.earliestDelivered.id}) vs ${s.blockTimeSource} time ${s.blockTime.toISOString()}` +
        `${passed ? ' — ALREADY PASSED' : ''} · posture ${s.posture.toUpperCase()}`,
    );
  } else {
    print(`Earliest delivered expiresAt: none recorded · posture ${s.posture.toUpperCase()}`);
  }
  print(CLAIM_REFUND_WARNING);
  print(`About cancel: ${CANCEL_DOES_NOT_SETTLE}`);
}

// ── Execution ────────────────────────────────────────────────────────────────

function phraseFor(op: Operation, chainId: number, nonces: number[], plans: Map<number, NoncePlan>, afterExpiry: boolean): string {
  const tail = afterExpiry ? ' AFTER EXPIRY' : '';
  if (op === 'cancel') return `CANCEL ${chainId} NONCE ${nonces[0]} DOES NOT SETTLE${tail}`;
  if (nonces.length > 1) return `SPEED-UP ${chainId} NONCES ${nonces[0]}-${nonces[nonces.length - 1]} ${nonces.length} TXS${tail}`;
  const p = plans.get(nonces[0]!);
  const label = op === 'speed-up' ? 'SPEED-UP' : 'REBROADCAST';
  return `${label} ${chainId} NONCE ${nonces[0]} ${p?.ours?.action ?? 'UNKNOWN'} ${p?.ours?.jobId ?? p?.job?.id ?? 'NO-JOB'}${tail}`;
}

/** Plan §3: a refusal at a limit — shown, alerted (`evaluator-recovery-refused`), escalated to the owner. Never retried by itself. */
async function refuseAtLimit(deps: RecoveryDeps, s: Situation, nonce: number, reason: string): Promise<never> {
  await raiseEscrowAlert(deps.erc8183, {
    kind: 'evaluator-recovery-refused',
    chainId: s.chainId,
    ...(s.plans.get(nonce)?.job ? { jobId: s.plans.get(nonce)!.job!.id } : {}),
    message:
      `Evaluator recovery on chain ${s.chainId}, nonce ${nonce}, refused: ${reason}. Earliest delivered expiresAt ` +
      `${s.earliestDelivered?.expiresAt?.toISOString() ?? '(none)'}. Only the owner changes a cap (env edit + a new run with a note); ` +
      'nothing is retried automatically.',
    details: { nonce, reason, earliestDeliveredExpiresAt: s.earliestDelivered?.expiresAt?.toISOString() ?? null },
  });
  throw new Refused(reason, 2, true);
}

async function assertEnvironment(deps: RecoveryDeps, s: Situation): Promise<void> {
  const rpc = deps.rpcChainId ? await deps.rpcChainId(s.chainId) : await (deps.erc8183.publicClient(s.chainId) as { getChainId?: () => Promise<number> }).getChainId?.();
  if (rpc !== s.chainId) throw new Refused(`wrong chain: the RPC answers eth_chainId ${rpc ?? 'unreadable'}, --chain is ${s.chainId}`);
  if (!deps.erc8183.config.chain(s.chainId)) throw new Refused(`no escrow configured for chain ${s.chainId} in this environment`);
  const configured = deps.erc8183.config.evaluatorAddress;
  if (configured && getAddress(configured) !== s.evaluator) throw new Refused('the signer key is not the configured evaluator of this environment');
  const foreignJobs = [...s.delivered, ...s.otherLive].filter((j) => j.evaluator && getAddress(j.evaluator) !== s.evaluator);
  if (foreignJobs.length > 0) {
    throw new Refused(`the signer key is not the Job.evaluator of the live jobs (${foreignJobs.slice(0, 3).map((j) => j.id).join(', ')}) — wrong DB or wrong key`);
  }
}

interface ExecContext {
  deps: RecoveryDeps;
  args: Args;
  op: Operation;
  incidentId: string;
  print: (l: string) => void;
  sent: Array<{ nonce: number; hash: Hex }>;
}

/** §8.4-3: the critical section for one nonce, inside the evaluator lane. */
async function executeNonce(ctx: ExecContext, s: Situation, nonce: number, confirmed: string): Promise<void> {
  const { deps, args, op, print } = ctx;
  const lanes = (deps.erc8183.evaluatorLanes ?? deps.erc8183.lanes) as Partial<LeaseLock> | undefined;
  if (!lanes || typeof lanes.acquire !== 'function') throw new Refused('no evaluator lane lock (LeaseLock) in this process — nothing is sent without the lane');
  const settings = deps.erc8183.evaluatorA1 ?? { leaseMinRemainingMs: 30_000, criticalSectionMaxMs: 60_000 };
  const lease = await lanes.acquire(evaluatorLaneKey(s.chainId, s.evaluator));
  const t0 = nowOf(deps).getTime();
  const section = () => {
    const elapsed = nowOf(deps).getTime() - t0;
    if (elapsed > settings.criticalSectionMaxMs) throw new Refused(`critical section took ${elapsed} ms (> ${settings.criticalSectionMaxMs} ms, P17): aborted before the send`, 3);
  };
  let candidateId: string | null = null;
  try {
    // 1. re-read everything and compare the fingerprint
    const fresh = await readSituation(deps, args);
    const p = fresh.plans.get(nonce);
    if (!p) throw new Refused(`nonce ${nonce} is no longer in the queue — the plan changed; run the dry-run again`, 3);
    if (p.fingerprint[op] !== confirmed) throw new Refused(`the plan of nonce ${nonce} changed since the confirmation (fingerprint) — aborted, nothing sent; run the dry-run again`, 3);
    // 2. Q7 again, inside the lane
    if (!gateOpen(deps, s.chainId)) throw new Refused(`the on-chain configuration of chain ${s.chainId} is not verified in this process (Q7)`, 3);
    // 3. caps and balance, fresh
    const caps = fresh.caps;
    const problem = capsProblem(caps);
    if (problem) throw new Refused(`no usable caps (${problem.reason}) — dry-run only`);
    const allowed = op === 'speed-up' ? p.ops.speedUp : op === 'cancel' ? p.ops.cancel : p.ops.rebroadcast;
    if (!allowed.ok) throw new Refused(`${op} refused at nonce ${nonce}: ${allowed.reason}${allowed.detail ? ` (${allowed.detail})` : ''}`);
    section();

    if (op === 'rebroadcast') {
      const ours = p.ours!;
      await ledger.markBroadcast(db(deps), ours.id);
      section();
      const out = await deps.signer.sendRaw(ours.rawTx as Hex, { lease, minLeaseMs: settings.leaseMinRemainingMs });
      await answer(deps, ours.id, out);
      print(`  nonce ${nonce}: identical rebroadcast of ${ours.txHash} → ${out.kind}`);
      ctx.sent.push({ nonce, hash: ours.txHash as Hex });
      return;
    }

    if (!p.limit.ok) await refuseAtLimit(deps, fresh, nonce, `replacement limit: ${p.limit.reason}${'retryAt' in p.limit && p.limit.retryAt ? ` (retry at ${p.limit.retryAt.toISOString()})` : ''}`);
    const proposal = op === 'speed-up' ? p.fees.speedUp : p.fees.cancel;
    if (!proposal.ok) {
      await refuseAtLimit(deps, fresh, nonce, `fees: ${proposal.reason}${'needed' in proposal && proposal.needed !== undefined ? ` — would need ${proposal.needed} wei, cap ${proposal.cap} wei` : ''}`);
      return;
    }
    const budget = op === 'speed-up' ? p.budget.speedUp : p.budget.cancel;
    if (!budget || !budget.ok) {
      await refuseAtLimit(deps, fresh, nonce, `budget: ${budget ? budget.reason : 'balance unreadable'}${budget && 'needed' in budget && budget.needed !== undefined ? ` — would need ${budget.needed} wei, cap / available ${budget.cap} wei` : ''}`);
      return;
    }
    const ours = p.ours;
    const job = p.job;
    // A cancel replaces the most expensive live candidate of the nonce (fees must beat it) and stamps ITS job.
    const replaced = [...p.live].sort((x, y) => (y.maxFeePerGas > x.maxFeePerGas ? 1 : y.maxFeePerGas < x.maxFeePerGas ? -1 : 0))[0] ?? null;
    const stampJobId = op === 'cancel' ? (replaced?.jobId ?? null) : ours!.jobId;
    // 4. sign with explicit nonce and fees (no RPC)
    const tx: EvaluatorExplicitTx =
      op === 'speed-up'
        ? { to: getAddress(ours!.toAddress!), data: ours!.calldata as Hex, value: 0n, nonce, gas: ours!.gasLimit, maxFeePerGas: proposal.maxFeePerGas, maxPriorityFeePerGas: proposal.maxPriorityFeePerGas }
        : { to: s.evaluator, data: '0x', value: 0n, nonce, gas: CANCEL_GAS, maxFeePerGas: proposal.maxFeePerGas, maxPriorityFeePerGas: proposal.maxPriorityFeePerGas };
    const signed = await deps.signer.signExplicit(tx);
    if (op === 'speed-up' && keccak256(signed.data).toLowerCase() !== ours!.calldataHash.toLowerCase()) {
      throw new Refused('the speed-up calldata differs from the original (calldataHash) — refused', 3);
    }
    section();
    // 5. the SCRIPT candidate + the job stamp, one DB transaction (budget re-checked under the ledger lock)
    const note = `${args.note} (by ${args.operator})`;
    const jobRow = stampJobId ? await db(deps).job.findUnique({ where: { id: stampJobId }, select: { settleTxHash: true } }) : null;
    try {
      const inserted = await ledger.insertCandidateWithJobStamp(db(deps), {
        candidate: {
          chainId: s.chainId,
          evaluator: s.evaluator,
          nonce,
          jobId: stampJobId,
          kind: op === 'speed-up' ? 'SPEED_UP' : 'CANCEL',
          action: op === 'speed-up' ? ours!.action : 'CANCEL_NOOP',
          decision: op === 'speed-up' ? ours!.decision : null,
          reasonHex: op === 'speed-up' ? ours!.reasonHex : null,
          replacesId: op === 'speed-up' ? ours!.id : (replaced?.id ?? null),
          toAddress: signed.to,
          valueWei: 0n,
          calldata: signed.data,
          gasLimit: signed.gas,
          maxFeePerGas: signed.maxFeePerGas,
          maxPriorityFeePerGas: signed.maxPriorityFeePerGas,
          txHash: signed.hash,
          rawTx: signed.raw,
          origin: 'SCRIPT',
          operator: args.operator,
          note: args.note,
          incidentId: ctx.incidentId,
        },
        ...(stampJobId
          ? {
              job: {
                id: stampJobId,
                expectedSettleTxHash: jobRow?.settleTxHash ?? null,
                setSettleTxHash: op === 'speed-up',
                stampAttempt: true,
              },
            }
          : {}),
        budget: { caps, incidentId: ctx.incidentId, balanceWei: fresh.balance ?? 0n },
        now: nowOf(deps),
      });
      candidateId = inserted.id;
    } catch (err) {
      if (err instanceof ledger.BudgetRefusedError) {
        await refuseAtLimit(deps, fresh, nonce, `${err.reason}${err.extra.needed !== undefined ? ` — would need ${err.extra.needed} wei, cap ${err.extra.cap} wei` : ''}${err.extra.retryAt ? ` (retry at ${err.extra.retryAt.toISOString()})` : ''}`);
      }
      throw new Refused(`the ledger refused the candidate: ${(err as Error).message}`, 3);
    }
    // D-i: one short line in Job.escrowError (the reviewLog is not touched)
    const affectedJob = stampJobId;
    if (affectedJob) {
      await db(deps).job.updateMany({
        where: { id: affectedJob },
        data: { escrowError: `A1 recovery ${op} at nonce ${nonce} (${signed.hash}) by ${args.operator}: ${args.note}`.slice(0, 500) },
      });
    }
    await ledger.markBroadcast(db(deps), candidateId);
    section();
    // 6. assertHeld (inside sendRaw) + send
    const out = await deps.signer.sendRaw(signed.raw, { lease, minLeaseMs: settings.leaseMinRemainingMs });
    await answer(deps, candidateId, out);
    if (affectedJob) await db(deps).job.updateMany({ where: { id: affectedJob, settleAttemptAt: { not: null } }, data: { settleAttemptAt: null } });
    print(`  nonce ${nonce}: ${op} ${signed.hash} sent → ${out.kind}${'message' in out ? ` (${out.message})` : ''} · note: ${note}`);
    ctx.sent.push({ nonce, hash: signed.hash });
  } catch (err) {
    if ((err as { name?: string }).name === 'LeaseLostError') {
      if (candidateId) await ledger.markAnswered(db(deps), candidateId, 'UNCERTAIN', `not broadcast: ${(err as Error).message}`);
      throw new Refused(`the evaluator lane was lost before the send (${(err as Error).message}) — nothing sent; the recorded candidate stays SIGNED`, 3);
    }
    throw err;
  } finally {
    await lease.release();
  }
}

async function answer(deps: RecoveryDeps, id: string, out: EvaluatorSendRawOutcome): Promise<void> {
  if (out.kind === 'accepted' || out.kind === 'already-known') await ledger.markAnswered(db(deps), id, 'SENT');
  else if (out.kind !== 'nonce-too-low') await ledger.markAnswered(db(deps), id, 'UNCERTAIN', `${out.kind}: ${out.message}`);
  // nonce-too-low: the nonce is consumed — the reconciliation proves which transaction won (§4.2).
}

// ── Entry ────────────────────────────────────────────────────────────────────

/**
 * The script, testable: parses `argv`, prints the dry-run, and executes only with every gate passed.
 * Never throws for an expected refusal (exit code 2 / 3 with the reason in the output).
 */
export async function runEvaluatorRecovery(argv: readonly string[], deps: RecoveryDeps): Promise<RecoveryResult> {
  const lines: string[] = [];
  const print = (l: string) => {
    lines.push(l);
    deps.print?.(l);
  };
  let lock: RecoveryLockLike | null = null;
  try {
    const args = parseRecoveryArgs(argv);
    if (deps.erc8183.config.evaluatorAddress === null && !deps.signer) throw new Refused('no evaluator key configured');
    // §5.2: the reconciliation pass at the start of every run.
    try {
      await reconcileEvaluatorCandidates(deps.erc8183, args.chainId);
    } catch (err) {
      print(`  ! reconciliation pass failed: ${(err as Error).message}`);
    }
    let s = await readSituation(deps, args);
    describe(s, print);
    if (!args.execute) return { exitCode: 0, output: lines.join('\n') };

    // ── refusals before anything else
    const op = args.execute;
    const nonces = args.nonces!;
    if (capsProblem(s.caps)) throw new Refused('no recovery caps configured for this chain (EVALUATOR_RECOVERY_*): dry-run only, --execute refused (fail closed)');
    if (!deps.tty.isTTY) throw new Refused('no TTY (stdin redirected): the typed confirmation is required — refused');
    if (s.problems.length > 0) throw new Refused(`the situation could not be read: ${s.problems.join('; ')}`);
    await assertEnvironment(deps, s);
    // §4.3: an unacknowledged EXTERNAL blocks every execution on the chain.
    for (const e of s.unackedExternal) {
      if (args.acknowledgeForeign.includes(e.txHash.toLowerCase())) await ledger.acknowledgeExternal(db(deps), args.chainId, e.txHash, args.operator!);
    }
    const stillForeign = (await ledger.unacknowledgedExternal(db(deps), args.chainId, s.evaluator)).map((e) => e.txHash);
    if (stillForeign.length > 0) throw new Refused(`EXTERNAL transaction(s) of this key not acknowledged: ${stillForeign.join(', ')} — rerun with --acknowledge-foreign <hash> after the incident review`);
    if (s.latest === null) throw new Refused('the head nonce cannot be read on every node');
    if (op === 'speed-up' && nonces.length > 1) {
      const r = rangePlanCheck(s.latest, nonces, s.caps);
      if (!r.ok) throw new Refused(`range refused: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
    } else {
      const h = headCheck(nonces[0]!, s.views);
      if (!h.ok) throw new Refused(`nonce ${nonces[0]} is not the head (${h.reason}${h.detail ? `: ${h.detail}` : ''}) — always the head first`);
    }
    let afterExpiry = false;
    for (const n of nonces) {
      const p = s.plans.get(n);
      if (!p) throw new Refused(`nonce ${n} is not in the queue [latest, pending)`);
      const a = op === 'speed-up' ? p.ops.speedUp : op === 'cancel' ? p.ops.cancel : p.ops.rebroadcast;
      if (!a.ok) {
        if (op === 'cancel' && a.reason === 'SPEED_UP_POSSIBLE') throw new Refused(`cancel refused at nonce ${n}: a speed-up is possible (R2-P2-1, no override). ${CANCEL_DOES_NOT_SETTLE}`);
        throw new Refused(`${op} refused at nonce ${n}: ${a.reason}${a.detail ? ` (${a.detail})` : ''}`);
      }
      if (a.requiresAfterExpiryPhrase) afterExpiry = true;
      if (op !== 'rebroadcast') {
        if (!p.limit.ok) await refuseAtLimit(deps, s, n, `replacement limit: ${p.limit.reason}`);
        const f = op === 'speed-up' ? p.fees.speedUp : p.fees.cancel;
        if (!f.ok) await refuseAtLimit(deps, s, n, `fees: ${f.reason}${'needed' in f && f.needed !== undefined ? ` — would need ${f.needed} wei, cap ${f.cap} wei` : ''}`);
        const b = op === 'speed-up' ? p.budget.speedUp : p.budget.cancel;
        if (!b || !b.ok) await refuseAtLimit(deps, s, n, `budget: ${b ? b.reason : 'balance unreadable'}${b && 'needed' in b && b.needed !== undefined ? ` — would need ${b.needed} wei, cap / available ${b.cap} wei` : ''}`);
      }
    }

    // ── the typed confirmation (never inside the lane)
    const phrase = phraseFor(op, args.chainId, nonces, s.plans, afterExpiry);
    print(`Plan: ${op} ${nonces.map((n) => `nonce ${n} (job ${s.plans.get(n)?.job?.id ?? '-'}, ${s.plans.get(n)?.ours?.action ?? 'CANCEL_NOOP'})`).join(', ')}`);
    if (op === 'cancel') print(CANCEL_DOES_NOT_SETTLE);
    const typed = (await deps.tty.ask(`Type exactly: ${phrase}\n> `)).trim();
    if (typed !== phrase) throw new Refused('confirmation phrase does not match — nothing done');
    const confirmed = new Map(nonces.map((n) => [n, s.plans.get(n)!.fingerprint[op]]));

    // ── the recovery lock (one recovery per chain), the full Q7 after the confirmation
    try {
      lock = await deps.acquireRecoveryLock(args.chainId, args.operator!);
    } catch (err) {
      throw new Refused(`another recovery holds the lock of chain ${args.chainId}: ${(err as Error).message}`);
    }
    const verified = deps.verifyConfig ? await deps.verifyConfig(args.chainId) : gateOpen(deps, args.chainId) ? ({ ok: true } as const) : ({ ok: false, reason: 'the config gate is closed' } as const);
    if (!verified.ok) throw new Refused(`the on-chain configuration could not be verified (Q7): ${verified.reason}`);

    const { incident } = await ledger.openIncident(db(deps), { chainId: args.chainId, evaluator: s.evaluator, headNonce: s.latest, openedBy: args.operator! });
    print(`Incident ${incident.id} (head nonce ${incident.headNonce}, opened by ${incident.openedBy})`);
    const ctx: ExecContext = { deps, args, op, incidentId: incident.id, print, sent: [] };
    // R2-P2-4: nonce by nonce, from the head backwards; stop at the first deviation.
    for (const n of nonces) {
      await executeNonce(ctx, s, n, confirmed.get(n)!);
    }

    // ── after: the receipt OUTSIDE the lane (bounded), then the reconciliation
    const waitMs = deps.receiptWaitMs ?? 90_000;
    for (const sent of ctx.sent) {
      try {
        await Promise.race([deps.signer.waitForTransactionReceipt(sent.hash), new Promise((_, reject) => setTimeout(() => reject(new Error('receipt wait timeout')), waitMs))]);
      } catch {
        print(`  nonce ${sent.nonce}: no receipt within ${waitMs} ms — the reconciliation pass will prove the winner`);
      }
    }
    await reconcileEvaluatorCandidates(deps.erc8183, args.chainId);
    s = await readSituation(deps, args);
    if (s.pending !== null && s.latest !== null && s.pending <= s.latest && s.queue.every((n) => (s.plans.get(n)?.live.length ?? 0) === 0)) {
      await ledger.closeIncident(db(deps), incident.id, 'queue unblocked');
      print(`Incident ${incident.id} closed: the queue is unblocked`);
    } else {
      print(`Incident ${incident.id} stays open (queue: ${s.queue.join(', ') || 'empty'}) — run the dry-run again`);
    }
    return { exitCode: 0, output: lines.join('\n') };
  } catch (err) {
    if (err instanceof Refused) {
      print(`REFUSED: ${err.reason}`);
      return { exitCode: err.exitCode, output: lines.join('\n') };
    }
    print(`ERROR: ${(err as Error)?.message ?? String(err)}`);
    return { exitCode: 1, output: lines.join('\n') };
  } finally {
    if (lock) await lock.release().catch(() => undefined);
  }
}

/** Production wiring (only when run as a script): the backend's env, DB, Redis, signer and RPCs. */
async function main(): Promise<void> {
  const [{ env, escrowEvaluatorAddress }, runtime, signerMod, laneRuntime, boot, readline] = await Promise.all([
    import('../config/env.js'),
    import('../services/job/escrow-erc8183.runtime.js'),
    import('../services/escrow/evaluator-signer.js'),
    import('../services/transaction/wallet-lane.runtime.js'),
    import('../config/escrow-boot.runtime.js'),
    import('node:readline/promises'),
  ]);
  if (!env.ESCROW_EVALUATOR_PRIVATE_KEY || !escrowEvaluatorAddress) {
    console.error('ESCROW_EVALUATOR_PRIVATE_KEY is not configured — run this where the evaluator key already is');
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const chainIdx = argv.indexOf('--chain');
  const chainId = chainIdx >= 0 ? Number(argv[chainIdx + 1]) : NaN;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const actWithin = (env.ESCROW_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS || 86_400) * 1000;
  const result = await runEvaluatorRecovery(argv, {
    erc8183: runtime.erc8183Deps(),
    signer: signerMod.getEvaluatorSigner(chainId, env.ESCROW_EVALUATOR_PRIVATE_KEY as Hex),
    acquireRecoveryLock: (id, owner) => laneRuntime.acquireEvaluatorRecoveryLock(id, { owner }),
    verifyConfig: (id) => boot.verifyEscrowConfigOnce(id),
    thresholds: {
      actWithinMs: actWithin,
      urgentWithinMs: Math.min(actWithin, env.EVALUATOR_RECOVERY_URGENT_WITHIN_SECONDS * 1000),
      handToOwnerWithinMs: Math.min(actWithin, env.EVALUATOR_RECOVERY_URGENT_WITHIN_SECONDS * 1000, env.EVALUATOR_RECOVERY_HAND_TO_OWNER_WITHIN_SECONDS * 1000),
    },
    tty: { isTTY: Boolean(process.stdin.isTTY), ask: (q) => rl.question(q) },
    print: (l) => console.log(l),
    receiptWaitMs: env.EVALUATOR_RECOVERY_RECEIPT_WAIT_SECONDS * 1000,
  });
  rl.close();
  process.exit(result.exitCode);
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === new URL(`file:///${(process.argv[1] ?? '').replace(/\\/g, '/').replace(/^\//, '')}`).href || /evaluator-recovery\.ts$/.test(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (invokedDirectly && !process.env['VITEST']) {
  void main();
}
