import { db } from '../../db/client.js';
import { logger } from '../../api/middleware/logger.js';

/**
 * Reputation scoring service (v2).
 *
 * Two layers of reputation:
 *   1. Real-time event recording (recordJobOutcome, recordHandshakeVerification):
 *      lightweight counter updates on a2aTxCount and lastActiveAt.
 *   2. Aggregate score computation (computeReputationScore, updateAllReputationScores):
 *      derives a 0–10,000 score from real behavior metrics.
 *      Run periodically via cron or on-demand via admin endpoint.
 *
 * Scoring formula (weighted):
 *   - Transaction success rate (40%): CONFIRMED / (CONFIRMED + FAILED + REVERTED)
 *   - Job completion rate    (30%):  COMPLETED / (COMPLETED + FAILED) as provider
 *   - Volume score           (20%):  log10-normalized USD volume, capped at 100k
 *   - Activity consistency   (10%):  unique active days in last 30 days / 30
 */
export class ReputationService {
  /**
   * Records a job outcome event. Updates a2aTxCount and lastActiveAt only.
   * The reputationScore field is computed separately by computeReputationScore.
   */
  async recordJobOutcome(agentId: string, success: boolean): Promise<void> {
    await db.agent.update({
      where: { id: agentId },
      data: {
        a2aTxCount: { increment: success ? 1 : 0 },
        lastActiveAt: new Date(),
      },
    });

    logger.info({ agentId, success }, 'Job outcome recorded');
  }

  /**
   * Records a successful handshake verification event.
   */
  async recordHandshakeVerification(agentId: string): Promise<void> {
    await db.agent.update({
      where: { id: agentId },
      data: {
        lastActiveAt: new Date(),
      },
    });

    logger.info({ agentId }, 'Handshake verification recorded');
  }

  /**
   * Computes a reputation score from real behavior metrics.
   * Returns a 0–10,000 integer score.
   */
  async computeReputationScore(agentId: string): Promise<number> {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent) return 0;

    // 1. Transaction success rate (40%)
    const [confirmed, failed, reverted] = await Promise.all([
      db.transaction.count({ where: { agentId, status: 'CONFIRMED' } }),
      db.transaction.count({ where: { agentId, status: 'FAILED' } }),
      db.transaction.count({ where: { agentId, status: 'REVERTED' } }),
    ]);
    const totalTx = confirmed + failed + reverted;
    const txSuccessRate = totalTx > 0 ? confirmed / totalTx : 0;

    // 2. Job completion rate as provider (30%)
    const [completedJobs, failedJobs] = await Promise.all([
      db.job.count({ where: { providerId: agentId, status: 'COMPLETED' } }),
      db.job.count({ where: { providerId: agentId, status: 'FAILED' } }),
    ]);
    const totalJobs = completedJobs + failedJobs;
    // Neutral score (0.5) if no jobs yet — don't penalize new agents
    const jobCompletionRate = totalJobs > 0 ? completedJobs / totalJobs : 0.5;

    // 3. Volume score (20%) — derived from collected fees
    const billing = await db.agentBilling.findUnique({
      where: { agentId },
      select: { totalFeesCollectedUsd: true },
    });
    const totalFeesUsd = billing ? parseFloat(billing.totalFeesCollectedUsd) : 0;
    // Reverse-estimate volume from fees (avg fee ~20 bps = 0.002)
    const estimatedVolumeUsd = totalFeesUsd / 0.002;
    // Log scale: $100k volume = max score
    const volumeScore = Math.min(
      Math.log10(estimatedVolumeUsd + 1) / Math.log10(100_000),
      1,
    );

    // 4. Activity consistency (10%) — unique active days in last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentTxs = await db.transaction.findMany({
      where: { agentId, createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
    });
    const uniqueDays = new Set(
      recentTxs.map((tx) => tx.createdAt.toISOString().slice(0, 10)),
    );
    const consistencyScore = Math.min(uniqueDays.size / 30, 1);

    // Weighted aggregate (0–1)
    const weighted =
      txSuccessRate * 0.4 +
      jobCompletionRate * 0.3 +
      volumeScore * 0.2 +
      consistencyScore * 0.1;

    // Convert to 0–10,000 integer
    const finalScore = Math.floor(weighted * 10_000);

    logger.info(
      {
        agentId,
        txSuccessRate: Number(txSuccessRate.toFixed(3)),
        jobCompletionRate: Number(jobCompletionRate.toFixed(3)),
        volumeScore: Number(volumeScore.toFixed(3)),
        consistencyScore: Number(consistencyScore.toFixed(3)),
        finalScore,
      },
      'Reputation score computed',
    );

    return finalScore;
  }

  /**
   * Recomputes reputation for a single agent and persists the result.
   */
  async refreshReputation(agentId: string): Promise<number> {
    const score = await this.computeReputationScore(agentId);
    await db.agent.update({
      where: { id: agentId },
      data: { reputationScore: score },
    });
    return score;
  }

  /**
   * Recomputes reputation for all active agents.
   * Intended for daily cron or admin-triggered batch refresh.
   */
  async updateAllReputationScores(): Promise<{ updated: number; total: number }> {
    const agents = await db.agent.findMany({
      where: { active: true },
      select: { id: true },
    });

    let updated = 0;
    for (const agent of agents) {
      try {
        await this.refreshReputation(agent.id);
        updated++;
      } catch (err) {
        logger.error({ agentId: agent.id, err }, 'Failed to update reputation');
      }
    }

    logger.info({ total: agents.length, updated }, 'Reputation batch update complete');
    return { updated, total: agents.length };
  }

  /**
   * Returns the current persisted reputation score (compatibility helper).
   */
  async normalizeReputation(agentId: string): Promise<number> {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { reputationScore: true },
    });
    return agent?.reputationScore ?? 0;
  }
}
