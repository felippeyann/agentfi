-- Migration: 0027_x402_reconciliation
-- Purpose: on-chain reconciliation of x402 resource payments (first x402 delivery, 2026-11-15).
--   status "expired" - terminal: reconciliation PROVED the signed EIP-3009
--     authorization can no longer move money (authorizationState unused at a
--     block whose timestamp is >= validBefore, or an AuthorizationCanceled
--     event). Not counted against the job budget or the daily volume.
--   "attemptId" - owner token of the attempt that last reserved the row; every
--     later write of that attempt is conditional on it and reconciliation
--     clears it (no late send / overwrite after a release or takeover).
--   "payer", "authorizationMethod" - who signed and how (set once signed):
--     what reconciliation needs to read `authorizationState(payer, nonce)`.
--   "chainVerifiedAt" - when the transfer was proven on-chain
--     (AuthorizationUsed + a matching USDC Transfer payer -> payTo). A
--     `settled` row without it is only REPORTED settled by the server.
--   "reconciledAt", "reconcileNote" - last reconciliation verdict.
--   "resourceSha256", "resourceBytes" - delivery evidence (the paid response
--     body as received), kept apart from the money.

ALTER TYPE "ResourcePaymentStatus" ADD VALUE 'expired';

ALTER TABLE "ResourcePayment"
  ADD COLUMN "attemptId" TEXT,
  ADD COLUMN "payer" TEXT,
  ADD COLUMN "authorizationMethod" TEXT,
  ADD COLUMN "chainVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "reconciledAt" TIMESTAMP(3),
  ADD COLUMN "reconcileNote" TEXT,
  ADD COLUMN "resourceSha256" TEXT,
  ADD COLUMN "resourceBytes" INTEGER;
