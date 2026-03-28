/**
 * Stripe Billing Service
 *
 * Handles PRO tier subscriptions at $99/month.
 * On payment: upgrades agent tier, resets tx counter.
 * On cancellation: downgrades to FREE at period end.
 *
 * Webhooks handle all state transitions — never trust client-side.
 */

import Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../../api/middleware/logger.js';

const STRIPE_SECRET_KEY = process.env['STRIPE_SECRET_KEY'] ?? '';
const STRIPE_WEBHOOK_SECRET = process.env['STRIPE_WEBHOOK_SECRET'] ?? '';

// Price IDs — set these after creating products in Stripe dashboard
const PRICE_IDS = {
  PRO_MONTHLY: process.env['STRIPE_PRO_PRICE_ID'] ?? '',
};

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
  }
  return stripeClient;
}

export class StripeService {
  constructor(private db: PrismaClient) {}

  /**
   * Creates a Stripe checkout session for PRO subscription.
   * The agentId is stored in metadata to identify the agent in webhooks.
   */
  async createCheckoutSession(params: {
    agentId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    const stripe = getStripe();

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: PRICE_IDS.PRO_MONTHLY,
          quantity: 1,
        },
      ],
      metadata: {
        agentId: params.agentId,
        tier: 'PRO',
      },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { url: session.url };
  }

  /**
   * Creates a Stripe customer portal session for managing/cancelling subscription.
   */
  async createPortalSession(params: {
    agentId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const stripe = getStripe();

    const billing = await this.db.agentBilling.findUnique({
      where: { agentId: params.agentId },
      select: { stripeCustomerId: true },
    });

    if (!billing?.stripeCustomerId) {
      throw new Error('No Stripe customer found for this agent');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: params.returnUrl,
    });

    return { url: session.url };
  }

  /**
   * Processes Stripe webhook events.
   * This is the single source of truth for subscription state changes.
   */
  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    const stripe = getStripe();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${err}`);
    }

    logger.info({ type: event.type }, 'Stripe webhook received');

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.onCheckoutCompleted(session);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await this.onSubscriptionCancelled(sub);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await this.onPaymentFailed(invoice);
        break;
      }
    }
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const agentId = session.metadata?.agentId;
    if (!agentId) return;

    const periodEnd = session.subscription
      ? await this.getSubscriptionPeriodEnd(session.subscription as string)
      : null;

    await Promise.all([
      this.db.agent.update({
        where: { id: agentId },
        data: { tier: 'PRO' },
      }),
      this.db.agentBilling.update({
        where: { agentId },
        data: {
          subscriptionActive: true,
          subscriptionPeriodEnd: periodEnd,
          stripeCustomerId: session.customer as string,
          stripeSubscriptionId: session.subscription as string,
          txCountThisPeriod: 0, // reset on upgrade
        },
      }),
    ]);

    logger.info({ agentId }, 'Agent upgraded to PRO');
  }

  private async onSubscriptionCancelled(sub: Stripe.Subscription): Promise<void> {
    const billing = await this.db.agentBilling.findFirst({
      where: { stripeSubscriptionId: sub.id },
    });
    if (!billing) return;

    await Promise.all([
      this.db.agent.update({
        where: { id: billing.agentId },
        data: { tier: 'FREE' },
      }),
      this.db.agentBilling.update({
        where: { agentId: billing.agentId },
        data: { subscriptionActive: false, subscriptionPeriodEnd: null },
      }),
    ]);

    logger.info({ agentId: billing.agentId }, 'Agent downgraded to FREE (subscription cancelled)');
  }

  private async onPaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    logger.warn({ invoiceId: invoice.id, customerId: invoice.customer }, 'Payment failed');
    // Stripe retries automatically — no action needed until subscription cancels
  }

  private async getSubscriptionPeriodEnd(subscriptionId: string): Promise<Date | null> {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return new Date(sub.current_period_end * 1000);
  }
}
