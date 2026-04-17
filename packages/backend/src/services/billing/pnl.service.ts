/**
 * PnL Service — computes per-agent profit & loss from existing DB data.
 *
 * This endpoint directly serves VISION.md's thesis:
 *   "The moment an agent's earnings exceed its costs, it has crossed a line
 *    that no AI system has crossed before."
 *
 * Earnings sources (v1):
 *   - A2A job rewards received (this agent as provider, status=COMPLETED)
 *
 * Cost sources (v2):
 *   - Protocol fees paid (FeeEvent records linked via AgentBilling)
 *   - A2A job rewards paid out (this agent as requester, status=COMPLETED)
 *   - Gas costs: gasUsed * effectiveGasPriceWei per CONFIRMED/REVERTED tx
 *     (REVERTED txs still burn gas, so they are counted)
 *
 * Deferred to future:
 *   - Realized yield from DEPOSIT transactions (needs on-chain reads)
 *
 * USD conversion uses the same price oracle as the fee and escrow services.
 * On oracle failure, individual values are returned as '0' (graceful degradation).
 */

import { parseEther, parseUnits } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { db as defaultDb } from '../../db/client.js';
import { weiToUsd, tokenAmountToUsd } from '../transaction/price.service.js';
import { logger } from '../../api/middleware/logger.js';

export interface PnLBreakdown {
  agentId: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  earnings: {
    a2aJobsAsProvider: { count: number; usd: string };
    totalEarningsUsd: string;
  };
  costs: {
    protocolFees: { count: number; usd: string };
    a2aJobsAsRequester: { count: number; usd: string };
    gas: { count: number; usd: string };
    totalCostsUsd: string;
  };
  netPnlUsd: string;
  breakEven: boolean;
  profitable: boolean;
  notes: string[];
}

interface RewardJson {
  amount?: string;
  token?: string;
  chainId?: number;
}

/**
 * Convert a reward spec to USD string. Returns '0' on any failure
 * (unknown token, price oracle error, malformed amount).
 */
async function rewardToUsd(reward: RewardJson | null): Promise<string> {
  if (!reward || !reward.amount) return '0';

  const token = reward.token ?? 'ETH';
  const chainId = reward.chainId ?? 1;
  const isEth = token.toUpperCase() === 'ETH';

  try {
    if (isEth) {
      const wei = parseEther(reward.amount);
      return await weiToUsd(wei, chainId);
    }
    // Assume 6 decimals (USDC/USDT) as MVP fallback.
    const units = parseUnits(reward.amount, 6);
    return await tokenAmountToUsd(units, token, 6, chainId);
  } catch {
    return '0';
  }
}

export class PnLService {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultDb) {
    this.db = db;
  }

  /**
   * Computes P&L for a single agent.
   * @param agentId - the agent to analyze
   * @param since - optional start of the period (defaults to agent.createdAt)
   */
  async computeAgentPnL(params: {
    agentId: string;
    since?: Date;
  }): Promise<PnLBreakdown> {
    const agent = await this.db.agent.findUnique({
      where: { id: params.agentId },
      select: { id: true, name: true, createdAt: true },
    });

    if (!agent) {
      throw new Error(`Agent ${params.agentId} not found`);
    }

    const periodStart = params.since ?? agent.createdAt;
    const periodEnd = new Date();
    const notes: string[] = [];

    // --- Earnings: A2A jobs as provider (COMPLETED) ---
    const jobsAsProvider = await this.db.job.findMany({
      where: {
        providerId: agent.id,
        status: 'COMPLETED',
        updatedAt: { gte: periodStart },
      },
      select: { reward: true },
    });

    let earningsUsd = 0;
    for (const job of jobsAsProvider) {
      const usd = await rewardToUsd(job.reward as RewardJson | null);
      earningsUsd += parseFloat(usd);
    }

    // --- Costs: protocol fees paid ---
    const feeEvents = await this.db.feeEvent.findMany({
      where: {
        billing: { agentId: agent.id },
        collectedAt: { gte: periodStart },
      },
      select: { feeUsd: true },
    });

    const protocolFeesUsd = feeEvents.reduce(
      (acc, fe) => acc + parseFloat(fe.feeUsd || '0'),
      0,
    );

    // --- Costs: A2A jobs as requester (COMPLETED) ---
    const jobsAsRequester = await this.db.job.findMany({
      where: {
        requesterId: agent.id,
        status: 'COMPLETED',
        updatedAt: { gte: periodStart },
      },
      select: { reward: true },
    });

    let rewardsPaidUsd = 0;
    for (const job of jobsAsRequester) {
      const usd = await rewardToUsd(job.reward as RewardJson | null);
      rewardsPaidUsd += parseFloat(usd);
    }

    // --- Costs: gas burned on confirmed/reverted txs ---
    // REVERTED txs still burn gas on-chain, so they are counted as a real cost.
    // Txs with missing gasUsed or effectiveGasPriceWei (older rows pre-migration)
    // are silently skipped rather than biasing the total toward zero.
    const gasTxs = await this.db.transaction.findMany({
      where: {
        agentId: agent.id,
        status: { in: ['CONFIRMED', 'REVERTED'] },
        confirmedAt: { gte: periodStart },
      },
      select: {
        chainId: true,
        gasUsed: true,
        effectiveGasPriceWei: true,
      },
    });

    let gasCostsUsd = 0;
    let gasCostedTxCount = 0;
    let gasMissingCount = 0;
    for (const tx of gasTxs) {
      if (!tx.gasUsed || !tx.effectiveGasPriceWei) {
        gasMissingCount++;
        continue;
      }
      try {
        const gasCostWei =
          BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPriceWei);
        const usd = await weiToUsd(gasCostWei, tx.chainId);
        gasCostsUsd += parseFloat(usd);
        gasCostedTxCount++;
      } catch {
        gasMissingCount++;
      }
    }

    if (gasMissingCount > 0) {
      notes.push(
        `${gasMissingCount} tx(s) skipped in gas cost calc (missing gasUsed/effectiveGasPriceWei — likely pre-migration rows).`,
      );
    }

    notes.push(
      'Realized yield from DEPOSIT transactions not included (needs on-chain reads).',
    );

    const totalEarningsUsd = earningsUsd;
    const totalCostsUsd = protocolFeesUsd + rewardsPaidUsd + gasCostsUsd;
    const netPnlUsd = totalEarningsUsd - totalCostsUsd;

    const breakdown: PnLBreakdown = {
      agentId: agent.id,
      name: agent.name,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      earnings: {
        a2aJobsAsProvider: {
          count: jobsAsProvider.length,
          usd: totalEarningsUsd.toFixed(6),
        },
        totalEarningsUsd: totalEarningsUsd.toFixed(6),
      },
      costs: {
        protocolFees: {
          count: feeEvents.length,
          usd: protocolFeesUsd.toFixed(6),
        },
        a2aJobsAsRequester: {
          count: jobsAsRequester.length,
          usd: rewardsPaidUsd.toFixed(6),
        },
        gas: {
          count: gasCostedTxCount,
          usd: gasCostsUsd.toFixed(6),
        },
        totalCostsUsd: totalCostsUsd.toFixed(6),
      },
      netPnlUsd: netPnlUsd.toFixed(6),
      breakEven: netPnlUsd >= 0,
      profitable: netPnlUsd > 0,
      notes,
    };

    logger.info(
      {
        agentId: agent.id,
        netPnlUsd: breakdown.netPnlUsd,
        profitable: breakdown.profitable,
      },
      'Agent P&L computed',
    );

    return breakdown;
  }
}
