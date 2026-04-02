/**
 * Transaction Queue — BullMQ workers for async tx processing.
 */

import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { MonitorService } from '../services/transaction/monitor.service.js';
import { FeeService } from '../services/policy/fee.service.js';
import { weiToUsd } from '../services/transaction/price.service.js';
import { logger } from '../api/middleware/logger.js';
import type { Address, Hex } from 'viem';

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

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number, // required by BullMQ
  enableReadyCheck: false,
};
const db = new PrismaClient();
const submitter = new SubmitterService();
const monitor = new MonitorService(db);
const feeService = new FeeService(db);

export const transactionQueue = new Queue<TransactionJobData>('transactions', {
  connection,
  defaultJobOptions: {
    // 3 retries with exponential backoff: 5s → 10s → 20s
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

/** Dead-letter queue — permanently failed jobs land here for forensics / manual retry. */
export const deadLetterQueue = new Queue('transactions-dlq', {
  connection,
  defaultJobOptions: {
    removeOnComplete: { count: 5000 },
    removeOnFail: false,
  },
});

/**
 * Atomically adds incoming USD volume to today's DailyVolume row.
 * Uses INSERT ... ON CONFLICT ... DO UPDATE to avoid read-then-write
 * race conditions under concurrent worker execution.
 */
async function addDailyVolumeAtomic(agentId: string, date: string, valueUsd: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
    VALUES (gen_random_uuid()::text, ${agentId}, ${date}, ${valueUsd}, NOW())
    ON CONFLICT ("agentId", "date")
    DO UPDATE SET
      "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${valueUsd}::numeric))::text,
      "updatedAt" = NOW()
  `;
}

function isRedisQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('max requests limit exceeded') ||
    message.includes('upstash.com/docs/redis/troubleshooting/max_requests_limit')
  );
}

export function startTransactionWorker(): Worker<TransactionJobData> {
  const workerConcurrency = env.TRANSACTION_WORKER_CONCURRENCY;
  const workerDrainDelaySec = env.TRANSACTION_WORKER_DRAIN_DELAY_SEC;
  const workerStalledIntervalMs = env.TRANSACTION_WORKER_STALLED_INTERVAL_MS;
  const stopOnRedisQuota = env.TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA === 'true';

  const worker = new Worker<TransactionJobData>(
    'transactions',
    async (job: Job<TransactionJobData>) => {
      const { data } = job;

      logger.info({ transactionId: data.transactionId }, 'Processing transaction job');

      await db.transaction.update({
        where: { id: data.transactionId },
        data: { status: 'SUBMITTED' },
      });

      const { txHash } = await submitter.submit({
        chainId: data.chainId,
        walletId: data.walletId,
        from: data.from,
        to: data.to,
        data: data.data,
        value: BigInt(data.value),
      });

      await db.transaction.update({
        where: { id: data.transactionId },
        data: { txHash },
      });

      logger.info({ transactionId: data.transactionId, txHash }, 'Transaction submitted');

      // Monitor confirmation async — resolves feeUsd via price oracle once confirmed
      monitor.waitForConfirmation({
        txHash,
        chainId: data.chainId,
        transactionId: data.transactionId,
      }).then(async () => {
        const tx = await db.transaction.findUnique({
          where: { id: data.transactionId },
          select: { status: true, amountIn: true },
        });
        if (tx?.status === 'CONFIRMED') {
          await feeService.incrementTxUsage(data.agentId);

          // Resolve USD value at time of confirmation
          const feeUsd = BigInt(data.feeAmountWei) > 0n
            ? await weiToUsd(BigInt(data.feeAmountWei), data.chainId)
            : '0';

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
            await addDailyVolumeAtomic(data.agentId, today, valueUsd);
          }
        }
      }).catch((err) => {
        logger.error({ err, transactionId: data.transactionId }, 'Post-confirmation accounting failed');
      });

      return { txHash };
    },
    {
      connection,
      concurrency: workerConcurrency,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 500 },
      // Reduce Redis polling when idle — critical for Upstash/metered Redis
      drainDelay: workerDrainDelaySec,
      stalledInterval: workerStalledIntervalMs,
    } satisfies WorkerOptions,
  );

  logger.info(
    {
      concurrency: workerConcurrency,
      drainDelaySec: workerDrainDelaySec,
      stalledIntervalMs: workerStalledIntervalMs,
    },
    'Transaction worker started',
  );

  let quotaShutdownTriggered = false;
  worker.on('error', async (err) => {
    logger.error({ err }, 'Transaction worker runtime error');

    if (
      !stopOnRedisQuota ||
      quotaShutdownTriggered ||
      !isRedisQuotaExceededError(err)
    ) {
      return;
    }

    quotaShutdownTriggered = true;
    logger.error(
      'Redis provider request quota exceeded; stopping worker to avoid request burn. ' +
      'Increase Redis plan or reduce worker polling/replicas before re-enabling.',
    );

    try {
      await worker.close();
      logger.warn('Transaction worker stopped after Redis quota exhaustion');
    } catch (closeErr) {
      logger.error({ closeErr }, 'Failed to close transaction worker after Redis quota exhaustion');
    }
  });

  // On final failure (all retries exhausted), move to dead-letter queue and mark FAILED.
  worker.on('failed', async (job: Job<TransactionJobData> | undefined, err: Error) => {
    if (!job) return;
    const isLastAttempt = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1);
    if (!isLastAttempt) return;

    const { transactionId } = job.data;
    logger.error(
      { transactionId, err: err.message, attempts: job.attemptsMade },
      'Transaction job permanently failed — moving to DLQ',
    );

    try {
      // Persist to dead-letter queue for forensics / manual retry
      await deadLetterQueue.add('dlq', {
        ...job.data,
        failedAt: new Date().toISOString(),
        error: err.message.slice(0, 500),
        attempts: job.attemptsMade,
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
  });

  return worker;
}
