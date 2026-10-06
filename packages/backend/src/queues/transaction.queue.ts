/**
 * Transaction Queue — BullMQ queues + worker wiring for async tx processing.
 *
 * The processing logic lives in `transaction.processor.ts`
 * (`processTransactionJob` / `handleFailedTransactionJob`) with injected
 * dependencies so it is unit-testable without Redis; this module owns the
 * queues, the worker lifecycle and the real dependency instances.
 */

import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { MonitorService } from '../services/transaction/monitor.service.js';
import { FeeService } from '../services/policy/fee.service.js';
import { logger } from '../api/middleware/logger.js';
import {
  handleFailedTransactionJob,
  processTransactionJob,
  type TransactionJobData,
} from './transaction.processor.js';

export type { TransactionJobData } from './transaction.processor.js';

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number, // required by BullMQ
  enableReadyCheck: false,
};
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

  const processorDeps = { db, submitter, monitor, feeService, logger };

  const worker = new Worker<TransactionJobData>(
    'transactions',
    (job: Job<TransactionJobData>) => processTransactionJob(job, processorDeps),
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
  worker.on('failed', (job: Job<TransactionJobData> | undefined, err: Error) =>
    handleFailedTransactionJob(job, err, { db, deadLetterQueue, logger }),
  );

  return worker;
}
