-- Migration: 0008_job_payment_status
-- Purpose: Add intermediate payment lifecycle states to JobStatus so the
--          PATCH /v1/jobs/:id handler stops reporting revenue for jobs
--          whose on-chain payment has not yet confirmed (or failed).
--
--          PAYMENT_PENDING: provider marked work done, payment fired but
--          not yet confirmed on-chain. Revenue must NOT be counted here.
--
--          PAYMENT_FAILED: payment broadcast failed (or reverted) after
--          provider marked the work done. Escrow is refunded to requester.
--
-- Notes:
--   * Postgres requires `ALTER TYPE ... ADD VALUE` to run outside an
--     explicit transaction in older server versions; Prisma's migrate
--     deploy runs each statement separately, so we keep them as two
--     standalone statements with IF NOT EXISTS for idempotency.
--   * Existing rows are unaffected — old jobs keep their COMPLETED status.

ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';
