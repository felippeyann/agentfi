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
 *   settleVolumeAfterRevert      RESERVED → RELEASED after exactly one signed
 *                                broadcast (the value never moved), HELD after
 *                                more (an earlier one may have been mined)
 *   settleVolumeAfterFailure     RESERVED → RELEASED when no broadcast was
 *                                ever attempted, HELD otherwise
 *   holdTransactionVolume        RESERVED → HELD       outcome unknown (dropped)
 *
 * RELEASED subtracts the reserved USD from the row's own UTC day; HELD keeps
 * it counted because the transaction may still settle.
 *
 * Every settlement is a conditional write on `volumeState = RESERVED`, so a
 * replayed confirmation, a duplicated failure event or two observers racing
 * settle the reservation once. The transaction processor stamps the row
 * (`markBroadcastAttempt`) after signing and before every broadcast; the stamp
 * is itself conditional on the row still being QUEUED without a hash, so a
 * worker that lost the row to the pre-submit guard does not broadcast. A
 * status write and its settlement are separate writes: a crash between them
 * is repaired by `sweepUnsettledVolume` on the payment-recovery tick.
 *
 * A6b: the stamp also records the signed hash (`broadcastTxHash`). A stamped
 * row is never FAILED by the guard, the failed handler or the stranded-QUEUED
 * sweep: `stopStampedTransaction` hands it to the chain (SUBMITTED with that
 * hash) and the receipt — or the re-poll's drop — settles it as above.
 *
 * A6c: an operator approval revalidates the spend on the approval day and
 * moves a reservation made on an earlier UTC day to it, refused — nothing
 * moved, nothing released — when that day's limit would be exceeded
 * (`approvePendingTransaction`).
 *
 * Rows that reserve nothing keep `volumeState` NULL and every settlement is a
 * no-op for them: zero-value transactions, the legacy A2A payment (its spend
 * is the Job's reservation, `reserveJobEscrow` / `releaseJobEscrow`) and the
 * ERC-8183 escrow steps (the Job's reservation too).
 *
 * The reservation takes the agent row lock (`SELECT … FOR NO KEY UPDATE` on
 * Agent), which conflicts with the x402 ledger's `FOR UPDATE`
 * (`ResourcePaymentService.reserve`, P6) and with the escrow job reservation
 * (C3d), so the three spend paths read each other's committed totals and one
 * daily limit holds across them.
 */

import { Prisma, type PrismaClient, type Transaction } from '@prisma/client';
import { parsePolicyDecimal } from './policy-numbers.js';
import type { SpendPriceSource } from './spend-pricing.js';
import { resourcePaymentSpentToday, utcDay } from '../payments/resource-payment-ledger.js';

export type VolumeDb = Pick<PrismaClient, '$transaction' | 'transaction'>;

export type CreateWithVolumeResult =
  /** `replayed`: a row with the same idempotencyKey already existed; it is returned and nothing was reserved. */
  | { ok: true; transaction: Transaction; replayed: boolean }
  | { ok: false; code: 'DAILY_LIMIT' | 'PRICE_UNAVAILABLE'; reason: string };

/** Thrown inside the reservation transaction to roll it back; never escapes this module. */
class ReservationRefusal extends Error {
  constructor(
    readonly code: 'DAILY_LIMIT' | 'PRICE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thrown by `markBroadcastAttempt` when the row is no longer broadcastable
 * (the guard or an operator failed it, or another attempt already recorded a
 * hash). The submitter aborts before sending anything.
 */
export class BroadcastNotAllowedError extends Error {}

/** Interactive-transaction limits: waiting for the agent lock counts against `timeout`. */
const RESERVATION_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** USD as a positive finite number, or 0 when there is nothing to reserve. */
function reservableUsd(valueUsd: string | undefined): number {
  const usd = Number.parseFloat(valueUsd ?? '0');
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Creates the Transaction row and its DailyVolume reservation atomically.
 *
 * Under the agent row lock, in order:
 *  1. a row with the same idempotencyKey already exists → it is returned
 *     (`replayed`), nothing is reserved;
 *  2. a spend with an unpriced component (`unpricedReason`, Q9 — any asset,
 *     not only native value as in A6) while a daily limit applies → refused
 *     (`PRICE_UNAVAILABLE`, fail closed): an unpriced spend would be counted
 *     as 0. The routes refuse it earlier, before simulating
 *     (`validateTransaction`); this is the binding check under the lock;
 *  3. DailyVolume += usd, then the binding limit check against everything
 *     committed today (DailyVolume, this reservation included, plus the
 *     counted x402 payments) → refused (`DAILY_LIMIT`) and rolled back;
 *  4. the row is inserted as RESERVED, with the price source of `usd`
 *     (`volumePriceSource`: oracle / synthetic / usdc-peg, Q9).
 * `PolicyService.validateTransaction` only pre-checks the limit (read-only) to
 * fail before simulating.
 *
 * Throws what `transaction.create` throws; the DailyVolume increment is
 * rolled back with it.
 */
export async function createTransactionWithVolume(
  db: VolumeDb,
  params: {
    agentId: string;
    /** The USD value the policy judged (decimal string). 0 / unparsable: nothing reserved. */
    valueUsd: string | undefined;
    /**
     * Set when a component of the spend has no trusted price (Q9,
     * `spend-pricing.ts`): the reason. Refused when a daily limit applies;
     * otherwise only the priced part (`valueUsd`) is reserved.
     */
    unpricedReason?: string;
    /** Price source of `valueUsd`, stored next to the reservation (`volumePriceSource`). */
    priceSource?: SpendPriceSource | null;
    data: Prisma.TransactionUncheckedCreateInput;
    now?: Date;
  },
): Promise<CreateWithVolumeResult> {
  const usd = reservableUsd(params.valueUsd);
  const unpriced = params.unpricedReason !== undefined;
  const needsLock = usd > 0 || unpriced || Boolean(params.data.idempotencyKey);
  if (!needsLock) {
    return { ok: true, transaction: await db.transaction.create({ data: params.data }), replayed: false };
  }

  const now = params.now ?? new Date();
  const day = utcDay(now);
  const reservedUsd = usd.toFixed(6);

  return db
    .$transaction(async (tx) => {
      // NO KEY UPDATE (as C3d's escrow reservation): it conflicts with the x402
      // ledger's FOR UPDATE and with itself, so one agent's spends are checked
      // one at a time, without blocking the FOR KEY SHARE a Job insert naming
      // this agent as provider takes through its foreign key.
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${params.agentId} FOR NO KEY UPDATE`;

      const key = params.data.idempotencyKey;
      if (key) {
        const existing = await tx.transaction.findUnique({
          where: { agentId_idempotencyKey: { agentId: params.agentId, idempotencyKey: key } },
        });
        if (existing) return { ok: true as const, transaction: existing, replayed: true };
      }

      const policy = await tx.agentPolicy.findUnique({
        where: { agentId: params.agentId },
        select: { active: true, maxDailyVolumeUsd: true },
      });
      // Same reading as validateTransaction: 0 / unparsable = no daily limit.
      const limit = policy?.active ? parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0 : 0;

      if (unpriced && limit > 0) {
        throw new ReservationRefusal(
          'PRICE_UNAVAILABLE',
          `${params.unpricedReason}. The daily volume limit of ${policy?.maxDailyVolumeUsd} USD cannot be checked, ` +
            'so the spend is refused (it would otherwise count as 0).',
        );
      }

      if (usd === 0) {
        return { ok: true as const, transaction: await tx.transaction.create({ data: params.data }), replayed: false };
      }

      const [row] = await tx.$queryRaw<[{ volumeUsd: string }]>`
        INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
        VALUES (gen_random_uuid()::text, ${params.agentId}, ${day}, ${reservedUsd}, NOW())
        ON CONFLICT ("agentId", "date")
        DO UPDATE SET
          "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${reservedUsd}::numeric))::text,
          "updatedAt" = NOW()
        RETURNING "volumeUsd"
      `;

      if (limit > 0) {
        const x402Usd = Number(await resourcePaymentSpentToday(tx, params.agentId, now)) / 1e6;
        const projected = Number.parseFloat(row?.volumeUsd ?? '0') + x402Usd;
        if (projected > limit) {
          // Throwing rolls the DailyVolume increment back with the transaction.
          throw new ReservationRefusal(
            'DAILY_LIMIT',
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
          volumePriceSource: params.priceSource ?? null,
        },
      });
      return { ok: true as const, transaction, replayed: false };
    }, RESERVATION_TX_OPTIONS)
    .catch((err: unknown) => {
      if (err instanceof ReservationRefusal) return { ok: false as const, code: err.code, reason: err.message };
      throw err;
    });
}

/** Why `approvePendingTransaction` refused. The row is left exactly as it was. */
export type ApprovalRefusalCode =
  /** Not (or no longer) PENDING_APPROVAL: a concurrent approval or rejection won. */
  | 'APPROVAL_NOT_PENDING'
  /** The agent was paused (`Agent.active = false`) since the request. */
  | 'APPROVAL_AGENT_PAUSED'
  /** The agent's policy is inactive (kill switch) since the request. */
  | 'APPROVAL_POLICY_INACTIVE'
  /** The agent's policy expired (`expiresAt`) since the request. */
  | 'APPROVAL_POLICY_EXPIRED'
  /** Counting the spend on the approval day would exceed that day's `maxDailyVolumeUsd`. */
  | 'APPROVAL_DAILY_LIMIT'
  /** A daily limit applies now but the spend reserved nothing (it was unpriced while no limit applied). */
  | 'APPROVAL_UNCOUNTED_SPEND';

export type ApprovalResult =
  /** Approved: the row is QUEUED; `moved` when its reservation went from an earlier day to `day`. */
  | { ok: true; day: string; moved: boolean }
  | {
      ok: false;
      code: ApprovalRefusalCode;
      reason: string;
      /** APPROVAL_DAILY_LIMIT only: the approval day's numbers (USD, decimal strings). */
      details?: { day: string; limitUsd: string; committedUsd: string; requestedUsd: string };
    };

/** Thrown inside the approval transaction to roll it back; never escapes this module. */
class ApprovalRefusal extends Error {
  constructor(readonly result: Extract<ApprovalResult, { ok: false }>) {
    super(result.reason);
  }
}

function refuseApproval(code: ApprovalRefusalCode, reason: string, details?: Extract<ApprovalResult, { ok: false }>['details']): never {
  throw new ApprovalRefusal({ ok: false, code, reason, ...(details ? { details } : {}) });
}

/** The legacy A2A payment row: its spend is the Job's reservation (`reserveJobEscrow`), not the row's. */
function isLegacyA2APayment(metadata: Prisma.JsonValue | null): boolean {
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) && metadata['a2aPayment'] === true;
}

/**
 * The operator's approval of a PENDING_APPROVAL transaction (A6c, plan §5
 * question 8): revalidates the spend on the EFFECTIVE approval day — the UTC
 * day of `now`, when it executes — and approves it, atomically.
 *
 * One database transaction under the agent row lock (`FOR NO KEY UPDATE`, the
 * lock every reservation path takes, so x402 payments, escrow jobs, new
 * transactions and other approvals of the same agent are judged one at a
 * time), in order:
 *  1. the row must still be PENDING_APPROVAL;
 *  2. the agent must be active and its policy active and unexpired (the
 *     pre-submit guard's rules, checked here so the operator is told now);
 *  3. a daily limit applies but the spend reserved nothing (unpriced when no
 *     limit applied — D15: never counted as 0) → refused; the legacy A2A
 *     payment is exempt (its spend is the Job's reservation, see below);
 *  4. PENDING_APPROVAL → QUEUED, conditional (a rejection takes no agent lock;
 *     whichever writes first wins, the other matches nothing);
 *  5. a reservation made on an earlier UTC day moves to the approval day
 *     (A6b: it executes then; counted on its creation day the approval day's
 *     limit would hand the agent a full fresh budget on top of it);
 *  6. the approval day's DailyVolume — this reservation included — plus its
 *     counted x402 payments must stay within `maxDailyVolumeUsd`; on the
 *     creation day too (the total there includes it already: only a limit
 *     lowered since the request can refuse it).
 * Any refusal throws inside the transaction: the status, the move and the
 * DailyVolume writes roll back together — the row stays PENDING_APPROVAL with
 * its reservation untouched on the day it was made; nothing is released or
 * moved. A database error rolls back the same way and is rethrown.
 *
 * An ordinary approval never exceeds the daily limit. Approving beyond it
 * would need a separate, explicit, audited operator act, which does not exist
 * (the operator can raise the policy's limit, an audited policy change of its
 * own, and approve again).
 *
 * Not revalidated here: the per-transaction caps, the allowlists and the
 * cooldown (judged at the request), and the legacy A2A payment's Job
 * reservation, which stays on the Job's day (legacy path, D8).
 */
export async function approvePendingTransaction(
  db: VolumeDb,
  transactionId: string,
  now: Date = new Date(),
): Promise<ApprovalResult> {
  const today = utcDay(now);
  const owner = await db.transaction.findUnique({ where: { id: transactionId }, select: { agentId: true } });
  if (!owner) return { ok: false, code: 'APPROVAL_NOT_PENDING', reason: 'Transaction not found.' };
  const agentId = owner.agentId;

  return db
    .$transaction(async (tx): Promise<ApprovalResult> => {
      const [agent] = await tx.$queryRaw<Array<{ active: boolean }>>`
        SELECT "active" FROM "Agent" WHERE "id" = ${agentId} FOR NO KEY UPDATE
      `;
      const row = await tx.transaction.findUnique({
        where: { id: transactionId },
        select: { status: true, volumeState: true, volumeReservedUsd: true, volumeReservedDate: true, metadata: true },
      });
      if (row?.status !== 'PENDING_APPROVAL') refuseApproval('APPROVAL_NOT_PENDING', 'Transaction is no longer PENDING_APPROVAL.');
      if (!agent?.active) refuseApproval('APPROVAL_AGENT_PAUSED', 'The agent is paused; it cannot be approved. Resume the agent first.');

      const policy = await tx.agentPolicy.findUnique({
        where: { agentId },
        select: { active: true, expiresAt: true, maxDailyVolumeUsd: true },
      });
      if (policy && !policy.active) {
        refuseApproval('APPROVAL_POLICY_INACTIVE', 'Agent policy is paused (kill switch active); it cannot be approved.');
      }
      if (policy?.expiresAt && policy.expiresAt < now) {
        refuseApproval('APPROVAL_POLICY_EXPIRED', `Agent policy expired at ${policy.expiresAt.toISOString()}; it cannot be approved.`);
      }
      // Same reading as everywhere: no policy, 0 or unparsable = no daily limit.
      const limit = policy ? parsePolicyDecimal(policy.maxDailyVolumeUsd) ?? 0 : 0;

      const reserved =
        row.volumeState === 'RESERVED' && row.volumeReservedUsd && row.volumeReservedDate
          ? { usd: row.volumeReservedUsd, day: row.volumeReservedDate }
          : null;
      if (!reserved && limit > 0 && !isLegacyA2APayment(row.metadata)) {
        refuseApproval(
          'APPROVAL_UNCOUNTED_SPEND',
          `This spend reserved nothing in the daily volume (it could not be priced when no daily limit applied), and the daily volume ` +
            `limit of ${policy?.maxDailyVolumeUsd} USD applies now, so it cannot be checked. Reject it; the agent can request it again.`,
        );
      }

      const move = reserved !== null && reserved.day < today;
      const { count } = await tx.transaction.updateMany({
        where: { id: transactionId, status: 'PENDING_APPROVAL' },
        data: { status: 'QUEUED', ...(move ? { volumeReservedDate: today } : {}) },
      });
      if (count === 0) refuseApproval('APPROVAL_NOT_PENDING', 'Transaction is no longer PENDING_APPROVAL.');

      if (!reserved) return { ok: true, day: today, moved: false };

      // The day the reservation counts on from now on (a creation day "after"
      // `now` — clock skew around midnight — keeps its own day).
      const day = move ? today : reserved.day;
      let dayVolumeUsd: string;
      if (move) {
        await tx.$executeRaw`
          UPDATE "DailyVolume"
          SET "volumeUsd" = GREATEST(0, (("volumeUsd"::numeric) - (${reserved.usd}::numeric)))::text,
              "updatedAt" = NOW()
          WHERE "agentId" = ${agentId} AND "date" = ${reserved.day}
        `;
        const [added] = await tx.$queryRaw<[{ volumeUsd: string }]>`
          INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
          VALUES (gen_random_uuid()::text, ${agentId}, ${today}, ${reserved.usd}, NOW())
          ON CONFLICT ("agentId", "date")
          DO UPDATE SET
            "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${reserved.usd}::numeric))::text,
            "updatedAt" = NOW()
          RETURNING "volumeUsd"
        `;
        dayVolumeUsd = added?.volumeUsd ?? reserved.usd;
      } else {
        const current = await tx.dailyVolume.findUnique({
          where: { agentId_date: { agentId, date: day } },
          select: { volumeUsd: true },
        });
        dayVolumeUsd = current?.volumeUsd ?? reserved.usd;
      }

      if (limit > 0) {
        const x402Usd = Number(await resourcePaymentSpentToday(tx, agentId, now)) / 1e6;
        const projected = Number.parseFloat(dayVolumeUsd) + x402Usd;
        if (projected > limit) {
          const requested = Number.parseFloat(reserved.usd);
          const committed = Math.max(0, projected - requested);
          refuseApproval(
            'APPROVAL_DAILY_LIMIT',
            `Approving it on ${day} would exceed the daily volume limit of ${policy?.maxDailyVolumeUsd} USD: ` +
              `${committed.toFixed(2)} USD already committed that day, ${requested.toFixed(2)} USD requested. ` +
              'An approval never exceeds the daily limit; it stays PENDING_APPROVAL (approve it when the day has room, or reject it).',
            { day, limitUsd: policy?.maxDailyVolumeUsd ?? String(limit), committedUsd: committed.toFixed(6), requestedUsd: requested.toFixed(6) },
          );
        }
      }
      return { ok: true, day, moved: move };
    }, RESERVATION_TX_OPTIONS)
    .catch((err: unknown) => {
      if (err instanceof ApprovalRefusal) return err.result;
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
 * The settlement of a REVERTED receipt: the recorded transaction moved no
 * value. Released when it was the only signed broadcast for the row; held
 * when an earlier attempt also broadcast (that one may have been mined, e.g.
 * its SUBMITTED write was lost and the retry reverted for lack of funds).
 */
export async function settleVolumeAfterRevert(
  db: VolumeDb,
  transactionId: string,
): Promise<'released' | 'held' | 'none'> {
  if (await releaseWhere(db, transactionId, { broadcastAttempts: { lte: 1 } })) return 'released';
  return (await holdTransactionVolume(db, transactionId)) ? 'held' : 'none';
}

/**
 * The settlement of a transaction marked FAILED without a receipt (permanent
 * broadcast failure, pre-submit guard, operator rejection, enqueue failure):
 * released when no broadcast was ever attempted for it and it carries no hash,
 * held otherwise — a signed transaction that reached a node may still mine.
 * Returns what happened, `none` when the row had no live reservation.
 */
export async function settleVolumeAfterFailure(
  db: VolumeDb,
  transactionId: string,
): Promise<'released' | 'held' | 'none'> {
  if (await releaseWhere(db, transactionId, { broadcastAttemptedAt: null, txHash: null })) return 'released';
  return (await holdTransactionVolume(db, transactionId)) ? 'held' : 'none';
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
 * Stamps a broadcast attempt, after signing and before the signed transaction
 * is sent: the first one sets `broadcastAttemptedAt`, every one increments
 * `broadcastAttempts`, and `broadcastTxHash` records the hash of the signed
 * transaction about to be sent (A6b: the chain can then decide the outcome of
 * a row whose attempt failed or whose SUBMITTED write was lost). Conditional
 * on the row still being QUEUED without a hash; otherwise throws
 * `BroadcastNotAllowedError` and the submitter sends nothing (a stalled-job
 * redelivery whose row the guard already failed and released). Any other
 * error also aborts the submit before broadcasting.
 */
export async function markBroadcastAttempt(
  db: Pick<PrismaClient, '$executeRaw'>,
  transactionId: string,
  signedTxHash: string | null = null,
): Promise<void> {
  const updated = await db.$executeRaw`
    UPDATE "Transaction"
    SET "broadcastAttemptedAt" = COALESCE("broadcastAttemptedAt", NOW()),
        "broadcastAttempts" = "broadcastAttempts" + 1,
        "broadcastTxHash" = COALESCE(${signedTxHash}::text, "broadcastTxHash")
    WHERE "id" = ${transactionId} AND "status" = 'QUEUED' AND "txHash" IS NULL
  `;
  if (updated === 0) {
    throw new BroadcastNotAllowedError(`Transaction ${transactionId} is no longer QUEUED without a hash — not broadcasting`);
  }
}

/** What `stopStampedTransaction` did to the row. */
export type StampedStop =
  /** SUBMITTED with the stamped hash: the re-poll (or the delivery that sent it) records the receipt, or drops it after the grace. */
  | { outcome: 'handed-to-chain'; txHash: string }
  /**
   * FAILED with the error. `broadcastAttempted`: a signed attempt was stamped
   * but cannot be handed to the chain (stamped before migration 0024, so no
   * hash; or `handToChain: false`) — its outcome is unknown.
   */
  | { outcome: 'failed'; broadcastAttempted: boolean }
  /** The row was no longer QUEUED without a hash (another delivery recorded its broadcast): untouched. */
  | { outcome: 'not-queued' };

/**
 * Stops a row that is still QUEUED without a hash, when an earlier attempt
 * may have been stamped for broadcast (A6b). The pre-submit guard (agent
 * paused, policy expired), the permanent-failure handler and the
 * stranded-QUEUED sweep call it once their plain "never stamped → FAILED"
 * write matched nothing.
 *
 * A stamped row is never FAILED when its signed hash is known and
 * `handToChain` is set: that transaction may be in a mempool or a block (the
 * delivery that sent it may even be about to write SUBMITTED), and FAILED
 * would let the A2A finalizer refund a payment that is then mined. It becomes
 * SUBMITTED with `broadcastTxHash`, exactly the state of a recorded broadcast,
 * and the chain decides: the re-poll records its receipt (CONFIRMED commits,
 * REVERTED settles) or, after the drop grace with no node knowing it, FAILS it
 * — with the reservation HELD for an ordinary transaction and the A2A
 * finalizer run then.
 *
 * One conditional UPDATE (Postgres re-evaluates it against a concurrent stamp
 * or SUBMITTED write), so no stamp can slip between a check and the write.
 * The hash is not handed over when another row already carries it (two rows
 * that signed byte-identical transactions — the unique `txHash`).
 */
export async function stopStampedTransaction(
  db: Pick<PrismaClient, '$queryRaw'>,
  transactionId: string,
  error: string,
  opts: { handToChain: boolean },
): Promise<StampedStop> {
  const rows = await db.$queryRaw<Array<{ status: string; txHash: string | null; broadcastAttempted: boolean }>>`
    UPDATE "Transaction" AS t
    SET "status" = (CASE WHEN ${opts.handToChain}::boolean AND t."broadcastTxHash" IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM "Transaction" o WHERE o."txHash" = t."broadcastTxHash")
                         THEN 'SUBMITTED' ELSE 'FAILED' END)::"TxStatus",
        "txHash" = (CASE WHEN ${opts.handToChain}::boolean AND t."broadcastTxHash" IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM "Transaction" o WHERE o."txHash" = t."broadcastTxHash")
                         THEN t."broadcastTxHash" ELSE NULL END),
        "error" = (CASE WHEN ${opts.handToChain}::boolean AND t."broadcastTxHash" IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM "Transaction" o WHERE o."txHash" = t."broadcastTxHash")
                        THEN NULL ELSE ${error}::text END),
        "updatedAt" = NOW()
    WHERE t."id" = ${transactionId} AND t."status" = 'QUEUED' AND t."txHash" IS NULL
    RETURNING t."status"::text AS "status", t."txHash", (t."broadcastAttemptedAt" IS NOT NULL) AS "broadcastAttempted"
  `;
  const row = rows[0];
  if (!row) return { outcome: 'not-queued' };
  if (row.status === 'SUBMITTED' && row.txHash) return { outcome: 'handed-to-chain', txHash: row.txHash };
  return { outcome: 'failed', broadcastAttempted: row.broadcastAttempted };
}

export interface VolumeSweepSummary {
  scanned: number;
  committed: number;
  released: number;
  held: number;
  errors: number;
}

/**
 * Repairs reservations left RESERVED on a terminal row: the status write and
 * the settlement are separate writes, so a crash or a database error between
 * them would otherwise keep the reservation counted (or never commit it)
 * forever. Runs on the payment-recovery tick for rows untouched since
 * `olderThan`: CONFIRMED commits, REVERTED and FAILED settle exactly as their
 * first observer would have. Idempotent (every settlement is conditional).
 */
export async function sweepUnsettledVolume(
  db: VolumeDb,
  opts: { olderThan: Date; limit: number },
): Promise<VolumeSweepSummary> {
  const rows = await db.transaction.findMany({
    where: {
      volumeState: 'RESERVED',
      status: { in: ['CONFIRMED', 'REVERTED', 'FAILED'] },
      updatedAt: { lte: opts.olderThan },
    },
    orderBy: { updatedAt: 'asc' },
    take: opts.limit,
    select: { id: true, status: true },
  });
  const summary: VolumeSweepSummary = { scanned: rows.length, committed: 0, released: 0, held: 0, errors: 0 };
  for (const row of rows) {
    try {
      if (row.status === 'CONFIRMED') {
        if (await commitTransactionVolume(db, row.id)) summary.committed++;
        continue;
      }
      const outcome =
        row.status === 'REVERTED' ? await settleVolumeAfterRevert(db, row.id) : await settleVolumeAfterFailure(db, row.id);
      if (outcome === 'released') summary.released++;
      if (outcome === 'held') summary.held++;
    } catch {
      summary.errors++;
    }
  }
  return summary;
}
