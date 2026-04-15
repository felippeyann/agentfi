/**
 * Reputation Queue — BullMQ repeatable job for daily reputation score recompute.
 *
 * Runs `ReputationService.updateAllReputationScores()` on a fixed schedule.
 * Default: daily at 02:00 UTC. Override via env REPUTATION_CRON_PATTERN.
 */

import { Queue, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { ReputationService } from '../services/policy/reputation.service.js';
import { logger } from '../api/middleware/logger.js';

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
};

const REPUTATION_QUEUE_NAME = 'reputation';

// Daily at 02:00 UTC by default. Override via env if needed.
const CRON_PATTERN = process.env['REPUTATION_CRON_PATTERN'] ?? '0 2 * * *';

export const reputationQueue = new Queue(REPUTATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 30 },
    removeOnFail: { count: 100 },
  },
});

/**
 * Schedules the daily repeatable job. Idempotent — BullMQ dedupes by job key.
 */
export async function scheduleReputationUpdate(): Promise<void> {
  await reputationQueue.add(
    'daily-reputation-update',
    {},
    {
      repeat: { pattern: CRON_PATTERN, tz: 'UTC' },
      jobId: 'daily-reputation-update', // prevents duplicates on restart
    },
  );
  logger.info(
    { pattern: CRON_PATTERN, queue: REPUTATION_QUEUE_NAME },
    'Reputation update cron scheduled',
  );
}

/**
 * Starts a worker that processes reputation update jobs.
 * Returns the worker so callers can close it on shutdown.
 */
export function startReputationWorker(): Worker {
  const reputationService = new ReputationService();

  const worker = new Worker(
    REPUTATION_QUEUE_NAME,
    async () => {
      const result = await reputationService.updateAllReputationScores();
      return result;
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, result },
      'Reputation update job completed',
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err?.message ?? String(err) },
      'Reputation update job failed',
    );
  });

  logger.info({ queue: REPUTATION_QUEUE_NAME }, 'Reputation worker started');
  return worker;
}
