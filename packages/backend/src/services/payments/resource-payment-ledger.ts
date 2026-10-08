/**
 * ResourcePayment ledger rules shared by the pay-resource service and the
 * policy checks (task P6, second adversarial review 2026-10-08).
 *
 * Which rows count against a job budget and the payer's daily volume:
 *
 *   reserved, pending, settled, unknown   always — money reserved, in flight,
 *                                         moved, or possibly moved.
 *   refused                               while its authorization is LIVE.
 *   failed_before_signing                 never — nothing was signed.
 *
 * `refused` always means "refused AFTER signing": the resource server holds a
 * valid EIP-3009 / Permit2 authorization until `validBefore` and can settle it
 * whatever it answered (a 500, `settle.success: false`, a redirect). Its word
 * is not proof that nothing settled, so the amount stays counted until the
 * authorization can no longer be used — `authorizationValidBefore` has passed
 * — or until a reconciliation proves no transfer happened (not implemented
 * yet; see docs/architecture/x402-payments.md §10). Rows written before
 * migration 0018 have no `authorizationValidBefore`; they are treated as live
 * for `LEGACY_REFUSAL_WINDOW_SECONDS` after their last update (the refusal
 * happened after signing, so that bounds the window from above).
 */

import type { Prisma, PrismaClient, ResourcePaymentStatus } from '@prisma/client';

/** Statuses that count whatever their age. */
export const ALWAYS_COUNTED_STATUSES: ResourcePaymentStatus[] = ['reserved', 'pending', 'settled', 'unknown'];

/**
 * A refused row without a stored `validBefore` is live this long after its
 * last update. Equal to the x402 client's `MAX_AUTHORIZATION_WINDOW_SECONDS`
 * (the longest window it signs; a test pins the two together) — not imported
 * so the policy service does not pull the x402 libraries in.
 */
export const LEGACY_REFUSAL_WINDOW_SECONDS = 600;

function legacyCutoff(now: Date): Date {
  return new Date(now.getTime() - LEGACY_REFUSAL_WINDOW_SECONDS * 1000);
}

/** `refused` rows whose authorization may still be settled at `now`. */
export function liveRefusalWhere(now: Date): Prisma.ResourcePaymentWhereInput {
  return {
    status: 'refused',
    OR: [
      { authorizationValidBefore: { gt: now } },
      { authorizationValidBefore: null, updatedAt: { gt: legacyCutoff(now) } },
    ],
  };
}

/** Rows that count against a job budget and the daily volume at `now`. */
export function countedWhere(now: Date): Prisma.ResourcePaymentWhereInput {
  return {
    OR: [
      { status: { in: ALWAYS_COUNTED_STATUSES } },
      { status: 'refused', authorizationValidBefore: { gt: now } },
      { status: 'refused', authorizationValidBefore: null, updatedAt: { gt: legacyCutoff(now) } },
    ],
  };
}

/**
 * Rows a retry with the same `paymentId` may take over: nothing was signed,
 * or a refused authorization has expired. Never `reserved` / `pending` /
 * `settled` / `unknown`, never a live refusal.
 */
export function retryableWhere(now: Date): Prisma.ResourcePaymentWhereInput {
  return {
    OR: [
      { status: 'failed_before_signing' },
      { status: 'refused', authorizationValidBefore: { lte: now } },
      { status: 'refused', authorizationValidBefore: null, updatedAt: { lte: legacyCutoff(now) } },
    ],
  };
}

interface RefusalFields {
  status: ResourcePaymentStatus;
  authorizationValidBefore: Date | null;
  updatedAt: Date;
}

/** When a `refused` row stops counting; `null` for any other status. */
export function refusalLiveUntil(row: RefusalFields): Date | null {
  if (row.status !== 'refused') return null;
  return row.authorizationValidBefore ?? new Date(row.updatedAt.getTime() + LEGACY_REFUSAL_WINDOW_SECONDS * 1000);
}

/** True for a `refused` row whose authorization may still be settled at `now`. */
export function isLiveRefusal(row: RefusalFields, now: Date): boolean {
  const until = refusalLiveUntil(row);
  return until !== null && until.getTime() > now.getTime();
}

/** Same predicate as `retryableWhere`, for a row already in memory. */
export function isRetryable(row: RefusalFields, now: Date): boolean {
  if (row.status === 'failed_before_signing') return true;
  return row.status === 'refused' && !isLiveRefusal(row, now);
}

/** Sum of base-unit amounts; rows with a malformed amount are skipped. */
export function sumBaseUnits(rows: Array<{ amount: string }>): bigint {
  let total = 0n;
  for (const row of rows) {
    if (/^\d+$/.test(row.amount)) total += BigInt(row.amount);
  }
  return total;
}

/** `YYYY-MM-DD` in UTC — the key `DailyVolume` uses. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Midnight UTC of `now`'s day. */
export function startOfUtcDay(now: Date): Date {
  return new Date(`${utcDay(now)}T00:00:00.000Z`);
}

type LedgerReader = Pick<PrismaClient, 'resourcePayment'> | Prisma.TransactionClient;

/**
 * USDC (base units, 6 decimals = micro-USD; USDC is priced at 1.0) that
 * `agentId` has committed to x402 payments today (UTC): every counted row
 * reserved since midnight, across all its jobs.
 */
export async function resourcePaymentSpentToday(db: LedgerReader, agentId: string, now: Date): Promise<bigint> {
  const rows = await db.resourcePayment.findMany({
    where: { agentId, reservedAt: { gte: startOfUtcDay(now) }, ...countedWhere(now) },
    select: { amount: true },
  });
  return sumBaseUnits(rows);
}
