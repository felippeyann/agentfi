-- Revenue Sharing: Operator model, revenue accrual, and settlement

-- Settlement status enum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'SETTLED', 'FAILED');

-- Operator table
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "contactEmail" TEXT,
    "revShareBps" INTEGER NOT NULL DEFAULT 2000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Operator_walletAddress_key" ON "Operator"("walletAddress");

-- Link Agent to Operator
ALTER TABLE "Agent" ADD COLUMN "operatorId" TEXT;
CREATE INDEX "Agent_operatorId_idx" ON "Agent"("operatorId");
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Operator revenue accrual (one row per fee event split)
CREATE TABLE "OperatorRevenue" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "feeEventId" TEXT NOT NULL,
    "grossFeeUsd" TEXT NOT NULL,
    "operatorShareUsd" TEXT NOT NULL,
    "protocolShareUsd" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "accrualDate" TEXT NOT NULL,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorRevenue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorRevenue_operatorId_idx" ON "OperatorRevenue"("operatorId");
CREATE INDEX "OperatorRevenue_accrualDate_idx" ON "OperatorRevenue"("accrualDate");
CREATE INDEX "OperatorRevenue_settled_idx" ON "OperatorRevenue"("settled");

ALTER TABLE "OperatorRevenue" ADD CONSTRAINT "OperatorRevenue_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Settlement records
CREATE TABLE "OperatorSettlement" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "amountUsd" TEXT NOT NULL,
    "txHash" TEXT,
    "chainId" INTEGER,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "OperatorSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorSettlement_operatorId_idx" ON "OperatorSettlement"("operatorId");
CREATE INDEX "OperatorSettlement_status_idx" ON "OperatorSettlement"("status");

ALTER TABLE "OperatorSettlement" ADD CONSTRAINT "OperatorSettlement_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
