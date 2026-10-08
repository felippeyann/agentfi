-- Migration: 0019_c3d_contest_review
-- Purpose: task C3d of the Q4-2026 execution plan (owner decision D9, second
--          adversarial review 2026-10-08). See docs/architecture/erc-8183-mapping.md §6.8.
--
--   Job.resolution / resolvedBy / resolvedAt / resolutionNote — the operator's
--     decision on an ERC-8183 job held for review (a requester's contest, a
--     CANCELLED/FAILED job whose deliverable is Submitted on-chain, a provider
--     that cannot receive the payout): "pay", "refund", "quality-rejected" or
--     "payout-blocked", who took it, when, and the note.
--   Job.reviewLog — append-only JSON array of every decision taken on the job
--     (a decision whose settlement failed can be replaced; the history stays).
--   Job.reviewAlertedAt — when the "job held for review close to expiresAt"
--     operator alert was sent (sent once).
--   Job.ratedAgentId — the ERC-8004 agent id the ReputationHook actually rated
--     (its canonicalAgentId for the provider address), which can differ from
--     providerAgentId when a provider address ever bound another identity.
--   Job.reservedValueUsd — the USD amount the reservation added to the
--     requester's DailyVolume ("0" when no daily limit applied), so a release
--     credits back exactly what was reserved instead of re-pricing the reward.
--
-- Rows contested before C3d and not yet settled (PAYMENT_PENDING + SUBMITTED
-- with contestedAt) are moved to the new CONTESTED hold, so the settlement
-- worker does not reject them automatically any more.

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "resolution" TEXT,
  ADD COLUMN IF NOT EXISTS "resolvedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolutionNote" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewLog" JSONB,
  ADD COLUMN IF NOT EXISTS "reviewAlertedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ratedAgentId" TEXT,
  ADD COLUMN IF NOT EXISTS "reservedValueUsd" TEXT;

UPDATE "Job"
SET "onChainStatus" = 'CONTESTED'
WHERE "escrowKind" = 'erc8183'
  AND "contestedAt" IS NOT NULL
  AND "status" = 'PAYMENT_PENDING'
  AND "onChainStatus" = 'SUBMITTED';
