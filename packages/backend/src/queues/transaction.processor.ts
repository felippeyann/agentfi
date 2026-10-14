/**
 * Transaction job processor — the body of the BullMQ transaction worker and
 * its permanent-failure handler, with every collaborator injected.
 *
 * Kept free of BullMQ instances, the `db` singleton and the logger module so
 * it can be unit-tested with a mocked Prisma client, submitter and monitor
 * (see `__tests__/transaction.worker.test.ts`). `transaction.queue.ts` wires
 * the real dependencies in.
 *
 * Status lifecycle (what makes retries safe):
 *
 *   QUEUED ──(guard: proceed)──► submitter.submit() ──► SUBMITTED + txHash
 *      │                               │
 *      │                               └─ throws → tx is STILL QUEUED → BullMQ
 *      │                                  retries; after the last attempt the
 *      │                                  failed handler marks FAILED, dead-letters
 *      │                                  the job and finalizes an A2A payment.
 *      └─(guard: fail)──► FAILED (paused / expired), no submit, no retry
 *
 * `SUBMITTED` is written in ONE update together with `txHash`, only after the
 * broadcast resolved. The transaction never sits in SUBMITTED without a hash,
 * and `preSubmitGuard` skips anything that already left QUEUED or carries a
 * hash, so a redelivery cannot broadcast twice. (The previous ordering wrote
 * SUBMITTED *before* broadcasting: a submit failure left the row SUBMITTED
 * forever, every retry was skipped by the guard, the failed handler never ran
 * and an A2A payment stayed PAYMENT_PENDING with its reservation locked.)
 *
 * A lost SUBMITTED write (A6b): if the DB write after a successful broadcast
 * fails, the row stays QUEUED without a hash and BullMQ retries. The retry
 * must not sign again — since the C3c wallet lane the next signature takes the
 * NEXT nonce (`max(pending, last used + 1)`), so a second transaction would
 * be accepted and the value would move twice. The broadcast stamp records the
 * signed hash (`broadcastTxHash`); inside the wallet lane, before stamping a
 * new attempt, the processor asks the chain whether the previous signed
 * attempt is known (pending or mined) and, if it is, adopts that hash instead
 * of sending anything (`EarlierBroadcastLiveError`). An RPC error in that
 * check aborts the attempt before the send.
 *
 * Who decides the outcome once an attempt was stamped (A6b): only the chain.
 * The SUBMITTED write is conditional on QUEUED without a hash; the guard and
 * the failed handler never FAIL a stamped row — they hand it to the chain
 * (SUBMITTED with the stamped hash, `stopStampedTransaction`) and settle or
 * finalize nothing, so an A2A payment is never refunded while it may still
 * be mined. When the delivery that sent the transaction finds its row already
 * handed over with its own hash, it monitors it as usual.
 *
 * Confirmation (C3c): the monitor is a detached promise, so a worker restart
 * or a slow chain can lose it. The receipt is recorded with a conditional
 * write (`status = SUBMITTED`), and only the observer that made the write runs
 * `runPostConfirmation` (fees, daily volume, A2A finalizer, escrow outcome).
 * `repollSubmittedTransactions` is the second observer: the payment-recovery
 * tick runs it for SUBMITTED rows older than a threshold and both entry
 * points (`worker.ts`, `index.ts` with the worker) run it at boot for every
 * SUBMITTED row, so a monitor killed by a shutdown or out of attempts never
 * leaves a row — and the job behind it — stuck.
 */

import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { preSubmitGuard } from '../services/transaction/pre-submit-guard.js';
import { finalizeA2APaymentJob } from '../services/job/payment-finalizer.service.js';
import { onEscrowTxOutcome } from '../services/job/escrow-erc8183.runtime.js';
import { weiToUsd } from '../services/transaction/price.service.js';
import {
  commitTransactionVolume,
  holdTransactionVolume,
  markBroadcastAttempt,
  settleVolumeAfterFailure,
  settleVolumeAfterRevert,
  stopStampedTransaction,
} from '../services/policy/daily-volume.js';
import type { SubmitterService } from '../services/transaction/submitter.service.js';
import { recordReceiptOnce, type ConfirmationOutcome } from '../services/transaction/monitor.service.js';
import type { FeeService } from '../services/policy/fee.service.js';

export interface TransactionJobData {
  transactionId: string;
  chainId: number;
  walletId: string;
  from: Address;
  to: Address;
  data: Hex;
  value: string; // bigint as string
  agentId: string;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  feeAmountWei: string; // bigint as string
  feeUsd: string;
  feeBps: number;
  /** True when transaction was wrapped via AgentExecutor — fee collected on-chain. */
  routedViaExecutor?: boolean;
}

/** The slice of a BullMQ job the processor reads — a plain object satisfies it in tests. */
export type TransactionJobLike = Pick<Job<TransactionJobData>, 'data'> &
  Partial<Pick<Job<TransactionJobData>, 'attemptsMade' | 'opts'>>;

/** pino-compatible logger surface. */
export interface ProcessorLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface TransactionProcessorDeps {
  db: PrismaClient;
  submitter: Pick<SubmitterService, 'submit'>;
  monitor: {
    waitForConfirmation(params: { txHash: Hex; chainId: number; transactionId: string }): Promise<ConfirmationOutcome | void>;
  };
  feeService: Pick<FeeService, 'incrementTxUsage' | 'recordFeeEvent'>;
  logger: ProcessorLogger;
  /** Receives the detached confirmation promise (shutdown bookkeeping; tests await it). */
  trackMonitor?: (monitoring: Promise<void>) => void;
  /**
   * A6b: whether any RPC node knows a transaction (pending or mined); throws
   * on RPC errors. Asked, before a retry signs again, about the hash an earlier
   * attempt was stamped with. Without it that check is skipped (unit tests).
   */
  isKnownTransaction?: (chainId: number, txHash: Hex) => Promise<boolean>;
  /**
   * Q7: re-queue THIS job after `delayMs` without consuming an attempt (the
   * worker binds it per job: `job.moveToDelayed` + `DelayedError`, see
   * `defer-job.ts`). Absent (unit tests) → the job returns `deferred`.
   */
  deferJob?: (delayMs: number) => Promise<void>;
}

/**
 * A6b: thrown from the broadcast hook (inside the wallet lane, before the new
 * attempt is stamped or sent) when the chain already knows the transaction an
 * earlier attempt of this row signed: that one is adopted, nothing new is sent.
 */
export class EarlierBroadcastLiveError extends Error {
  constructor(readonly txHash: Hex) {
    super(`An earlier signed attempt (${txHash}) is known to the chain — adopted, not signing again`);
  }
}

/** What the post-confirmation accounting needs — from the queue payload, or from `metadata.queuePayload` on a replay. */
export interface PostConfirmationInput {
  transactionId: string;
  chainId: number;
  agentId: string;
  feeAmountWei: string;
  value: string;
  feeBps: number;
  routedViaExecutor?: boolean;
}

export type PostConfirmationDeps = Pick<TransactionProcessorDeps, 'db' | 'feeService' | 'logger'>;

export interface TransactionFailureDeps {
  db: PrismaClient;
  deadLetterQueue: Pick<Queue, 'add'>;
  logger: ProcessorLogger;
}

export type TransactionJobResult =
  | { txHash: Hex }
  | { txHash: null; outcome: 'skipped' | 'blocked' | 'deferred'; reason: string };

/**
 * Processes one transaction job. Throws only when the broadcast itself fails
 * (so BullMQ retries with the tx still QUEUED); every policy/kill-switch block
 * and every idempotent skip returns normally.
 */
export async function processTransactionJob(
  job: TransactionJobLike,
  deps: TransactionProcessorDeps,
): Promise<TransactionJobResult> {
  const { db, submitter, monitor, feeService, logger } = deps;
  const { data } = job;

  logger.info({ transactionId: data.transactionId }, 'Processing transaction job');

  // Re-validate against the DB before signing. The job payload is a
  // snapshot from enqueue time: the admin kill switch, a policy pause or
  // expiry, or a redelivery of an already-broadcast tx are invisible in
  // it. Returning (not throwing) keeps BullMQ from retrying a paused tx.
  const guard = await preSubmitGuard(db, data.transactionId);
  if (guard.action === 'skip') {
    logger.warn(
      { transactionId: data.transactionId, reason: guard.reason },
      'Transaction job skipped — not resubmitting',
    );
    return { txHash: null, outcome: 'skipped', reason: guard.reason };
  }
  if (guard.action === 'fail') {
    logger.warn(
      {
        transactionId: data.transactionId,
        agentId: data.agentId,
        reason: guard.reason,
        ...(guard.finalizerError ? { finalizerError: guard.finalizerError } : {}),
      },
      'Transaction blocked before submission — marked FAILED',
    );
    return { txHash: null, outcome: 'blocked', reason: guard.reason };
  }
  if (guard.action === 'defer') {
    // Q7: nothing was written; the row stays QUEUED and the job comes back later.
    logger.warn(
      { transactionId: data.transactionId, chainId: data.chainId, delayMs: guard.delayMs, reason: guard.reason },
      'Transaction deferred — on-chain configuration not verified (escrow: Q7; executor / policy module: S9; no attempt consumed)',
    );
    await deps.deferJob?.(guard.delayMs);
    return { txHash: null, outcome: 'deferred', reason: guard.reason };
  }

  // The tx stays QUEUED while broadcasting. A throw here propagates so BullMQ
  // retries; the next attempt's guard still sees QUEUED + no txHash and proceeds.
  // `broadcastAttemptedAt` / `broadcastTxHash` are stamped before the signed
  // transaction is sent (A6, A6b): a permanent failure after it keeps the
  // reservation and hands the row to the chain.
  let txHash: Hex;
  try {
    ({ txHash } = await submitter.submit({
      chainId: data.chainId,
      walletId: data.walletId,
      from: data.from,
      to: data.to,
      data: data.data,
      value: BigInt(data.value),
      onBeforeBroadcast: async (signedTxHash) => {
        await refuseIfEarlierBroadcastLive(deps, data, signedTxHash);
        await markBroadcastAttempt(db, data.transactionId, signedTxHash);
      },
    }));
  } catch (err) {
    if (!(err instanceof EarlierBroadcastLiveError)) throw err;
    // A6b: a previous attempt reached the chain (its SUBMITTED write was lost,
    // or its send "failed" after the node took it). Record that one.
    txHash = err.txHash;
    logger.warn(
      { transactionId: data.transactionId, txHash },
      'An earlier signed attempt is known to the chain — adopted instead of signing a second transaction',
    );
  }

  // One write: SUBMITTED always carries its txHash. Conditional (A6b): only
  // from QUEUED without a hash — never over a row somebody else settled.
  // From here on the guard skips any redelivery of this job.
  const recorded = await db.transaction.updateMany({
    where: { id: data.transactionId, status: 'QUEUED', txHash: null },
    data: { status: 'SUBMITTED', txHash },
  });
  if (recorded.count === 0) {
    const row = await db.transaction.findUnique({
      where: { id: data.transactionId },
      select: { status: true, txHash: true },
    });
    if (row?.txHash?.toLowerCase() !== txHash.toLowerCase()) {
      // Settled by somebody else (e.g. an ERC-8183 step the guard failed):
      // not overwritten, and not monitored here. `broadcastTxHash` keeps the
      // evidence for reconciliation.
      logger.error(
        { transactionId: data.transactionId, txHash, status: row?.status, recordedTxHash: row?.txHash ?? null },
        'Transaction broadcast, but its row was already settled — not overwritten; reconcile from broadcastTxHash',
      );
      return { txHash };
    }
    // A concurrent guard / failed handler handed this very hash to the chain
    // (SUBMITTED): observe it like our own.
  }

  logger.info({ transactionId: data.transactionId, txHash }, 'Transaction submitted');

  // Monitor confirmation async — resolves feeUsd via price oracle once confirmed.
  // Only the observer that records the receipt runs the outcome (C3c): a
  // timeout leaves the row SUBMITTED for `repollSubmittedTransactions`, and a
  // receipt the re-poll recorded first is not handled twice.
  const monitoring = monitor
    .waitForConfirmation({
      txHash,
      chainId: data.chainId,
      transactionId: data.transactionId,
    })
    .then(async (outcome) => {
      if (outcome && (outcome.status === 'TIMEOUT' || !outcome.recorded)) return;
      await runPostConfirmation({ db, feeService, logger }, data);
    })
    .catch((err) => {
      logger.error({ err, transactionId: data.transactionId }, 'Post-confirmation accounting failed');
    });
  deps.trackMonitor?.(monitoring);

  return { txHash };
}

/**
 * A6b: called inside the wallet lane right before a new attempt is stamped
 * and sent. When an earlier attempt of the row was stamped with a different
 * signed hash and the chain knows that one, throws `EarlierBroadcastLiveError`
 * (the submitter sends nothing). An RPC error propagates and aborts the
 * attempt before the send, as a failed stamp does.
 */
async function refuseIfEarlierBroadcastLive(
  deps: Pick<TransactionProcessorDeps, 'db' | 'isKnownTransaction'>,
  data: Pick<TransactionJobData, 'transactionId' | 'chainId'>,
  signedTxHash: Hex,
): Promise<void> {
  if (!deps.isKnownTransaction) return;
  const row = await deps.db.transaction.findUnique({
    where: { id: data.transactionId },
    select: { broadcastTxHash: true },
  });
  const earlier = row?.broadcastTxHash;
  if (!earlier || earlier.toLowerCase() === signedTxHash.toLowerCase()) return;
  if (await deps.isKnownTransaction(data.chainId, earlier as Hex)) {
    throw new EarlierBroadcastLiveError(earlier as Hex);
  }
}

/**
 * Everything that follows a recorded outcome (CONFIRMED / REVERTED / dropped
 * FAILED): fee usage and FeeEvent for a confirmed transaction, the settlement
 * of its DailyVolume reservation, then the job lifecycle — the A2A finalizer
 * or the ERC-8183 orchestrator. Callers guarantee it runs once per transaction
 * (conditional status write); the reservation settlement is conditional too.
 *
 * DailyVolume (A6): the USD was reserved when the row was created and is not
 * added again here. CONFIRMED commits it, REVERTED gives it back (the value
 * never moved), a dropped transaction holds it (it may still be mined).
 */
export async function runPostConfirmation(deps: PostConfirmationDeps, data: PostConfirmationInput): Promise<void> {
  const { db, feeService } = deps;
  const tx = await db.transaction.findUnique({
    where: { id: data.transactionId },
    select: { status: true, amountIn: true, error: true, metadata: true },
  });
  // A failed settlement must not skip fees or the job lifecycle below; the
  // payment-recovery volume sweep settles a row left RESERVED.
  try {
    if (tx?.status === 'CONFIRMED') {
      await commitTransactionVolume(db, data.transactionId);
    } else if (tx?.status === 'REVERTED') {
      await settleVolumeAfterRevert(db, data.transactionId);
    } else if (tx?.status === 'FAILED') {
      await holdTransactionVolume(db, data.transactionId);
    }
  } catch (volumeErr) {
    deps.logger.error(
      { transactionId: data.transactionId, err: (volumeErr as Error)?.message ?? String(volumeErr) },
      'Daily volume settlement failed — left for the recovery sweep',
    );
  }

  if (tx?.status === 'CONFIRMED') {
    await feeService.incrementTxUsage(data.agentId);

    // Resolve USD value at time of confirmation
    const feeUsd =
      BigInt(data.feeAmountWei) > 0n ? await weiToUsd(BigInt(data.feeAmountWei), data.chainId) : '0';

    // FeeEvent means collected revenue. Only log when fee was collected
    // atomically on-chain through AgentExecutor.
    if (data.routedViaExecutor && BigInt(data.feeAmountWei) > 0n) {
      await feeService.recordFeeEvent({
        agentId: data.agentId,
        transactionId: data.transactionId,
        feeAmountWei: BigInt(data.feeAmountWei),
        feeUsd,
        feeBps: data.feeBps,
      });
    }
  }

  // Issue #81: A2A payment Job lifecycle is driven by the on-chain
  // outcome here, not by executeA2APayment's resolution. The Transaction
  // worker is the sole source of truth for finalizing paid jobs.
  const meta = (tx?.metadata ?? null) as
    | { jobId?: string; a2aPayment?: boolean; erc8183?: boolean }
    | null;
  if (meta?.a2aPayment === true && typeof meta.jobId === 'string') {
    if (tx?.status === 'CONFIRMED') {
      await finalizeA2APaymentJob({
        jobId: meta.jobId,
        transactionId: data.transactionId,
        outcome: 'CONFIRMED',
      });
    } else {
      // REVERTED, FAILED (dropped), or anything not-CONFIRMED → refund.
      await finalizeA2APaymentJob({
        jobId: meta.jobId,
        transactionId: data.transactionId,
        outcome: 'FAILED',
        reason: tx?.error ?? `Transaction ${tx?.status ?? 'unknown'} on-chain`,
      });
    }
  } else if (meta?.erc8183 === true) {
    // C3: an ERC-8183 escrow step (create/setBudget/approve/fund/submit).
    // The orchestrator advances or unwinds the Job from the chain outcome.
    await onEscrowTxOutcome({
      transactionId: data.transactionId,
      status: tx?.status === 'CONFIRMED' ? 'CONFIRMED' : tx?.status === 'REVERTED' ? 'REVERTED' : 'FAILED',
      error: tx?.error ?? (tx?.status === 'CONFIRMED' ? null : `Transaction ${tx?.status ?? 'unknown'} on-chain`),
    });
  }
}

// ── Re-poll of SUBMITTED rows (C3c) ────────────────────────────────────────

export interface RepollDeps extends PostConfirmationDeps {
  /** The receipt, or null while the transaction is not mined. Throws on RPC errors. */
  getReceipt(chainId: number, txHash: Hex): Promise<Pick<TransactionReceipt, 'status' | 'gasUsed' | 'effectiveGasPrice'> | null>;
  /** Whether any RPC node still knows the transaction (pending or mined). Throws on RPC errors. */
  isKnownTransaction(chainId: number, txHash: Hex): Promise<boolean>;
  now?: () => Date;
}

export interface RepollOptions {
  /** Only rows that have been SUBMITTED for longer than this (0 at boot: every row). */
  olderThanMs: number;
  /**
   * A row with no receipt that no RPC node knows any more is declared dropped
   * (FAILED) only after this long — a node behind a load balancer may simply
   * not have seen it, and a dropped row unwinds its job.
   */
  dropAfterMs: number;
  limit: number;
}

export interface RepollSummary {
  scanned: number;
  confirmed: number;
  reverted: number;
  dropped: number;
  pending: number;
  errors: number;
}

interface QueuePayloadMeta {
  value?: string;
  feeAmountWei?: string;
  feeBps?: number;
  routedViaExecutor?: boolean;
}

function postConfirmationInputOf(row: { id: string; chainId: number; agentId: string; metadata: unknown }): PostConfirmationInput {
  const payload = ((row.metadata as { queuePayload?: QueuePayloadMeta } | null)?.queuePayload ?? {}) as QueuePayloadMeta;
  return {
    transactionId: row.id,
    chainId: row.chainId,
    agentId: row.agentId,
    feeAmountWei: payload.feeAmountWei ?? '0',
    value: payload.value ?? '0',
    feeBps: payload.feeBps ?? 0,
    routedViaExecutor: payload.routedViaExecutor ?? false,
  };
}

/**
 * Re-reads the receipt of SUBMITTED transactions whose monitor is gone
 * (worker restart, shutdown, out of polling attempts) and replays the outcome
 * through `runPostConfirmation` — exactly once, the receipt write is
 * conditional. Without a receipt, a transaction is left alone while any node
 * knows it; after `dropAfterMs` with no node knowing it, it is marked FAILED
 * (dropped), which for an escrow step means a chain read before anything is
 * unwound (`onEscrowTxOutcome`).
 */
export async function repollSubmittedTransactions(deps: RepollDeps, opts: RepollOptions): Promise<RepollSummary> {
  const { db, logger } = deps;
  const now = (deps.now?.() ?? new Date()).getTime();
  const rows = await db.transaction.findMany({
    where: { status: 'SUBMITTED', txHash: { not: null }, updatedAt: { lte: new Date(now - opts.olderThanMs) } },
    orderBy: { updatedAt: 'asc' },
    take: opts.limit,
    select: { id: true, chainId: true, agentId: true, txHash: true, metadata: true, updatedAt: true },
  });
  const summary: RepollSummary = { scanned: rows.length, confirmed: 0, reverted: 0, dropped: 0, pending: 0, errors: 0 };

  for (const row of rows) {
    const txHash = row.txHash as Hex;
    try {
      const receipt = await deps.getReceipt(row.chainId, txHash);
      if (receipt) {
        const recorded = await recordReceiptOnce(db, row.id, receipt);
        if (recorded.recorded) {
          await runPostConfirmation(deps, postConfirmationInputOf(row));
          if (recorded.status === 'CONFIRMED') summary.confirmed++;
          else summary.reverted++;
          logger.warn(
            { transactionId: row.id, txHash, status: recorded.status },
            'Re-poll: SUBMITTED transaction had a receipt nobody recorded — outcome replayed',
          );
        }
        continue;
      }

      const ageMs = now - row.updatedAt.getTime();
      if (ageMs < opts.dropAfterMs || (await deps.isKnownTransaction(row.chainId, txHash))) {
        summary.pending++;
        continue;
      }
      const error = `Dropped: no receipt and unknown to the RPC ${Math.round(ageMs / 60_000)} min after broadcast`;
      const dropped = await db.transaction.updateMany({
        where: { id: row.id, status: 'SUBMITTED' },
        data: { status: 'FAILED', error },
      });
      if (dropped.count > 0) {
        summary.dropped++;
        logger.error({ transactionId: row.id, txHash, ageMs }, 'Re-poll: transaction dropped — marked FAILED');
        await runPostConfirmation(deps, postConfirmationInputOf(row));
      }
    } catch (err) {
      summary.errors++;
      logger.warn(
        { transactionId: row.id, txHash, err: (err as Error)?.message ?? String(err) },
        'Re-poll: could not resolve a SUBMITTED transaction — will retry next tick',
      );
    }
  }
  return summary;
}

/** True on the attempt after which BullMQ will not retry the job again. */
export function isLastAttempt(job: TransactionJobLike): boolean {
  return (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1);
}

/**
 * `worker.on('failed')` handler. On the final attempt only: dead-letter the
 * job, mark the transaction FAILED and — for an A2A payment — finalize the
 * Job as PAYMENT_FAILED (refunds the escrow reservation). Reachable for
 * broadcast failures because `processTransactionJob` leaves the tx QUEUED
 * until the broadcast succeeds. A6b: a row an attempt was stamped for is not
 * FAILED but handed to the chain (`settlePermanentFailure`).
 */
export async function handleFailedTransactionJob(
  job: TransactionJobLike | undefined,
  err: Error,
  deps: TransactionFailureDeps,
): Promise<void> {
  if (!job) return;
  if (!isLastAttempt(job)) return;

  const { db, deadLetterQueue, logger } = deps;
  const { transactionId } = job.data;
  const attempts = job.attemptsMade ?? 0;
  logger.error(
    { transactionId, err: err.message, attempts },
    'Transaction job permanently failed — moving to DLQ',
  );

  try {
    // Persist to dead-letter queue for forensics / manual retry
    await deadLetterQueue.add('dlq', {
      ...job.data,
      failedAt: new Date().toISOString(),
      error: err.message.slice(0, 500),
      attempts,
    });
  } catch (dlqErr) {
    logger.error({ transactionId, dlqErr }, 'Failed to enqueue to dead-letter queue');
  }

  await settlePermanentFailure(db, transactionId, err.message.slice(0, 500), logger);
}

/**
 * The transaction side of a permanent failure (shared by the failed handler
 * and the stranded-QUEUED sweep): stop the row, settle its reservation and
 * finalize its job — or hand it to the chain when an attempt was stamped.
 *
 *  - never stamped (no attempt reached the broadcast): FAILED, reservation
 *    released, A2A payment finalized PAYMENT_FAILED (refund), ERC-8183 step
 *    unwound by the orchestrator;
 *  - stamped with its signed hash (A6b): SUBMITTED with that hash — the
 *    receipt or the re-poll's drop decides; nothing settled or finalized here;
 *  - stamped before migration 0024 (no hash): FAILED with the reservation
 *    HELD, and an A2A payment is NOT refunded (left PAYMENT_PENDING);
 *  - no longer QUEUED (a stalled-job redelivery while another delivery
 *    recorded its broadcast): left to its own outcome.
 * 6d (C3e): ERC-8183 / ERC-8004 steps follow the same rule (they used to be
 * FAILED whatever the stamp, and the orchestrator's chain read cannot see a
 * step still in a mempool: a pending `fund` unwound the job and released its
 * reservation, a pending `submit` handed a delivered job back to ACCEPTED).
 */
export async function settlePermanentFailure(
  db: PrismaClient,
  transactionId: string,
  error: string,
  logger: ProcessorLogger,
): Promise<void> {
  type RowMeta = { jobId?: string; a2aPayment?: boolean; erc8183?: boolean } | null;
  let meta: RowMeta = null;
  let broadcastAttempted = false;
  try {
    const tx = await db.transaction.findUnique({
      where: { id: transactionId },
      select: { metadata: true },
    });
    meta = (tx?.metadata ?? null) as RowMeta;

    // Conditional on QUEUED: a stalled-job redelivery can reach this handler
    // while another delivery of the same job already broadcast it (SUBMITTED, or
    // later). That row is in flight — its own observer settles it and finalizes
    // its job — so it is neither overwritten nor finalized as FAILED here.
    // A6b: and on no attempt having been stamped for broadcast. 6d (C3e): for
    // ERC-8183 / ERC-8004 steps too — a stamped step may still be in a mempool,
    // where the orchestrator's chain read cannot see it.
    const { count } = await db.transaction.updateMany({
      where: { id: transactionId, status: 'QUEUED', broadcastAttemptedAt: null },
      data: { status: 'FAILED', error },
    });
    if (count === 0) {
      const stop = await stopStampedTransaction(db, transactionId, error, { handToChain: true });
      if (stop.outcome === 'not-queued') {
        logger.warn(
          { transactionId },
          'Permanently failed job, but the transaction already left QUEUED — left to its own outcome',
        );
        return;
      }
      if (stop.outcome === 'handed-to-chain') {
        logger.warn(
          { transactionId, txHash: stop.txHash, err: error },
          'Permanently failed after a signed attempt was stamped for broadcast — not FAILED: handed to the chain (re-poll decides), nothing refunded',
        );
        return;
      }
      broadcastAttempted = stop.broadcastAttempted;
    }
  } catch (dbErr) {
    // Unknown state: nothing is settled or finalized (the stranded-QUEUED
    // sweep picks the row up again while it is QUEUED with a failed job).
    logger.error({ transactionId, dbErr }, 'Failed to update transaction status to FAILED');
    return;
  }

  // A6: give the DailyVolume reservation back only when no attempt ever
  // reached the broadcast step; after one, the signed transaction may still
  // be mined, so it stays counted (HELD).
  try {
    const volume = await settleVolumeAfterFailure(db, transactionId);
    if (volume === 'held') {
      logger.warn({ transactionId }, 'Permanently failed after a broadcast attempt — daily volume reservation kept');
    }
  } catch (volumeErr) {
    logger.error({ transactionId, volumeErr }, 'Failed to settle the daily volume reservation of a failed transaction');
  }

  // Issue #81: if this tx was an A2A payment, finalize the Job too.
  // Without this, broadcast-time failures (estimateGas, RPC reject, etc.)
  // leave the Job stuck in PAYMENT_PENDING forever after BullMQ exhausts
  // retries. monitor.waitForConfirmation never runs in this path.
  try {
    if (meta?.a2aPayment === true && typeof meta.jobId === 'string' && broadcastAttempted) {
      // A6b: stamped without a recorded hash — the payment may still be mined.
      logger.error(
        { transactionId, jobId: meta.jobId },
        'A2A payment failed after a broadcast attempt with no recorded hash — job left PAYMENT_PENDING (not refunded); reconcile manually',
      );
    } else if (meta?.a2aPayment === true && typeof meta.jobId === 'string') {
      await finalizeA2APaymentJob({
        jobId: meta.jobId,
        transactionId,
        outcome: 'FAILED',
        reason: error,
      });
    } else if (meta?.erc8183 === true) {
      // C3: a permanently failed escrow step — FAILED + reservation release
      // before FUNDED, or back to ACCEPTED for a failed provider `submit`.
      await onEscrowTxOutcome({
        transactionId,
        status: 'FAILED',
        error,
      });
    }
  } catch (finalizeErr) {
    logger.error(
      { transactionId, finalizeErr },
      'Failed to finalize A2A payment job after permanent broadcast failure',
    );
  }
}
