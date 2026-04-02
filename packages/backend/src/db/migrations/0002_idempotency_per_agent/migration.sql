-- Migration: 0002_idempotency_per_agent
-- Purpose: scope idempotency to each agent instead of global uniqueness

ALTER TABLE "Transaction"
DROP CONSTRAINT IF EXISTS "Transaction_idempotencyKey_key";

ALTER TABLE "Transaction"
ADD CONSTRAINT "Transaction_agentId_idempotencyKey_key"
UNIQUE ("agentId", "idempotencyKey");
