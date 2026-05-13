/**
 * Operator Service — Revenue Sharing (Phase 4)
 *
 * Manages operators who run agent fleets and earn a share of protocol fees.
 * Each operator has a configurable revShareBps (default 2000 = 20%).
 *
 * Revenue flow:
 *   1. Agent tx confirmed → FeeService.recordFeeEvent()
 *   2. If agent has an active operator → accrueRevenue() splits the fee
 *   3. Admin creates a settlement for a date range → createSettlement()
 *   4. Admin marks settlement as SETTLED after on-chain transfer
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../../api/middleware/logger.js';

export class OperatorService {
  constructor(private db: PrismaClient) {}

  async createOperator(params: {
    name: string;
    walletAddress: string;
    contactEmail?: string | null;
    revShareBps?: number | null;
  }) {
    return this.db.operator.create({
      data: {
        name: params.name,
        walletAddress: params.walletAddress,
        contactEmail: params.contactEmail ?? null,
        revShareBps: params.revShareBps ?? 2000,
      },
    });
  }

  async assignAgentToOperator(agentId: string, operatorId: string) {
    return this.db.agent.update({
      where: { id: agentId },
      data: { operatorId },
    });
  }

  async removeAgentFromOperator(agentId: string) {
    return this.db.agent.update({
      where: { id: agentId },
      data: { operatorId: null },
    });
  }

  /**
   * Record the operator's share of a fee event. Called from FeeService
   * after a fee is recorded, if the agent has an operator.
   */
  async accrueRevenue(params: {
    operatorId: string;
    feeEventId: string;
    grossFeeUsd: string;
    revShareBps: number;
  }) {
    const grossFee = parseFloat(params.grossFeeUsd);
    const operatorShare = (grossFee * params.revShareBps) / 10_000;
    const protocolShare = grossFee - operatorShare;

    await this.db.operatorRevenue.create({
      data: {
        operatorId: params.operatorId,
        feeEventId: params.feeEventId,
        grossFeeUsd: params.grossFeeUsd,
        operatorShareUsd: operatorShare.toFixed(6),
        protocolShareUsd: protocolShare.toFixed(6),
        shareBps: params.revShareBps,
        accrualDate: new Date().toISOString().slice(0, 10),
      },
    });

    logger.info(
      {
        operatorId: params.operatorId,
        grossFeeUsd: params.grossFeeUsd,
        operatorShareUsd: operatorShare.toFixed(6),
        revShareBps: params.revShareBps,
      },
      'Operator revenue accrued',
    );
  }

  /**
   * Get pending (unsettled) revenue for an operator.
   */
  async getPendingRevenue(operatorId: string): Promise<string> {
    const accruals = await this.db.operatorRevenue.findMany({
      where: { operatorId, settled: false },
      select: { operatorShareUsd: true },
    });
    return accruals
      .reduce((sum, a) => sum + parseFloat(a.operatorShareUsd), 0)
      .toFixed(6);
  }

  /**
   * Create a settlement record for an operator's pending revenue.
   * Marks all unsettled accruals in the period as settled.
   */
  async createSettlement(params: {
    operatorId: string;
    periodStart: string;
    periodEnd: string;
    chainId?: number | null;
  }) {
    const pendingAccruals = await this.db.operatorRevenue.findMany({
      where: {
        operatorId: params.operatorId,
        settled: false,
        accrualDate: { gte: params.periodStart, lte: params.periodEnd },
      },
    });

    if (pendingAccruals.length === 0) {
      return null;
    }

    const totalUsd = pendingAccruals
      .reduce((sum, a) => sum + parseFloat(a.operatorShareUsd), 0)
      .toFixed(6);

    const settlement = await this.db.operatorSettlement.create({
      data: {
        operatorId: params.operatorId,
        amountUsd: totalUsd,
        chainId: params.chainId ?? null,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        status: 'PENDING',
      },
    });

    await this.db.operatorRevenue.updateMany({
      where: {
        id: { in: pendingAccruals.map((a) => a.id) },
      },
      data: { settled: true },
    });

    logger.info(
      {
        settlementId: settlement.id,
        operatorId: params.operatorId,
        amountUsd: totalUsd,
        accrualCount: pendingAccruals.length,
      },
      'Operator settlement created',
    );

    return settlement;
  }

  /**
   * Mark a settlement as settled (after on-chain transfer confirms).
   */
  async markSettlementComplete(settlementId: string, txHash: string) {
    return this.db.operatorSettlement.update({
      where: { id: settlementId },
      data: {
        status: 'SETTLED',
        txHash,
        settledAt: new Date(),
      },
    });
  }

  async markSettlementFailed(settlementId: string) {
    return this.db.operatorSettlement.update({
      where: { id: settlementId },
      data: { status: 'FAILED' },
    });
  }

  async getOperatorStats(operatorId: string) {
    const [operator, agentCount, pendingRevenue, settlements] =
      await Promise.all([
        this.db.operator.findUnique({ where: { id: operatorId } }),
        this.db.agent.count({ where: { operatorId } }),
        this.getPendingRevenue(operatorId),
        this.db.operatorSettlement.findMany({
          where: { operatorId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    const totalSettledUsd = await this.db.operatorSettlement
      .findMany({
        where: { operatorId, status: 'SETTLED' },
        select: { amountUsd: true },
      })
      .then((rows) =>
        rows
          .reduce((sum, r) => sum + parseFloat(r.amountUsd), 0)
          .toFixed(2),
      );

    const totalAccruedUsd = await this.db.operatorRevenue
      .findMany({
        where: { operatorId },
        select: { operatorShareUsd: true },
      })
      .then((rows) =>
        rows
          .reduce((sum, r) => sum + parseFloat(r.operatorShareUsd), 0)
          .toFixed(2),
      );

    return {
      operator,
      agentCount,
      pendingRevenueUsd: pendingRevenue,
      totalAccruedUsd,
      totalSettledUsd,
      recentSettlements: settlements,
    };
  }

  async listOperators() {
    const operators = await this.db.operator.findMany({
      include: { _count: { select: { agents: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const stats = await Promise.all(
      operators.map(async (op) => {
        const pendingRevenue = await this.getPendingRevenue(op.id);
        return {
          ...op,
          agentCount: op._count.agents,
          pendingRevenueUsd: pendingRevenue,
        };
      }),
    );

    return stats;
  }
}
