/**
 * Automatic reconciliation of x402 payments (second x402 delivery, 2026-11-15).
 *
 * Runs as one more guarded pass of the existing payment-recovery tick
 * (`queues/payment-recovery.queue.ts`: a BullMQ repeatable job, one schedule
 * per Redis, in `worker.ts` and in `index.ts` with the transaction worker),
 * and on demand with `npm run x402:ops -- auto`.
 *
 * What it does per cycle, for every payment that is not proven or terminal
 * and is due (`ResourcePaymentReconcileState.nextAttemptAt`):
 *   1. claims the row with a short lease (two workers do not judge one row at
 *      once — correctness does not depend on it: every transition is the
 *      conditional write of `reconcileOneRow`);
 *   2. judges it on the chain with `reconcileOneRow(apply)` — the SAME rules as
 *      the CLI: proof → settled/expired/released, anything else → no write;
 *   3. schedules the next look:
 *        wait (live authorization, unused)  → validBefore + margin
 *        in-flight (attempt may still run)  → stale threshold
 *        transient (evidence source down)   → backoff base·2^(n−1), capped;
 *                                             escalated after maxAttempts
 *        structural manual / mismatch       → escalated at once
 *   4. releases the lease.
 *
 * What it never does: sign, send, retry or re-fetch a paid resource (a new
 * fetch could be a new charge); release budget without chain proof; treat a
 * failed RPC read as evidence of anything. An escalated row keeps counting
 * until the operator acts (`x402:ops reconcile --apply`, which re-arms the
 * automation for the rows it judges, or `x402:ops resolve`).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ResourcePayment } from '@prisma/client';
import {
  DEFAULT_EXPIRY_MARGIN_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  chainIdOfNetwork,
  readerForRpcUrl,
  reconcilableWhere,
  reconcileOneRow,
  type ChainEvidenceReader,
  type HeadSelector,
  type ReconcileResult,
  type ReconcileVerdict,
} from './resource-payment-reconciliation.js';

export interface AutoReconcileConfig {
  head: HeadSelector;
  expiryMarginSeconds: number;
  staleAfterMs: number;
  /** Consecutive transient failures before escalating to the operator. */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Lease per claimed row; must exceed one row's chain reads. */
  leaseMs: number;
  /** Rows per cycle. */
  batchSize: number;
}

export const DEFAULT_AUTO_RECONCILE_CONFIG: AutoReconcileConfig = {
  head: { tag: 'finalized' },
  expiryMarginSeconds: DEFAULT_EXPIRY_MARGIN_SECONDS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  maxAttempts: 8,
  backoffBaseMs: 30_000,
  backoffCapMs: 3_600_000,
  leaseMs: 120_000,
  batchSize: 50,
};

/**
 * Reads the X402_RECONCILE_* variables. `latest-0` (unsafe head) is accepted
 * only with X402_RECONCILE_LOCAL_CHAIN=true outside production / staging;
 * an invalid value falls back to the safe default and is reported.
 */
export function autoReconcileConfigFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): { config: AutoReconcileConfig; enabled: boolean; problems: string[] } {
  const problems: string[] = [];
  const config: AutoReconcileConfig = { ...DEFAULT_AUTO_RECONCILE_CONFIG };
  const int = (name: string, min: number): number | undefined => {
    const raw = source[name]?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      problems.push(`${name}=${raw} ignored (integer ≥ ${min} expected)`);
      return undefined;
    }
    return n;
  };
  const head = source['X402_RECONCILE_HEAD']?.trim();
  if (head) {
    const latest = /^latest-(\d+)$/.exec(head);
    if (head === 'finalized' || head === 'safe') config.head = { tag: head };
    else if (latest) {
      const n = Number(latest[1]);
      const env = source['NODE_ENV'] ?? 'development';
      const local = source['X402_RECONCILE_LOCAL_CHAIN'] === 'true' && env !== 'production' && env !== 'staging';
      if (n === 0 && !local) problems.push('X402_RECONCILE_HEAD=latest-0 needs X402_RECONCILE_LOCAL_CHAIN=true outside production/staging: using finalized');
      else config.head = { confirmations: n };
    } else problems.push(`X402_RECONCILE_HEAD=${head} ignored (finalized | safe | latest-N): using finalized`);
  }
  const margin = int('X402_RECONCILE_EXPIRY_MARGIN_SEC', 0);
  if (margin !== undefined) config.expiryMarginSeconds = margin;
  const stale = int('X402_RECONCILE_STALE_SEC', 1);
  if (stale !== undefined) config.staleAfterMs = stale * 1000;
  const attempts = int('X402_RECONCILE_MAX_ATTEMPTS', 1);
  if (attempts !== undefined) config.maxAttempts = attempts;
  const base = int('X402_RECONCILE_BACKOFF_BASE_SEC', 1);
  if (base !== undefined) config.backoffBaseMs = base * 1000;
  const cap = int('X402_RECONCILE_BACKOFF_CAP_SEC', 1);
  if (cap !== undefined) config.backoffCapMs = cap * 1000;
  return { config, enabled: source['X402_RECONCILE_ENABLED'] !== 'false', problems };
}

export interface AutoReconcileOutcome {
  resourcePaymentId: string;
  jobId: string;
  paymentId: string;
  statusBefore: string;
  verdict: ReconcileVerdict['kind'];
  transient: boolean;
  applied: boolean;
  raced: boolean;
  nextAttemptAt: Date | null;
  escalated: boolean;
  note: string;
}

export interface AutoReconcileDeps {
  db: Pick<PrismaClient, 'resourcePayment' | 'resourcePaymentReconcileState'>;
  /** RPC URL of a chain (the backend's primary — one endpoint, no provider fallback). */
  rpcFor: (chainId: number) => string;
  config?: AutoReconcileConfig;
  /** Injected in tests; defaults to `readerForRpcUrl(rpcFor(id), config.head)`. */
  readerFor?: (chainId: number) => ChainEvidenceReader;
  now?: () => Date;
  /** Lease owner id; defaults to a random id per call. */
  owner?: string;
  /** Operator alert for an escalation (the caller logs it). */
  onEscalate?: (outcome: AutoReconcileOutcome) => void;
  /** Restrict the cycle (CLI `auto --job / --agent`, tests). */
  jobId?: string;
  agentId?: string;
}

function dueWhere(now: Date): Prisma.ResourcePaymentWhereInput {
  return {
    AND: [
      reconcilableWhere(),
      {
        OR: [
          { reconcileState: { is: null } },
          {
            reconcileState: {
              is: {
                escalatedAt: null,
                nextAttemptAt: { lte: now },
                OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
              },
            },
          },
        ],
      },
    ],
  };
}

/** Claims a row for this cycle; false when another worker holds it (or it is no longer due). */
async function claim(
  db: AutoReconcileDeps['db'],
  row: ResourcePayment,
  owner: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const { count } = await db.resourcePaymentReconcileState.updateMany({
    where: {
      resourcePaymentId: row.id,
      escalatedAt: null,
      nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseOwner: owner, leaseUntil },
  });
  if (count === 1) return true;
  try {
    await db.resourcePaymentReconcileState.create({
      data: { resourcePaymentId: row.id, leaseOwner: owner, leaseUntil, nextAttemptAt: now },
    });
    return true;
  } catch {
    return false; // exists (held, not due, or escalated) or the payment row vanished
  }
}

/** Next look for a verdict that wrote nothing. */
function schedule(
  result: ReconcileResult,
  attemptsBefore: number,
  now: Date,
  config: AutoReconcileConfig,
): { attempts: number; nextAttemptAt: Date | null; escalationReason: string | null } {
  const { verdict, row } = result;
  if (result.applied) return { attempts: 0, nextAttemptAt: null, escalationReason: null };
  if (result.raced) return { attempts: attemptsBefore, nextAttemptAt: now, escalationReason: null };
  switch (verdict.kind) {
    case 'wait':
      return {
        attempts: 0,
        nextAttemptAt: new Date(verdict.until.getTime() + config.expiryMarginSeconds * 1000 + 1000),
        escalationReason: null,
      };
    case 'in-flight': {
      const since = row.status === 'reserved' ? row.reservedAt : row.updatedAt;
      return { attempts: 0, nextAttemptAt: new Date(since.getTime() + config.staleAfterMs + 1000), escalationReason: null };
    }
    case 'manual':
      if (verdict.transient) {
        const attempts = attemptsBefore + 1;
        if (attempts >= config.maxAttempts) {
          return {
            attempts,
            nextAttemptAt: null,
            escalationReason: `evidence source unavailable ${attempts} times in a row (last: ${verdict.note.slice(0, 300)})`,
          };
        }
        const delay = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** (attempts - 1));
        return { attempts, nextAttemptAt: new Date(now.getTime() + delay), escalationReason: null };
      }
      return { attempts: attemptsBefore, nextAttemptAt: null, escalationReason: `cannot be judged automatically: ${verdict.note.slice(0, 300)}` };
    case 'mismatch':
      return { attempts: attemptsBefore, nextAttemptAt: null, escalationReason: `on-chain evidence does not match the row: ${verdict.note.slice(0, 300)}` };
    default:
      return { attempts: 0, nextAttemptAt: null, escalationReason: null };
  }
}

/**
 * One automatic cycle. Safe to run from several processes at once and after a
 * crash at any point (a lease left behind expires; a transition is written at
 * most once; nothing financial is ever initiated).
 */
export async function runAutoReconcileCycle(deps: AutoReconcileDeps): Promise<AutoReconcileOutcome[]> {
  const config = deps.config ?? DEFAULT_AUTO_RECONCILE_CONFIG;
  const nowFn = deps.now ?? (() => new Date());
  const owner = deps.owner ?? `x402-auto-${randomUUID()}`;
  const start = nowFn();
  const rows = await deps.db.resourcePayment.findMany({
    where: {
      ...dueWhere(start),
      ...(deps.jobId ? { jobId: deps.jobId } : {}),
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
    },
    include: { reconcileState: true },
    orderBy: { reservedAt: 'asc' },
    take: config.batchSize,
  });
  const readers = new Map<number, ChainEvidenceReader>();
  const verifiedChains = new Map<number, boolean>();
  const outcomes: AutoReconcileOutcome[] = [];

  for (const candidate of rows) {
    const now = nowFn();
    if (!(await claim(deps.db, candidate, owner, now, config.leaseMs))) continue;
    // Re-read after claiming: another worker may have moved it meanwhile.
    const row = await deps.db.resourcePayment.findUnique({ where: { id: candidate.id }, include: { reconcileState: true } });
    if (!row) continue;
    const attemptsBefore = row.reconcileState?.attempts ?? 0;
    const chainId = chainIdOfNetwork(row.network);
    if (chainId !== null && !readers.has(chainId)) {
      try {
        readers.set(chainId, deps.readerFor ? deps.readerFor(chainId) : readerForRpcUrl(deps.rpcFor(chainId), config.head));
      } catch {
        // No RPC configured for the chain: reconcileOneRow reports it as structural manual.
      }
    }
    let result: ReconcileResult;
    try {
      result = await reconcileOneRow(
        deps.db,
        row,
        { readers, apply: true, now, staleAfterMs: config.staleAfterMs, expiryMarginSeconds: config.expiryMarginSeconds },
        verifiedChains,
      );
    } catch (error) {
      // A DB failure mid-row: release the lease and back off like a transient failure.
      result = {
        row,
        applied: false,
        verdict: { kind: 'manual', transient: true, note: `reconciliation error: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` },
      };
    }
    const next = schedule(result, attemptsBefore, now, config);
    const outcome: AutoReconcileOutcome = {
      resourcePaymentId: row.id,
      jobId: row.jobId,
      paymentId: row.paymentId,
      statusBefore: row.status,
      verdict: result.verdict.kind,
      transient: result.verdict.kind === 'manual' && result.verdict.transient === true,
      applied: result.applied,
      raced: result.raced === true,
      nextAttemptAt: next.nextAttemptAt,
      escalated: next.escalationReason !== null,
      note: result.verdict.note,
    };
    await deps.db.resourcePaymentReconcileState.updateMany({
      where: { resourcePaymentId: row.id, leaseOwner: owner },
      data: {
        attempts: next.attempts,
        lastVerdict: outcome.verdict,
        lastNote: result.verdict.note.slice(0, 1000),
        leaseOwner: null,
        leaseUntil: null,
        // A row that left the reconcilable set is never selected again; keep the schedule as history.
        nextAttemptAt: next.nextAttemptAt ?? now,
        ...(next.escalationReason ? { escalatedAt: now, escalationReason: next.escalationReason } : {}),
      },
    });
    if (outcome.escalated) deps.onEscalate?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Re-arms automation for rows an operator just looked at (`x402:ops reconcile --apply`). */
export async function rearmAutoReconcile(
  db: Pick<PrismaClient, 'resourcePaymentReconcileState'>,
  resourcePaymentIds: string[],
): Promise<number> {
  if (resourcePaymentIds.length === 0) return 0;
  const { count } = await db.resourcePaymentReconcileState.deleteMany({ where: { resourcePaymentId: { in: resourcePaymentIds } } });
  return count;
}
