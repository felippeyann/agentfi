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
 * Accepted trade-off: if the DB write after a successful broadcast fails, the
 * row stays QUEUED without a hash and a retry re-submits. The submitter uses
 * the wallet's next nonce, so the node rejects the duplicate once the first
 * broadcast is pending/mined — the same protection any retrying submitter
 * relies on.
 */

import type { Job, Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { preSubmitGuard } from '../services/transaction/pre-submit-guard.js';
import { finalizeA2APaymentJob } from '../services/job/payment-finalizer.service.js';
import { weiToUsd } from '../services/transaction/price.service.js';
import type { SubmitterService } from '../services/transaction/submitter.service.js';
import type { MonitorService } from '../services/transaction/monitor.service.js';
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
  monitor: Pick<MonitorService, 'waitForConfirmation'>;
  feeService: Pick<FeeService, 'incrementTxUsage' | 'recordFeeEvent'>;
  logger: ProcessorLogger;
}

export interface TransactionFailureDeps {
  db: PrismaClient;
  deadLetterQueue: Pick<Queue, 'add'>;
  logger: ProcessorLogger;
}

export type TransactionJobResult =
  | { txHash: Hex }
  | { txHash: null; outcome: 'skipped' | 'blocked'; reason: string };

/**
 * Atomically adds incoming USD volume to today's DailyVolume row.
 * Uses INSERT ... ON CONFLICT ... DO UPDATE to avoid read-then-write
 * race conditions under concurrent worker execution.
 */
async function addDailyVolumeAtomic(
  db: PrismaClient,
  agentId: string,
  date: string,
  valueUsd: string,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
    VALUES (gen_random_uuid()::text, ${agentId}, ${date}, ${valueUsd}, NOW())
    ON CONFLICT ("agentId", "date")
    DO UPDATE SET
      "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${valueUsd}::numeric))::text,
      "updatedAt" = NOW()
  `;
}

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

  // The tx stays QUEUED while broadcasting. A throw here propagates so BullMQ
  // retries; the next attempt's guard still sees QUEUED + no txHash and proceeds.
  const { txHash } = await submitter.submit({
    chainId: data.chainId,
    walletId: data.walletId,
    from: data.from,
    to: data.to,
    data: data.data,
    value: BigInt(data.value),
  });

  // One write: SUBMITTED always carries its txHash. From here on the guard
  // skips any redelivery of this job.
  await db.transaction.update({
    where: { id: data.transactionId },
    data: { status: 'SUBMITTED', txHash },
  });

  logger.info({ transactionId: data.transactionId, txHash }, 'Transaction submitted');

  // Monitor confirmation async — resolves feeUsd via price oracle once confirmed
  monitor
    .waitForConfirmation({
      txHash,
      chainId: data.chainId,
      transactionId: data.transactionId,
    })
    .then(async () => {
      const tx = await db.transaction.findUnique({
        where: { id: data.transactionId },
        select: { status: true, amountIn: true, error: true, metadata: true },
      });
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

        // Update daily volume — atomic upsert avoids race condition under concurrency: 5
        const valueUsd = await weiToUsd(BigInt(data.value), data.chainId);
        if (parseFloat(valueUsd) > 0) {
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
          await addDailyVolumeAtomic(db, data.agentId, today, valueUsd);
        }
      }

      // Issue #81: A2A payment Job lifecycle is driven by the on-chain
      // outcome here, not by executeA2APayment's resolution. The Transaction
      // worker is the sole source of truth for finalizing paid jobs.
      const meta = (tx?.metadata ?? null) as { jobId?: string; a2aPayment?: boolean } | null;
      if (meta?.a2aPayment === true && typeof meta.jobId === 'string') {
        if (tx?.status === 'CONFIRMED') {
          await finalizeA2APaymentJob({
            jobId: meta.jobId,
            transactionId: data.transactionId,
            outcome: 'CONFIRMED',
          });
        } else {
          // REVERTED, FAILED (timeout), or anything not-CONFIRMED → refund.
          await finalizeA2APaymentJob({
            jobId: meta.jobId,
            transactionId: data.transactionId,
            outcome: 'FAILED',
            reason: tx?.error ?? `Transaction ${tx?.status ?? 'unknown'} on-chain`,
          });
        }
      }
    })
    .catch((err) => {
      logger.error({ err, transactionId: data.transactionId }, 'Post-confirmation accounting failed');
    });

  return { txHash };
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
 * until the broadcast succeeds.
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

  try {
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'FAILED',
        error: err.message.slice(0, 500),
      },
    });
  } catch (dbErr) {
    logger.error({ transactionId, dbErr }, 'Failed to update transaction status to FAILED');
  }

  // Issue #81: if this tx was an A2A payment, finalize the Job too.
  // Without this, broadcast-time failures (estimateGas, RPC reject, etc.)
  // leave the Job stuck in PAYMENT_PENDING forever after BullMQ exhausts
  // retries. monitor.waitForConfirmation never runs in this path.
  try {
    const tx = await db.transaction.findUnique({
      where: { id: transactionId },
      select: { metadata: true },
    });
    const meta = (tx?.metadata ?? null) as { jobId?: string; a2aPayment?: boolean } | null;
    if (meta?.a2aPayment === true && typeof meta.jobId === 'string') {
      await finalizeA2APaymentJob({
        jobId: meta.jobId,
        transactionId,
        outcome: 'FAILED',
        reason: err.message.slice(0, 500),
      });
    }
  } catch (finalizeErr) {
    logger.error(
      { transactionId, finalizeErr },
      'Failed to finalize A2A payment job after permanent broadcast failure',
    );
  }
}
