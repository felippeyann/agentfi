/**
 * Q7: put the BullMQ job being processed back in the delayed set WITHOUT
 * consuming an attempt, and stop processing it.
 *
 * `job.moveToDelayed` (BullMQ 5: `skipAttempt: true`, `attemptsMade` is not
 * incremented) followed by `DelayedError`, which the worker treats as "moved,
 * not failed": no retry back-off, no `failed` event, so the permanent-failure
 * handlers (FAILED + unwind / settlement-failed alert) never run for a job
 * that was only deferred. Used by the transaction worker (escrow steps whose
 * chain configuration is unverified) and the escrow settlement worker.
 */

import { DelayedError, type Job } from 'bullmq';

export async function deferBullJob(job: Pick<Job, 'moveToDelayed'>, token: string | undefined, delayMs: number): Promise<never> {
  await job.moveToDelayed(Date.now() + Math.max(1_000, delayMs), token);
  throw new DelayedError();
}
