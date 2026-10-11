/**
 * DailyVolume accounting of ordinary transactions (plan task A6).
 *
 * Before A6 an ordinary transaction was counted twice and never given back:
 * `PolicyService.validateTransaction` added its USD to DailyVolume at enqueue,
 * `runPostConfirmation` added it again when it confirmed, and nothing
 * subtracted it when it failed, reverted, or was refused after validation
 * (cooldown, simulation, operator rejection, a lost idempotency race).
 *
 * Now there is one reservation per Transaction row and one settlement:
 *
 *   createTransactionWithVolume  DailyVolume += usd and the row (RESERVED) are
 *                                written in ONE database transaction, after
 *                                the binding daily-limit check; a refusal or a
 *                                failed insert rolls both back.
 *   commitTransactionVolume      RESERVED → COMMITTED  confirmed; stays counted
 *   releaseTransactionVolume     RESERVED → RELEASED   never executed; usd is
 *                                subtracted from the row's own UTC day
 *   settleVolumeAfterFailure     RESERVED → RELEASED when no broadcast was
 *                                ever attempted, RESERVED → HELD otherwise
 *   holdTransactionVolume        RESERVED → HELD       outcome unknown (dropped);
 *                                stays counted — it may still settle
 *
 * Every settlement is a conditional write on `volumeState = RESERVED`, so a
 * replayed confirmation, a duplicated failure event or two observers racing
 * settle the reservation once. `broadcastAttemptedAt` is written by the
 * transaction processor before the first signed broadcast; after it, a
 * failure is never treated as "never executed".
 *
 * Rows that reserve nothing keep `volumeState` NULL and every settlement is a
 * no-op for them: zero-value transactions, the legacy A2A payment (its spend
 * is the Job's reservation, `reserveJobEscrow` / `releaseJobEscrow`) and the
 * ERC-8183 escrow steps (the Job's reservation too).
 *
 * The reservation takes the agent row lock (`SELECT … FOR UPDATE` on Agent)
 * that the x402 ledger (`ResourcePaymentService.reserve`, P6) takes, so the two
 * spend paths read each other's committed totals and one daily limit holds
 * across both.
 */

import { Prisma, type PrismaClient, type Transaction } from '@prisma/client';
import { parsePolicyDecimal } from './policy-numbers.js';
import { resourcePaymentSpentToday, utcDay } from '../payments/resource-payment-ledger.js';

export type VolumeDb = Pick<PrismaClient, '$transaction' | 'transaction'>;

export type CreateWithVolumeResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; reason: string };

/** Thrown inside the reservation transaction to roll it back; never escapes this module. */
class DailyLimitRefusal extends Error {}

/** USD as a positive finite number, or 0 when there is nothing to reserve. */
function reservableUsd(valueUsd: string | undefined): number {
  const usd = Number.parseFloat(valueUsd ?? '0');
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Creates the Transaction row and its DailyVolume reservation atomically.
 *
 * The daily limit is checked here, under the agent row lock and after the
 * upsert, against everything committed today: DailyVolume (this reservation
 * included) plus the counted x402 payments. `PolicyService.validateTransaction`
 * only pre-checks it (read-only) to fail before simulating.
 *
 * Throws what `transaction.create` throws (e.g. P2002 on a duplicate
 * idempotencyKey); the DailyVolume increment is rolled back with it.
 */
export async function createTransactionWithVolume(
  db: VolumeDb,
  params: {
    agentId: string;
    /** The USD value the policy judged (decimal string). 0 / unparsable: nothing reserved. */
    valueUsd: string | undefined;
    data: Prisma.TransactionUncheckedCreateInput;
    now?: Date;
  },
): Promise<CreateWithVolumeResult> {
  const usd = reservableUsd(params.valueUsd);
  if (usd === 0) {
    return { ok: true, transaction: await db.transaction.create({ data: params.data }) };
  }

  const now = params.now ?? new Date();
  const day = utcDay(now);
  const reservedUsd = usd.toFixed(6);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${params.agentId} FOR UPDATE`;

    const [row] = await tx.$queryRaw<[{ volumeUsd: string }]>`
      INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
      VALUES (gen_random_uuid()::text, ${params.agentId}, ${day}, ${reservedUsd}, NOW())
      ON CONFLICT ("agentId", "date")
      DO UPDATE SET
        "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${reservedUsd}::numeric))::text,
        "updatedAt" = NOW()
      RETURNING "volumeUsd"
    `;

    const policy = await tx.agentPolicy.findUnique({
      where: { agentId: params.agentId },
      select: { active: true, maxDailyVolumeUsd: true },
    });
    // Same reading as validateTransaction: 0 / unparsable = no daily limit.
    const limit = policy?.active ? parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0 : 0;
    if (limit > 0) {
      const x402Usd = Number(await resourcePaymentSpentToday(tx, params.agentId, now)) / 1e6;
      const projected = Number.parseFloat(row?.volumeUsd ?? '0') + x402Usd;
      if (projected > limit) {
        // Throwing rolls the DailyVolume increment back with the transaction.
        throw new DailyLimitRefusal(
          `Daily volume limit of ${policy?.maxDailyVolumeUsd} USD would be exceeded. ` +
            `Current: ${(projected - usd).toFixed(2)}, requested: ${usd.toFixed(2)}`,
        );
      }
    }

    const transaction = await tx.transaction.create({
      data: {
        ...params.data,
        volumeReservedUsd: reservedUsd,
        volumeReservedDate: day,
        volumeState: 'RESERVED',
      },
    });
    return { ok: true as const, transaction };
  }).catch((err: unknown) => {
    if (err instanceof DailyLimitRefusal) return { ok: false as const, reason: err.message };
    throw err;
  });
}

/** RESERVED → COMMITTED (the transaction confirmed). Returns whether this call settled it. */
export async function commitTransactionVolume(db: VolumeDb, transactionId: string): Promise<boolean> {
  const { count } = await db.transaction.updateMany({
    where: { id: transactionId, volumeState: 'RESERVED' },
    data: { volumeState: 'COMMITTED' },
  });
  return count > 0;
}

/** RESERVED → HELD (outcome unknown; the reservation stays counted). */
export async function holdTransactionVolume(db: VolumeDb, transactionId: string): Promise<boolean> {
  const { count } = await db.transaction.updateMany({
    where: { id: transactionId, volumeState: 'RESERVED' },
    data: { volumeState: 'HELD' },
  });
  return count > 0;
}

/**
 * RESERVED → RELEASED and DailyVolume -= the reserved USD on the day it was
 * reserved, in one database transaction. Only for a transaction that never
 * executed: refused or rejected before broadcasting, or mined and REVERTED.
 */
export async function releaseTransactionVolume(db: VolumeDb, transactionId: string): Promise<boolean> {
  return releaseWhere(db, transactionId, {});
}

/**
 * The settlement of a transaction marked FAILED without a receipt (permanent
 * broadcast failure, pre-submit guard, operator rejection): released when no
 * broadcast was ever attempted for it, held otherwise — a signed transaction
 * that reached a node may still mine. Returns what happened, `none` when the
 * row had no live reservation.
 */
export async function settleVolumeAfterFailure(
  db: VolumeDb,
  transactionId: string,
): Promise<'released' | 'held' | 'none'> {
  if (await releaseWhere(db, transactionId, { broadcastAttemptedAt: null })) return 'released';
  const { count } = await db.transaction.updateMany({
    where: { id: transactionId, volumeState: 'RESERVED', broadcastAttemptedAt: { not: null } },
    data: { volumeState: 'HELD' },
  });
  return count > 0 ? 'held' : 'none';
}

async function releaseWhere(
  db: VolumeDb,
  transactionId: string,
  extra: Prisma.TransactionWhereInput,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.transaction.updateMany({
      where: { id: transactionId, volumeState: 'RESERVED', ...extra },
      data: { volumeState: 'RELEASED' },
    });
    if (count === 0) return false;
    const row = await tx.transaction.findUnique({
      where: { id: transactionId },
      select: { agentId: true, volumeReservedUsd: true, volumeReservedDate: true },
    });
    if (row?.volumeReservedUsd && row.volumeReservedDate) {
      await tx.$executeRaw`
        UPDATE "DailyVolume"
        SET "volumeUsd" = GREATEST(0, (("volumeUsd"::numeric) - (${row.volumeReservedUsd}::numeric)))::text,
            "updatedAt" = NOW()
        WHERE "agentId" = ${row.agentId} AND "date" = ${row.volumeReservedDate}
      `;
    }
    return true;
  });
}

/**
 * Stamps the first broadcast attempt (before the signed transaction is sent).
 * The transaction processor passes it to the submitter; if the write fails the
 * submit is aborted before anything is broadcast.
 */
export async function markBroadcastAttempt(db: VolumeDb, transactionId: string, now: Date = new Date()): Promise<void> {
  await db.transaction.updateMany({
    where: { id: transactionId, broadcastAttemptedAt: null },
    data: { broadcastAttemptedAt: now },
  });
}
