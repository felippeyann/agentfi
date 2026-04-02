/**
 * Fee Service — AgentFi Revenue Engine
 *
 * Revenue model:
 *  - Protocol fee (basis points) charged on every swap/deposit/withdraw
 *  - Fee is collected by routing a small portion of the transaction to the
 *    OPERATOR_FEE_WALLET before executing the agent's intended action.
 *  - Subscription tiers reduce the fee rate:
 *      FREE:       30 bps (0.30%)
 *      PRO:        15 bps (0.15%) — $99/month
 *      ENTERPRISE:  5 bps (0.05%) — custom
 *
 * The fee wallet address is set via OPERATOR_FEE_WALLET env var.
 * Fee events are logged immutably in the FeeEvent table for accounting.
 */

import type { PrismaClient } from '@prisma/client';
import { parseEther, formatEther, type Address } from 'viem';

export const FEE_BPS = {
  FREE: 30,
  PRO: 15,
  ENTERPRISE: 5,
} as const;

export const TX_LIMITS = {
  FREE: 100,
  PRO: 10_000,
  ENTERPRISE: Infinity,
} as const;

export const SUBSCRIPTION_PRICE_USD = {
  FREE: 0,
  PRO: 99,
  ENTERPRISE: 0, // custom
} as const;

export interface FeeCalculation {
  feeAmountWei: bigint;
  feeBps: number;
  netAmountWei: bigint;
  feeWallet: Address;
}

export class FeeService {
  private readonly operatorFeeWallet: Address;

  constructor(private db: PrismaClient) {
    const wallet = process.env['OPERATOR_FEE_WALLET'];
    if (!wallet) throw new Error('OPERATOR_FEE_WALLET env var is required');
    this.operatorFeeWallet = wallet as Address;
  }

  /**
   * Calculates the protocol fee for a given transaction amount and agent tier.
   * All amounts in wei (bigint strings).
   */
  calculateFee(params: {
    grossAmountWei: bigint;
    tier: keyof typeof FEE_BPS;
  }): FeeCalculation {
    const bps = FEE_BPS[params.tier];
    const feeAmountWei = (params.grossAmountWei * BigInt(bps)) / BigInt(10_000);
    const netAmountWei = params.grossAmountWei - feeAmountWei;

    return {
      feeAmountWei,
      feeBps: bps,
      netAmountWei,
      feeWallet: this.operatorFeeWallet,
    };
  }

  /**
   * Records a fee event after a transaction is confirmed.
   */
  async recordFeeEvent(params: {
    agentId: string;
    transactionId: string;
    feeAmountWei: bigint;
    feeUsd: string;
    feeBps: number;
  }): Promise<void> {
    const billing = await this.db.agentBilling.upsert({
      where: { agentId: params.agentId },
      create: {
        agentId: params.agentId,
        txCountThisPeriod: 0,
        totalFeesCollectedUsd: params.feeUsd,
      },
      update: {
        totalFeesCollectedUsd: {
          // Prisma doesn't support decimal math natively — handled in app layer
          set: await this.accumulateFee(params.agentId, params.feeUsd),
        },
      },
    });

    await this.db.feeEvent.create({
      data: {
        billingId: billing.id,
        transactionId: params.transactionId,
        feeUsd: params.feeUsd,
        feeTokens: params.feeAmountWei.toString(),
        feeBps: params.feeBps,
      },
    });
  }

  /**
   * Increments monthly transaction usage for quota enforcement.
   * Called after confirmation for every successful transaction.
   */
  async incrementTxUsage(agentId: string): Promise<void> {
    await this.db.agentBilling.upsert({
      where: { agentId },
      create: {
        agentId,
        txCountThisPeriod: 1,
      },
      update: {
        txCountThisPeriod: { increment: 1 },
      },
    });
  }

  /**
   * Checks whether an agent has exceeded their monthly tx limit.
   */
  async checkTxLimit(agentId: string, tier: keyof typeof TX_LIMITS): Promise<boolean> {
    const limit = TX_LIMITS[tier];
    if (limit === Infinity) return true;

    const billing = await this.db.agentBilling.findUnique({
      where: { agentId },
    });

    const count = billing?.txCountThisPeriod ?? 0;
    return count < limit;
  }

  /**
   * Resets tx count at the start of a new billing period (called by cron).
   */
  async resetMonthlyCounters(): Promise<void> {
    await this.db.agentBilling.updateMany({
      data: {
        txCountThisPeriod: 0,
        periodStart: new Date(),
      },
    });
  }

  /**
   * Returns aggregate revenue stats for the admin dashboard.
   */
  async getRevenueStats(): Promise<{
    totalFeesUsd: string;
    feesByTier: Record<string, string>;
    txCount: number;
  }> {
    const [events, txCount] = await Promise.all([
      this.db.feeEvent.findMany({ select: { feeUsd: true } }),
      this.db.transaction.count({ where: { status: 'CONFIRMED' } }),
    ]);

    const totalFeesUsd = events
      .reduce((acc, e) => acc + parseFloat(e.feeUsd), 0)
      .toFixed(2);

    const tierEvents = await this.db.feeEvent.findMany({
      select: { feeUsd: true, feeBps: true },
    });

    const feesByTier: Record<string, string> = { FREE: '0', PRO: '0', ENTERPRISE: '0' };
    for (const e of tierEvents) {
      const tier =
        e.feeBps === FEE_BPS.FREE ? 'FREE' : e.feeBps === FEE_BPS.PRO ? 'PRO' : 'ENTERPRISE';
      feesByTier[tier] = (parseFloat(feesByTier[tier] ?? '0') + parseFloat(e.feeUsd)).toFixed(2);
    }

    return { totalFeesUsd, feesByTier, txCount };
  }

  private async accumulateFee(agentId: string, newFeeUsd: string): Promise<string> {
    const billing = await this.db.agentBilling.findUnique({ where: { agentId } });
    const current = parseFloat(billing?.totalFeesCollectedUsd ?? '0');
    return (current + parseFloat(newFeeUsd)).toFixed(6);
  }
}
