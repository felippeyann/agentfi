-- Migration: 0020_a6_transaction_volume
-- Purpose: DailyVolume accounting of ordinary transactions (plan task A6).
--   An ordinary transaction reserves its USD value in DailyVolume in the same
--   database transaction that creates its row, and the reservation is settled
--   exactly once from here (conditional writes on "volumeState"):
--     RESERVED -> COMMITTED  the transaction confirmed; it stays counted
--     RESERVED -> RELEASED   it never executed (refused or failed before any
--                            broadcast attempt, rejected by the operator, or
--                            mined and REVERTED): subtracted from the day in
--                            "volumeReservedDate", by "volumeReservedUsd"
--     RESERVED -> HELD       its outcome is unknown (permanent failure after a
--                            broadcast attempt, dropped from the mempool): it
--                            stays counted, it may still settle
--   "broadcastAttemptedAt" is written before the first signed broadcast is
--   sent; a failure after it is never treated as "never executed".
--   "broadcastAttempts" counts the signed broadcasts (one per attempt that
--   reached the network call): a REVERTED receipt releases only when there was
--   exactly one, since an earlier attempt's transaction may have been mined.
--   The (volumeState, updatedAt) index serves the payment-recovery sweep of
--   reservations left RESERVED on a terminal row (a crash between the status
--   write and the settlement).
--   Rows without a reservation keep "volumeState" NULL: zero-value
--   transactions, the legacy A2A payment (counted by its Job reservation) and
--   the ERC-8183 escrow steps. Existing rows are not backfilled: an in-flight
--   row at deploy time keeps whatever it reserved at enqueue and is not
--   counted again when it confirms.

-- CreateEnum
CREATE TYPE "VolumeState" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'HELD');

ALTER TABLE "Transaction"
  ADD COLUMN "volumeReservedUsd" TEXT,
  ADD COLUMN "volumeReservedDate" TEXT,
  ADD COLUMN "volumeState" "VolumeState",
  ADD COLUMN "broadcastAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "broadcastAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Transaction_volumeState_updatedAt_idx" ON "Transaction"("volumeState", "updatedAt");
