/**
 * Recovery of QUEUED transactions that no BullMQ job will ever run (A6b).
 *
 * Every path writes the Transaction row first and adds its BullMQ job second:
 * the ordinary routes (`createWithVolumeReservation` → `enqueueOrFail`), the
 * operator approval (PENDING_APPROVAL → QUEUED, then the add) and the legacy
 * A2A payment (`executeA2APayment`). A process that dies between the two
 * writes leaves a QUEUED row with no job: it holds its DailyVolume
 * reservation (or, for an A2A payment, the Job stays PAYMENT_PENDING — the
 * recovery scan treats QUEUED as in flight) forever, and the operator cannot
 * approve it again (it is no longer PENDING_APPROVAL). The same happens when a
 * job ended in BullMQ's failed set but the in-process failed handler never ran
 * (crash right after, or a stalled job failed before its last attempt).
 *
 * Those enqueue sites now add the job with a deterministic id
 * (`transactionJobId`): BullMQ does not add a second job with an id that
 * exists, so this sweep can ask BullMQ for the row's job and re-add it without
 * ever creating a duplicate. Run on the payment-recovery tick for QUEUED rows
 * without a hash untouched for `olderThan`:
 *
 *   job waiting / active / delayed …  in flight — left alone
 *   a broadcast attempt was stamped   no live job will decide it: handed to the
 *                                     chain like the failed handler does
 *                                     (`settlePermanentFailure`), never re-sent
 *   job failed (handler never ran)    settled as the failed handler would have
 *   no job at all                     re-added with the same payload (rebuilt
 *                                     from `metadata.queuePayload`), so the
 *                                     pre-submit guard re-validates it
 *   job completed, row still QUEUED   the job ran while the row was not
 *                                     runnable (e.g. an approval whose add
 *                                     timed out after reaching Redis was
 *                                     reverted to PENDING_APPROVAL, then
 *                                     approved again — that add was a no-op on
 *                                     the existing id): the finished job is
 *                                     removed and the row re-added as above
 *
 * ERC-8183 / ERC-8004 steps (`metadata.erc8183`) and the legacy EscrowModule
 * rows are not swept: the escrow reconciliation owns the former and the
 * latter are not enqueued with deterministic ids.
 */

import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { getAddress, type Address, type Hex } from 'viem';
import {
  settlePermanentFailure,
  type ProcessorLogger,
  type TransactionJobData,
} from '../../queues/transaction.processor.js';
import { transactionJobId } from '../../queues/transaction-job-id.js';

/** Row types every enqueue site adds with `transactionJobId` (routes, approval, A2A payment, admin batch). */
const SWEPT_TYPES = ['SWAP', 'TRANSFER', 'DEPOSIT', 'WITHDRAW', 'APPROVE', 'BATCH', 'GMX_OPEN', 'GMX_CLOSE'] as const;

/** BullMQ states in which the job will still run (or is running). */
const LIVE_STATES = new Set(['waiting', 'wait', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused']);

export interface StrandedSweepDeps {
  db: PrismaClient;
  queue: Pick<Queue<TransactionJobData>, 'add' | 'getJob'>;
  logger: ProcessorLogger;
}

export interface StrandedSweepSummary {
  scanned: number;
  /** A live job exists: left alone. */
  live: number;
  /** No job: added again. */
  requeued: number;
  /** Stamped for broadcast, or its job failed: settled as the failed handler does. */
  settled: number;
  /** Anything else (completed job, escrow step, no payload): logged, left alone. */
  leftAlone: number;
  errors: number;
}

interface QueuePayload {
  to?: string;
  data?: string;
  value?: string;
  feeAmountWei?: string;
  feeBps?: number;
  routedViaExecutor?: boolean;
}

export async function recoverStrandedQueuedTransactions(
  deps: StrandedSweepDeps,
  opts: { olderThan: Date; limit: number },
): Promise<StrandedSweepSummary> {
  const { db, queue, logger } = deps;
  const rows = await db.transaction.findMany({
    where: {
      status: 'QUEUED',
      txHash: null,
      type: { in: [...SWEPT_TYPES] },
      updatedAt: { lte: opts.olderThan },
    },
    orderBy: { updatedAt: 'asc' },
    take: opts.limit,
    select: {
      id: true,
      chainId: true,
      agentId: true,
      type: true,
      metadata: true,
      broadcastAttemptedAt: true,
      agent: { select: { walletId: true, safeAddress: true, tier: true } },
    },
  });
  const summary: StrandedSweepSummary = { scanned: rows.length, live: 0, requeued: 0, settled: 0, leftAlone: 0, errors: 0 };

  for (const row of rows) {
    try {
      const meta = (row.metadata ?? null) as { erc8183?: boolean; a2aPayment?: boolean; queuePayload?: QueuePayload } | null;
      if (meta?.erc8183 === true) {
        summary.leftAlone++;
        continue;
      }
      const jobId = transactionJobId(row.id);
      const job = await queue.getJob(jobId);
      const state = job ? await job.getState() : 'missing';
      if (LIVE_STATES.has(state)) {
        summary.live++;
        continue;
      }

      if (row.broadcastAttemptedAt || state === 'failed') {
        // A signed attempt may be on its way (the chain decides), or the job
        // failed for good and its handler never ran: exactly the failed
        // handler's settlement, idempotent against a handler running now.
        const reason = row.broadcastAttemptedAt
          ? `Stranded QUEUED after a broadcast attempt (BullMQ job ${state})`
          : `Stranded QUEUED: BullMQ job failed — ${job?.failedReason ?? 'no reason recorded'}`;
        await settlePermanentFailure(db, row.id, reason.slice(0, 500), logger);
        summary.settled++;
        logger.warn({ transactionId: row.id, jobState: state }, 'Stranded QUEUED transaction settled as a permanent failure');
        continue;
      }

      if (state === 'completed' && job) {
        // Never stamped, so never sent: a finished job will not run again and
        // its id would swallow the re-add. Remove it, then re-add below.
        await job.remove();
      } else if (state !== 'missing') {
        // 'unknown' (removed between the two reads) or a state BullMQ added
        // later: look again next tick.
        summary.leftAlone++;
        logger.warn({ transactionId: row.id, jobState: state }, 'QUEUED transaction whose BullMQ job is in an unexpected state — left for the next tick');
        continue;
      }

      const payload = meta?.queuePayload;
      if (!payload?.to || !payload.data) {
        // Never broadcast and cannot be rebuilt: fail it (reservation released, A2A refunded).
        await settlePermanentFailure(db, row.id, 'Stranded QUEUED without a BullMQ job or a stored queue payload', logger);
        summary.settled++;
        continue;
      }
      await queue.add(
        meta?.a2aPayment === true ? 'a2a-payment' : row.type.toLowerCase(),
        {
          transactionId: row.id,
          chainId: row.chainId,
          walletId: row.agent.walletId,
          from: getAddress(row.agent.safeAddress) as Address,
          to: getAddress(payload.to) as Address,
          data: payload.data as Hex,
          value: payload.value ?? '0',
          agentId: row.agentId,
          tier: row.agent.tier,
          feeAmountWei: payload.feeAmountWei ?? '0',
          feeUsd: '0',
          feeBps: payload.feeBps ?? 0,
          routedViaExecutor: payload.routedViaExecutor ?? false,
        },
        { jobId },
      );
      summary.requeued++;
      logger.warn({ transactionId: row.id, jobId }, 'QUEUED transaction had no BullMQ job (crash before the enqueue) — enqueued again');
    } catch (err) {
      summary.errors++;
      logger.error(
        { transactionId: row.id, err: (err as Error)?.message ?? String(err) },
        'Stranded QUEUED recovery failed for a row — retried next tick',
      );
    }
  }
  return summary;
}
