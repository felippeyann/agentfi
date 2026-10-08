-- Migration: 0018_resource_payment_valid_before
-- Purpose: pay-resource money fixes (plan task P6, second adversarial review 2026-10-08).
--   "authorizationValidBefore" — EIP-3009 validBefore / Permit2 deadline of the
--     signed authorization. A `refused` row (the server answered the signed
--     payment without reporting a settlement) keeps counting against the job
--     budget and the payer's daily volume until it has passed, and blocks new
--     signatures to the same payTo on that job. NULL on older rows: they are
--     treated as live for 600 s after their last update.
--   "reservedAt" — when the row was last reserved (a retry reuses the row), so
--     x402 spend lands in the right day of the payer's daily volume. Existing
--     rows are backfilled from "updatedAt".

ALTER TABLE "ResourcePayment"
  ADD COLUMN "authorizationValidBefore" TIMESTAMP(3),
  ADD COLUMN "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ResourcePayment" SET "reservedAt" = "updatedAt";

-- CreateIndex
CREATE INDEX "ResourcePayment_agentId_reservedAt_idx" ON "ResourcePayment"("agentId", "reservedAt");
