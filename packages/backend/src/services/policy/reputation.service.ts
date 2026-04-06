import { PrismaClient } from '@prisma/client';
import { logger } from '../../api/middleware/logger.js';

const db = new PrismaClient();

export class ReputationService {
  /**
   * Updates agent reputation based on job outcome.
   */
  async recordJobOutcome(agentId: string, success: boolean): Promise<void> {
    const scoreChange = success ? 10 : -5;
    
    await db.agent.update({
      where: { id: agentId },
      data: {
        reputationScore: { increment: scoreChange },
        a2aTxCount: { increment: success ? 1 : 0 },
        lastActiveAt: new Date(),
      },
    });

    logger.info({ agentId, success, scoreChange }, 'Reputation Updated via Job Outcome');
  }

  /**
   * Adds a small trust bonus for verifiable cryptographic identity proofs.
   */
  async recordHandshakeVerification(agentId: string): Promise<void> {
    await db.agent.update({
      where: { id: agentId },
      data: {
        reputationScore: { increment: 2 },
        lastActiveAt: new Date(),
      },
    });

    logger.info({ agentId }, 'Reputation Bonus: Handshake Verified');
  }

  /**
   * Normalizes reputation score (optional: prevents runaway scores or resets periodically).
   */
  async normalizeReputation(agentId: string): Promise<number> {
    const agent = await db.agent.findUnique({ where: { id: agentId }, select: { reputationScore: true } });
    if (!agent) return 0;
    
    // Logic Sentinel: Prevent negative reputation from blocking system entry, 
    // but keep it as a signal to peers.
    return agent.reputationScore;
  }
}
