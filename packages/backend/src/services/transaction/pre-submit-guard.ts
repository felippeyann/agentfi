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
import { settleVolumeAfterFailure, stopStampedTransaction } from '../policy/daily-volume.js';
import { escrowConfigGate } from '../../config/escrow-verification.runtime.js';
import { policyStackGate } from '../../config/policy-stack-verification.runtime.js';
import { getContracts } from '../../config/contracts.js';
import {
  desiredOnChainPolicy,
  policySyncMetadataOf,
  supersededReason,
  type PolicySyncMetadata,
} from '../policy/policy-sync.js';

export const PAUSED_BEFORE_SUBMISSION = 'Agent paused before submission';
export const POLICY_EXPIRED_BEFORE_SUBMISSION = 'Agent policy expired before submission';
/** A6b: suffix of a block on a row an earlier attempt was stamped for: handed to the chain, not FAILED. */
export const OUTCOME_LEFT_TO_CHAIN = 'not signed again; an earlier signed attempt was stamped for broadcast, its outcome is left to the chain';
/** A6b: an A2A payment stamped without a recorded hash (before migration 0024) is not refunded. */
export const PAYMENT_OUTCOME_UNKNOWN =
  'an earlier attempt was stamped for broadcast without a recorded hash: the payment may still be mined, so the job is left PAYMENT_PENDING (not refunded) for reconciliation';
/** C3d: prefix of the error of a `setProviderAgentId` the guard did not broadcast. */
export const BIND_SKIPPED_BEFORE_SUBMISSION = 'setProviderAgentId skipped before submission';
/** S8: prefix of the error of an on-chain policy-sync call the stored policy no longer matches. */
export const POLICY_SYNC_SUPERSEDED = 'Policy sync superseded before submission';

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
  | { action: 'fail'; reason: string; finalizerError?: string }
  /**
   * Q7: an escrow-dependent transaction (`metadata.erc8183`) whose chain's
   * on-chain configuration is not verified in this process. NOTHING was
   * written: the row stays QUEUED, no broadcast attempt is stamped, nothing is
   * failed or unwound. The worker re-queues the job after `delayMs` without
   * consuming an attempt.
   */
  | { action: 'defer'; reason: string; delayMs: number };

interface AgentSnapshot {
  active: boolean;
  policy: { active: boolean; expiresAt: Date | null } | null;
}

/**
 * Q7 — scope (owner, 2026-10-14): only transactions that depend on the
 * verified ERC-8183 configuration are gated: the rows the escrow orchestrator
 * creates (`metadata.erc8183 === true`: createJob / setBudget / approve /
 * fund / submit, and the provider's ERC-8004 register / setProviderAgentId).
 * Ordinary transfers, swaps and DeFi calls on the same chain never depend on
 * it and are never deferred. Returns the `defer` decision, or null to go on.
 */
function escrowConfigDeferral(tx: { chainId: number; metadata: unknown }): PreSubmitDecision | null {
  if ((tx.metadata as { erc8183?: unknown } | null)?.erc8183 !== true) return null;
  const gate = escrowConfigGate(tx.chainId);
  if (gate.allowed) return null;
  return { action: 'defer', reason: gate.reason, delayMs: gate.retryAfterSeconds * 1000 };
}

/**
 * S9 — a transaction that gives the chain's AgentExecutor / AgentPolicyModule
 * value or authority (routed through the executor: `queuePayload.routedViaExecutor`;
 * or an on-chain policy sync) waits while this process has not verified them
 * against this build (`policyStackGate`). Nothing is written: the row stays
 * QUEUED and the job comes back after the re-check interval, no attempt
 * consumed. Returns the `defer` decision, or null to go on.
 */
function contractsDeferral(tx: { chainId: number; metadata: unknown }, isPolicySync: boolean): PreSubmitDecision | null {
  const routed = (tx.metadata as { queuePayload?: { routedViaExecutor?: unknown } } | null)?.queuePayload?.routedViaExecutor === true;
  if (!routed && !isPolicySync) return null;
  const gate = policyStackGate(tx.chainId);
  if (gate.allowed) return null;
  return { action: 'defer', reason: gate.reason, delayMs: gate.retryAfterSeconds * 1000 };
}

/** What `recheckBeforeBroadcast` found: the send must not happen now. */
export type BroadcastRecheck =
  /** A policy-sync call the stored policy has moved past: the processor FAILs the row. */
  | { kind: 'superseded'; reason: string }
  /** The row's on-chain configuration is no longer verified: the processor DEFERS the job. */
  | { kind: 'defer'; reason: string; delayMs: number };

/**
 * The guard runs before the submitter takes the wallet lane, reads the chain
 * and signs. What it checked can change in that window, so the processor
 * calls this from `onBeforeBroadcast` — inside the lane, after signing,
 * before anything is stamped or sent — and acts on it:
 *  - #179 review P2-2: a policy change landing in between (a pause after a
 *    queued `resume`…) supersedes a policy-sync call → `superseded`;
 *  - #182 review: the verification the guard relied on expired or was
 *    revoked (a failed re-check) → `defer`, with the guard's scope: Q7 for
 *    escrow / ERC-8004 steps, S9 for executor-routed transactions and
 *    policy syncs. Ordinary transactions never wait on either.
 * Null: the send may go ahead. The order is the guard's: superseded first.
 */
export async function recheckBeforeBroadcast(db: PrismaClient, transactionId: string): Promise<BroadcastRecheck | null> {
  const row = await db.transaction.findUnique({ where: { id: transactionId }, select: { chainId: true, metadata: true } });
  if (!row) return null;
  const sync = policySyncMetadataOf(row.metadata);
  if (sync) {
    const superseded = await policySyncBlockReason(db, transactionId, row.chainId, sync);
    if (superseded) return { kind: 'superseded', reason: superseded };
  }
  const deferred = sync ? contractsDeferral(row, true) : (escrowConfigDeferral(row) ?? contractsDeferral(row, false));
  return deferred?.action === 'defer' ? { kind: 'defer', reason: deferred.reason, delayMs: deferred.delayMs } : null;
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
 * S8 — an on-chain policy-sync call (`metadata.policySync`, queued only by the
 * admin sync / kill switch, sent from the agent's own wallet straight to the
 * module). It is NOT blocked by a pause or an expiry: pushing the pause to the
 * chain is the point of the kill switch. Instead it is re-derived from the
 * policy stored NOW and refused when the DB moved on after it was queued (a
 * later change, a resume after a pause, another module configured), so what
 * is signed always moves the module towards the current stored policy and a
 * stale call never undoes a newer one.
 */
async function policySyncBlockReason(
  db: PrismaClient,
  transactionId: string,
  chainId: number,
  sync: PolicySyncMetadata,
): Promise<string | null> {
  const row = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      agent: {
        select: {
          safeAddress: true,
          active: true,
          policy: {
            select: { maxValuePerTxEth: true, cooldownSeconds: true, active: true, expiresAt: true, allowedContracts: true, allowedTokens: true },
          },
        },
      },
    },
  });
  const agent = row?.agent;
  if (!agent?.policy) return `${POLICY_SYNC_SUPERSEDED}: the agent has no stored policy any more`;
  let configured: string | undefined;
  try {
    configured = getContracts(chainId).policyModule;
  } catch {
    configured = undefined;
  }
  if (!configured || configured.toLowerCase() !== sync.module.toLowerCase()) {
    return `${POLICY_SYNC_SUPERSEDED}: queued for module ${sync.module}, the configured module is now ${configured ?? 'none'}`;
  }
  const derived = desiredOnChainPolicy({ safeAddress: agent.safeAddress, agentActive: agent.active, policy: agent.policy });
  if (!derived.ok) {
    return `${POLICY_SYNC_SUPERSEDED}: the stored policy can no longer be held by the module (${derived.problems.join('; ')})`;
  }
  const why = supersededReason(sync, derived.desired);
  return why ? `${POLICY_SYNC_SUPERSEDED}: ${why}` : null;
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
 *
 * A6b: a blocked row an earlier attempt was stamped for (a retry after a
 * failed send, or a redelivery racing the delivery that sent it) is not
 * FAILED: it is handed to the chain — SUBMITTED with the stamped hash, the
 * decision is `skip` — and nothing is settled or finalized here; the receipt
 * (or the re-poll's drop) decides. 6d (C3e): ERC-8183 / ERC-8004 steps are
 * handed to the chain the same way (they used to keep the FAILED path).
 *
 * S8: an on-chain policy-sync call (`metadata.policySync`) is not blocked by
 * a pause or an expiry; it is re-derived from the stored policy instead and
 * FAILED as superseded when the DB moved on (`policySyncBlockReason`).
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
      chainId: true,
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

  // S8: a policy-sync call is judged against the stored policy, not the pause.
  const sync = policySyncMetadataOf(tx.metadata);
  const reason = sync
    ? await policySyncBlockReason(db, transactionId, tx.chainId, sync)
    : resolveBlockReason(tx.agent, new Date());
  if (!reason && sync) return contractsDeferral(tx, true) ?? { action: 'proceed' };
  if (!reason) {
    // Q7: an escrow-dependent step waits while its chain is unverified.
    const deferred = escrowConfigDeferral(tx) ?? contractsDeferral(tx, false);
    if (deferred) return deferred;
    // C3d (H14 dry-run): the provider's ERC-8004 bind is only valid while the
    // job is live and Funded. It was enqueued at FUNDED; a cancellation (and
    // its refund) may have happened since — then broadcasting it only
    // reverts at the provider's expense. Re-check right before signing.
    const step = (tx.metadata ?? null) as { escrowStep?: string; jobId?: string } | null;
    if (step?.escrowStep === 'bindAgent' && typeof step.jobId === 'string') {
      const skipped = await vetBindBeforeBroadcast(step.jobId);
      if (skipped) {
        const error = `${BIND_SKIPPED_BEFORE_SUBMISSION}: ${skipped}`;
        // C3e item 4: conditional like every other stop of a row (A6 / A6b).
        // The vet reads the job and the chain; a concurrent delivery of the
        // same job may have broadcast the bind meanwhile (SUBMITTED + hash —
        // left to its own outcome), or an earlier attempt of this row was
        // stamped (handed to the chain, never FAILED while it may mine).
        const stopped = await db.transaction.updateMany({
          where: { id: transactionId, status: 'QUEUED', txHash: null, broadcastAttemptedAt: null },
          data: { status: 'FAILED', error },
        });
        if (stopped.count === 0) {
          const stop = await stopStampedTransaction(db, transactionId, error, { handToChain: true });
          if (stop.outcome === 'not-queued') {
            return { action: 'skip', reason: 'Transaction left QUEUED while it was being checked' };
          }
          if (stop.outcome === 'handed-to-chain') {
            return { action: 'skip', reason: `${error}: ${OUTCOME_LEFT_TO_CHAIN} (${stop.txHash})` };
          }
          // Stamped before migration 0024 (no hash to hand over): FAILED as before.
        }
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

  const meta = (tx.metadata ?? null) as
    | { jobId?: string; a2aPayment?: boolean; erc8183?: boolean }
    | null;
  // A6b: once a signed attempt was stamped for broadcast, the chain decides
  // its outcome, not this guard. 6d (C3e): ERC-8183 / ERC-8004 steps too — the
  // orchestrator's chain read cannot see a step that is still in a mempool
  // (a pending `fund` reads as Open, a pending `submit` as Funded), so FAILED
  // there unwound a job whose budget then locked (reservation released) or
  // handed a delivered job back to ACCEPTED (cancellable, refunded).

  // Conditional (A6): a concurrent delivery may have stamped and broadcast the
  // row since it was read above; then it is not ours to fail.
  const failed = await db.transaction.updateMany({
    where: { id: transactionId, status: 'QUEUED', txHash: null, broadcastAttemptedAt: null },
    data: { status: 'FAILED', error: reason },
  });
  let broadcastAttempted = false;
  if (failed.count === 0) {
    // Not a never-stamped QUEUED row: stamped (an earlier attempt threw after
    // its stamp, or another delivery is between its send and its SUBMITTED
    // write), or no longer QUEUED. Nothing is signed again either way.
    const stop = await stopStampedTransaction(db, transactionId, reason, { handToChain: true });
    if (stop.outcome === 'not-queued') {
      return { action: 'skip', reason: 'Transaction left QUEUED while it was being checked' };
    }
    if (stop.outcome === 'handed-to-chain') {
      return { action: 'skip', reason: `${reason}: ${OUTCOME_LEFT_TO_CHAIN} (${stop.txHash})` };
    }
    // Stamped before migration 0024 (no hash to hand over): FAILED, held below.
    broadcastAttempted = stop.broadcastAttempted;
  }
  // Released when no attempt reached the broadcast, held otherwise. A failure
  // here must not skip the finalizers below; the recovery sweep settles it.
  await settleVolumeAfterFailure(db, transactionId).catch(() => undefined);

  if (meta?.a2aPayment === true && typeof meta.jobId === 'string' && broadcastAttempted) {
    // The payment may still be mined: no refund, the job stays PAYMENT_PENDING
    // (the recovery scan leaves a stamped FAILED payment alone too).
    return { action: 'fail', reason: `${reason}; ${PAYMENT_OUTCOME_UNKNOWN}` };
  }
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
