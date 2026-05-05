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
 * USD conversion (Phase 3 of #71):
 *   - Per-job rewards prefer the `rewardUsd` snapshot persisted by the
 *     finalizer at the moment the on-chain payment confirmed. Once written,
 *     the historical revenue figure is locked — no longer affected by
 *     subsequent token-price moves or oracle outages.
 *   - When a COMPLETED job has no snapshot (oracle was unresolved at
 *     finalization, or the row pre-dates this column), we fall back to
 *     live pricing AND record a "snapshot unresolved" warning so the
 *     dashboard can flag the row instead of silently zeroing it.
 *   - Gas costs are still computed live — no snapshot needed because
 *     gasUsed * effectiveGasPriceWei is denominated in wei, not USD.
 */

import type { PrismaClient } from '@prisma/client';
import { db as defaultDb } from '../../db/client.js';
import { weiToUsd } from '../transaction/price.service.js';
import { logger } from '../../api/middleware/logger.js';
import { resolveRewardUsd, type RewardJson } from './reward-pricing.js';

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

/**
 * Resolve a row's USD value: prefer the persisted snapshot, fall back to
 * live pricing. Returns the USD figure plus whether the snapshot was used —
 * the caller aggregates an "unresolved" count for the dashboard warning.
 */
async function rewardRowToUsd(row: {
  reward: unknown;
  rewardUsd: string | null;
}): Promise<{ usd: number; usedSnapshot: boolean; resolved: boolean }> {
  if (row.rewardUsd != null) {
    const parsed = parseFloat(row.rewardUsd);
    return {
      usd: Number.isFinite(parsed) ? parsed : 0,
      usedSnapshot: true,
      resolved: true,
    };
  }
  const live = await resolveRewardUsd(row.reward as RewardJson | null);
  return {
    usd: parseFloat(live.usd),
    usedSnapshot: false,
    resolved: live.resolved,
  };
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
      select: { reward: true, rewardUsd: true },
    });

    let earningsUsd = 0;
    let earningsSnapshotCount = 0;
    let earningsLiveFallbackCount = 0;
    let earningsUnresolvedCount = 0;
    for (const job of jobsAsProvider) {
      const r = await rewardRowToUsd(job);
      earningsUsd += r.usd;
      if (r.usedSnapshot) earningsSnapshotCount++;
      else {
        earningsLiveFallbackCount++;
        if (!r.resolved) earningsUnresolvedCount++;
      }
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
      select: { reward: true, rewardUsd: true },
    });

    let rewardsPaidUsd = 0;
    let costsSnapshotCount = 0;
    let costsLiveFallbackCount = 0;
    let costsUnresolvedCount = 0;
    for (const job of jobsAsRequester) {
      const r = await rewardRowToUsd(job);
      rewardsPaidUsd += r.usd;
      if (r.usedSnapshot) costsSnapshotCount++;
      else {
        costsLiveFallbackCount++;
        if (!r.resolved) costsUnresolvedCount++;
      }
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

    // Phase 3 of #71 — surface revenue-snapshot quality so the dashboard
    // can flag rows the oracle couldn't price. We split between earnings
    // and cost-as-requester sides because the same agent can be on either
    // side of an oracle outage and we want both signals visible.
    if (earningsLiveFallbackCount > 0) {
      const tail =
        earningsUnresolvedCount > 0
          ? ` (${earningsUnresolvedCount} unresolved — counted as $0; figure may understate true revenue)`
          : '';
      notes.push(
        `${earningsLiveFallbackCount} earning job(s) priced live (no stored snapshot)${tail}.`,
      );
    }
    if (costsLiveFallbackCount > 0) {
      const tail =
        costsUnresolvedCount > 0
          ? ` (${costsUnresolvedCount} unresolved — counted as $0; figure may understate true cost)`
          : '';
      notes.push(
        `${costsLiveFallbackCount} cost-as-requester job(s) priced live (no stored snapshot)${tail}.`,
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
        earningsSnapshotCount,
        earningsLiveFallbackCount,
        earningsUnresolvedCount,
        costsSnapshotCount,
        costsLiveFallbackCount,
        costsUnresolvedCount,
      },
      'Agent P&L computed',
    );

    return breakdown;
  }
}
