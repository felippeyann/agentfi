-- Migration: 0003_a2a_reputation
-- Purpose: Add A2A job queue, agent reputation/trust fields,
--          X402 nonce table, PENDING_APPROVAL tx status,
--          and new AgentPolicy columns.

-- ---------------------------------------------------------------------------
-- ENUM: JobStatus
-- ---------------------------------------------------------------------------

CREATE TYPE "JobStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

-- ---------------------------------------------------------------------------
-- ENUM: TxStatus — add PENDING_APPROVAL value
-- ---------------------------------------------------------------------------

ALTER TYPE "TxStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

-- ---------------------------------------------------------------------------
-- TABLE: Agent — add reputation / service-manifest columns
-- ---------------------------------------------------------------------------

ALTER TABLE "Agent"
  ADD COLUMN IF NOT EXISTS "serviceManifest"  JSONB,
  ADD COLUMN IF NOT EXISTS "reputationScore"  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "a2aTxCount"       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastActiveAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- TABLE: AgentPolicy — add auto-approval threshold and expiry columns
-- ---------------------------------------------------------------------------

ALTER TABLE "AgentPolicy"
  ADD COLUMN IF NOT EXISTS "maxValueForAutoApprovalEth" TEXT NOT NULL DEFAULT '0.1',
  ADD COLUMN IF NOT EXISTS "expiresAt"                  TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- TABLE: X402Nonce — replay-attack prevention for x402 payments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "X402Nonce" (
  "id"        TEXT        NOT NULL,
  "nonce"     TEXT        NOT NULL,
  "chainId"   INTEGER     NOT NULL,
  "usedAt"    TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "X402Nonce_pkey"  PRIMARY KEY ("id"),
  CONSTRAINT "X402Nonce_nonce_key" UNIQUE ("nonce")
);

CREATE INDEX IF NOT EXISTS "X402Nonce_nonce_idx"     ON "X402Nonce" ("nonce");
CREATE INDEX IF NOT EXISTS "X402Nonce_createdAt_idx" ON "X402Nonce" ("createdAt");

-- ---------------------------------------------------------------------------
-- TABLE: Job — A2A service request queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "Job" (
  "id"          TEXT        NOT NULL,
  "requesterId" TEXT        NOT NULL,
  "providerId"  TEXT        NOT NULL,
  "status"      "JobStatus" NOT NULL DEFAULT 'PENDING',
  "payload"     JSONB       NOT NULL,
  "reward"      JSONB,
  "signature"   TEXT,
  "result"      JSONB,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL,

  CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Job_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "Agent" ("id"),
  CONSTRAINT "Job_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Agent" ("id")
);

CREATE INDEX IF NOT EXISTS "Job_requesterId_idx" ON "Job" ("requesterId");
CREATE INDEX IF NOT EXISTS "Job_providerId_idx"  ON "Job" ("providerId");
CREATE INDEX IF NOT EXISTS "Job_status_idx"      ON "Job" ("status");
