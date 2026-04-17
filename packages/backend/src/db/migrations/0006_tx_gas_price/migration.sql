-- Migration: 0006_tx_gas_price
-- Purpose: Add effectiveGasPriceWei to Transaction so that P&L v2 can compute
--          real gas costs (gasUsed * effectiveGasPrice) per confirmed tx.
--
-- v1 P&L left gas as a deferred cost because only gasUsed was persisted;
-- with the effective gas price captured at receipt time, P&L now reports
-- an accurate `profitable` flag.

ALTER TABLE "Transaction"
  ADD COLUMN IF NOT EXISTS "effectiveGasPriceWei" TEXT;
