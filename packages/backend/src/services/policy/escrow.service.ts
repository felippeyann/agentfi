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

import type { Prisma, PrismaClient } from '@prisma/client';
import { db } from '../../db/client.js';
import { logger } from '../../api/middleware/logger.js';
import { resolveRewardUsd } from '../billing/reward-pricing.js';
import { onChainEscrowService } from './escrow-onchain.service.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { getAddress, parseUnits, type Address } from 'viem';
import { getKnownTokenDecimals } from '../transaction/token-registry.js';
import { resourcePaymentSpentToday, utcDay } from '../payments/resource-payment-ledger.js';
import { parsePolicyDecimal } from './policy-numbers.js';
import {
  evaluateUsdcSpend,
  formatMicroUsd,
  policyDecimalToMicro,
  usdTextToMicroCeil,
  type UsdcSpendRule,
} from './usdc-spend-policy.js';

interface RewardSpec {
  amount: string;
  token: string; // "ETH" or token address
  chainId: number;
}

interface ReservationResult {
  success: boolean;
  reason?: string;
  /** USD added to the requester's DailyVolume ("0" when no daily limit applied). Stored as `Job.reservedValueUsd`. */
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

/** Raw-SQL capable client: the singleton or an interactive transaction. */
type SqlClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'> | Prisma.TransactionClient;

/** Adds `usd` to the agent's DailyVolume of `date` atomically and returns the new total (numeric text). */
async function addDailyVolume(agentId: string, date: string, usd: string, client: SqlClient = db): Promise<string> {
  const reserved = await client.$queryRaw<[{ volumeUsd: string }]>`
    INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
    VALUES (gen_random_uuid()::text, ${agentId}, ${date}, ${usd}, NOW())
    ON CONFLICT ("agentId", "date")
    DO UPDATE SET
      "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${usd}::numeric))::text,
      "updatedAt" = NOW()
    RETURNING "volumeUsd"
  `;
  return reserved[0]?.volumeUsd ?? '0';
}

/** Subtracts `usd` from the agent's DailyVolume of `date` (never below 0). */
async function subtractDailyVolume(agentId: string, date: string, usd: string, client: SqlClient = db): Promise<void> {
  await client.$executeRaw`
    UPDATE "DailyVolume"
    SET "volumeUsd" = GREATEST(0, (("volumeUsd"::numeric) - (${usd}::numeric)))::text,
        "updatedAt" = NOW()
    WHERE "agentId" = ${agentId} AND "date" = ${date}
  `;
}

/**
 * Reserves funds for a job at creation time — the legacy (non-ERC-8183)
 * path; escrow jobs use `reserveEscrowJobSpend`.
 * Atomically commits the USD value to the requester's daily volume.
 * Rolls back if it would exceed the policy's daily limit.
 *
 * C3d: when an active daily limit applies and the reward cannot be priced,
 * the reservation is REFUSED (fail closed) — it used to reserve $0 and let
 * the job through, which is how the daily limit never applied on chains the
 * oracle does not price. Without a daily limit an unpriced reward still
 * reserves nothing. The amount actually added to DailyVolume is returned as
 * `reservedValueUsd` so the release credits back exactly that.
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

  // 2. The policy's daily limit (0 / unparsable = none, as everywhere).
  const policy = await db.agentPolicy.findUnique({
    where: { agentId: params.requesterId },
  });
  const dailyLimitUsd = policy && policy.active ? parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0 : 0;

  // 3. Convert reward to USD
  const priced = await resolveRewardUsd(params.reward);
  const valueUsdNum = priced.resolved ? parseFloat(priced.usd) : 0;

  if (!priced.resolved || valueUsdNum <= 0) {
    if (dailyLimitUsd > 0) {
      // C3d: fail closed — a daily limit that cannot be checked must not pass.
      logger.warn(
        { requesterId: params.requesterId, reward: params.reward },
        'Escrow: reward price unresolved while a daily limit applies — reservation refused',
      );
      return {
        success: false,
        reason:
          `The reward (${params.reward.amount} ${params.reward.token} on chain ${params.reward.chainId}) could not be priced in USD, ` +
          `so the daily volume limit of $${policy!.maxDailyVolumeUsd} cannot be checked; retry later or pay in USDC on an escrow chain`,
      };
    }
    logger.warn(
      { requesterId: params.requesterId, reward: params.reward },
      'Escrow: USD value unresolved and no daily limit applies, skipping volume reservation',
    );
    return { success: true, reservedValueUsd: '0' };
  }

  // 4. Atomically reserve daily volume when a limit applies.
  if (dailyLimitUsd > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const usd = valueUsdNum.toFixed(6);
    const projectedVolumeUsd = parseFloat(await addDailyVolume(params.requesterId, today, usd));
    if (projectedVolumeUsd > dailyLimitUsd) {
      await subtractDailyVolume(params.requesterId, today, usd);
      return {
        success: false,
        reason: `Daily volume limit of $${policy!.maxDailyVolumeUsd} USD would be exceeded by escrow reservation ($${valueUsdNum.toFixed(2)})`,
      };
    }
    logger.info({ requesterId: params.requesterId, reward: params.reward, reservedValueUsd: usd }, 'Job escrow reserved');
    return { success: true, reservedValueUsd: usd };
  }

  logger.info({ requesterId: params.requesterId, reward: params.reward, valueUsd: priced.usd }, 'Job escrow reserved (no daily limit — nothing added to DailyVolume)');
  return { success: true, reservedValueUsd: '0' };
}

// ── ERC-8183 escrow jobs (C3d) ─────────────────────────────────────────────

export type EscrowSpendRule = UsdcSpendRule | 'cooldown';

export type EscrowSpendRefusal = {
  success: false;
  /** 403 for a policy refusal, 400 for a requester that cannot reserve at all. */
  httpStatus: 400 | 403;
  code: 'POLICY_VIOLATION' | 'POLICY_PAUSED' | 'RESERVATION_FAILED';
  reason: string;
  rule?: EscrowSpendRule;
  limit?: string;
  /** USD already committed today, without this job (`maxDailyVolume`). */
  spentToday?: string;
};

export type EscrowSpendResult<T> = { success: true; reservedValueUsd: string; created: T } | EscrowSpendRefusal;

/** Thrown inside the reservation transaction to roll it back with a refusal. */
class SpendRefused extends Error {
  constructor(readonly refusal: EscrowSpendRefusal) {
    super(refusal.reason);
  }
}

/** Latest transaction of the agent that counts for the cooldown (same statuses as the transaction routes). */
async function latestAgentTxAt(client: Pick<PrismaClient, 'transaction'> | Prisma.TransactionClient, agentId: string): Promise<Date | null> {
  const latest = await client.transaction.findFirst({
    where: { agentId, status: { in: ['PENDING_APPROVAL', 'QUEUED', 'SUBMITTED', 'CONFIRMED'] } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return latest?.createdAt ?? null;
}

/**
 * C3d — the requester's spending policy for an ERC-8183 escrow job, applied
 * at `POST /v1/jobs` before anything is reserved or created (second
 * adversarial review: on Base Sepolia the daily limit never applied — the
 * oracle has no 84532 price, so `$0` was reserved — and the allowlists and the
 * cooldown were never checked for escrow jobs).
 *
 * The budget is USDC, priced at exactly 1 USD (no oracle, so the gate never
 * depends on one and never needs a price it cannot get). P6's
 * `evaluateUsdcSpend` decides with the same readings as pay-resource:
 *   - active / expiresAt: a paused or expired policy refuses;
 *   - allowedTokens (non-empty): the escrow's USDC must be listed;
 *   - allowedRecipients (non-empty, Q8): the PAYEE must be listed — for an
 *     escrow job the provider's wallet, where the budget ends on `complete`.
 *     The escrow contract is the operator's own custody (configured, not
 *     chosen by the agent); checking it would make the list a no-op for every
 *     escrow job, whereas the provider is exactly the choice a prompt-injected
 *     agent would make. Same list as x402 `payTo` and a transfer's recipient
 *     ("who this agent may send value to"). Until Q8 this was
 *     `allowedContracts`; that list is not read here any more;
 *   - maxValuePerTxUsd (Q8): the whole budget is one USD spend (until Q8 the
 *     `maxValuePerTxEth` number read in USD; that field is ETH only now);
 *   - maxDailyVolumeUsd: DailyVolume (transactions + earlier jobs) + counted
 *     x402 rows + this budget ≤ limit.
 * The cooldown applies too: creating a paid job commits funds (the
 * requester's wallet then signs createJob / setBudget / approve / fund), so a
 * job is refused while the agent's last transaction is younger than
 * `cooldownSeconds` — the same rule the transaction routes apply per spend.
 * `maxValueForAutoApprovalEth` does not apply (an escrow job cannot wait for a
 * human approval; the operator's limit is the per-tx cap above).
 *
 * Atomicity (C3d review): the check, the DailyVolume increment and the Job
 * row (`create`, called inside the same interactive transaction) commit or
 * roll back together — a refusal, a failed check or a failed insert leaves
 * nothing behind. The transaction first locks the requester's Agent row
 * (`FOR NO KEY UPDATE`): it conflicts with the `FOR UPDATE` the x402 ledger
 * (P6) and the transaction policy take on the same row, so an escrow job and
 * an x402 payment (or another job) of one agent are checked one after the
 * other and neither can overshoot the limit by the other's amount. Lock order
 * Agent → DailyVolume, as in those paths. `NO KEY UPDATE` rather than
 * `UPDATE`: the Job insert takes `FOR KEY SHARE` on the provider's Agent row
 * (foreign key), which `FOR UPDATE` would block — two agents creating jobs for
 * each other at the same time would deadlock.
 */
export async function reserveEscrowJobSpend<T>(
  params: {
    requesterId: string;
    chainId: number;
    /** Human-readable USDC amount (`reward.amount`). */
    amount: string;
    /** The escrow's token (USDC) on `chainId`. */
    token: string;
    /** The payee: the provider's wallet address. */
    payee: string;
    now?: Date;
  },
  /** Creates the Job row inside the reservation transaction (it receives the USD actually reserved). */
  create: (tx: Prisma.TransactionClient, reservation: { reservedValueUsd: string }) => Promise<T>,
): Promise<EscrowSpendResult<T>> {
  const now = params.now ?? new Date();
  const requester = await db.agent.findUnique({
    where: { id: params.requesterId },
    select: { id: true, active: true, chainIds: true },
  });
  if (!requester) return { success: false, httpStatus: 400, code: 'RESERVATION_FAILED', reason: 'Requester agent not found' };
  if (!requester.active) return { success: false, httpStatus: 400, code: 'RESERVATION_FAILED', reason: 'Requester agent is deactivated' };
  if (!requester.chainIds.includes(params.chainId)) {
    return { success: false, httpStatus: 400, code: 'RESERVATION_FAILED', reason: `Requester does not support chainId ${params.chainId}` };
  }

  let amount: bigint;
  try {
    amount = parseUnits(params.amount, 6);
  } catch {
    return { success: false, httpStatus: 400, code: 'RESERVATION_FAILED', reason: `reward.amount ${JSON.stringify(params.amount)} is not a USDC amount` };
  }
  if (amount <= 0n) return { success: false, httpStatus: 400, code: 'RESERVATION_FAILED', reason: 'reward.amount must be greater than zero' };
  const amountUsd = formatMicroUsd(amount);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${params.requesterId} FOR NO KEY UPDATE`;

      const policy = await tx.agentPolicy.findUnique({ where: { agentId: params.requesterId } });
      if (!policy) {
        // No policy = no restrictions (same as validateTransaction).
        return { success: true as const, reservedValueUsd: '0', created: await create(tx, { reservedValueUsd: '0' }) };
      }

      // Static rules (paused / expired / allowlists / per-tx cap; the daily
      // limit against this budget alone). The committed volume follows.
      const verdict = evaluateUsdcSpend(policy, { amount, token: params.token, recipient: params.payee, spentTodayMicroUsd: 0n, now });
      if (!verdict.allowed) {
        throw new SpendRefused({
          success: false,
          httpStatus: 403,
          code: verdict.rule === 'policyPaused' || verdict.rule === 'policyExpired' ? 'POLICY_PAUSED' : 'POLICY_VIOLATION',
          reason: verdict.rule === 'allowedRecipients' ? `Provider wallet ${params.payee} is not in the agent's allowed recipients whitelist` : verdict.reason,
          rule: verdict.rule,
          ...(verdict.limit !== undefined ? { limit: verdict.limit } : {}),
        });
      }

      if (policy.cooldownSeconds > 0) {
        const last = await latestAgentTxAt(tx, params.requesterId);
        if (last) {
          const elapsed = Math.floor((now.getTime() - last.getTime()) / 1000);
          if (elapsed < policy.cooldownSeconds) {
            throw new SpendRefused({
              success: false,
              httpStatus: 403,
              code: 'POLICY_VIOLATION',
              rule: 'cooldown',
              reason: `Cooldown active. ${policy.cooldownSeconds - elapsed} seconds remaining before the agent may commit funds again`,
              limit: String(policy.cooldownSeconds),
            });
          }
        }
      }

      const daily = policyDecimalToMicro(policy.maxDailyVolumeUsd);
      if (daily === null || daily === 0n) {
        return { success: true as const, reservedValueUsd: '0', created: await create(tx, { reservedValueUsd: '0' }) };
      }

      const total = await addDailyVolume(params.requesterId, utcDay(now), amountUsd, tx);
      const x402 = await resourcePaymentSpentToday(tx, params.requesterId, now);
      const projected = usdTextToMicroCeil(total) + x402;
      if (projected > daily) {
        const spentToday = projected - amount;
        // Rolls the increment back with the rest of the transaction.
        throw new SpendRefused({
          success: false,
          httpStatus: 403,
          code: 'POLICY_VIOLATION',
          rule: 'maxDailyVolume',
          reason:
            `Daily volume limit of ${policy.maxDailyVolumeUsd} USD would be exceeded. ` +
            `Already committed today: ${formatMicroUsd(spentToday)}, requested: ${amountUsd} (USDC at 1.00 USD)`,
          limit: policy.maxDailyVolumeUsd,
          spentToday: formatMicroUsd(spentToday),
        });
      }
      const created = await create(tx, { reservedValueUsd: amountUsd });
      logger.info({ requesterId: params.requesterId, chainId: params.chainId, reservedValueUsd: amountUsd }, 'ERC-8183 job budget reserved against the daily limit');
      return { success: true as const, reservedValueUsd: amountUsd, created };
    });
  } catch (err) {
    if (err instanceof SpendRefused) return err.refusal;
    throw err;
  }
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
 *
 * C3d: idempotent under concurrency, not just sequentially. The
 * PENDING → CANCELLED flip is a conditional write and only the caller that
 * made it credits DailyVolume — a cancellation racing a step failure (both
 * read PENDING) used to credit the volume twice. The credit is the USD the
 * reservation added (`reservedValueUsd`; "0" when no daily limit applied), not
 * a re-priced reward; rows from before C3d fall back to re-pricing.
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
      reservedValueUsd: true,
    },
  });

  if (!job || !job.reservedAmount || job.reservationStatus !== 'PENDING') {
    return; // Nothing to release or already released
  }

  const claimed = await db.job.updateMany({
    where: { id: jobId, reservationStatus: 'PENDING' },
    data: { reservationStatus: 'CANCELLED' },
  });
  if (claimed.count === 0) return; // a concurrent release (or the payment) got there first

  // Convert reserved amount back to USD
  const valueUsd =
    job.reservedValueUsd ??
    (await rewardToUsd({
      amount: job.reservedAmount,
      token: job.reservedToken ?? 'ETH',
      chainId: job.reservedChainId ?? 1,
    }));
  const valueUsdNum = parseFloat(valueUsd);

  if (valueUsdNum > 0 && job.reservedAt) {
    await subtractDailyVolume(job.requesterId, job.reservedAt.toISOString().slice(0, 10), valueUsd);
  }

  logger.info(
    { jobId, releasedUsd: valueUsd },
    'Job escrow released (cancelled)',
  );
}

/**
 * Marks a reservation as RELEASED (consumed by payment).
 * Called when job is COMPLETED and the payment is triggered.
 * Does NOT touch DailyVolume — the committed USD was already paid.
 * C3d: conditional on PENDING, so it never turns a released (credited back)
 * reservation into RELEASED.
 */
export async function markEscrowReleased(jobId: string): Promise<void> {
  const marked = await db.job.updateMany({
    where: { id: jobId, reservationStatus: 'PENDING' },
    data: { reservationStatus: 'RELEASED' },
  });
  if (marked.count > 0) logger.info({ jobId }, 'Job escrow marked as released (payment triggered)');
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
