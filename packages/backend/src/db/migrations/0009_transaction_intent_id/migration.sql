-- Migration: 0009_transaction_intent_id
-- Purpose: Add a system-generated, deterministic idempotency key on
--          Transaction so that internal callers (currently the A2A payment
--          path; recovery worker after #73 lands) can re-invoke
--          executeA2APayment without double-spending. The call site supplies
--          intentId = "a2a-payment:<jobId>"; the function short-circuits to
--          the existing Transaction row if a match exists.
--
-- Distinct from the existing per-agent idempotencyKey:
--   * idempotencyKey is user-supplied via the HTTP request, scoped per
--     agent (@@unique([agentId, idempotencyKey])).
--   * intentId is system-supplied for internal flows, globally unique. It
--     never crosses the API boundary, so the agent scope is not needed and
--     a global key keeps the recovery worker's lookups dead-simple.
--
-- Notes:
--   * NULL is allowed for non-A2A txs (the vast majority). Postgres' default
--     NULLS DISTINCT semantics let the unique constraint coexist with many
--     NULL rows, so no partial-index workaround is required.
--   * Idempotent: IF NOT EXISTS guards keep this re-runnable in dev/CI.

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "intentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_intentId_key"
  ON "Transaction"("intentId");
