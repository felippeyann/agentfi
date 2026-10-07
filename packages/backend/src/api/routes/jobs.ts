import type { FastifyInstance } from 'fastify';
import type { JobStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { logger } from '../middleware/logger.js';
import { publicErrorMessage, sanitizeStoredError } from '../errors/sanitize.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { executeA2APayment } from './transactions.js';
import {
  reserveJobEscrow,
  releaseJobEscrow,
  markEscrowReleased,
  queueOnChainEscrowLock,
} from '../../services/policy/escrow.service.js';
import { finalizeA2APaymentJob } from '../../services/job/payment-finalizer.service.js';
import {
  enqueueSubmit,
  erc8183Config,
  getEscrowToken,
  isErc8183Enabled,
  requestCancellationReject,
  startEscrow,
} from '../../services/job/escrow-erc8183.runtime.js';
import {
  ESCROW_KIND,
  isEscrowTokenReward,
  serializeFeedbackFile,
  toJobResponse,
} from '../../services/job/escrow-erc8183.service.js';
const reputationService = new ReputationService();

const createJobSchema = z.object({
  providerId: z.string().cuid(),
  payload: z.record(z.any()),
  reward: z.object({
    amount: z.string(),
    token: z.string().default('ETH'),
    chainId: z.number().default(1),
  }).optional(),
  signature: z.string().optional(),
});

const updateJobSchema = z.object({
  status: z.enum(['ACCEPTED', 'COMPLETED', 'FAILED', 'CANCELLED']),
  result: z.record(z.any()).optional(),
  error: z.string().optional(),
});

const contestJobSchema = z.object({
  reason: z.string().max(500).optional(),
});

/** Valid status transitions for jobs */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING:  ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['COMPLETED', 'FAILED', 'CANCELLED'],
};

/**
 * Full error text — for logs and the DB columns operators read. A response
 * carries `publicErrorMessage(err)` instead (S5): a viem error's message
 * holds the RPC URL with the provider key in its path.
 */
function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export async function jobRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/jobs — create a new service request (job) for another agent.
   *
   * On a chain where the ERC-8183 escrow is configured (C3), a paid job is
   * USDC-only (decision D8) and its budget is escrowed on-chain through
   * `AgentJobEscrow`: the requester's wallet runs createJob → setBudget →
   * approve → fund from the transaction queue, and the Job reports progress
   * in `escrow.onChainStatus`. Everywhere else the legacy (DB reservation +
   * optional EscrowModule lock) path is unchanged.
   */
  fastify.post('/v1/jobs', async (request, reply) => {
    const body = createJobSchema.parse(request.body);

    // Logic Sentinel: Verify provider exists and is active
    const provider = await db.agent.findUnique({
      where: { id: body.providerId, active: true },
    });
    if (!provider) return reply.code(404).send({ error: 'Provider agent not found or inactive' });

    const rewardChainId = body.reward?.chainId ?? 1;
    const rewardToken = body.reward?.token ?? 'ETH';
    const useErc8183 = Boolean(body.reward?.amount) && isErc8183Enabled(rewardChainId);

    let requester: { id: string; walletId: string; safeAddress: string } | null = null;
    if (useErc8183) {
      // ERC-8183: the contract rejects provider == client and provider == evaluator.
      if (provider.id === request.agentId) {
        return reply.code(400).send({
          error: 'ERC8183_PROVIDER_IS_REQUESTER',
          message: 'An escrowed job cannot name its requester as the provider',
        });
      }
      if (
        erc8183Config.evaluatorAddress &&
        provider.safeAddress.toLowerCase() === erc8183Config.evaluatorAddress.toLowerCase()
      ) {
        return reply.code(400).send({
          error: 'ERC8183_PROVIDER_IS_EVALUATOR',
          message: 'An escrowed job cannot name the evaluator signer as the provider',
        });
      }

      // Decision D8: USDC only on escrow chains.
      let escrowToken: string;
      try {
        escrowToken = await getEscrowToken(rewardChainId);
      } catch (err) {
        logger.error({ chainId: rewardChainId, err: errorMessage(err) }, 'ERC-8183 escrow token unavailable');
        return reply.code(503).send({ error: 'ERC8183_UNAVAILABLE', message: publicErrorMessage(err) });
      }
      if (!isEscrowTokenReward(rewardToken, escrowToken)) {
        return reply.code(400).send({
          error: 'ERC8183_USDC_ONLY',
          message: `Jobs on chain ${rewardChainId} are escrowed in USDC; set reward.token to "USDC" or ${escrowToken}`,
          chainId: rewardChainId,
          escrowToken,
        });
      }

      requester = await db.agent.findUnique({
        where: { id: request.agentId },
        select: { id: true, walletId: true, safeAddress: true },
      });
      if (!requester) return reply.code(404).send({ error: 'Requester agent not found' });
    }

    // v2 Escrow: if reward is specified, reserve funds before creating the job.
    // This prevents requesters from creating paid jobs they can't honor.
    let reservedAt: Date | null = null;
    if (body.reward?.amount) {
      const reservation = await reserveJobEscrow({
        requesterId: request.agentId,
        reward: {
          amount: body.reward.amount,
          token: rewardToken,
          chainId: rewardChainId,
        },
      });
      if (!reservation.success) {
        return reply.code(400).send({
          error: 'Escrow reservation failed',
          reason: reservation.reason,
        });
      }
      reservedAt = new Date();
    }

    const job = await db.job.create({
      data: {
        requesterId: request.agentId,
        providerId: body.providerId,
        payload: body.payload,
        reward: body.reward ?? {},
        signature: body.signature ?? null,
        status: 'PENDING',
        ...(body.reward?.amount && reservedAt
          ? {
              reservedAmount: body.reward.amount,
              reservedToken: rewardToken,
              reservedChainId: rewardChainId,
              reservedAt,
              reservationStatus: 'PENDING',
            }
          : {}),
      },
    });

    if (useErc8183 && requester && body.reward?.amount) {
      try {
        await startEscrow({
          job: { id: job.id },
          requester,
          provider: { safeAddress: provider.safeAddress },
          amount: body.reward.amount,
          chainId: rewardChainId,
        });
      } catch (err) {
        // Nothing reached the chain: fail the job, give the reservation back
        // and tell the caller — a PENDING job that can never be funded is a trap.
        const reason = `startEscrow failed: ${errorMessage(err)}`;
        await db.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', onChainStatus: 'FAILED', escrowError: reason },
        });
        await releaseJobEscrow(job.id).catch((releaseErr) =>
          logger.error({ jobId: job.id, err: errorMessage(releaseErr) }, 'ERC-8183 start failed AND reservation release failed'),
        );
        logger.error({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 escrow could not be started');
        return reply.code(503).send({ error: 'ERC8183_START_FAILED', jobId: job.id, reason: publicErrorMessage(err) });
      }
    } else if (body.reward?.amount && reservedAt) {
      // Escrow v3: queue on-chain lock if EscrowModule is deployed on the target chain.
      // Fire-and-forget — the DB reservation is already committed above.
      queueOnChainEscrowLock({
        jobId: job.id,
        requesterId: request.agentId,
        providerAddress: provider.safeAddress as `0x${string}`,
        amount: body.reward.amount,
        token: rewardToken,
        chainId: rewardChainId,
      }).catch((err) =>
        logger.warn(
          { jobId: job.id, err: errorMessage(err) },
          'On-chain escrow lock failed (non-fatal, DB reservation still holds)',
        ),
      );
    }

    logger.info(
      {
        jobId: job.id,
        requesterId: request.agentId,
        providerId: body.providerId,
        escrowed: Boolean(body.reward?.amount),
        erc8183: useErc8183,
      },
      'A2A Job Created',
    );
    const created = useErc8183 ? await db.job.findUnique({ where: { id: job.id } }) : null;
    return reply.code(201).send(toJobResponse(created ?? job));
  });

  /**
   * GET /v1/jobs/inbox — fetch jobs assigned to the current agent.
   */
  fastify.get('/v1/jobs/inbox', async (request) => {
    const jobs = await db.job.findMany({
      where: { providerId: request.agentId },
      include: { requester: { select: { id: true, name: true, safeAddress: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { jobs: jobs.map(toJobResponse) };
  });

  /**
   * GET /v1/jobs/outbox — fetch jobs created by the current agent.
   */
  fastify.get('/v1/jobs/outbox', async (request) => {
    const jobs = await db.job.findMany({
      where: { requesterId: request.agentId },
      include: { provider: { select: { id: true, name: true, safeAddress: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { jobs: jobs.map(toJobResponse) };
  });

  /**
   * PATCH /v1/jobs/:id — update job status (Accept, Complete, Fail).
   */
  fastify.patch<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const body = updateJobSchema.parse(request.body);

    const job = await db.job.findUnique({
      where: { id: request.params.id }
    });

    if (!job) return reply.code(404).send({ error: 'Job not found' });

    // Logic Sentinel: Only the provider can accept/complete; only requester/provider can cancel.
    const isProvider = job.providerId === request.agentId;
    const isRequester = job.requesterId === request.agentId;

    if (!isProvider && !isRequester) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    if (body.status === 'ACCEPTED' || body.status === 'COMPLETED' || body.status === 'FAILED') {
      if (!isProvider) return reply.code(403).send({ error: 'Only provider can update this status' });
    }

    // Logic Sentinel: Validate status transition
    const allowed = VALID_TRANSITIONS[job.status as string];
    if (!allowed || !allowed.includes(body.status)) {
      return reply.code(400).send({
        error: `Invalid status transition from ${job.status} to ${body.status}`,
      });
    }

    const isErc8183 = job.escrowKind === ESCROW_KIND;

    // C3: a provider may only accept an escrowed job once the budget is
    // locked on-chain — otherwise it would work for a job nobody funded.
    if (body.status === 'ACCEPTED' && isErc8183 && job.onChainStatus !== 'FUNDED') {
      return reply.code(409).send({
        error: 'ESCROW_NOT_FUNDED',
        message: `Job is not funded on-chain yet (onChainStatus=${job.onChainStatus ?? 'unknown'})`,
        onChainStatus: job.onChainStatus,
        escrowError: sanitizeStoredError(job.escrowError),
      });
    }

    // Issue #71 — A2A revenue integrity (see docs/project/issue-71-a2a-revenue-integrity.md).
    // For paid completions we no longer flip straight to COMPLETED. We move to
    // PAYMENT_PENDING, fire the on-chain transfer, and only finalize as COMPLETED
    // (with reputation + escrow release) when the transfer confirms. This keeps
    // ghost completions out of the PnL dashboard.
    const reward =
      job.reward as { amount?: string; token?: string; chainId?: number } | null;
    const isPaidCompletion = body.status === 'COMPLETED' && Boolean(reward?.amount);

    const persistedStatus: JobStatus = isPaidCompletion ? 'PAYMENT_PENDING' : body.status;

    const updatedJob = await db.job.update({
      where: { id: request.params.id },
      data: {
        status: persistedStatus,
        ...(body.result !== undefined ? { result: body.result } : {}),
      },
    });

    if (isPaidCompletion && isErc8183) {
      // C3: the provider's wallet calls `submit(jobId, keccak256(result))`;
      // the evaluator settles from the settlement queue once it confirms.
      // A synchronous failure here leaves the Job ACCEPTED (retryable).
      try {
        await enqueueSubmit({ jobId: job.id, result: body.result });
      } catch (err) {
        const reason = `submit could not be enqueued: ${errorMessage(err)}`;
        await db.job.update({ where: { id: job.id }, data: { status: 'ACCEPTED', escrowError: reason } });
        logger.error({ jobId: job.id, err: errorMessage(err) }, 'ERC-8183 submit enqueue failed — job returned to ACCEPTED');
        return reply.code(503).send({ error: 'ESCROW_SUBMIT_FAILED', reason: publicErrorMessage(err) });
      }
    } else if (isPaidCompletion) {
      // Issue #81 (Phase 1.5 of #71): the Job lifecycle is finalized by the
      // Transaction worker once the on-chain outcome is known — see
      // queues/transaction.queue.ts and services/job/payment-finalizer.service.ts.
      // Here we only need to (a) verify the provider exists, (b) hand off to
      // executeA2APayment, and (c) handle synchronous failures (auth, policy,
      // simulation, db) that prevent the tx from ever being queued.
      const provider = await db.agent.findUnique({
        where: { id: job.providerId },
        select: { safeAddress: true },
      });
      if (!provider) {
        // Defensive: provider record vanished between job creation and completion.
        // Refund the requester and bail without firing payment.
        await db.job.update({
          where: { id: job.id },
          data: { status: 'PAYMENT_FAILED' },
        });
        if (job.reservationStatus === 'PENDING') {
          await releaseJobEscrow(job.id);
        }
        logger.error(
          { jobId: job.id, providerId: job.providerId },
          'A2A payment skipped — provider record missing; job marked PAYMENT_FAILED',
        );
        return reply.code(409).send({ error: 'Provider record missing; payment aborted' });
      }

      // Capture reward fields locally; reward is non-null here (isPaidCompletion).
      const amount = reward!.amount as string;
      const token = reward!.token ?? 'ETH';
      const chainId = reward!.chainId ?? 1;

      executeA2APayment({
        requesterId: job.requesterId,
        providerSafeAddress: provider.safeAddress,
        amount,
        token,
        chainId,
        jobId: job.id,
        // Issue #74: deterministic key keyed on jobId. The recovery worker
        // (#73) re-invokes with the same key after a crash and gets back
        // the original tx instead of double-spending.
        intentId: `a2a-payment:${job.id}`,
      })
        .then((result) => {
          // Tx queued (or PENDING_APPROVAL) — the worker now owns the Job
          // lifecycle. Do NOT update Job state here: this resolves at queue
          // time, not on-chain confirmation (#81 root cause).
          logger.info(
            { jobId: job.id, paymentTxId: result.transactionId, status: result.status },
            'A2A payment dispatched; awaiting worker finalization',
          );
        })
        .catch((err) => {
          // Synchronous pre-queue failure (auth, policy denied, simulation
          // failed, db error). No Transaction row may exist; the worker will
          // never run for this job. Finalize as PAYMENT_FAILED inline.
          finalizeA2APaymentJob({
            jobId: job.id,
            transactionId: null,
            outcome: 'FAILED',
            reason: err?.message ?? String(err),
          }).catch((finalizeErr) =>
            logger.error(
              {
                jobId: job.id,
                paymentErr: err?.message ?? String(err),
                finalizeErr:
                  (finalizeErr as Error)?.message ?? String(finalizeErr),
              },
              'A2A payment failed AND finalizer failed — manual reconciliation required',
            ),
          );
        });
    } else if (body.status === 'COMPLETED') {
      // Free job (no reward) — completes synchronously, same as before.
      await reputationService.recordJobOutcome(job.providerId, true);
      if (job.reservationStatus === 'PENDING') {
        await markEscrowReleased(job.id);
      }
    } else if (body.status === 'FAILED' || body.status === 'CANCELLED') {
      // v2 Escrow: release reservation, return daily volume credit to requester
      if (job.reservationStatus === 'PENDING') {
        await releaseJobEscrow(job.id);
      }
      if (body.status === 'FAILED') {
        await reputationService.recordJobOutcome(job.providerId, false);
      }
      if (isErc8183) {
        // C3: unwind a budget that is already locked on-chain through the
        // evaluator (`reject` → full refund). Before FUNDED the step chain
        // stops by itself; a `fund` that confirms later schedules the reject.
        await requestCancellationReject({
          jobId: job.id,
          reason: body.status === 'CANCELLED' ? 'cancelled' : 'provider-failed',
        }).catch((err) =>
          logger.error(
            { jobId: job.id, err: errorMessage(err) },
            'ERC-8183 cancellation reject could not be scheduled — expiry sweep will refund after expiresAt',
          ),
        );
      }
    }

    logger.info({ jobId: job.id, status: persistedStatus }, 'A2A Job Updated');
    if (isErc8183) {
      const fresh = await db.job.findUnique({ where: { id: job.id } });
      return toJobResponse(fresh ?? updatedJob);
    }
    return toJobResponse(updatedJob);
  });

  /**
   * POST /v1/jobs/:id/contest — requester disputes a submitted deliverable
   * before the evaluator settles (C3). Allowed while the job is
   * PAYMENT_PENDING, the deliverable is SUBMITTED on-chain and no settlement
   * has been claimed (`onChainStatus` still SUBMITTED). The evaluator then
   * sends `reject` (full refund) instead of `complete`.
   */
  fastify.post<{ Params: { id: string } }>('/v1/jobs/:id/contest', async (request, reply) => {
    const body = contestJobSchema.parse(request.body ?? {});
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      select: { id: true, requesterId: true, escrowKind: true, status: true, onChainStatus: true, contestedAt: true },
    });
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    if (job.requesterId !== request.agentId) {
      return reply.code(403).send({ error: 'Only the requester can contest a job' });
    }
    if (job.escrowKind !== ESCROW_KIND) {
      return reply.code(409).send({ error: 'NOT_ESCROW_JOB', message: 'Only ERC-8183 escrowed jobs can be contested' });
    }

    // Conditional write: the settlement worker claims the job by flipping
    // SUBMITTED → SETTLING, so exactly one of (contest, settle) wins.
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', contestedAt: null },
      data: { contestedAt: new Date(), contestReason: body.reason ?? null },
    });
    if (claimed.count === 0) {
      return reply.code(409).send({
        error: 'CONTEST_NOT_ALLOWED',
        message: 'A job can only be contested while PAYMENT_PENDING, SUBMITTED on-chain and not yet settled',
        status: job.status,
        onChainStatus: job.onChainStatus,
        contestedAt: job.contestedAt,
      });
    }

    logger.warn({ jobId: job.id, requesterId: request.agentId, reason: body.reason }, 'ERC-8183 job contested by requester');
    const fresh = await db.job.findUnique({ where: { id: job.id } });
    return toJobResponse(fresh!);
  });

  /**
   * GET /v1/jobs/:id/feedback.json — public ERC-8004 feedback file (C3/R3).
   * Served byte-for-byte as it was hashed into the `complete`/`reject`
   * `optParams` (`keccak256(body) == feedbackHash` emitted by the hook).
   * 404 until the settlement worker has generated it.
   */
  fastify.get<{ Params: { id: string } }>('/v1/jobs/:id/feedback.json', async (request, reply) => {
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      select: { feedbackFile: true },
    });
    if (!job || !job.feedbackFile) {
      return reply.code(404).send({ error: 'Feedback file not available for this job' });
    }
    return reply
      .code(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(serializeFeedbackFile(job.feedbackFile as Record<string, unknown>));
  });

  /**
   * GET /v1/jobs/:id — fetch single job details.
   */
  fastify.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = await db.job.findUnique({
      where: { id: request.params.id },
      include: {
        requester: { select: { id: true, name: true, safeAddress: true } },
        provider: { select: { id: true, name: true, safeAddress: true } }
      }
    });

    if (!job) return reply.code(404).send({ error: 'Job not found' });

    if (job.requesterId !== request.agentId && job.providerId !== request.agentId) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    return toJobResponse(job);
  });
}
