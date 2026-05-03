import type { FastifyInstance } from 'fastify';
import type { JobStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { logger } from '../middleware/logger.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { executeA2APayment } from './transactions.js';
import {
  reserveJobEscrow,
  releaseJobEscrow,
  markEscrowReleased,
} from '../../services/policy/escrow.service.js';
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

/** Valid status transitions for jobs */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING:  ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['COMPLETED', 'FAILED', 'CANCELLED'],
};

export async function jobRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/jobs — create a new service request (job) for another agent.
   */
  fastify.post('/v1/jobs', async (request, reply) => {
    const body = createJobSchema.parse(request.body);

    // Logic Sentinel: Verify provider exists and is active
    const provider = await db.agent.findUnique({
      where: { id: body.providerId, active: true },
    });
    if (!provider) return reply.code(404).send({ error: 'Provider agent not found or inactive' });

    // v2 Escrow: if reward is specified, reserve funds before creating the job.
    // This prevents requesters from creating paid jobs they can't honor.
    let reservedAt: Date | null = null;
    if (body.reward?.amount) {
      const reservation = await reserveJobEscrow({
        requesterId: request.agentId,
        reward: {
          amount: body.reward.amount,
          token: body.reward.token ?? 'ETH',
          chainId: body.reward.chainId ?? 1,
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
              reservedToken: body.reward.token ?? 'ETH',
              reservedChainId: body.reward.chainId ?? 1,
              reservedAt,
              reservationStatus: 'PENDING',
            }
          : {}),
      },
    });

    logger.info(
      {
        jobId: job.id,
        requesterId: request.agentId,
        providerId: body.providerId,
        escrowed: Boolean(body.reward?.amount),
      },
      'A2A Job Created',
    );
    return reply.code(201).send(job);
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
    return { jobs };
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
    return { jobs };
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

    if (isPaidCompletion) {
      // Two-phase completion: side effects (reputation, escrow release, final
      // COMPLETED status) only run inside the payment promise's resolution
      // handlers, never before the on-chain transfer is settled.
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
      })
        .then(async (result) => {
          // Payment confirmed → finalize: COMPLETED + reputation + escrow released.
          await db.job.update({
            where: { id: job.id },
            data: { status: 'COMPLETED' },
          });
          await reputationService.recordJobOutcome(job.providerId, true);
          if (job.reservationStatus === 'PENDING') {
            await markEscrowReleased(job.id);
          }
          logger.info(
            { jobId: job.id, paymentTxId: result.transactionId },
            'A2A payment confirmed → COMPLETED',
          );
        })
        .catch(async (err) => {
          // Payment failed → mark PAYMENT_FAILED + refund escrow to requester.
          // No reputation update: provider does not get credit for an unpaid job.
          try {
            await db.job.update({
              where: { id: job.id },
              data: { status: 'PAYMENT_FAILED' },
            });
            if (job.reservationStatus === 'PENDING') {
              await releaseJobEscrow(job.id);
            }
          } catch (recoveryErr) {
            logger.error(
              {
                jobId: job.id,
                paymentErr: err?.message ?? String(err),
                recoveryErr:
                  (recoveryErr as Error)?.message ?? String(recoveryErr),
              },
              'A2A payment failed AND status/escrow recovery failed — manual reconciliation required',
            );
            return;
          }
          logger.error(
            { jobId: job.id, err: err?.message ?? String(err) },
            'A2A payment failed → PAYMENT_FAILED, escrow refunded',
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
    }

    logger.info({ jobId: job.id, status: persistedStatus }, 'A2A Job Updated');
    return updatedJob;
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

    return job;
  });
}
