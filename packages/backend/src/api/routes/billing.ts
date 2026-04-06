/**
 * Billing routes — Stripe subscription management.
 *
 * POST /v1/billing/checkout   — create Stripe checkout session (upgrade to PRO)
 * POST /v1/billing/portal     — create Stripe customer portal (manage/cancel)
 * POST /v1/billing/webhook    — Stripe webhook receiver (no auth — verified by signature)
 * GET  /v1/billing/status     — current subscription status for the agent
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { StripeService } from '../../services/billing/stripe.service.js';
const stripeService = new StripeService(db);

const ADMIN_URL = process.env['ADMIN_URL'] ?? 'http://localhost:3001';

export async function billingRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/billing/checkout — initiate PRO upgrade via Stripe.
   */
  fastify.post('/v1/billing/checkout', async (request, reply) => {
    const { url } = await stripeService.createCheckoutSession({
      agentId: request.agentId,
      successUrl: `${ADMIN_URL}/agents/${request.agentId}?upgraded=true`,
      cancelUrl: `${ADMIN_URL}/agents/${request.agentId}`,
    });

    return { checkoutUrl: url };
  });

  /**
   * POST /v1/billing/portal — manage or cancel existing subscription.
   */
  fastify.post('/v1/billing/portal', async (request, reply) => {
    const { url } = await stripeService.createPortalSession({
      agentId: request.agentId,
      returnUrl: `${ADMIN_URL}/agents/${request.agentId}`,
    });

    return { portalUrl: url };
  });

  /**
   * POST /v1/billing/webhook — Stripe sends events here.
   * Bypass auth middleware — signature is verified inside the handler.
   */
  fastify.post(
    '/v1/billing/webhook',
    {
      config: { skipAuth: true },
      // Raw body needed for Stripe signature verification
    },
    async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (!signature || typeof signature !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature header' });
      }

      try {
        await stripeService.handleWebhook(
          request.body as Buffer,
          signature,
        );
        return reply.code(200).send({ received: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  /**
   * GET /v1/billing/status — subscription and usage info.
   */
  fastify.get('/v1/billing/status', async (request) => {
    const [agent, billing] = await Promise.all([
      db.agent.findUnique({
        where: { id: request.agentId },
        select: { tier: true },
      }),
      db.agentBilling.findUnique({
        where: { agentId: request.agentId },
        select: {
          subscriptionActive: true,
          subscriptionPeriodEnd: true,
          txCountThisPeriod: true,
          totalFeesCollectedUsd: true,
        },
      }),
    ]);

    const TX_LIMITS = { FREE: 100, PRO: 10_000, ENTERPRISE: null };
    const tier = agent?.tier ?? 'FREE';
    const limit = TX_LIMITS[tier as keyof typeof TX_LIMITS];

    return {
      tier,
      subscription: {
        active: billing?.subscriptionActive ?? false,
        periodEnd: billing?.subscriptionPeriodEnd,
      },
      usage: {
        txCountThisPeriod: billing?.txCountThisPeriod ?? 0,
        txLimit: limit,
        totalFeesCollectedUsd: billing?.totalFeesCollectedUsd ?? '0',
      },
      upgrade: tier === 'FREE' ? 'POST /v1/billing/checkout to upgrade to PRO ($99/mo)' : null,
    };
  });
}
