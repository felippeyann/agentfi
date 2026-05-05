/**
 * Payment Recovery Queue — BullMQ repeatable job for stale PAYMENT_PENDING jobs.
 *
 * Issue #73 (Phase 1.5 of #71). Without this, a backend crash between the
 * `executeA2APayment` call and the worker confirming the on-chain outcome
 * leaves the Job stuck in `PAYMENT_PENDING` forever. Provider work is done,
 * requester escrow is locked, the dashboard hides the row from PnL → silent
 * production-grade data integrity failure.
 *
 * Architecture (deliberately simple, leaning on prior work):
 *   1. Every N minutes, scan Job rows with `status = 'PAYMENT_PENDING'` AND
 *      `updatedAt < now() - STALE_THRESHOLD`.
 *   2. For each candidate, look up the Transaction via the deterministic
 *      `intentId = "a2a-payment:<jobId>"` introduced by #74. One indexed row.
 *   3. Decide based on the Transaction's on-chain status:
 *        - CONFIRMED  → call finalizer(CONFIRMED) — worker crashed before
 *                       triggering the finalizer; complete the lifecycle now.
 *        - REVERTED / FAILED → finalizer(FAILED) — refund escrow, mark job.
 *        - QUEUED / SUBMITTED / PENDING_APPROVAL → leave alone (still in-flight,
 *          BullMQ will retry / human will approve).
 *        - No Transaction at all → orphan. Refund as PAYMENT_FAILED with reason.
 *
 *  Idempotency rests on three pillars from prior PRs:
 *    - #74: intentId on Transaction prevents duplicate broadcasts on retry.
 *    - #83: finalizer no-ops when Job is not in PAYMENT_PENDING.
 *    - #85: refund-then-flip ordering means observers never see a partial state.
 */

import { Queue, Worker } from 'bullmq';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../api/middleware/logger.js';
import { finalizeA2APaymentJob } from '../services/job/payment-finalizer.service.js';

const RECOVERY_QUEUE_NAME = 'payment-recovery';

// How often the recovery scan runs. 2 minutes by default — tight enough that a
// stuck job is recovered quickly, loose enough to keep Redis polling cheap.
const RECOVERY_INTERVAL_MS =
  parseInt(process.env['PAYMENT_RECOVERY_INTERVAL_SEC'] ?? '120', 10) * 1000;

// How long a Job must sit in PAYMENT_PENDING before the recovery worker
// considers it stale. Default 5 min — covers BullMQ's 3-attempt retry window
// (≈35s with our exponential backoff) plus a comfortable buffer for slow
// chains and price-oracle latency. Bump higher on chains with longer
// confirmation windows; lower on testnets.
const STALE_THRESHOLD_MS =
  parseInt(process.env['PAYMENT_RECOVERY_STALE_THRESHOLD_SEC'] ?? '300', 10) * 1000;

// Cap per scan tick — protects against unbounded queries if the table ever
// accumulates a large backlog (e.g. after a multi-hour outage).
const PER_TICK_LIMIT = parseInt(process.env['PAYMENT_RECOVERY_PER_TICK_LIMIT'] ?? '50', 10);

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
};

export const paymentRecoveryQueue = new Queue(RECOVERY_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    // Keep the last few completed/failed scans visible for debugging without
    // accumulating forever.
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

/**
 * Idempotently registers the repeatable scan job. BullMQ dedupes by jobId, so
 * calling this on every boot is safe — only the first call (across all
 * replicas) creates the schedule; subsequent calls are no-ops.
 */
export async function schedulePaymentRecovery(): Promise<void> {
  await paymentRecoveryQueue.add(
    'scan',
    {},
    {
      repeat: { every: RECOVERY_INTERVAL_MS },
      jobId: 'payment-recovery-scan', // prevents duplicates across restarts/replicas
    },
  );
  logger.info(
    {
      queue: RECOVERY_QUEUE_NAME,
      intervalMs: RECOVERY_INTERVAL_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      perTickLimit: PER_TICK_LIMIT,
    },
    'Payment recovery scan scheduled',
  );
}

interface RecoverySummary {
  scanned: number;
  finalizedConfirmed: number;
  finalizedFailed: number;
  refundedOrphan: number;
  stillInFlight: number;
}

export function startPaymentRecoveryWorker(): Worker {
  const worker = new Worker(
    RECOVERY_QUEUE_NAME,
    async () => {
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

      const stale = await db.job.findMany({
        where: {
          status: 'PAYMENT_PENDING',
          updatedAt: { lt: cutoff },
        },
        select: { id: true, updatedAt: true },
        take: PER_TICK_LIMIT,
        orderBy: { updatedAt: 'asc' }, // oldest first, in case we hit the cap
      });

      const summary: RecoverySummary = {
        scanned: stale.length,
        finalizedConfirmed: 0,
        finalizedFailed: 0,
        refundedOrphan: 0,
        stillInFlight: 0,
      };

      if (stale.length === 0) {
        logger.debug(summary, 'Payment recovery scan: nothing to do');
        return summary;
      }

      for (const job of stale) {
        const intentId = `a2a-payment:${job.id}`;
        const tx = await db.transaction.findUnique({
          where: { intentId },
          select: { id: true, status: true, error: true },
        });

        if (!tx) {
          // Orphan: Job stuck in PAYMENT_PENDING with no Transaction row.
          // executeA2APayment must have died before line 1848 of
          // api/routes/transactions.ts (the create() call). Without a Tx
          // there is nothing to recover from — refund the escrow.
          logger.warn(
            { jobId: job.id, ageSec: Math.floor((Date.now() - job.updatedAt.getTime()) / 1000) },
            'Payment recovery: orphan PAYMENT_PENDING (no Transaction) → refunding',
          );
          await finalizeA2APaymentJob({
            jobId: job.id,
            transactionId: null,
            outcome: 'FAILED',
            reason: 'Recovery: orphan PAYMENT_PENDING with no Transaction record',
          });
          summary.refundedOrphan++;
          continue;
        }

        if (tx.status === 'CONFIRMED') {
          // Worker crashed between the chain confirmation and the finalizer
          // call. Complete the lifecycle now.
          logger.info(
            { jobId: job.id, transactionId: tx.id },
            'Payment recovery: tx CONFIRMED but Job still PAYMENT_PENDING → finalizing as COMPLETED',
          );
          await finalizeA2APaymentJob({
            jobId: job.id,
            transactionId: tx.id,
            outcome: 'CONFIRMED',
          });
          summary.finalizedConfirmed++;
          continue;
        }

        if (tx.status === 'REVERTED' || tx.status === 'FAILED') {
          logger.info(
            { jobId: job.id, transactionId: tx.id, txStatus: tx.status },
            `Payment recovery: tx ${tx.status} but Job still PAYMENT_PENDING → finalizing as PAYMENT_FAILED`,
          );
          await finalizeA2APaymentJob({
            jobId: job.id,
            transactionId: tx.id,
            outcome: 'FAILED',
            reason: `Recovery: tx ${tx.status} (${tx.error ?? 'no error message recorded'})`,
          });
          summary.finalizedFailed++;
          continue;
        }

        // QUEUED, SUBMITTED, PENDING_APPROVAL — still in-flight. The
        // transaction worker (or human approver) will reach the finalizer
        // through the normal path. Don't interfere; the next scan will pick
        // it up if it stays stuck.
        logger.debug(
          { jobId: job.id, transactionId: tx.id, txStatus: tx.status },
          'Payment recovery: tx still in-flight, leaving alone',
        );
        summary.stillInFlight++;
      }

      logger.info(summary, 'Payment recovery scan completed');
      return summary;
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err?.message ?? String(err) },
      'Payment recovery scan failed',
    );
  });

  logger.info({ queue: RECOVERY_QUEUE_NAME }, 'Payment recovery worker started');
  return worker;
}
