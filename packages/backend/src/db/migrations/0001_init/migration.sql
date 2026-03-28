-- Migration: 0001_init
-- Created manually from schema.prisma (AgentFi)

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE "AgentTier" AS ENUM (
  'FREE',
  'PRO',
  'ENTERPRISE'
);

CREATE TYPE "TxStatus" AS ENUM (
  'PENDING',
  'SIMULATING',
  'QUEUED',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'REVERTED'
);

CREATE TYPE "TxType" AS ENUM (
  'SWAP',
  'TRANSFER',
  'DEPOSIT',
  'WITHDRAW',
  'APPROVE',
  'BATCH'
);

-- ---------------------------------------------------------------------------
-- TABLE: Agent
-- (referenced by AgentPolicy, AgentBilling, Transaction — must come first)
-- ---------------------------------------------------------------------------

CREATE TABLE "Agent" (
  "id"           TEXT          NOT NULL,
  "name"         TEXT          NOT NULL,
  "apiKeyHash"   TEXT          NOT NULL,
  "apiKeyPrefix" TEXT          NOT NULL,
  "walletId"     TEXT          NOT NULL,
  "safeAddress"  TEXT          NOT NULL,
  "chainIds"     INTEGER[]     NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ   NOT NULL,
  "active"       BOOLEAN       NOT NULL DEFAULT TRUE,
  "tier"         "AgentTier"   NOT NULL DEFAULT 'FREE',

  CONSTRAINT "Agent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Agent_apiKeyHash_key" UNIQUE ("apiKeyHash"),
  CONSTRAINT "Agent_walletId_key"   UNIQUE ("walletId"),
  CONSTRAINT "Agent_safeAddress_key" UNIQUE ("safeAddress")
);

CREATE INDEX "Agent_apiKeyHash_idx" ON "Agent" ("apiKeyHash");

-- ---------------------------------------------------------------------------
-- TABLE: AgentPolicy
-- ---------------------------------------------------------------------------

CREATE TABLE "AgentPolicy" (
  "id"                TEXT      NOT NULL,
  "agentId"           TEXT      NOT NULL,
  "maxValuePerTxEth"  TEXT      NOT NULL DEFAULT '1.0',
  "maxDailyVolumeUsd" TEXT      NOT NULL DEFAULT '10000',
  "allowedContracts"  TEXT[]    NOT NULL DEFAULT '{}',
  "allowedTokens"     TEXT[]    NOT NULL DEFAULT '{}',
  "cooldownSeconds"   INTEGER   NOT NULL DEFAULT 60,
  "active"            BOOLEAN   NOT NULL DEFAULT TRUE,
  "updatedAt"         TIMESTAMPTZ NOT NULL,

  CONSTRAINT "AgentPolicy_pkey"    PRIMARY KEY ("id"),
  CONSTRAINT "AgentPolicy_agentId_key" UNIQUE ("agentId"),
  CONSTRAINT "AgentPolicy_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- TABLE: AgentBilling
-- (referenced by FeeEvent — must come before FeeEvent)
-- ---------------------------------------------------------------------------

CREATE TABLE "AgentBilling" (
  "id"                    TEXT          NOT NULL,
  "agentId"               TEXT          NOT NULL,
  "subscriptionActive"    BOOLEAN       NOT NULL DEFAULT FALSE,
  "subscriptionPeriodEnd" TIMESTAMPTZ,
  "stripeCustomerId"      TEXT,
  "stripeSubscriptionId"  TEXT,
  "totalFeesCollectedUsd" TEXT          NOT NULL DEFAULT '0',
  "txCountThisPeriod"     INTEGER       NOT NULL DEFAULT 0,
  "periodStart"           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"             TIMESTAMPTZ   NOT NULL,

  CONSTRAINT "AgentBilling_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "AgentBilling_agentId_key"     UNIQUE ("agentId"),
  CONSTRAINT "AgentBilling_stripeCustomerId_key"
    UNIQUE ("stripeCustomerId"),
  CONSTRAINT "AgentBilling_stripeSubscriptionId_key"
    UNIQUE ("stripeSubscriptionId"),
  CONSTRAINT "AgentBilling_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- TABLE: Transaction
-- (referenced by FeeEvent — must come before FeeEvent)
-- ---------------------------------------------------------------------------

CREATE TABLE "Transaction" (
  "id"             TEXT          NOT NULL,
  "idempotencyKey" TEXT,
  "agentId"        TEXT          NOT NULL,
  "chainId"        INTEGER       NOT NULL,
  "txHash"         TEXT,
  "status"         "TxStatus"    NOT NULL DEFAULT 'QUEUED',
  "type"           "TxType"      NOT NULL,
  "fromToken"      TEXT,
  "toToken"        TEXT,
  "amountIn"       TEXT,
  "amountOut"      TEXT,
  "gasUsed"        TEXT,
  "gasPrice"       TEXT,
  "error"          TEXT,
  "simulation"     JSONB,
  "metadata"       JSONB,
  "createdAt"      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ   NOT NULL,
  "confirmedAt"    TIMESTAMPTZ,

  CONSTRAINT "Transaction_pkey"             PRIMARY KEY ("id"),
  CONSTRAINT "Transaction_idempotencyKey_key" UNIQUE ("idempotencyKey"),
  CONSTRAINT "Transaction_txHash_key"       UNIQUE ("txHash"),
  CONSTRAINT "Transaction_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent" ("id")
);

CREATE INDEX "Transaction_agentId_createdAt_idx" ON "Transaction" ("agentId", "createdAt" DESC);
CREATE INDEX "Transaction_status_idx"            ON "Transaction" ("status");
CREATE INDEX "Transaction_txHash_idx"            ON "Transaction" ("txHash");

-- ---------------------------------------------------------------------------
-- TABLE: FeeEvent
-- (depends on AgentBilling and Transaction)
-- ---------------------------------------------------------------------------

CREATE TABLE "FeeEvent" (
  "id"            TEXT          NOT NULL,
  "billingId"     TEXT          NOT NULL,
  "transactionId" TEXT          NOT NULL,
  "feeUsd"        TEXT          NOT NULL,
  "feeTokens"     TEXT          NOT NULL,
  "feeBps"        INTEGER       NOT NULL,
  "collectedAt"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "FeeEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeEvent_billingId_fkey"
    FOREIGN KEY ("billingId") REFERENCES "AgentBilling" ("id"),
  CONSTRAINT "FeeEvent_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE
);

CREATE INDEX "FeeEvent_billingId_idx"     ON "FeeEvent" ("billingId");
CREATE INDEX "FeeEvent_transactionId_idx" ON "FeeEvent" ("transactionId");
CREATE INDEX "FeeEvent_collectedAt_idx"   ON "FeeEvent" ("collectedAt" DESC);

-- ---------------------------------------------------------------------------
-- TABLE: DailyVolume
-- ---------------------------------------------------------------------------

CREATE TABLE "DailyVolume" (
  "id"        TEXT          NOT NULL,
  "agentId"   TEXT          NOT NULL,
  "date"      TEXT          NOT NULL,
  "volumeUsd" TEXT          NOT NULL DEFAULT '0',
  "updatedAt" TIMESTAMPTZ   NOT NULL,

  CONSTRAINT "DailyVolume_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agentId_date"     UNIQUE ("agentId", "date")
);

CREATE INDEX "DailyVolume_date_idx" ON "DailyVolume" ("date");
