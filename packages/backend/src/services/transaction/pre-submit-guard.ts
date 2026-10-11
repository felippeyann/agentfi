/**
 * Pre-submit guard — last-chance revalidation before a queued transaction is
 * signed and broadcast.
 *
 * Jobs reach the transaction worker already policy-checked at enqueue time,
 * but the job payload is a snapshot. Between enqueue and pickup the operator
 * may have hit the kill switch (POST /admin/agents/:id/pause), the policy may
 * have been paused or expired, or BullMQ may be redelivering a job whose
 * transaction already got a txHash. None of that is visible in the payload,
 * so the worker re-reads the database here and acts on the current state.
 *
 * Kept free of BullMQ, the `db` singleton and the logger so it can be
 * unit-tested with a mocked Prisma client
 * (see `__tests__/transaction.worker.guard.test.ts`).
 */

import type { PrismaClient } from '@prisma/client';
import { finalizeA2APaymentJob } from '../job/payment-finalizer.service.js';
import { onEscrowTxOutcome, vetBindBeforeBroadcast } from '../job/escrow-erc8183.runtime.js';
import { settleVolumeAfterFailure } from '../policy/daily-volume.js';

export const PAUSED_BEFORE_SUBMISSION = 'Agent paused before submission';
export const POLICY_EXPIRED_BEFORE_SUBMISSION = 'Agent policy expired before submission';
/** C3d: prefix of the error of a `setProviderAgentId` the guard did not broadcast. */
export const BIND_SKIPPED_BEFORE_SUBMISSION = 'setProviderAgentId skipped before submission';

export type PreSubmitDecision =
  /** Transaction is still QUEUED and agent + policy are live — submit it. */
  | { action: 'proceed' }
  /** Transaction already left QUEUED (or has a txHash) — do nothing, do not resubmit. */
  | { action: 'skip'; reason: string }
  /**
   * Agent or policy blocks the transaction. It has been marked FAILED in the
   * DB; the worker must return without submitting and without throwing so
   * BullMQ does not retry it.
   */
  | { action: 'fail'; reason: string; finalizerError?: string };

interface AgentSnapshot {
  active: boolean;
  policy: { active: boolean; expiresAt: Date | null } | null;
}

function resolveBlockReason(agent: AgentSnapshot, now: Date): string | null {
  if (!agent.active) return PAUSED_BEFORE_SUBMISSION;
  if (agent.policy && !agent.policy.active) return PAUSED_BEFORE_SUBMISSION;
  if (agent.policy?.expiresAt && agent.policy.expiresAt < now) {
    return POLICY_EXPIRED_BEFORE_SUBMISSION;
  }
  return null;
}

/**
 * Re-reads the transaction, its agent and the agent's policy in a single
 * Prisma query and decides whether the worker may sign and broadcast.
 *
 * Side effects (only on `fail`): the transaction is updated to FAILED with a
 * descriptive `error`, and — when it is an A2A payment — the Job is finalized
 * as FAILED through the same finalizer the worker's permanent-failure path
 * uses, which refunds the escrow reservation (including its DailyVolume
 * commitment) and flips the Job to PAYMENT_FAILED.
 *
 * An ordinary transaction's DailyVolume reservation (A6) is given back when
 * no earlier attempt reached the broadcast step, and kept (HELD) when one did:
 * that signed transaction may still be mined.
 */
export async function preSubmitGuard(
  db: PrismaClient,
  transactionId: string,
): Promise<PreSubmitDecision> {
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      status: true,
      txHash: true,
      metadata: true,
      agent: {
        select: {
          active: true,
          policy: { select: { active: true, expiresAt: true } },
        },
      },
    },
  });

  if (!tx) {
    return { action: 'skip', reason: 'Transaction not found' };
  }

  // Idempotency guard: a retry or stalled-job redelivery must never
  // re-broadcast a transaction that already left QUEUED.
  if (tx.status !== 'QUEUED' || tx.txHash) {
    const hashNote = tx.txHash ? ` with txHash ${tx.txHash}` : '';
    return { action: 'skip', reason: `Transaction is ${tx.status}${hashNote}` };
  }

  const reason = resolveBlockReason(tx.agent, new Date());
  if (!reason) {
    // C3d (H14 dry-run): the provider's ERC-8004 bind is only valid while the
    // job is live and Funded. It was enqueued at FUNDED; a cancellation (and
    // its refund) may have happened since — then broadcasting it only
    // reverts at the provider's expense. Re-check right before signing.
    const step = (tx.metadata ?? null) as { escrowStep?: string; jobId?: string } | null;
    if (step?.escrowStep === 'bindAgent' && typeof step.jobId === 'string') {
      const skipped = await vetBindBeforeBroadcast(step.jobId);
      if (skipped) {
        const error = `${BIND_SKIPPED_BEFORE_SUBMISSION}: ${skipped}`;
        await db.transaction.update({ where: { id: transactionId }, data: { status: 'FAILED', error } });
        // The binding is already SKIPPED; the outcome only moves the
        // provider's identity lane and releases a submit deferred behind it.
        try {
          await onEscrowTxOutcome({ transactionId, status: 'FAILED', error });
        } catch (err) {
          return { action: 'fail', reason: error, finalizerError: (err as Error)?.message ?? String(err) };
        }
        return { action: 'fail', reason: error };
      }
    }
    return { action: 'proceed' };
  }

  // Conditional (A6): a concurrent delivery may have stamped and broadcast the
  // row since it was read above; then it is not ours to fail.
  const failed = await db.transaction.updateMany({
    where: { id: transactionId, status: 'QUEUED', txHash: null },
    data: { status: 'FAILED', error: reason },
  });
  if (failed.count === 0) {
    return { action: 'skip', reason: 'Transaction left QUEUED while it was being checked' };
  }
  // Released when no attempt reached the broadcast, held otherwise. A failure
  // here must not skip the finalizers below; the recovery sweep settles it.
  await settleVolumeAfterFailure(db, transactionId).catch(() => undefined);

  const meta = (tx.metadata ?? null) as
    | { jobId?: string; a2aPayment?: boolean; erc8183?: boolean }
    | null;
  if (meta?.a2aPayment === true && typeof meta.jobId === 'string') {
    try {
      await finalizeA2APaymentJob({
        jobId: meta.jobId,
        transactionId,
        outcome: 'FAILED',
        reason,
      });
    } catch (err) {
      // The tx is already FAILED, so the money is safe; the payment-recovery
      // worker picks up Jobs left in PAYMENT_PENDING. Report, do not throw.
      const finalizerError = (err as Error)?.message ?? String(err);
      return { action: 'fail', reason, finalizerError };
    }
  } else if (meta?.erc8183 === true) {
    // C3: a blocked ERC-8183 step never reached the chain — unwind the Job
    // (FAILED + reservation release before FUNDED; back to ACCEPTED for submit).
    try {
      await onEscrowTxOutcome({ transactionId, status: 'FAILED', error: reason });
    } catch (err) {
      const finalizerError = (err as Error)?.message ?? String(err);
      return { action: 'fail', reason, finalizerError };
    }
  }

  return { action: 'fail', reason };
}
