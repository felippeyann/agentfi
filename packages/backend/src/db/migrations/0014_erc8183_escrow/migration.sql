-- Migration: 0014_erc8183_escrow
-- Purpose: C3 of the Q4-2026 execution plan — the backend drives the ERC-8183
--          `AgentJobEscrow` contract for paid agent-to-agent jobs. A Job that
--          runs on the escrow carries its on-chain identity and lifecycle here
--          (escrowKind = 'erc8183'); legacy and free jobs keep every new column
--          NULL and behave exactly as before.
--
-- Columns (all nullable, see docs/architecture/erc-8183-mapping.md §6):
--   escrowKind / escrowChainId / escrowContract / onChainJobId  — which contract
--     and which uint256 job id (decimal string) this Job maps to.
--   onChainStatus — backend view of the chain: CREATING, OPEN, BUDGET_SET,
--     APPROVED, FUNDED, SUBMITTED, SETTLING, COMPLETED, REJECTED, EXPIRED, FAILED.
--   evaluator — operator/backend signer address (decision D5).
--   budgetToken / budgetAmount — USDC address and budget in base units (D8).
--   expiresAt — on-chain `expiredAt`; claimRefund is possible after it.
--   deliverableHash — keccak256 of the provider's result JSON, passed to submit.
--   settleTxHash / platformFeeAmount / feedbackStatus / feedbackFile — what the
--     evaluator's complete/reject/claimRefund produced (fee accrued, ERC-8004
--     feedback written / skipped:<reason> / failed, the hashed feedback file).
--   contestedAt / contestReason — requester contested before settlement.
--   escrowError — last step or settlement error, for operators and retries.
--
-- TxType gains ESCROW_SUBMIT: the provider's `submit` transaction. The
-- requester's create/setBudget/approve/fund chain reuses ESCROW_LOCK with
-- metadata.escrowStep; the evaluator signs outside the transaction queue.
--
-- Idempotent: IF NOT EXISTS guards keep this re-runnable in dev/CI. Postgres
-- treats NULLs as distinct in the unique index, so legacy rows never collide.

ALTER TYPE "TxType" ADD VALUE IF NOT EXISTS 'ESCROW_SUBMIT';

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "escrowKind" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "escrowChainId" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "escrowContract" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "onChainJobId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "onChainStatus" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "evaluator" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "budgetToken" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "budgetAmount" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "deliverableHash" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "settleTxHash" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "platformFeeAmount" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "feedbackStatus" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "feedbackFile" JSONB;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "contestedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "contestReason" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "escrowError" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Job_escrowContract_onChainJobId_key"
  ON "Job"("escrowContract", "onChainJobId");
CREATE INDEX IF NOT EXISTS "Job_onChainStatus_idx" ON "Job"("onChainStatus");
CREATE INDEX IF NOT EXISTS "Job_expiresAt_idx" ON "Job"("expiresAt");
