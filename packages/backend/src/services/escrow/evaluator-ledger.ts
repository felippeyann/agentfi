/**
 * C3g-A1 — the evaluator candidate ledger (tables of migration 0026). The
 * ONLY writer of `EvaluatorTransaction`, `EvaluatorRecoveryIncident` and
 * `EvaluatorChainState`. Prisma is injected; nothing here reads the chain.
 *
 * Write rules (spec §2.4 + R2):
 *  1. a candidate is inserted as SIGNED before its first byte is sent, in ONE
 *     interactive transaction with the conditional write of its job
 *     (`insertCandidateWithJobStamp`): the job row is locked FOR UPDATE, the
 *     job's live candidates are re-checked (R2-P3-3), the evaluator key is
 *     serialized with a transaction-scoped advisory lock, a SCRIPT row passes
 *     the durable budget / replacement / interval checks derived from rows
 *     (never from memory), and a lost conditional write rolls everything back
 *     (`SettlementSupersededError`, nothing may be sent);
 *  2. idempotent: UNIQUE(chainId, txHash) + ON CONFLICT DO NOTHING;
 *  3. status changes are monotonic and conditional on the status read; the
 *     only way back is `revertForReorg`, for proof level `latest` only;
 *  4. nothing closes by time: callers bring the chain proof.
 * Addresses are stored checksummed, hashes lowercase.
 */
import { Prisma, type EvaluatorChainState, type EvaluatorTransaction, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getAddress, keccak256, type Hex } from 'viem';
import { sanitizeStoredError } from '../../api/errors/sanitize.js';
import { SettlementSupersededError } from '../job/escrow-errors.js';
import {
  LIVE_STATUSES,
  budgetCheck,
  isLiveStatus,
  replacementLimitCheck,
  type CandidateAction,
  type CandidateKind,
  type CandidateOrigin,
  type CandidateRow,
  type CandidateStatus,
  type ProofLevel,
  type RecoveryCaps,
} from './evaluator-candidates.js';

export { SettlementSupersededError };

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Client = Db | Tx;

// ── Errors ───────────────────────────────────────────────────────────────────

/** The candidate contradicts the ledger: nothing was written, nothing may be sent. */
export class CandidateConflictError extends Error {
  constructor(readonly code: CandidateConflictCode, detail: string) {
    super(`evaluator candidate refused (${code}): ${detail}`);
    this.name = 'CandidateConflictError';
  }
}
export type CandidateConflictCode =
  | 'LIVE_OTHER_DECISION'   // R2-P3-3: a live candidate of another decision (other calldata) of the job
  | 'LIVE_CANCEL'           // R2-P3-3: a live CANCEL of the job
  | 'NONCE_OCCUPIED'        // R2-P2-3: a live candidate already sits at that nonce
  | 'BAD_REPLACEMENT'       // a SPEED_UP / CANCEL that does not replace a live candidate of the same nonce correctly
  | 'CANCEL_WITHOUT_CANDIDATE' // a CANCEL stamped on a job that has no candidate at that nonce
  | 'TX_HASH_REUSED';       // the same (chainId, txHash) recorded with other fields

/** A SCRIPT row refused by the durable budget / replacement / interval rules. Nothing written. */
export class BudgetRefusedError extends Error {
  constructor(readonly reason: string, readonly detail?: string | undefined, readonly extra: { needed?: bigint | undefined; cap?: bigint | undefined; retryAt?: Date | undefined } = {}) {
    super(`evaluator recovery refused (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'BudgetRefusedError';
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

type DbRow = EvaluatorTransaction;

/** A ledger row: the rules' view plus the stored fields the callers need. */
export interface LedgerCandidate extends CandidateRow {
  decision: string | null;
  reasonHex: string | null;
  replacesId: string | null;
  toAddress: string | null;
  valueWei: bigint;
  calldata: string | null;
  rawTx: string | null;
  operator: string | null;
  note: string | null;
  sendError: string | null;
  answeredAt: Date | null;
  resolvedAt: Date | null;
  minedBlockNumber: bigint | null;
}

export function toCandidate(r: DbRow): LedgerCandidate {
  return {
    id: r.id,
    chainId: r.chainId,
    evaluator: r.evaluator,
    nonce: r.nonce,
    jobId: r.jobId,
    kind: r.kind as CandidateKind,
    action: r.action as CandidateAction,
    decision: r.decision,
    reasonHex: r.reasonHex,
    replacesId: r.replacesId,
    toAddress: r.toAddress,
    valueWei: BigInt(r.valueWei),
    calldata: r.calldata,
    // '' / 0n only on a LEGACY row without nonce (tx data unknown).
    calldataHash: r.calldataHash ?? '',
    gasLimit: BigInt(r.gasLimit ?? '0'),
    maxFeePerGas: BigInt(r.maxFeePerGas ?? '0'),
    maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas ?? '0'),
    txHash: r.txHash,
    rawTx: r.rawTx,
    status: r.status as CandidateStatus,
    proofLevel: r.proofLevel as ProofLevel | null,
    createdAt: r.createdAt,
    broadcastAt: r.broadcastAt,
    lastBroadcastAt: r.lastBroadcastAt,
    answeredAt: r.answeredAt,
    resolvedAt: r.resolvedAt,
    origin: r.origin as CandidateOrigin,
    operator: r.operator,
    note: r.note,
    incidentId: r.incidentId,
    sendError: r.sendError,
    minedBlockNumber: r.minedBlockNumber === null ? null : BigInt(r.minedBlockNumber),
    minedBlockHash: r.minedBlockHash,
  };
}

// ── Normalization ────────────────────────────────────────────────────────────

const HASH_RE = /^0x[0-9a-f]{64}$/;
const SEND_ERROR_MAX = 500;

function normHash(h: string, what: string): string {
  const v = h.toLowerCase();
  if (!HASH_RE.test(v)) throw new TypeError(`${what} is not a 32-byte hex hash: ${h}`);
  return v;
}

export function normAddress(a: string): string {
  return getAddress(a);
}

function nonNegInt(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`${what} must be a non-negative integer (got ${n})`);
  return n;
}

function posBig(v: bigint, what: string): bigint {
  if (typeof v !== 'bigint' || v < 0n) throw new TypeError(`${what} must be a non-negative bigint`);
  return v;
}

function clipError(e: string | null | undefined): string | null {
  const s = sanitizeStoredError(e ?? null);
  if (!s) return null;
  return s.length > SEND_ERROR_MAX ? `${s.slice(0, SEND_ERROR_MAX - 1)}…` : s;
}

/** Advisory-lock key of an evaluator key (chainId, checksummed evaluator → lowercase). */
export function evaluatorLockKey(chainId: number, evaluator: string): string {
  return `agentfi:evaluator-ledger:${chainId}:${evaluator.toLowerCase()}`;
}

async function lockEvaluator(tx: Tx, chainId: number, evaluator: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${evaluatorLockKey(chainId, evaluator)}, 0))::text AS "locked"`;
}

const LIVE = [...LIVE_STATUSES] as string[];

// ── Insert ───────────────────────────────────────────────────────────────────

export interface NewCandidate {
  chainId: number;
  evaluator: string;
  nonce: number;
  /** The job it settles; for a CANCEL, the job of the candidate it replaces; null for a foreign head. */
  jobId: string | null;
  kind: 'ORIGINAL' | 'SPEED_UP' | 'CANCEL';
  action: CandidateAction;
  decision?: string | null;
  reasonHex?: string | null;
  replacesId?: string | null;
  toAddress: string;
  valueWei?: bigint;
  calldata: Hex;
  /** Checked against keccak256(calldata) when given. */
  calldataHash?: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  txHash: string;
  rawTx?: string | null;
  origin: 'WORKER' | 'SCRIPT' | 'RECONCILE';
  operator?: string | null;
  note?: string | null;
  incidentId?: string | null;
}

export interface JobStampInput {
  id: string;
  /** The job's settleTxHash as read before signing (the conditional write's predicate). */
  expectedSettleTxHash: string | null;
  /** Move settleTxHash to this candidate: decision candidates only, never a CANCEL. */
  setSettleTxHash: boolean;
  /** Stamp settleAttemptAt = now. */
  stampAttempt: boolean;
  /** Extra predicate (today: 'SETTLING' for a claimed settlement). Addition to the contract of 22/10. */
  expectedOnChainStatus?: string;
}

export interface BudgetInputCtx {
  caps: RecoveryCaps | null;
  incidentId: string;
  /** Native balance of the evaluator, read before the critical section. Addition to the contract of 22/10. */
  balanceWei: bigint;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Inserts the SIGNED candidate and writes its job, in ONE interactive
 * transaction (spec §2.4-2, R2-P3-3, plan §3):
 *   SELECT … FROM "Job" … FOR UPDATE → pg_advisory_xact_lock(chainId, evaluator)
 *   → replay check (same txHash) → live-candidate re-check → SCRIPT: open
 *   incident, replacements / interval at the nonce, budget (incident, 24 h,
 *   reserve) from the rows → INSERT … ON CONFLICT DO NOTHING → conditional job
 *   write (count = 0 ⇒ rollback + SettlementSupersededError).
 * Returns the row id; `inserted: false` when the same tx was already recorded
 * (idempotent replay: the job write still runs and still decides).
 */
export async function insertCandidateWithJobStamp(
  db: Db,
  input: { candidate: NewCandidate; job?: JobStampInput; budget?: BudgetInputCtx; now?: Date },
): Promise<{ id: string; inserted: boolean }> {
  const now = input.now ?? new Date();
  const c = input.candidate;
  const evaluator = normAddress(c.evaluator);
  const toAddress = normAddress(c.toAddress);
  const nonce = nonNegInt(c.nonce, 'nonce');
  const txHash = normHash(c.txHash, 'txHash');
  const calldata = c.calldata.toLowerCase() as Hex;
  const calldataHash = keccak256(calldata);
  if (c.calldataHash !== undefined && c.calldataHash.toLowerCase() !== calldataHash) {
    throw new TypeError('calldataHash does not match keccak256(calldata)');
  }
  const valueWei = posBig(c.valueWei ?? 0n, 'valueWei');
  const gasLimit = posBig(c.gasLimit, 'gasLimit');
  const maxFee = posBig(c.maxFeePerGas, 'maxFeePerGas');
  const prio = posBig(c.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
  if (prio > maxFee) throw new TypeError('maxPriorityFeePerGas above maxFeePerGas');
  if (c.kind === 'CANCEL') {
    if (c.action !== 'CANCEL_NOOP' || calldata !== '0x' || valueWei !== 0n || gasLimit !== 21_000n || toAddress !== evaluator) {
      throw new TypeError('a CANCEL is a 0-value self-transfer of 21 000 gas with no data (action CANCEL_NOOP)');
    }
  } else if (c.action === 'CANCEL_NOOP') {
    throw new TypeError('CANCEL_NOOP is the action of a CANCEL only');
  }
  if (c.kind === 'SPEED_UP' && !c.replacesId) throw new TypeError('a SPEED_UP names the candidate it replaces');
  if (c.jobId !== null && !input.job) throw new TypeError('a candidate of a job is inserted with the job write (spec §2.4-2)');
  const job = input.job;
  if (job) {
    if (job.id !== c.jobId) throw new TypeError('job.id differs from candidate.jobId');
    if (!job.setSettleTxHash && !job.stampAttempt) throw new TypeError('the job write must change the job row (settleTxHash and / or settleAttemptAt)');
    if (job.setSettleTxHash && c.kind === 'CANCEL') throw new TypeError('settleTxHash never points to a CANCEL');
  }
  if (c.origin === 'SCRIPT') {
    if (!input.budget) throw new BudgetRefusedError('NO_CAPS', 'a SCRIPT candidate needs the configured caps and its incident');
    if (!c.operator) throw new TypeError('a SCRIPT candidate names its operator');
    if (c.incidentId !== input.budget.incidentId) throw new TypeError('candidate.incidentId differs from budget.incidentId');
  }

  return db.$transaction(async (tx) => {
    // 1. the job row, locked (R2-P3-3)
    let jobRow: { id: string; settleTxHash: string | null; onChainStatus: string | null } | undefined;
    if (job) {
      const rows = await tx.$queryRaw<Array<{ id: string; settleTxHash: string | null; onChainStatus: string | null }>>`
        SELECT "id", "settleTxHash", "onChainStatus" FROM "Job" WHERE "id" = ${job.id} FOR UPDATE`;
      jobRow = rows[0];
      if (!jobRow) throw new SettlementSupersededError(job.id);
    }
    // 2. the evaluator key, serialized across processes (released at commit / rollback)
    await lockEvaluator(tx, c.chainId, evaluator);

    // 3. replay of an already recorded tx
    let existing = await tx.evaluatorTransaction.findUnique({ where: { chainId_txHash: { chainId: c.chainId, txHash } } });
    // A1 fix round (row 32, R2-P3-1): a LEGACY row without nonce (backfilled from a hash no node returned) whose
    // job re-signs the SAME decision with the same nonce and fees gets the SAME hash — the same signed bytes
    // (hash = keccak256(raw)). The row becomes a normal one (nonce, tx data, raw), never a conflict.
    if (existing && existing.kind === 'LEGACY' && existing.nonce === null && existing.jobId === c.jobId && existing.evaluator === evaluator) {
      // Rechecagem R-P3-a: the promotion gives the row a nonce and a decision, so it passes the same checks as a
      // new candidate — nonce occupancy (R2-P2-3) and R2-P3-3 — excluding the row itself.
      const self = existing.id;
      const liveAtNonce = await tx.evaluatorTransaction.findMany({ where: { chainId: c.chainId, evaluator, nonce, status: { in: LIVE }, id: { not: self } } });
      if (liveAtNonce.length > 0) throw new CandidateConflictError('NONCE_OCCUPIED', `nonce ${nonce} has a live candidate (${liveAtNonce[0]!.txHash})`);
      if (c.jobId !== null) {
        const liveOfJob = await tx.evaluatorTransaction.findMany({ where: { jobId: c.jobId, status: { in: LIVE }, id: { not: self } } });
        for (const l of liveOfJob) {
          if (l.nonce === null) continue;
          if (l.kind === 'CANCEL') throw new CandidateConflictError('LIVE_CANCEL', `live cancel ${l.txHash} of job ${c.jobId}`);
          if (l.calldataHash !== calldataHash || (l.decision ?? null) !== (c.decision ?? null)) {
            throw new CandidateConflictError('LIVE_OTHER_DECISION', `live candidate ${l.txHash} of job ${c.jobId} carries another decision`);
          }
        }
      }
      existing = await tx.evaluatorTransaction.update({
        where: { id: existing.id },
        data: {
          nonce,
          toAddress,
          valueWei: valueWei.toString(),
          calldata,
          calldataHash,
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFee.toString(),
          maxPriorityFeePerGas: prio.toString(),
          rawTx: c.rawTx ?? existing.rawTx,
          action: existing.action === 'UNKNOWN' ? c.action : existing.action,
          decision: existing.decision ?? c.decision ?? null,
        },
      });
    }
    if (existing && existing.kind === 'LEGACY' && existing.nonce === nonce && existing.calldataHash === calldataHash && existing.jobId === c.jobId) {
      // replay of the upgraded legacy row: the same transaction
    } else if (existing) {
      if (existing.evaluator !== evaluator || existing.nonce !== nonce || existing.jobId !== c.jobId
          || existing.calldataHash !== calldataHash || existing.kind !== c.kind) {
        throw new CandidateConflictError('TX_HASH_REUSED', `${txHash} already recorded with other fields`);
      }
    } else {
      // 4. live candidates: nonce occupancy (R2-P2-3) and replacement shape
      const atNonce = await tx.evaluatorTransaction.findMany({ where: { chainId: c.chainId, evaluator, nonce } });
      const liveAtNonce = atNonce.filter((r) => isLiveStatus(r.status as CandidateStatus));
      if (c.kind === 'ORIGINAL') {
        if (liveAtNonce.length > 0) throw new CandidateConflictError('NONCE_OCCUPIED', `nonce ${nonce} has a live candidate (${liveAtNonce[0]!.txHash})`);
      } else if (!c.replacesId) {
        // a CANCEL of a foreign / unknown head replaces nothing of ours — only when nothing of ours is live there
        if (liveAtNonce.length > 0) throw new CandidateConflictError('BAD_REPLACEMENT', `nonce ${nonce} has a live candidate: name it in replacesId`);
      } else {
        const replaced = atNonce.find((r) => r.id === c.replacesId);
        if (!replaced || !isLiveStatus(replaced.status as CandidateStatus)) {
          throw new CandidateConflictError('BAD_REPLACEMENT', `${c.replacesId} is not a live candidate at nonce ${nonce}`);
        }
        if (replaced.jobId !== c.jobId) throw new CandidateConflictError('BAD_REPLACEMENT', 'the replacement belongs to the job of the candidate it replaces');
        // P6: above the MOST EXPENSIVE live candidate of the nonce, on both fees
        for (const l of liveAtNonce) {
          if (maxFee <= BigInt(l.maxFeePerGas ?? '0') || prio <= BigInt(l.maxPriorityFeePerGas ?? '0')) {
            throw new CandidateConflictError('BAD_REPLACEMENT', `both fees must be above every live candidate of nonce ${nonce} (${l.txHash})`);
          }
        }
        if (c.kind === 'SPEED_UP') {
          if (replaced.calldataHash !== calldataHash || replaced.jobId !== c.jobId || (replaced.toAddress ?? '') !== toAddress) {
            throw new CandidateConflictError('BAD_REPLACEMENT', 'a speed-up re-signs the same calldata, to, job (spec §3.1)');
          }
          if (gasLimit < BigInt(replaced.gasLimit ?? '0')) throw new CandidateConflictError('BAD_REPLACEMENT', 'gas limit below the original');
        }
      }
      if (c.kind === 'CANCEL' && c.jobId !== null && !atNonce.some((r) => r.jobId === c.jobId)) {
        throw new CandidateConflictError('CANCEL_WITHOUT_CANDIDATE', `job ${c.jobId} has no candidate at nonce ${nonce}`);
      }
      // 5. R2-P3-3: no live candidate of ANOTHER decision or a CANCEL of the job
      if (c.jobId !== null && c.kind !== 'CANCEL') {
        const live = await tx.evaluatorTransaction.findMany({ where: { jobId: c.jobId, status: { in: LIVE } } });
        for (const l of live) {
          if (l.nonce === null) continue; // legacy row without nonce: today's rule (P3-1), decided by the caller
          if (l.kind === 'CANCEL') throw new CandidateConflictError('LIVE_CANCEL', `live cancel ${l.txHash} of job ${c.jobId}`);
          const otherDecision = l.calldataHash !== calldataHash || (l.decision ?? null) !== (c.decision ?? null);
          if (otherDecision) throw new CandidateConflictError('LIVE_OTHER_DECISION', `live candidate ${l.txHash} of job ${c.jobId} carries another decision`);
        }
      }
      // 6. SCRIPT: durable limits, derived from the rows under the advisory lock
      if (c.origin === 'SCRIPT') await scriptLimits(tx, { chainId: c.chainId, evaluator, nonce, gasLimit, maxFee, budget: input.budget!, atNonce, now });

      // 7. the row
      await tx.evaluatorTransaction.createMany({
        skipDuplicates: true,
        data: [{
          chainId: c.chainId,
          evaluator,
          nonce,
          jobId: c.jobId,
          kind: c.kind,
          action: c.action,
          decision: c.decision ?? null,
          reasonHex: c.reasonHex ?? null,
          replacesId: c.replacesId ?? null,
          toAddress,
          valueWei: valueWei.toString(),
          calldata,
          calldataHash,
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFee.toString(),
          maxPriorityFeePerGas: prio.toString(),
          txHash,
          rawTx: c.rawTx ?? null,
          origin: c.origin,
          operator: c.operator ?? null,
          note: c.note ?? null,
          incidentId: c.incidentId ?? null,
          status: 'SIGNED',
          createdAt: now,
        }],
      });
    }
    const row = await tx.evaluatorTransaction.findUniqueOrThrow({ where: { chainId_txHash: { chainId: c.chainId, txHash } }, select: { id: true } });

    // 8. the conditional job write
    if (job) {
      const stamped = await tx.job.updateMany({
        where: { id: job.id, settleTxHash: job.expectedSettleTxHash, ...(job.expectedOnChainStatus !== undefined ? { onChainStatus: job.expectedOnChainStatus } : {}) },
        data: { ...(job.setSettleTxHash ? { settleTxHash: txHash } : {}), ...(job.stampAttempt ? { settleAttemptAt: now } : {}) },
      });
      if (stamped.count === 0) throw new SettlementSupersededError(job.id);
    }
    return { id: row.id, inserted: !existing };
  }, { maxWait: 15_000, timeout: 30_000 });
}

async function costByNonce(tx: Tx, where: Prisma.Sql): Promise<Map<number, bigint>> {
  const rows = await tx.$queryRaw<Array<{ nonce: number; cost: string }>>`
    SELECT "nonce", MAX(("gasLimit")::numeric * ("maxFeePerGas")::numeric)::text AS "cost"
    FROM "EvaluatorTransaction" WHERE "origin" = 'SCRIPT' AND "nonce" IS NOT NULL AND ${where}
    GROUP BY "nonce"`;
  return new Map(rows.map((r) => [Number(r.nonce), BigInt(r.cost)]));
}

async function scriptLimits(
  tx: Tx,
  a: { chainId: number; evaluator: string; nonce: number; gasLimit: bigint; maxFee: bigint; budget: BudgetInputCtx; atNonce: DbRow[]; now: Date },
): Promise<void> {
  const incident = await tx.evaluatorRecoveryIncident.findUnique({ where: { id: a.budget.incidentId } });
  if (!incident || incident.closedAt !== null || incident.chainId !== a.chainId || incident.evaluator !== a.evaluator) {
    throw new BudgetRefusedError('INCIDENT_NOT_OPEN', `incident ${a.budget.incidentId} is not open for this evaluator key`);
  }
  const limit = replacementLimitCheck({ rowsAtNonce: a.atNonce.map(toCandidate), caps: a.budget.caps, now: a.now });
  if (!limit.ok) throw new BudgetRefusedError(limit.reason, limit.detail, { retryAt: 'retryAt' in limit ? limit.retryAt : undefined });
  const since = new Date(a.now.getTime() - DAY_MS);
  const [incidentMax, dayMax, liveMax] = await Promise.all([
    costByNonce(tx, Prisma.sql`"incidentId" = ${a.budget.incidentId}`),
    costByNonce(tx, Prisma.sql`"chainId" = ${a.chainId} AND "evaluator" = ${a.evaluator} AND "createdAt" > ${since}`),
    costByNonce(tx, Prisma.sql`"chainId" = ${a.chainId} AND "evaluator" = ${a.evaluator} AND "status" IN ('SIGNED', 'SENT', 'SEND_UNCONFIRMED')`),
  ]);
  const verdict = budgetCheck({
    caps: a.budget.caps,
    nonce: a.nonce,
    gasLimit: a.gasLimit,
    maxFeePerGas: a.maxFee,
    incidentMaxByNonce: incidentMax,
    dayMaxByNonce: dayMax,
    liveMaxByNonce: liveMax,
    balanceWei: a.budget.balanceWei,
  });
  if (!verdict.ok) throw new BudgetRefusedError(verdict.reason, verdict.detail, { needed: verdict.needed, cap: verdict.cap });
}

// ── Status transitions ───────────────────────────────────────────────────────

/** A send attempt (first, or an identical rebroadcast) is about to leave: broadcastAt (first) / lastBroadcastAt. Live rows only. */
export async function markBroadcast(db: Client, id: string, at: Date = new Date()): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "EvaluatorTransaction" SET "broadcastAt" = COALESCE("broadcastAt", ${at}), "lastBroadcastAt" = ${at}
    WHERE "id" = ${id} AND "status" IN ('SIGNED', 'SENT', 'SEND_UNCONFIRMED')`;
  return n > 0;
}

/**
 * Spec §2.4-3 — what the send answered:
 *  - `SENT` (accepted, or a node knows the hash): from SIGNED or SEND_UNCONFIRMED;
 *  - `SEND_UNCONFIRMED` (error and every node "not found" — still LIVE): from SIGNED;
 *  - `UNCERTAIN` (error, a node could not be asked): stays SIGNED, keeps the error.
 * Conditional on the status read; false when nothing changed.
 */
export async function markAnswered(
  db: Client, id: string, outcome: 'SENT' | 'SEND_UNCONFIRMED' | 'UNCERTAIN', sendError?: string | null, at: Date = new Date(),
): Promise<boolean> {
  const row = await db.evaluatorTransaction.findUnique({ where: { id }, select: { status: true } });
  if (!row) return false;
  const from = row.status as CandidateStatus;
  const allowed: Record<typeof outcome, CandidateStatus[]> = {
    SENT: ['SIGNED', 'SEND_UNCONFIRMED'],
    SEND_UNCONFIRMED: ['SIGNED'],
    UNCERTAIN: ['SIGNED'],
  };
  if (!allowed[outcome].includes(from)) return false;
  const error = clipError(sendError);
  const res = await db.evaluatorTransaction.updateMany({
    where: { id, status: from },
    data: {
      status: outcome === 'UNCERTAIN' ? 'SIGNED' : outcome,
      answeredAt: at,
      ...(error !== null ? { sendError: error } : {}),
    },
  });
  return res.count > 0;
}

/**
 * MINED_SUCCESS / MINED_REVERTED / DEAD with the chain proof (never by time).
 *  - from a live status: the transition;
 *  - same terminal status at level `latest` → `proof` (same block): an upgrade;
 *  - anything else (another terminal, a downgrade): false. A reorged row goes
 *    back through `revertForReorg` first.
 * MINED_* needs the block number and hash.
 */
export async function markResolved(
  db: Client,
  id: string,
  to: 'MINED_SUCCESS' | 'MINED_REVERTED' | 'DEAD',
  proof: { level: ProofLevel; blockNumber?: bigint; blockHash?: string },
  at: Date = new Date(),
): Promise<boolean> {
  if (proof.level !== 'latest' && proof.level !== 'proof') throw new TypeError(`invalid proof level ${String(proof.level)}`);
  const mined = to !== 'DEAD';
  const blockHash = proof.blockHash !== undefined ? normHash(proof.blockHash, 'blockHash') : undefined;
  if (mined && (proof.blockNumber === undefined || blockHash === undefined)) throw new TypeError('a mined candidate needs blockNumber and blockHash');
  const row = await db.evaluatorTransaction.findUnique({ where: { id }, select: { status: true, proofLevel: true, minedBlockHash: true } });
  if (!row) return false;
  const from = row.status as CandidateStatus;
  if (isLiveStatus(from)) {
    const res = await db.evaluatorTransaction.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        proofLevel: proof.level,
        resolvedAt: at,
        ...(mined ? { minedBlockNumber: proof.blockNumber!.toString(), minedBlockHash: blockHash! } : {}),
      },
    });
    return res.count > 0;
  }
  if (from === to && row.proofLevel === 'latest' && proof.level === 'proof' && (!mined || row.minedBlockHash === blockHash)) {
    const res = await db.evaluatorTransaction.updateMany({
      where: { id, status: from, proofLevel: 'latest', ...(mined ? { minedBlockHash: blockHash! } : {}) },
      data: { proofLevel: 'proof', resolvedAt: at },
    });
    return res.count > 0;
  }
  return false;
}

/**
 * R2-P2-2, the only exception to monotonic status: a MINED_* / DEAD row
 * proven only at `latest` whose block was reorganised away goes back to live
 * (MINED_* → SENT; DEAD → SENT if it was sent, SIGNED otherwise). A row at
 * `proof` never comes back (false).
 */
export async function revertForReorg(db: Client, id: string): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE "EvaluatorTransaction"
    SET "status" = CASE WHEN "status" IN ('MINED_SUCCESS', 'MINED_REVERTED') OR "broadcastAt" IS NOT NULL OR "answeredAt" IS NOT NULL THEN 'SENT' ELSE 'SIGNED' END,
        "proofLevel" = NULL, "resolvedAt" = NULL, "minedBlockNumber" = NULL, "minedBlockHash" = NULL
    WHERE "id" = ${id} AND "status" IN ('MINED_SUCCESS', 'MINED_REVERTED', 'DEAD') AND "proofLevel" = 'latest'`;
  return n > 0;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Live candidates (SIGNED / SENT / SEND_UNCONFIRMED) of a job, by nonce then age. */
export async function liveCandidatesForJob(db: Client, jobId: string): Promise<LedgerCandidate[]> {
  const rows = await db.evaluatorTransaction.findMany({
    where: { jobId, status: { in: LIVE } },
    orderBy: [{ nonce: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toCandidate);
}

/** Every candidate of a job (any status), oldest first. */
export async function candidatesForJob(db: Client, jobId: string): Promise<LedgerCandidate[]> {
  const rows = await db.evaluatorTransaction.findMany({ where: { jobId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map(toCandidate);
}

/** Every candidate (any status) at a nonce of an evaluator key, oldest first. */
export async function candidatesAtNonce(db: Client, chainId: number, evaluator: string, nonce: number): Promise<LedgerCandidate[]> {
  const rows = await db.evaluatorTransaction.findMany({
    where: { chainId, evaluator: normAddress(evaluator), nonce },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toCandidate);
}

/** Distinct nonces with a live candidate, ascending (input of `chooseNonce`). */
export async function liveNonces(db: Client, chainId: number, evaluator: string): Promise<number[]> {
  const rows = await db.evaluatorTransaction.findMany({
    where: { chainId, evaluator: normAddress(evaluator), status: { in: LIVE }, nonce: { not: null } },
    distinct: ['nonce'],
    select: { nonce: true },
    orderBy: { nonce: 'asc' },
  });
  return rows.map((r) => r.nonce!);
}

/** Every live candidate of an evaluator key (the reconciliation pass's input), by nonce then age. */
export async function liveCandidates(db: Client, chainId: number, evaluator: string): Promise<LedgerCandidate[]> {
  const rows = await db.evaluatorTransaction.findMany({
    where: { chainId, evaluator: normAddress(evaluator), status: { in: LIVE } },
    orderBy: [{ nonce: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toCandidate);
}

// ── §4.3: a foreign transaction found on-chain ───────────────────────────────

/**
 * Records a transaction of the evaluator key found on-chain that no ledger
 * row covers (kind EXTERNAL, origin RECONCILE), already mined. Idempotent.
 */
export async function recordExternalCandidate(db: Db, input: {
  chainId: number; evaluator: string; nonce: number; toAddress: string; valueWei: bigint; calldata: Hex;
  gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; txHash: string;
  status: 'MINED_SUCCESS' | 'MINED_REVERTED'; proofLevel: ProofLevel; blockNumber: bigint; blockHash: string; note?: string | null; now?: Date;
}): Promise<{ id: string; inserted: boolean }> {
  const now = input.now ?? new Date();
  const txHash = normHash(input.txHash, 'txHash');
  const calldata = input.calldata.toLowerCase() as Hex;
  const res = await db.evaluatorTransaction.createMany({
    skipDuplicates: true,
    data: [{
      chainId: input.chainId,
      evaluator: normAddress(input.evaluator),
      nonce: nonNegInt(input.nonce, 'nonce'),
      jobId: null,
      kind: 'EXTERNAL',
      action: 'UNKNOWN',
      toAddress: normAddress(input.toAddress),
      valueWei: posBig(input.valueWei, 'valueWei').toString(),
      calldata,
      calldataHash: keccak256(calldata),
      gasLimit: posBig(input.gasLimit, 'gasLimit').toString(),
      maxFeePerGas: posBig(input.maxFeePerGas, 'maxFeePerGas').toString(),
      maxPriorityFeePerGas: posBig(input.maxPriorityFeePerGas, 'maxPriorityFeePerGas').toString(),
      txHash,
      origin: 'RECONCILE',
      note: input.note ?? null,
      status: input.status,
      proofLevel: input.proofLevel,
      createdAt: now,
      resolvedAt: now,
      minedBlockNumber: input.blockNumber.toString(),
      minedBlockHash: normHash(input.blockHash, 'blockHash'),
    }],
  });
  const row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { chainId_txHash: { chainId: input.chainId, txHash } }, select: { id: true } });
  return { id: row.id, inserted: res.count === 1 };
}

/** Marker written into the note of an EXTERNAL row the operator acknowledged (§4.3, `--acknowledge-foreign`). */
export const FOREIGN_ACK_MARKER = '[acknowledged-foreign]';

/** EXTERNAL rows of an evaluator key not yet acknowledged by an operator (the recovery script refuses while any exists). */
export async function unacknowledgedExternal(db: Client, chainId: number, evaluator: string): Promise<LedgerCandidate[]> {
  const rows = await db.evaluatorTransaction.findMany({
    where: { chainId, evaluator: normAddress(evaluator), kind: 'EXTERNAL' },
    orderBy: [{ nonce: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.filter((r) => !(r.note ?? '').includes(FOREIGN_ACK_MARKER)).map(toCandidate);
}

/** §4.3: the operator acknowledges one EXTERNAL row (by hash). Idempotent; true when the row exists. */
export async function acknowledgeExternal(db: Client, chainId: number, txHash: string, operator: string, at: Date = new Date()): Promise<boolean> {
  const hash = normHash(txHash, 'txHash');
  const row = await db.evaluatorTransaction.findUnique({ where: { chainId_txHash: { chainId, txHash: hash } } });
  if (!row || row.kind !== 'EXTERNAL') return false;
  if ((row.note ?? '').includes(FOREIGN_ACK_MARKER)) return true;
  const note = `${row.note ?? ''} ${FOREIGN_ACK_MARKER} by ${operator} at ${at.toISOString()}`.trim().slice(0, 1000);
  await db.evaluatorTransaction.update({ where: { id: row.id }, data: { note } });
  return true;
}

// ── §10-2: backfill of in-flight legacy rows ─────────────────────────────────

/**
 * One LEGACY / BACKFILL row for a job whose `settleTxHash` predates the
 * ledger. `tx` = what `getTransaction(settleTxHash)` returned:
 *  - known → nonce and tx data, status SENT;
 *  - null (no node returned it) → nonce NULL, status SEND_UNCONFIRMED: the
 *    gate keeps today's rule for it (P3-1).
 * Idempotent (ON CONFLICT DO NOTHING). A later call with the tx known
 * upgrades a nonce-NULL row (it "becomes a normal row"); it never touches a
 * row that has a nonce. The job is not written.
 */
export async function backfillLegacyCandidate(db: Db, input: {
  chainId: number; evaluator: string; jobId: string; txHash: string;
  action: CandidateAction; decision?: string | null;
  tx: null | { nonce: number; toAddress: string; calldata: Hex; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; valueWei: bigint };
  now?: Date;
}): Promise<{ id: string; inserted: boolean; upgraded: boolean }> {
  const now = input.now ?? new Date();
  const evaluator = normAddress(input.evaluator);
  const txHash = normHash(input.txHash, 'txHash');
  if (input.action === 'CANCEL_NOOP') throw new TypeError('a legacy settlement is not a cancel');
  const data = input.tx === null ? null : {
    nonce: nonNegInt(input.tx.nonce, 'nonce'),
    toAddress: normAddress(input.tx.toAddress),
    calldata: input.tx.calldata.toLowerCase(),
    calldataHash: keccak256(input.tx.calldata.toLowerCase() as Hex),
    gasLimit: posBig(input.tx.gasLimit, 'gasLimit').toString(),
    maxFeePerGas: posBig(input.tx.maxFeePerGas, 'maxFeePerGas').toString(),
    maxPriorityFeePerGas: posBig(input.tx.maxPriorityFeePerGas, 'maxPriorityFeePerGas').toString(),
    valueWei: posBig(input.tx.valueWei, 'valueWei').toString(),
  };
  const res = await db.evaluatorTransaction.createMany({
    skipDuplicates: true,
    data: [{
      chainId: input.chainId,
      evaluator,
      jobId: input.jobId,
      kind: 'LEGACY',
      action: input.action,
      decision: input.decision ?? null,
      txHash,
      origin: 'BACKFILL',
      status: data ? 'SENT' : 'SEND_UNCONFIRMED',
      createdAt: now,
      ...(data ?? { nonce: null, valueWei: '0' }),
    }],
  });
  const row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { chainId_txHash: { chainId: input.chainId, txHash } } });
  if (row.jobId !== input.jobId || row.evaluator !== evaluator) {
    throw new CandidateConflictError('TX_HASH_REUSED', `${txHash} already recorded for another job / key`);
  }
  let upgraded = false;
  if (res.count === 0 && data && row.nonce === null) {
    const up = await db.evaluatorTransaction.updateMany({
      where: { id: row.id, nonce: null, kind: 'LEGACY' },
      data: { ...data, ...(row.status === 'SEND_UNCONFIRMED' ? { status: 'SENT' } : {}) },
    });
    upgraded = up.count > 0;
  }
  return { id: row.id, inserted: res.count === 1, upgraded };
}

// ── Recovery incidents ───────────────────────────────────────────────────────

export interface RecoveryIncident {
  id: string; chainId: number; evaluator: string; headNonce: number;
  openedAt: Date; openedBy: string; closedAt: Date | null; closeReason: string | null;
}

/**
 * Opens the incident of an evaluator key, or returns the one already open
 * (at most one, partial unique index). `opened` tells which.
 */
export async function openIncident(db: Db, input: { chainId: number; evaluator: string; headNonce: number; openedBy: string; now?: Date }): Promise<{ incident: RecoveryIncident; opened: boolean }> {
  const evaluator = normAddress(input.evaluator);
  const at = input.now ?? new Date();
  const id = `inc_${randomUUID().replace(/-/g, '')}`;
  const n = await db.$executeRaw`
    INSERT INTO "EvaluatorRecoveryIncident" ("id", "chainId", "evaluator", "headNonce", "openedAt", "openedBy")
    VALUES (${id}, ${input.chainId}, ${evaluator}, ${nonNegInt(input.headNonce, 'headNonce')}, ${at}, ${input.openedBy})
    ON CONFLICT ("chainId", "evaluator") WHERE "closedAt" IS NULL DO NOTHING`;
  const incident = await db.evaluatorRecoveryIncident.findFirst({ where: { chainId: input.chainId, evaluator, closedAt: null } });
  if (!incident) throw new Error('evaluator recovery incident: none open after the insert (closed concurrently) — retry');
  return { incident, opened: n === 1 && incident.id === id };
}

export async function getOpenIncident(db: Client, chainId: number, evaluator: string): Promise<RecoveryIncident | null> {
  return db.evaluatorRecoveryIncident.findFirst({ where: { chainId, evaluator: normAddress(evaluator), closedAt: null } });
}

/** Closes an open incident (conditional on still open). */
export async function closeIncident(db: Client, id: string, reason: string, at: Date = new Date()): Promise<boolean> {
  if (!reason) throw new TypeError('closeIncident needs a reason');
  const res = await db.evaluatorRecoveryIncident.updateMany({ where: { id, closedAt: null }, data: { closedAt: at, closeReason: reason } });
  return res.count > 0;
}

// ── Chain state (persisted alert clocks, proof head, node health) ────────────

export interface EvaluatorChainStateView {
  chainId: number;
  evaluator: string;
  stuckSince: Date | null;
  stuckNonce: number | null;
  sendLostSince: Date | null;
  sendLostNonce: number | null;
  /** alert kind → time of the last DELIVERED alert. */
  lastAlertAt: Record<string, Date>;
  safeHeadBlock: bigint | null;
  safeHeadSeenAt: Date | null;
  /** node → consecutive failed reads. */
  rpcFailures: Record<string, number>;
  updatedAt: Date;
}

function toChainState(r: EvaluatorChainState): EvaluatorChainStateView {
  const alerts: Record<string, Date> = {};
  for (const [k, v] of Object.entries((r.lastAlertAt ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) alerts[k] = new Date(v);
  }
  const fails: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.rpcFailures ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'number') fails[k] = v;
  }
  return {
    chainId: r.chainId,
    evaluator: r.evaluator,
    stuckSince: r.stuckSince,
    stuckNonce: r.stuckNonce,
    sendLostSince: r.sendLostSince,
    sendLostNonce: r.sendLostNonce,
    lastAlertAt: alerts,
    safeHeadBlock: r.safeHeadBlock === null ? null : BigInt(r.safeHeadBlock),
    safeHeadSeenAt: r.safeHeadSeenAt,
    rpcFailures: fails,
    updatedAt: r.updatedAt,
  };
}

export async function readChainState(db: Client, chainId: number, evaluator: string): Promise<EvaluatorChainStateView | null> {
  const r = await db.evaluatorChainState.findUnique({ where: { chainId_evaluator: { chainId, evaluator: normAddress(evaluator) } } });
  return r ? toChainState(r) : null;
}

export interface ChainStatePatch {
  stuckSince?: Date | null;
  stuckNonce?: number | null;
  sendLostSince?: Date | null;
  sendLostNonce?: number | null;
}

/**
 * Upserts the clock fields given (others untouched). The alert times are NOT
 * written here: only `recordAlertDelivered`, after the delivery.
 */
export async function writeChainState(db: Client, chainId: number, evaluator: string, patch: ChainStatePatch): Promise<EvaluatorChainStateView> {
  const ev = normAddress(evaluator);
  const data = {
    ...(patch.stuckSince !== undefined ? { stuckSince: patch.stuckSince } : {}),
    ...(patch.stuckNonce !== undefined ? { stuckNonce: patch.stuckNonce === null ? null : nonNegInt(patch.stuckNonce, 'stuckNonce') } : {}),
    ...(patch.sendLostSince !== undefined ? { sendLostSince: patch.sendLostSince } : {}),
    ...(patch.sendLostNonce !== undefined ? { sendLostNonce: patch.sendLostNonce === null ? null : nonNegInt(patch.sendLostNonce, 'sendLostNonce') } : {}),
  };
  const r = await db.evaluatorChainState.upsert({
    where: { chainId_evaluator: { chainId, evaluator: ev } },
    create: { chainId, evaluator: ev, ...data },
    update: data,
  });
  return toChainState(r);
}

/**
 * Persisted clock of a head condition ('stuck': pending > latest at `nonce`;
 * 'sendLost': a live head candidate no node knows). `nonce === null` clears
 * it; the same nonce keeps the first `since`; another nonce restarts it at
 * `at`. Atomic (one statement). Returns the `since` in force (null if cleared).
 */
export async function observeHeadClock(
  db: Client, chainId: number, evaluator: string, clock: 'stuck' | 'sendLost', nonce: number | null, at: Date = new Date(),
): Promise<Date | null> {
  const ev = normAddress(evaluator);
  if (nonce !== null) nonNegInt(nonce, 'nonce');
  const sinceCol = clock === 'stuck' ? Prisma.raw('"stuckSince"') : Prisma.raw('"sendLostSince"');
  const nonceCol = clock === 'stuck' ? Prisma.raw('"stuckNonce"') : Prisma.raw('"sendLostNonce"');
  const since = nonce === null ? null : at;
  const rows = await db.$queryRaw<Array<{ since: Date | null }>>`
    INSERT INTO "EvaluatorChainState" ("chainId", "evaluator", ${sinceCol}, ${nonceCol}, "updatedAt")
    VALUES (${chainId}, ${ev}, ${since}, ${nonce}, ${at})
    ON CONFLICT ("chainId", "evaluator") DO UPDATE SET
      ${sinceCol} = CASE
        WHEN EXCLUDED.${nonceCol} IS NULL THEN NULL
        WHEN "EvaluatorChainState".${nonceCol} = EXCLUDED.${nonceCol} AND "EvaluatorChainState".${sinceCol} IS NOT NULL THEN "EvaluatorChainState".${sinceCol}
        ELSE EXCLUDED.${sinceCol} END,
      ${nonceCol} = EXCLUDED.${nonceCol},
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING ${sinceCol} AS "since"`;
  return rows[0]?.since ?? null;
}

/** Records that an alert of `kind` was DELIVERED at `at` (call only after `raiseAlert` succeeded). Atomic merge. */
export async function recordAlertDelivered(db: Client, chainId: number, evaluator: string, kind: string, at: Date = new Date()): Promise<void> {
  if (!kind) throw new TypeError('alert kind required');
  const ev = normAddress(evaluator);
  const entry = JSON.stringify({ [kind]: at.toISOString() });
  await db.$executeRaw`
    INSERT INTO "EvaluatorChainState" ("chainId", "evaluator", "lastAlertAt", "updatedAt")
    VALUES (${chainId}, ${ev}, ${entry}::jsonb, ${at})
    ON CONFLICT ("chainId", "evaluator") DO UPDATE SET
      "lastAlertAt" = "EvaluatorChainState"."lastAlertAt" || EXCLUDED."lastAlertAt",
      "updatedAt" = EXCLUDED."updatedAt"`;
}

/**
 * Per-node health (P3-10): a failed read increments the node's consecutive
 * failures, a good one resets them to 0. Returns the count after the write.
 */
export async function recordNodeRead(db: Client, chainId: number, evaluator: string, node: string, ok: boolean, at: Date = new Date()): Promise<number> {
  if (!node) throw new TypeError('node required');
  const ev = normAddress(evaluator);
  const initial = JSON.stringify({ [node]: ok ? 0 : 1 });
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    INSERT INTO "EvaluatorChainState" ("chainId", "evaluator", "rpcFailures", "updatedAt")
    VALUES (${chainId}, ${ev}, ${initial}::jsonb, ${at})
    ON CONFLICT ("chainId", "evaluator") DO UPDATE SET
      "rpcFailures" = jsonb_set("EvaluatorChainState"."rpcFailures", ARRAY[${node}]::text[],
        to_jsonb(CASE WHEN ${ok} THEN 0 ELSE COALESCE(("EvaluatorChainState"."rpcFailures" ->> ${node})::int, 0) + 1 END), true),
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING ("rpcFailures" ->> ${node})::int AS "n"`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Proof-tag head tracking (R2-P2-2 item 4): stores `block` and moves
 * `safeHeadSeenAt` to `at` only when the block ADVANCED (or on first sight).
 * Returns whether it advanced and since when the stored head stands.
 */
export async function observeSafeHead(db: Client, chainId: number, evaluator: string, block: bigint, at: Date = new Date()): Promise<{ advanced: boolean; seenAt: Date }> {
  const ev = normAddress(evaluator);
  const b = posBig(block, 'block').toString();
  const rows = await db.$queryRaw<Array<{ seenAt: Date; block: string }>>`
    INSERT INTO "EvaluatorChainState" ("chainId", "evaluator", "safeHeadBlock", "safeHeadSeenAt", "updatedAt")
    VALUES (${chainId}, ${ev}, ${b}, ${at}, ${at})
    ON CONFLICT ("chainId", "evaluator") DO UPDATE SET
      "safeHeadSeenAt" = CASE
        WHEN "EvaluatorChainState"."safeHeadBlock" IS NULL OR ("EvaluatorChainState"."safeHeadBlock")::numeric < (EXCLUDED."safeHeadBlock")::numeric
        THEN EXCLUDED."safeHeadSeenAt" ELSE "EvaluatorChainState"."safeHeadSeenAt" END,
      "safeHeadBlock" = CASE
        WHEN "EvaluatorChainState"."safeHeadBlock" IS NULL OR ("EvaluatorChainState"."safeHeadBlock")::numeric < (EXCLUDED."safeHeadBlock")::numeric
        THEN EXCLUDED."safeHeadBlock" ELSE "EvaluatorChainState"."safeHeadBlock" END,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "safeHeadSeenAt" AS "seenAt", "safeHeadBlock" AS "block"`;
  const r = rows[0]!;
  return { advanced: r.seenAt.getTime() === at.getTime() && r.block === b, seenAt: r.seenAt };
}
