/**
 * Automatic reconciliation of x402 payments (second x402 delivery, 2026-11-15).
 *
 * Runs as one more guarded pass of the existing payment-recovery tick
 * (`queues/payment-recovery.queue.ts`: a BullMQ repeatable job, one schedule
 * per Redis, in `worker.ts` and in `index.ts` with the transaction worker),
 * and on demand with `npm run x402:ops -- auto`.
 *
 * Per cycle, for every payment that is not proven or terminal and is due
 * (`ResourcePaymentReconcileState.nextAttemptAt`, not `stopped`):
 *   1. claim the row with a short lease (two workers do not judge one row at
 *      once — correctness does not depend on it: every transition is the
 *      conditional write of `reconcileOneRow`);
 *   2. judge it with `reconcileOneRow(apply)` — the SAME rules as the CLI;
 *      an `expired` verdict (the one release with no transfer to point at)
 *      must ALSO be confirmed by a second, independent evidence source that
 *      agrees on the judged block's hash (`X402_RECONCILE_SECOND_RPC_URL_<id>`);
 *      without one it is handed to the operator (single-source expiry only on
 *      a declared local chain);
 *   3. schedule the next look:
 *        wait (live authorization, unused)  → validBefore + margin
 *        wait although validBefore + margin
 *          already passed (head not moving)  → like a transient failure
 *        in-flight (attempt may still run)  → stale threshold
 *        transient (evidence source down)   → backoff base·2^(n−1) capped; after
 *                                             maxAttempts the operator is ALERTED
 *                                             once, retries continue at the cap
 *        structural manual / mismatch /
 *          unconfirmed expiry                → stopped + escalated (operator)
 *   4. release the lease.
 * A chain whose source failed is skipped for the rest of the cycle (one slow
 * RPC must not hold the whole recovery tick), and the cycle has a time budget.
 *
 * Never: sign, send, retry or re-fetch a paid resource (a new fetch could be
 * a new charge); release budget without chain proof; read a failed RPC call as
 * evidence of anything. A stopped row keeps counting until the operator acts
 * (`x402:ops reconcile --apply`, which re-arms the automation for the rows it
 * judges, or `x402:ops resolve`).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, ResourcePayment } from '@prisma/client';
import type { Address, Hex } from 'viem';
import {
  DEFAULT_EXPIRY_MARGIN_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  chainIdOfNetwork,
  readerForRpcUrl,
  reconcilableWhere,
  reconcileOneRow,
  type ChainEvidenceReader,
  type ExpiryConfirmation,
  type HeadSelector,
  type ReconcileResult,
  type ReconcileVerdict,
} from './resource-payment-reconciliation.js';

export interface AutoReconcileConfig {
  head: HeadSelector;
  expiryMarginSeconds: number;
  staleAfterMs: number;
  /** Consecutive transient failures before the operator is alerted (retries continue at the cap). */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Lease per claimed row; must exceed one row's chain reads. */
  leaseMs: number;
  /** Rows per cycle. */
  batchSize: number;
  /** No new row is claimed after this long in one cycle. */
  cycleBudgetMs: number;
  /** Accept an `expired` verdict from the primary source alone (only on a declared local chain). */
  singleSourceExpiry: boolean;
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
  cycleBudgetMs: 60_000,
  singleSourceExpiry: false,
};

/**
 * Reads the X402_RECONCILE_* variables. `latest-0` (unsafe head) and
 * single-source expiry are accepted only with X402_RECONCILE_LOCAL_CHAIN=true
 * outside production / staging; an invalid value falls back to the safe
 * default and is reported.
 */
export function autoReconcileConfigFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): { config: AutoReconcileConfig; enabled: boolean; problems: string[] } {
  const problems: string[] = [];
  const config: AutoReconcileConfig = { ...DEFAULT_AUTO_RECONCILE_CONFIG };
  const nodeEnv = source['NODE_ENV'] ?? 'development';
  const localChain = source['X402_RECONCILE_LOCAL_CHAIN'] === 'true' && nodeEnv !== 'production' && nodeEnv !== 'staging';
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
      if (n === 0 && !localChain) problems.push('X402_RECONCILE_HEAD=latest-0 needs X402_RECONCILE_LOCAL_CHAIN=true outside production/staging: using finalized');
      else config.head = { confirmations: n };
    } else problems.push(`X402_RECONCILE_HEAD=${head} ignored (finalized | safe | latest-N): using finalized`);
  }
  if (source['X402_RECONCILE_SINGLE_SOURCE_EXPIRY'] === 'true') {
    if (localChain) config.singleSourceExpiry = true;
    else problems.push('X402_RECONCILE_SINGLE_SOURCE_EXPIRY=true needs X402_RECONCILE_LOCAL_CHAIN=true outside production/staging: expiry needs a second source');
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
  const lease = int('X402_RECONCILE_LEASE_SEC', 10);
  if (lease !== undefined) config.leaseMs = lease * 1000;
  const batch = int('X402_RECONCILE_BATCH', 1);
  if (batch !== undefined) config.batchSize = batch;
  const budget = int('X402_RECONCILE_CYCLE_BUDGET_SEC', 1);
  if (budget !== undefined) config.cycleBudgetMs = budget * 1000;
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
  /** The operator was alerted in this cycle (first time the row needed it). */
  escalated: boolean;
  /** Automation stopped for this row (operator needed); transient escalations keep retrying. */
  stopped: boolean;
  note: string;
}

export interface AutoReconcileDeps {
  db: Pick<PrismaClient, 'resourcePayment' | 'resourcePaymentReconcileState'>;
  /** RPC URL of a chain (the backend's primary — one endpoint, no provider fallback). */
  rpcFor: (chainId: number) => string;
  /** Second, independent RPC of a chain, used only to confirm `expired`; undefined = none configured. */
  secondRpcFor?: (chainId: number) => string | undefined;
  config?: AutoReconcileConfig;
  /** Injected in tests; defaults to `readerForRpcUrl(rpcFor(id), config.head)`. */
  readerFor?: (chainId: number) => ChainEvidenceReader;
  /** Injected in tests; defaults to `readerForRpcUrl(secondRpcFor(id), config.head)`. */
  secondReaderFor?: (chainId: number) => ChainEvidenceReader | undefined;
  now?: () => Date;
  /** Lease owner id; defaults to a random id per call. */
  owner?: string;
  /** Operator alert (the caller logs it). */
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
                stopped: false,
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
async function claim(db: AutoReconcileDeps['db'], row: ResourcePayment, owner: string, now: Date, leaseMs: number): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const { count } = await db.resourcePaymentReconcileState.updateMany({
    where: {
      resourcePaymentId: row.id,
      stopped: false,
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
    return false; // exists (held, not due, or stopped) or the payment row vanished
  }
}

interface Next {
  attempts: number;
  nextAttemptAt: Date | null;
  /** Reason to alert the operator (once). */
  alert: string | null;
  /** Automation stops for this row. */
  stop: boolean;
  /** The row needs no alert any more (a real judgement came back). */
  clearAlert: boolean;
}

function backoff(attempts: number, now: Date, config: AutoReconcileConfig): Date {
  return new Date(now.getTime() + Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** Math.max(0, attempts - 1)));
}

function transientNext(attemptsBefore: number, reason: string, now: Date, config: AutoReconcileConfig): Next {
  const attempts = attemptsBefore + 1;
  return {
    attempts,
    nextAttemptAt: backoff(attempts, now, config),
    alert: attempts >= config.maxAttempts ? `${reason} (${attempts} times in a row; automatic retries continue every ≤ ${Math.round(config.backoffCapMs / 1000)} s)` : null,
    stop: false,
    clearAlert: false,
  };
}

/** Next look for a verdict that wrote nothing. */
function schedule(result: ReconcileResult, attemptsBefore: number, now: Date, config: AutoReconcileConfig): Next {
  const { verdict, row } = result;
  const ok = (nextAttemptAt: Date | null): Next => ({ attempts: 0, nextAttemptAt, alert: null, stop: false, clearAlert: true });
  if (result.applied) return ok(null);
  if (result.raced) return { attempts: attemptsBefore, nextAttemptAt: now, alert: null, stop: false, clearAlert: false };
  switch (verdict.kind) {
    case 'wait': {
      const due = new Date(verdict.until.getTime() + config.expiryMarginSeconds * 1000 + 1000);
      // Past due already: the judged head is not moving past validBefore (stalled node, finality lag).
      if (due.getTime() <= now.getTime()) {
        return transientNext(attemptsBefore, `chain head not past validBefore + margin yet (${verdict.note.slice(0, 200)})`, now, config);
      }
      return ok(due);
    }
    case 'in-flight': {
      const since = row.status === 'reserved' ? row.reservedAt : row.updatedAt;
      return ok(new Date(since.getTime() + config.staleAfterMs + 1000));
    }
    case 'manual':
      if (verdict.transient) return transientNext(attemptsBefore, verdict.note.slice(0, 300), now, config);
      return { attempts: attemptsBefore, nextAttemptAt: null, alert: `cannot be judged automatically: ${verdict.note.slice(0, 300)}`, stop: true, clearAlert: false };
    case 'mismatch':
      return { attempts: attemptsBefore, nextAttemptAt: null, alert: `on-chain evidence does not match the row: ${verdict.note.slice(0, 300)}`, stop: true, clearAlert: false };
    default:
      return ok(null);
  }
}

/**
 * The second-source check of an `expired` verdict: the independent reader
 * must answer the same chain, agree on the judged block's hash, and see the
 * authorization unused (lapsed) or used (cancelled) there as well.
 */
export async function confirmWithSecondSource(
  row: ResourcePayment,
  verdict: Extract<ReconcileVerdict, { kind: 'expired' }>,
  primary: ChainEvidenceReader,
  second: ChainEvidenceReader | undefined,
  config: AutoReconcileConfig,
): Promise<ExpiryConfirmation> {
  if (!second) {
    if (config.singleSourceExpiry) return { ok: true, note: 'single-source expiry (declared local chain)' };
    return {
      ok: false,
      note: `${verdict.note} — NOT applied automatically: releasing budget without a transfer needs a second evidence source (X402_RECONCILE_SECOND_RPC_URL_<chainId>) or an operator (\`x402:ops reconcile --apply --second-rpc <url>\`)`,
    };
  }
  const chainId = chainIdOfNetwork(row.network);
  if ((await second.chainId()) !== chainId) return { ok: false, note: 'second evidence source answers a different chain id' };
  const [a, b] = await Promise.all([primary.blockHash(verdict.atBlock), second.blockHash(verdict.atBlock)]);
  if (a.toLowerCase() !== b.toLowerCase()) {
    return { ok: false, note: `evidence sources disagree on block ${verdict.atBlock} (${a} vs ${b}): not the same chain view — operator needed` };
  }
  const used = await second.authorizationUsed(row.asset as Address, row.payer as Address, row.authorizationNonce as Hex, verdict.atBlock);
  const expected = verdict.reason === 'cancelled';
  if (used !== expected) {
    return { ok: false, note: `second evidence source sees authorizationState=${used} at block ${verdict.atBlock}: disagrees — operator needed` };
  }
  return { ok: true, note: 'confirmed by a second evidence source at the same block hash' };
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
  const startedAt = Date.now();
  const scope = {
    ...(deps.jobId ? { jobId: deps.jobId } : {}),
    ...(deps.agentId ? { agentId: deps.agentId } : {}),
  };
  // Rows never looked at first (new payments must not wait behind a backlog), then the most overdue.
  const fresh = await deps.db.resourcePayment.findMany({
    where: { AND: [reconcilableWhere(), { reconcileState: { is: null } }], ...scope },
    include: { reconcileState: true },
    orderBy: { reservedAt: 'asc' },
    take: config.batchSize,
  });
  const overdue =
    fresh.length >= config.batchSize
      ? []
      : await deps.db.resourcePayment.findMany({
          where: { ...dueWhere(start), reconcileState: { isNot: null }, ...scope },
          include: { reconcileState: true },
          orderBy: [{ reconcileState: { nextAttemptAt: 'asc' } }, { reservedAt: 'asc' }],
          take: config.batchSize - fresh.length,
        });
  const rows = [...fresh, ...overdue];
  const readers = new Map<number, ChainEvidenceReader>();
  const secondReaders = new Map<number, ChainEvidenceReader | undefined>();
  const verifiedChains = new Map<number, boolean>();
  const downChains = new Map<number, string>();
  const outcomes: AutoReconcileOutcome[] = [];

  for (const candidate of rows) {
    if (Date.now() - startedAt > config.cycleBudgetMs) break;
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
      try {
        const url = deps.secondRpcFor?.(chainId);
        secondReaders.set(chainId, deps.secondReaderFor ? deps.secondReaderFor(chainId) : url ? readerForRpcUrl(url, config.head) : undefined);
      } catch {
        secondReaders.set(chainId, undefined);
      }
    }
    let result: ReconcileResult;
    const down = chainId !== null ? downChains.get(chainId) : undefined;
    if (down && row.status !== 'reserved') {
      result = { row, applied: false, verdict: { kind: 'manual', transient: true, sourceDown: true, note: `skipped: ${down}` } };
    } else {
      try {
        const primary = chainId !== null ? readers.get(chainId) : undefined;
        result = await reconcileOneRow(
          deps.db,
          row,
          {
            readers,
            apply: true,
            now,
            staleAfterMs: config.staleAfterMs,
            expiryMarginSeconds: config.expiryMarginSeconds,
            confirmExpiry: (r, v) =>
              primary
                ? confirmWithSecondSource(r, v, primary, chainId !== null ? secondReaders.get(chainId) : undefined, config)
                : Promise.resolve({ ok: false, transient: true, note: 'no primary reader' }),
          },
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
      if (chainId !== null && result.verdict.kind === 'manual' && result.verdict.sourceDown) {
        downChains.set(chainId, `evidence source for chain ${chainId} failed earlier in this cycle (${result.verdict.note.slice(0, 120)})`);
      }
    }
    const next = schedule(result, attemptsBefore, now, config);
    const alreadyAlerted = row.reconcileState?.escalatedAt !== null && row.reconcileState?.escalatedAt !== undefined;
    const wasStopped = row.reconcileState?.stopped === true;
    // A stop is always announced (with its own reason), even after an earlier
    // transient alert; transient alerts are announced once.
    const alertNow = next.alert !== null && (next.stop ? !wasStopped : !alreadyAlerted);
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
      escalated: alertNow,
      stopped: next.stop,
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
        stopped: next.stop,
        ...(alertNow ? { escalatedAt: now, escalationReason: next.alert } : {}),
        ...(next.clearAlert ? { escalatedAt: null, escalationReason: null } : {}),
      },
    });
    if (alertNow) deps.onEscalate?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Re-arms automation for rows an operator just looked at (`x402:ops reconcile --apply`, `resolve`). */
export async function rearmAutoReconcile(
  db: Pick<PrismaClient, 'resourcePaymentReconcileState'>,
  resourcePaymentIds: string[],
): Promise<number> {
  if (resourcePaymentIds.length === 0) return 0;
  const { count } = await db.resourcePaymentReconcileState.deleteMany({ where: { resourcePaymentId: { in: resourcePaymentIds } } });
  return count;
}
