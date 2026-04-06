import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { logger } from '../middleware/logger.js';
import { ReputationService } from '../../services/policy/reputation.service.js';

const db = new PrismaClient();
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

export async function jobRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/jobs — create a new service request (job) for another agent.
   */
  fastify.post('/v1/jobs', async (request, reply) => {
    const body = createJobSchema.parse(request.body);
    
    // Logic Sentinel: Verify provider exists and is active
    const provider = await db.agent.findUnique({
      where: { id: body.providerId, active: true }
    });
    if (!provider) return reply.code(404).send({ error: 'Provider agent not found or inactive' });

    const job = await db.job.create({
      data: {
        requesterId: request.agentId,
        providerId: body.providerId,
        payload: body.payload,
        reward: body.reward ?? {},
        signature: body.signature,
        status: 'PENDING',
      },
    });

    logger.info({ jobId: job.id, requesterId: request.agentId, providerId: body.providerId }, 'A2A Job Created');
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

    const updatedJob = await db.job.update({
      where: { id: request.params.id },
      data: {
        status: body.status,
        result: body.result,
      },
    });

    // Logic Sentinel: Automatically update reputation on outcome
    if (body.status === 'COMPLETED') {
      await reputationService.recordJobOutcome(job.providerId, true);
    } else if (body.status === 'FAILED') {
      await reputationService.recordJobOutcome(job.providerId, false);
    }

    logger.info({ jobId: job.id, status: body.status }, 'A2A Job Updated');
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
