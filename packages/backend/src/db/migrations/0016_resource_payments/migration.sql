-- x402 resource payments charged against a job's reward budget (plan tasks P2 / P5).
-- One row per (job, paymentId); the status column is the durable ledger state machine:
--   reserved -> pending -> settled | unknown | refused ; failed_before_signing
-- Numbered 0016: 0014 (C3 job columns) and 0015 (R2 erc8004AgentId) are reserved by parallel tasks.

-- CreateEnum
CREATE TYPE "ResourcePaymentStatus" AS ENUM ('reserved', 'pending', 'settled', 'unknown', 'refused', 'failed_before_signing');

-- CreateTable
CREATE TABLE "ResourcePayment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "payTo" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "authorizationNonce" TEXT,
    "status" "ResourcePaymentStatus" NOT NULL,
    "receipt" JSONB,
    "receiptVerified" BOOLEAN,
    "settlementTxHash" TEXT,
    "responseStatus" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourcePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourcePayment_jobId_idx" ON "ResourcePayment"("jobId");

-- CreateIndex
CREATE INDEX "ResourcePayment_status_idx" ON "ResourcePayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ResourcePayment_jobId_paymentId_key" ON "ResourcePayment"("jobId", "paymentId");

-- AddForeignKey
ALTER TABLE "ResourcePayment" ADD CONSTRAINT "ResourcePayment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourcePayment" ADD CONSTRAINT "ResourcePayment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

