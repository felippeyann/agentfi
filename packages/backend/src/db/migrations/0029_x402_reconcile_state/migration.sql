-- Migration: 0029_x402_reconcile_state
-- Purpose: automatic reconciliation of x402 payments. One schedule row per
--   ResourcePayment the worker has looked at: consecutive transient failures
--   (attempts), next attempt (backoff / validBefore + margin), last verdict,
--   escalation to the operator, and a per-row lease for concurrent workers.
--   Separate table so the worker never bumps ResourcePayment."updatedAt".

CREATE TABLE "ResourcePaymentReconcileState" (
    "resourcePaymentId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerdict" TEXT,
    "lastNote" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "escalationReason" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourcePaymentReconcileState_pkey" PRIMARY KEY ("resourcePaymentId")
);

CREATE INDEX "ResourcePaymentReconcileState_nextAttemptAt_idx" ON "ResourcePaymentReconcileState"("nextAttemptAt");

ALTER TABLE "ResourcePaymentReconcileState" ADD CONSTRAINT "ResourcePaymentReconcileState_resourcePaymentId_fkey" FOREIGN KEY ("resourcePaymentId") REFERENCES "ResourcePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
