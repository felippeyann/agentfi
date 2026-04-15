/**
 * A2A Escrow Service (v2).
 *
 * Implements database-level escrow for Agent-to-Agent job payments:
 * funds are "reserved" at job creation, released at terminal state.
 *
 * The escrow model:
 *   1. reserveJobEscrow() runs at POST /v1/jobs time:
 *      - Validates requester active and chain-supported
 *      - Converts reward to USD
 *      - Atomically commits USD volume to DailyVolume (prevents race conditions)
 *      - Rolls back if daily limit would be exceeded
 *
 *   2. releaseJobEscrow() runs on CANCELLED/FAILED:
 *      - Subtracts reserved USD from DailyVolume
 *      - Marks reservation as CANCELLED
 *
 *   3. On COMPLETED: the caller marks reservation as RELEASED and invokes
 *      executeA2APayment() — the actual transfer reuses the already-committed
 *      daily volume (no double-counting needed).
 *
 * Limitations (v2):
 *   - DB-level only (no on-chain escrow contract)
 *   - Does not verify on-chain balance at reserve time (trust + policy)
 *   - No automatic cleanup of stale ACCEPTED jobs (operator task)
 */

import { parseEther, parseUnits } from 'viem';
import { db } from '../../db/client.js';
import { logger } from '../../api/middleware/logger.js';
import { weiToUsd, tokenAmountToUsd } from '../transaction/price.service.js';

interface RewardSpec {
  amount: string;
  token: string; // "ETH" or token address
  chainId: number;
}

interface ReservationResult {
  success: boolean;
  reason?: string;
  reservedValueUsd?: string;
}

/**
 * Convert a reward spec (native or token) to USD string.
 * Falls back to '0' if price oracle fails (graceful degradation).
 */
async function rewardToUsd(reward: RewardSpec): Promise<string> {
  const isEth = reward.token.toUpperCase() === 'ETH';
  if (isEth) {
    try {
      const wei = parseEther(reward.amount);
      return await weiToUsd(wei, reward.chainId);
    } catch {
      return '0';
    }
  }

  // For ERC-20 tokens, assume 6 decimals (USDC/USDT) as a sensible default
  // for MVP. Accurate decimal lookup happens at payment execution time.
  try {
    const units = parseUnits(reward.amount, 6);
    return await tokenAmountToUsd(units, reward.token, 6, reward.chainId);
  } catch {
    return '0';
  }
}

/**
 * Reserves funds for a job at creation time.
 * Atomically commits the USD value to the requester's daily volume.
 * Rolls back if it would exceed the policy's daily limit.
 */
export async function reserveJobEscrow(params: {
  requesterId: string;
  reward: RewardSpec;
}): Promise<ReservationResult> {
  // 1. Verify requester exists and is active
  const requester = await db.agent.findUnique({
    where: { id: params.requesterId },
    select: { id: true, active: true, chainIds: true },
  });
  if (!requester) {
    return { success: false, reason: 'Requester agent not found' };
  }
  if (!requester.active) {
    return { success: false, reason: 'Requester agent is deactivated' };
  }
  if (!requester.chainIds.includes(params.reward.chainId)) {
    return {
      success: false,
      reason: `Requester does not support chainId ${params.reward.chainId}`,
    };
  }

  // 2. Convert reward to USD
  const valueUsd = await rewardToUsd(params.reward);
  const valueUsdNum = parseFloat(valueUsd);

  if (valueUsdNum <= 0) {
    // Graceful: if price oracle fails, skip escrow volume check but still allow
    // (payment will be policy-checked at execution time as a fallback).
    logger.warn(
      { requesterId: params.requesterId, reward: params.reward },
      'Escrow: USD value resolved to 0, skipping volume reservation',
    );
    return { success: true, reservedValueUsd: '0' };
  }

  // 3. Check policy and atomically reserve daily volume
  const policy = await db.agentPolicy.findUnique({
    where: { agentId: params.requesterId },
  });

  if (policy && policy.active) {
    const dailyLimitUsd = parseFloat(policy.maxDailyVolumeUsd);
    if (dailyLimitUsd > 0) {
      const today = new Date().toISOString().slice(0, 10);

      // Atomic reserve: upsert into DailyVolume then read the new total.
      const reserved = await db.$queryRaw<[{ volumeUsd: string }]>`
        INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
        VALUES (gen_random_uuid()::text, ${params.requesterId}, ${today}, ${valueUsdNum.toFixed(6)}, NOW())
        ON CONFLICT ("agentId", "date")
        DO UPDATE SET
          "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${valueUsdNum}::numeric))::text,
          "updatedAt" = NOW()
        RETURNING "volumeUsd"
      `;
      const projectedVolumeUsd = parseFloat(reserved[0]?.volumeUsd ?? '0');

      if (projectedVolumeUsd > dailyLimitUsd) {
        // Rollback
        await db.$executeRaw`
          UPDATE "DailyVolume"
          SET "volumeUsd" = GREATEST(0, (("volumeUsd"::numeric) - (${valueUsdNum}::numeric)))::text,
              "updatedAt" = NOW()
          WHERE "agentId" = ${params.requesterId} AND "date" = ${today}
        `;
        return {
          success: false,
          reason: `Daily volume limit of $${policy.maxDailyVolumeUsd} USD would be exceeded by escrow reservation ($${valueUsdNum.toFixed(2)})`,
        };
      }
    }
  }

  logger.info(
    {
      requesterId: params.requesterId,
      reward: params.reward,
      reservedValueUsd: valueUsd,
    },
    'Job escrow reserved',
  );

  return { success: true, reservedValueUsd: valueUsd };
}

/**
 * Releases a job reservation (returns daily volume credit to the requester).
 * Called when job is CANCELLED or FAILED — no payment was executed.
 * Idempotent: calling it twice is safe.
 */
export async function releaseJobEscrow(jobId: string): Promise<void> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      requesterId: true,
      reservedAmount: true,
      reservedToken: true,
      reservedChainId: true,
      reservedAt: true,
      reservationStatus: true,
    },
  });

  if (!job || !job.reservedAmount || job.reservationStatus !== 'PENDING') {
    return; // Nothing to release or already released
  }

  // Convert reserved amount back to USD
  const valueUsd = await rewardToUsd({
    amount: job.reservedAmount,
    token: job.reservedToken ?? 'ETH',
    chainId: job.reservedChainId ?? 1,
  });
  const valueUsdNum = parseFloat(valueUsd);

  if (valueUsdNum > 0 && job.reservedAt) {
    const date = job.reservedAt.toISOString().slice(0, 10);
    await db.$executeRaw`
      UPDATE "DailyVolume"
      SET "volumeUsd" = GREATEST(0, (("volumeUsd"::numeric) - (${valueUsdNum}::numeric)))::text,
          "updatedAt" = NOW()
      WHERE "agentId" = ${job.requesterId} AND "date" = ${date}
    `;
  }

  await db.job.update({
    where: { id: jobId },
    data: { reservationStatus: 'CANCELLED' },
  });

  logger.info(
    { jobId, releasedUsd: valueUsd },
    'Job escrow released (cancelled)',
  );
}

/**
 * Marks a reservation as RELEASED (consumed by payment).
 * Called when job is COMPLETED and the payment is triggered.
 * Does NOT touch DailyVolume — the committed USD was already paid.
 */
export async function markEscrowReleased(jobId: string): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: { reservationStatus: 'RELEASED' },
  });
  logger.info({ jobId }, 'Job escrow marked as released (payment triggered)');
}
