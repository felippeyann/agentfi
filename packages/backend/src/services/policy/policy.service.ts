import type { PrismaClient, AgentPolicy } from '@prisma/client';
import { getAddress, type Address } from 'viem';

export interface PolicyValidationResult {
  allowed: boolean;
  reason?: string;
}

export class PolicyService {
  constructor(private db: PrismaClient) {}

  /**
   * Validates a proposed transaction against the agent's policy (off-chain check).
   * This runs before on-chain validation to fail fast and save gas.
   */
  async validateTransaction(params: {
    agentId: string;
    targetContract: Address;
    tokenAddress?: Address;
    valueEth: string; // as decimal string, e.g. "0.5"
    valueUsd?: string; // as decimal string, e.g. "150.00"
    lastTxTimestamp?: number; // unix seconds
  }): Promise<PolicyValidationResult> {
    const policy = await this.db.agentPolicy.findUnique({
      where: { agentId: params.agentId },
    });

    if (!policy) return { allowed: true }; // no policy = no restrictions
    if (!policy.active) return { allowed: false, reason: 'Agent policy is paused (kill switch active)' };

    // Check max value per tx
    const value = parseFloat(params.valueEth);
    const maxValue = parseFloat(policy.maxValuePerTxEth);
    if (value > maxValue) {
      return {
        allowed: false,
        reason: `Transaction value ${params.valueEth} ETH exceeds policy limit of ${policy.maxValuePerTxEth} ETH`,
      };
    }

    // Check contract whitelist
    if (policy.allowedContracts.length > 0) {
      const normalizedTarget = getAddress(params.targetContract);
      const normalizedWhitelist = policy.allowedContracts.map((a) => getAddress(a));
      if (!normalizedWhitelist.includes(normalizedTarget)) {
        return {
          allowed: false,
          reason: `Contract ${params.targetContract} is not in the agent's allowed contracts whitelist`,
        };
      }
    }

    // Check token whitelist
    if (params.tokenAddress && policy.allowedTokens.length > 0) {
      const normalizedToken = getAddress(params.tokenAddress);
      const normalizedWhitelist = policy.allowedTokens.map((a) => getAddress(a));
      if (!normalizedWhitelist.includes(normalizedToken)) {
        return {
          allowed: false,
          reason: `Token ${params.tokenAddress} is not in the agent's allowed tokens whitelist`,
        };
      }
    }

    // Check max daily volume in USD
    const dailyLimitUsd = parseFloat(policy.maxDailyVolumeUsd);
    if (dailyLimitUsd > 0) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const dailyVolume = await this.db.dailyVolume.findUnique({
        where: { agentId_date: { agentId: params.agentId, date: today } },
      });
      const existingVolumeUsd = parseFloat(dailyVolume?.volumeUsd ?? '0');
      const incomingVolumeUsd = parseFloat(params.valueUsd ?? '0');
      const projectedVolumeUsd = existingVolumeUsd + incomingVolumeUsd;
      if (projectedVolumeUsd > dailyLimitUsd) {
        return {
          allowed: false,
          reason: `Daily volume limit of $${policy.maxDailyVolumeUsd} USD would be exceeded. Current: $${existingVolumeUsd.toFixed(2)}, requested: $${incomingVolumeUsd.toFixed(2)}`,
        };
      }
    }

    // Check cooldown
    if (params.lastTxTimestamp && policy.cooldownSeconds > 0) {
      const elapsed = Math.floor(Date.now() / 1000) - params.lastTxTimestamp;
      if (elapsed < policy.cooldownSeconds) {
        const remaining = policy.cooldownSeconds - elapsed;
        return {
          allowed: false,
          reason: `Cooldown active. ${remaining} seconds remaining before next transaction is allowed`,
        };
      }
    }

    return { allowed: true };
  }

  async setPolicy(agentId: string, policy: Omit<AgentPolicy, 'id' | 'agentId' | 'updatedAt'>): Promise<AgentPolicy> {
    return this.db.agentPolicy.upsert({
      where: { agentId },
      create: { agentId, ...policy },
      update: policy,
    });
  }

  async getPolicy(agentId: string): Promise<AgentPolicy | null> {
    return this.db.agentPolicy.findUnique({ where: { agentId } });
  }

  /**
   * Emergency kill switch — immediately disables the agent's policy.
   */
  async emergencyPause(agentId: string): Promise<void> {
    await this.db.agentPolicy.update({
      where: { agentId },
      data: { active: false },
    });
  }

  async resume(agentId: string): Promise<void> {
    await this.db.agentPolicy.update({
      where: { agentId },
      data: { active: true },
    });
  }
}
