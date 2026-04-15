-- Migration: 0005_job_escrow
-- Purpose: Add escrow fields to Job so that reward funds are "reserved"
--          at job creation time and released on COMPLETED/FAILED/CANCELLED.
--          This prevents a requester from draining their wallet after
--          creating a paid job but before the provider completes it.
--
-- Reserved state is tracked via reservationStatus:
--   PENDING    — reservation active, funds committed to daily volume
--   RELEASED   — job completed, payment executed (escrow consumed)
--   CANCELLED  — job cancelled/failed, daily volume credit returned

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "reservedAmount"    TEXT,
  ADD COLUMN IF NOT EXISTS "reservedToken"     TEXT,
  ADD COLUMN IF NOT EXISTS "reservedChainId"   INTEGER,
  ADD COLUMN IF NOT EXISTS "reservedAt"        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "reservationStatus" TEXT;

-- Index for cleanup queries (find pending reservations by status)
CREATE INDEX IF NOT EXISTS "Job_reservationStatus_idx"
  ON "Job" ("reservationStatus");
