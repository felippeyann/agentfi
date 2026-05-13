/**
 * A2A payment job finalizer.
 *
 * Issue #81 (Phase 1.5 of #71): the Job lifecycle for paid A2A jobs MUST be
 * driven by the on-chain outcome of the payment transaction, not by the
 * resolution of `executeA2APayment` (which resolves at queue time, before the
 * tx is broadcast). This module is the single source of truth for finalizing
 * a Job once the Transaction worker knows the chain outcome.
 *
 * Called from:
 *   - `queues/transaction.queue.ts` worker post-confirmation handler
 *     (CONFIRMED → COMPLETED, REVERTED/timeout-FAILED → PAYMENT_FAILED).
 *   - `queues/transaction.queue.ts` `worker.on('failed')` after broadcast
 *     retries are exhausted (FAILED → PAYMENT_FAILED).
 *   - `api/routes/jobs.ts` synchronous catch path (auth/policy/sim error
 *     before queueing → PAYMENT_FAILED with no transactionId).
 *
 * Idempotent: only acts when the Job is still in `PAYMENT_PENDING`. Safe to
 * invoke multiple times for the same outcome (e.g. recovery worker re-fires
 * after the original handler already finalized).
 */

import { db } from '../../db/client.js';
import { logger } from '../../api/middleware/logger.js';
import { ReputationService } from '../policy/reputation.service.js';
import {
  releaseJobEscrow,
  markEscrowReleased,
  queueOnChainEscrowRelease,
  queueOnChainEscrowRefund,
} from '../policy/escrow.service.js';
import { notificationService } from '../notification.service.js';
import { resolveRewardUsd } from '../billing/reward-pricing.js';

const reputationService = new ReputationService();

export type A2APaymentOutcome = 'CONFIRMED' | 'FAILED';

export interface FinalizeA2APaymentJobParams {
  jobId: string;
  outcome: A2APaymentOutcome;
  /** Transaction id, when one exists (queued path). Null for pre-queue failures. */
  transactionId: string | null;
  /** Error message for FAILED outcomes (chain revert reason, broadcast error, etc.). */
  reason?: string;
}

export async function finalizeA2APaymentJob(
  params: FinalizeA2APaymentJobParams,
): Promise<void> {
  const { jobId, outcome, transactionId, reason } = params;

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      providerId: true,
      requesterId: true,
      reservationStatus: true,
      reward: true,
      provider: { select: { name: true } },
    },
  });

  if (!job) {
    logger.error({ jobId, outcome }, 'A2A finalizer: job not found');
    return;
  }

  // Idempotency guard: only finalize jobs sitting in PAYMENT_PENDING. If a
  // prior call already moved the job to COMPLETED or PAYMENT_FAILED, this is
  // a no-op (recovery worker re-firing after the original handler succeeded,
  // or duplicate event from BullMQ retries).
  if (job.status !== 'PAYMENT_PENDING') {
    logger.info(
      { jobId, currentStatus: job.status, outcome },
      'A2A finalizer: job not in PAYMENT_PENDING, skipping',
    );
    return;
  }

  const reward =
    job.reward as { amount?: string; token?: string; chainId?: number } | null;
  const amount = reward?.amount ?? '0';
  const token = reward?.token ?? 'ETH';
  const chainId = reward?.chainId ?? 1;
  const providerName = job.provider?.name ?? job.providerId;

  if (outcome === 'CONFIRMED') {
    // Phase 2 of #71 — capture the USD value of the reward at the moment
    // of confirmation. Done BEFORE the status flip so it lands in the same
    // write as `status: 'COMPLETED'`. If the price oracle is unresolved
    // (CoinGecko down, unknown token, malformed amount), we deliberately
    // leave the snapshot columns NULL rather than persisting '0' — that
    // way PnLService can later distinguish "we never priced this" from
    // "the reward was genuinely zero" (free job).
    const snapshot = await resolveRewardUsd(reward);
    if (!snapshot.resolved) {
      logger.warn(
        { jobId, transactionId, reward },
        'A2A finalizer: reward price unresolved at confirmation — snapshot left NULL, PnL will fall back to live pricing',
      );
    }

    // Order matters (mirrors the FAILED branch below): perform side effects
    // first, flip the public Job status last. An observer polling between
    // writes sees either old (PAYMENT_PENDING + PENDING) or new
    // (COMPLETED + RELEASED) state — never an inconsistent intermediate.
    if (job.reservationStatus === 'PENDING') {
      await markEscrowReleased(jobId);
    }

    // Escrow v3: queue on-chain release if EscrowModule is deployed.
    // Fire-and-forget — the DB escrow is already marked RELEASED above;
    // the on-chain release is a best-effort secondary settlement.
    if (chainId) {
      queueOnChainEscrowRelease({ jobId, chainId }).catch((err) =>
        logger.warn(
          { jobId, err: (err as Error)?.message ?? String(err) },
          'On-chain escrow release failed (non-fatal)',
        ),
      );
    }

    await reputationService.recordJobOutcome(job.providerId, true);
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        rewardUsd: snapshot.resolved ? snapshot.usd : null,
        rewardPriceUsd: snapshot.resolved ? snapshot.priceUsd : null,
      },
    });
    logger.info(
      {
        jobId,
        transactionId,
        rewardUsd: snapshot.resolved ? snapshot.usd : null,
        snapshotResolved: snapshot.resolved,
      },
      'A2A finalizer: payment confirmed → COMPLETED',
    );

    notificationService
      .notify({
        type: 'TRANSACTION_CONFIRMED',
        agentId: job.providerId,
        agentName: providerName,
        ...(transactionId ? { transactionId } : {}),
        message: `A2A payment settled: ${amount} ${token} (chain ${chainId}) for job ${jobId}`,
        metadata: {
          jobId,
          requesterId: job.requesterId,
          providerId: job.providerId,
          amount,
          token,
          chainId,
        },
      })
      .catch((notifyErr) =>
        logger.warn(
          { jobId, err: (notifyErr as Error)?.message ?? String(notifyErr) },
          'A2A payment success notification failed (non-fatal)',
        ),
      );
    return;
  }

  // outcome === 'FAILED'
  // Order matters: refund the escrow FIRST, then flip the Job status. The
  // Job status (`PAYMENT_FAILED`) is the public signal everyone polls on
  // (admin dashboard, requester UI, automated tests). If we flipped status
  // first and then refunded, an observer polling between the two writes
  // would see `PAYMENT_FAILED` + `reservationStatus: PENDING` — which is
  // exactly the "ghost completion" symptom #81 was meant to eliminate.
  // By doing the refund first, any in-flight observer either sees the old
  // (`PAYMENT_PENDING` + `PENDING`) or the new (`PAYMENT_FAILED` + `CANCELLED`)
  // state — never an inconsistent intermediate.
  try {
    if (job.reservationStatus === 'PENDING') {
      await releaseJobEscrow(jobId);
    }

    // Escrow v3: queue on-chain refund if EscrowModule is deployed.
    if (chainId) {
      queueOnChainEscrowRefund({ jobId, chainId }).catch((err) =>
        logger.warn(
          { jobId, err: (err as Error)?.message ?? String(err) },
          'On-chain escrow refund failed (non-fatal)',
        ),
      );
    }

    await db.job.update({
      where: { id: jobId },
      data: { status: 'PAYMENT_FAILED' },
    });
  } catch (recoveryErr) {
    logger.error(
      {
        jobId,
        transactionId,
        paymentReason: reason,
        recoveryErr:
          (recoveryErr as Error)?.message ?? String(recoveryErr),
      },
      'A2A finalizer: failed to mark PAYMENT_FAILED / refund — manual reconciliation required',
    );
    return;
  }

  logger.error(
    { jobId, transactionId, reason },
    'A2A finalizer: payment failed → PAYMENT_FAILED, escrow refunded',
  );

  notificationService
    .notify({
      type: 'TRANSACTION_FAILED',
      agentId: job.providerId,
      agentName: providerName,
      ...(transactionId ? { transactionId } : {}),
      message: `A2A payment FAILED: ${amount} ${token} (chain ${chainId}) for job ${jobId}. Escrow refunded to requester. Reason: ${reason ?? 'unknown'}`,
      metadata: {
        jobId,
        requesterId: job.requesterId,
        providerId: job.providerId,
        amount,
        token,
        chainId,
        error: reason,
      },
    })
    .catch((notifyErr) =>
      logger.warn(
        { jobId, err: (notifyErr as Error)?.message ?? String(notifyErr) },
        'A2A payment failure notification failed (non-fatal) — operator may miss this event',
      ),
    );
}
