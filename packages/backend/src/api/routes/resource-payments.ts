/**
 * POST /v1/jobs/:id/pay-resource — pay an x402 (HTTP 402) resource from a
 * job's remaining reward budget (execution plan task P2).
 *
 * The caller must be the job's PROVIDER (it pays with its own USDC); the
 * job must be ACCEPTED. Every attempt is a durable `ResourcePayment` row —
 * the state machine and the idempotency rules live in
 * `services/payments/resource-payment.service.ts`.
 *
 * Kept in its own file (not `jobs.ts`) so it can be reviewed and rebased
 * independently of the job lifecycle routes.
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getWalletService } from '../../services/wallet/index.js';
import { X402ClientService } from '../../services/payments/x402-client.service.js';
import {
  ResourcePaymentError,
  ResourcePaymentService,
} from '../../services/payments/resource-payment.service.js';

/** Same constraint as `@x402/extensions` `isValidPaymentId`: 16–128 chars of `[A-Za-z0-9_-]`. */
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const payResourceSchema = z
  .object({
    url: z.string().min(1).max(2048),
    method: z.enum(['GET', 'POST']).default('GET'),
    body: z.unknown().optional(),
    maxAmount: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, 'must be a plain USDC amount with at most 6 decimals, e.g. "0.50"')
      .optional(),
    paymentId: z.string().regex(PAYMENT_ID_PATTERN, 'must be 16-128 chars of [A-Za-z0-9_-]').optional(),
  })
  .refine((body) => body.method === 'POST' || body.body === undefined, {
    message: 'body is only allowed with method POST',
    path: ['body'],
  });

export interface ResourcePaymentRoutesOptions extends FastifyPluginOptions {
  /** Injected by tests; production builds the service from the shared db, wallet and x402 client. */
  service?: ResourcePaymentService;
}

export async function resourcePaymentRoutes(
  fastify: FastifyInstance,
  opts: ResourcePaymentRoutesOptions = {},
): Promise<void> {
  const service =
    opts.service ??
    new ResourcePaymentService({ db, wallet: getWalletService(), client: new X402ClientService() });

  fastify.post<{ Params: { id: string } }>('/v1/jobs/:id/pay-resource', async (request, reply) => {
    const parsed = payResourceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', code: 'VALIDATION_FAILED', details: parsed.error.errors });
    }
    const { url, method, body, maxAmount, paymentId } = parsed.data;

    try {
      const outcome = await service.payForResource({
        jobId: request.params.id,
        agentId: request.agentId,
        url,
        method,
        ...(body !== undefined ? { body } : {}),
        ...(maxAmount !== undefined ? { maxAmount } : {}),
        ...(paymentId !== undefined ? { paymentId } : {}),
      });
      return reply.code(200).send(outcome);
    } catch (err) {
      if (err instanceof ResourcePaymentError) {
        return reply.code(err.httpStatus).send({ error: err.message, code: err.code, ...err.details });
      }
      throw err;
    }
  });
}
