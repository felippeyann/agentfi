/**
 * Transaction Queue — BullMQ queues + worker wiring for async tx processing.
 *
 * The processing logic lives in `transaction.processor.ts`
 * (`processTransactionJob` / `handleFailedTransactionJob`) with injected
 * dependencies so it is unit-testable without Redis; this module owns the
 * queues, the worker lifecycle and the real dependency instances.
 */

import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { createChainPublicClient } from '../config/chains.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { MonitorService } from '../services/transaction/monitor.service.js';
import { FeeService } from '../services/policy/fee.service.js';
import { walletLaneLock, walletNonceStore } from '../services/transaction/wallet-lane.runtime.js';
import { logger } from '../api/middleware/logger.js';
import {
  handleFailedTransactionJob,
  processTransactionJob,
  repollSubmittedTransactions,
  type RepollOptions,
  type RepollSummary,
  type TransactionJobData,
} from './transaction.processor.js';

export type { TransactionJobData } from './transaction.processor.js';

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number, // required by BullMQ
  enableReadyCheck: false,
};
// C3c / N1: one broadcast lane per wallet (Redis lock from nonce read to
// broadcast) and pending-nonce reads, shared by every process.
const submitter = new SubmitterService({ lane: walletLaneLock, nonces: walletNonceStore });
const monitor = new MonitorService(db);
const feeService = new FeeService(db);

/** Confirmation monitors still running in this process (detached from the BullMQ job). */
const inFlightMonitors = new Set<Promise<void>>();

function trackMonitor(monitoring: Promise<void>): void {
  inFlightMonitors.add(monitoring);
  void monitoring.finally(() => inFlightMonitors.delete(monitoring));
}

/**
 * Waits up to `timeoutMs` for this process's confirmation monitors, then
 * reports how many are still running. Those rows stay SUBMITTED and are
 * re-polled at the next boot (`repollSubmittedTransactionsNow`), so a
 * shutdown never loses an outcome — it only delays it.
 */
export async function drainTransactionMonitors(timeoutMs: number): Promise<number> {
  if (inFlightMonitors.size > 0) {
    await Promise.race([
      Promise.allSettled([...inFlightMonitors]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
  if (inFlightMonitors.size > 0) {
    logger.warn(
      { abandoned: inFlightMonitors.size },
      'Shutdown with confirmation monitors still running — their transactions stay SUBMITTED and are re-polled at the next boot',
    );
  }
  return inFlightMonitors.size;
}

const receiptClients = new Map<number, ReturnType<typeof createChainPublicClient>>();
function receiptClient(chainId: number) {
  let client = receiptClients.get(chainId);
  if (!client) {
    client = createChainPublicClient(chainId);
    receiptClients.set(chainId, client);
  }
  return client;
}

/** Default re-poll knobs (seconds, env-overridable like the other recovery knobs). */
export const TX_REPOLL_STALE_MS = parseInt(process.env['TX_REPOLL_STALE_SEC'] ?? '600', 10) * 1000;
export const TX_DROP_AFTER_MS = parseInt(process.env['TX_DROP_AFTER_SEC'] ?? '1800', 10) * 1000;
export const TX_REPOLL_LIMIT = parseInt(process.env['TX_REPOLL_LIMIT'] ?? '100', 10);

/**
 * Re-polls SUBMITTED rows with the real RPC clients (see
 * `repollSubmittedTransactions`). Boot: `{ olderThanMs: 0 }`; the
 * payment-recovery tick: the stale threshold.
 */
export async function repollSubmittedTransactionsNow(opts: Partial<RepollOptions> = {}): Promise<RepollSummary> {
  return repollSubmittedTransactions(
    {
      db,
      feeService,
      logger,
      async getReceipt(chainId, txHash) {
        try {
          return await receiptClient(chainId).getTransactionReceipt({ hash: txHash as Hex });
        } catch (err) {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          throw err;
        }
      },
      async isKnownTransaction(chainId, txHash) {
        try {
          await receiptClient(chainId).getTransaction({ hash: txHash as Hex });
          return true;
        } catch (err) {
          if (err instanceof TransactionNotFoundError) return false;
          throw err;
        }
      },
    },
    {
      olderThanMs: opts.olderThanMs ?? TX_REPOLL_STALE_MS,
      dropAfterMs: opts.dropAfterMs ?? TX_DROP_AFTER_MS,
      limit: opts.limit ?? TX_REPOLL_LIMIT,
    },
  );
}

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

  const processorDeps = { db, submitter, monitor, feeService, logger, trackMonitor };

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
