/**
 * Escrow settlement queue — BullMQ queue + worker for the ERC-8183 steps the
 * EVALUATOR signs (`complete` / `reject` / `claimRefund`) and for the expiry
 * sweep. Agent-signed steps (create/setBudget/approve/fund/submit) go through
 * the ordinary transaction queue; the evaluator is an operator key, not an
 * Agent row, so it has its own lane (see services/escrow/evaluator-signer.ts).
 *
 * The processing logic lives in `services/job/escrow-erc8183.service.ts`
 * (`processSettlementJob` / `handleFailedSettlementJob`, injected deps); this
 * module owns the queue, the dedupe keys, the evaluation delay and the worker
 * lifecycle.
 *
 * Dedupe: one BullMQ job per `<action>-<jobId>`. A completed job is removed
 * immediately and a failed one is removed before re-adding, so a recovery
 * re-enqueue is never silently ignored. Every settlement reads the on-chain
 * status first, which is what makes re-running safe.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../api/middleware/logger.js';
import {
  handleFailedSettlementJob,
  processSettlementJob,
  type Erc8183Deps,
  type EscrowSettlementJobData,
} from '../services/job/escrow-erc8183.service.js';

export const ESCROW_SETTLEMENT_QUEUE_NAME = 'escrow-settlement';

/** Same cadence as the payment-recovery scan (PAYMENT_RECOVERY_INTERVAL_SEC, default 120 s). */
const SWEEP_INTERVAL_MS = parseInt(process.env['PAYMENT_RECOVERY_INTERVAL_SEC'] ?? '120', 10) * 1000;

const connection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as unknown as number,
  enableReadyCheck: false,
};

export const escrowSettlementQueue = new Queue<EscrowSettlementJobData>(ESCROW_SETTLEMENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // 3 attempts with exponential backoff: 15s → 30s → 60s. A reverted or
    // unmined settlement is retried against a fresh on-chain read.
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: true,
    removeOnFail: { count: 500 },
  },
});

/**
 * BullMQ job id of a settlement action: `<action>-<jobId>`.
 *
 * Not `<action>:<jobId>`: BullMQ 5 rejects a custom id containing `:` unless
 * it splits into exactly three parts (a compatibility rule for old repeatable
 * jobs that its next major turns into "no `:` at all"), so every `queue.add`
 * with the colon form threw "Custom Id cannot contain :". Found by the C5a
 * fork rehearsal: no evaluator settlement, cancellation refund or expiry
 * claim could ever be enqueued (unit tests mocked the queue).
 */
export function settlementJobId(data: EscrowSettlementJobData): string {
  return `${data.action}-${data.jobId}`;
}

/**
 * Enqueues one settlement action per job (dedupe key `<action>-<jobId>`).
 * `delayMs` applies the evaluation grace period to `settle`.
 */
export async function addSettlementJob(data: EscrowSettlementJobData, opts?: { delayMs?: number }): Promise<void> {
  const jobId = settlementJobId(data);
  const existing = await escrowSettlementQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') {
      await existing.remove();
    } else {
      logger.info({ jobId: data.jobId, action: data.action, state }, 'Escrow settlement already queued — not re-added');
      return;
    }
  }
  await escrowSettlementQueue.add(data.action, data, {
    jobId,
    ...(opts?.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
  });
}

/**
 * Idempotently registers the repeatable expiry sweep (claimRefund for
 * Funded/Submitted jobs past `expiresAt`). BullMQ dedupes by jobId, so calling
 * this on every boot is safe.
 */
export async function scheduleEscrowExpirySweep(): Promise<void> {
  await escrowSettlementQueue.add(
    'sweep',
    { jobId: '*', action: 'sweep' },
    {
      repeat: { every: SWEEP_INTERVAL_MS },
      jobId: 'escrow-expiry-sweep',
    },
  );
  logger.info({ queue: ESCROW_SETTLEMENT_QUEUE_NAME, intervalMs: SWEEP_INTERVAL_MS }, 'Escrow expiry sweep scheduled');
}

export function startEscrowSettlementWorker(getDeps: () => Erc8183Deps): Worker<EscrowSettlementJobData> {
  const worker = new Worker<EscrowSettlementJobData>(
    ESCROW_SETTLEMENT_QUEUE_NAME,
    (job: Job<EscrowSettlementJobData>) => processSettlementJob(getDeps(), job),
    {
      connection,
      // One settlement at a time: the evaluator key has one nonce sequence.
      concurrency: 1,
      removeOnComplete: { count: 0 },
      removeOnFail: { count: 500 },
    },
  );

  worker.on('failed', (job: Job<EscrowSettlementJobData> | undefined, err: Error) =>
    handleFailedSettlementJob(getDeps(), job, err).catch((handlerErr) =>
      logger.error({ jobId: job?.data.jobId, handlerErr }, 'Escrow settlement failure handler threw'),
    ),
  );
  worker.on('error', (err) => logger.error({ err }, 'Escrow settlement worker runtime error'));

  logger.info({ queue: ESCROW_SETTLEMENT_QUEUE_NAME }, 'Escrow settlement worker started');
  return worker;
}
