/**
 * A2A Escrow Service (v2 + v3 on-chain).
 *
 * Implements database-level escrow for Agent-to-Agent job payments:
 * funds are "reserved" at job creation, released at terminal state.
 *
 * v3 addition: when EscrowModule is deployed on the target chain,
 * this service also queues on-chain lock/release/refund transactions
 * via the transaction queue. The DB-level escrow remains the source
 * of truth; on-chain custody is a secondary settlement layer.
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

import { db } from '../../db/client.js';
import { logger } from '../../api/middleware/logger.js';
import { resolveRewardUsd } from '../billing/reward-pricing.js';
import { onChainEscrowService } from './escrow-onchain.service.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { getAddress, parseEther, parseUnits, type Address } from 'viem';
import { getKnownTokenDecimals } from '../transaction/token-registry.js';

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
  const resolved = await resolveRewardUsd(reward);
  return resolved.resolved ? resolved.usd : '0';
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
 * Queue an on-chain EscrowModule.lock() transaction if the contract is
 * deployed on the target chain. Called after the DB-level reservation
 * succeeds and the Job row exists. No-op when EscrowModule is absent.
 *
 * Returns the Transaction id if queued, null otherwise.
 */
export async function queueOnChainEscrowLock(params: {
  jobId: string;
  requesterId: string;
  providerAddress: Address;
  amount: string;
  token: string;
  chainId: number;
}): Promise<string | null> {
  if (!onChainEscrowService.isAvailable(params.chainId)) {
    return null;
  }

  const requester = await db.agent.findUnique({
    where: { id: params.requesterId },
    select: { safeAddress: true, walletId: true },
  });
  if (!requester) return null;

  const isNativeEth = params.token === 'ETH' || params.token === '0x0000000000000000000000000000000000000000';
  const decimals = isNativeEth
    ? 18
    : getKnownTokenDecimals(getAddress(params.token), params.chainId) ?? 18;
  const amountWei = parseUnits(params.amount, decimals);

  const txData = isNativeEth
    ? onChainEscrowService.buildLockEth({
        chainId: params.chainId,
        jobId: params.jobId,
        provider: params.providerAddress,
        amountWei,
      })
    : onChainEscrowService.buildLockToken({
        chainId: params.chainId,
        jobId: params.jobId,
        provider: params.providerAddress,
        token: params.token as Address,
        amount: amountWei,
      });

  const tx = await db.transaction.create({
    data: {
      agentId: params.requesterId,
      type: 'ESCROW_LOCK',
      chainId: params.chainId,
      status: 'QUEUED',
      intentId: `escrow-lock:${params.jobId}`,
      metadata: {
        jobId: params.jobId,
        escrowAction: 'lock',
        queuePayload: {
          to: txData.to,
          data: txData.data,
          value: txData.value.toString(),
        },
      },
    },
  });

  await transactionQueue.add('escrow-lock', {
    transactionId: tx.id,
    chainId: params.chainId,
    walletId: requester.walletId,
    from: getAddress(requester.safeAddress),
    to: txData.to,
    data: txData.data,
    value: txData.value.toString(),
    agentId: params.requesterId,
    tier: 'FREE',
    feeAmountWei: '0',
    feeUsd: '0',
    feeBps: 0,
  });

  logger.info(
    { jobId: params.jobId, transactionId: tx.id, chainId: params.chainId },
    'On-chain escrow lock queued',
  );
  return tx.id;
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

/**
 * Resolve the protocol-level operator wallet that can call
 * EscrowModule.release() and refund(). The on-chain operator is the
 * address passed as OPERATOR_ADDRESS at deploy time. We find an agent
 * whose safeAddress matches, so we can sign via its walletId.
 */
async function resolveEscrowOperatorWallet(): Promise<{
  agentId: string;
  walletId: string;
  safeAddress: string;
} | null> {
  const operatorAddr = process.env['OPERATOR_ADDRESS'];
  if (!operatorAddr) return null;

  const agent = await db.agent.findFirst({
    where: { safeAddress: { equals: operatorAddr, mode: 'insensitive' } },
    select: { id: true, walletId: true, safeAddress: true },
  });
  if (!agent) return null;
  return { agentId: agent.id, walletId: agent.walletId, safeAddress: agent.safeAddress };
}

/**
 * Queue an on-chain EscrowModule.release() to send escrowed funds to the
 * provider. Called from the payment finalizer when outcome is CONFIRMED.
 * No-op when EscrowModule is absent on the chain or the protocol operator
 * wallet is not configured.
 */
export async function queueOnChainEscrowRelease(params: {
  jobId: string;
  chainId: number;
}): Promise<string | null> {
  if (!onChainEscrowService.isAvailable(params.chainId)) {
    return null;
  }

  const operator = await resolveEscrowOperatorWallet();
  if (!operator) {
    logger.warn({ jobId: params.jobId }, 'On-chain escrow release: protocol operator wallet not found, skipping');
    return null;
  }

  const txData = onChainEscrowService.buildRelease({
    chainId: params.chainId,
    jobId: params.jobId,
  });

  const tx = await db.transaction.create({
    data: {
      agentId: operator.agentId,
      type: 'ESCROW_RELEASE',
      chainId: params.chainId,
      status: 'QUEUED',
      intentId: `escrow-release:${params.jobId}`,
      metadata: {
        jobId: params.jobId,
        escrowAction: 'release',
        queuePayload: {
          to: txData.to,
          data: txData.data,
          value: '0',
        },
      },
    },
  });

  await transactionQueue.add('escrow-release', {
    transactionId: tx.id,
    chainId: params.chainId,
    walletId: operator.walletId,
    from: getAddress(operator.safeAddress),
    to: txData.to,
    data: txData.data,
    value: '0',
    agentId: operator.agentId,
    tier: 'FREE',
    feeAmountWei: '0',
    feeUsd: '0',
    feeBps: 0,
  });

  logger.info(
    { jobId: params.jobId, transactionId: tx.id },
    'On-chain escrow release queued',
  );
  return tx.id;
}

/**
 * Queue an on-chain EscrowModule.refund() to return escrowed funds to the
 * requester. Called from the payment finalizer when outcome is FAILED.
 * No-op when EscrowModule is absent on the chain.
 */
export async function queueOnChainEscrowRefund(params: {
  jobId: string;
  chainId: number;
}): Promise<string | null> {
  if (!onChainEscrowService.isAvailable(params.chainId)) {
    return null;
  }

  const operator = await resolveEscrowOperatorWallet();
  if (!operator) {
    logger.warn({ jobId: params.jobId }, 'On-chain escrow refund: protocol operator wallet not found, skipping');
    return null;
  }

  const txData = onChainEscrowService.buildRefund({
    chainId: params.chainId,
    jobId: params.jobId,
  });

  const tx = await db.transaction.create({
    data: {
      agentId: operator.agentId,
      type: 'ESCROW_REFUND',
      chainId: params.chainId,
      status: 'QUEUED',
      intentId: `escrow-refund:${params.jobId}`,
      metadata: {
        jobId: params.jobId,
        escrowAction: 'refund',
        queuePayload: {
          to: txData.to,
          data: txData.data,
          value: '0',
        },
      },
    },
  });

  await transactionQueue.add('escrow-refund', {
    transactionId: tx.id,
    chainId: params.chainId,
    walletId: operator.walletId,
    from: getAddress(operator.safeAddress),
    to: txData.to,
    data: txData.data,
    value: '0',
    agentId: operator.agentId,
    tier: 'FREE',
    feeAmountWei: '0',
    feeUsd: '0',
    feeBps: 0,
  });

  logger.info(
    { jobId: params.jobId, transactionId: tx.id },
    'On-chain escrow refund queued',
  );
  return tx.id;
}
