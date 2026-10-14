-- Migration: 0022_q9_price_source
-- Purpose: owner decision Q9 (2026-10-14) — trusted prices for daily-volume
--          accounting; no spend counted as zero.
--
--   Transaction.volumePriceSource — where the USD price behind
--     "volumeReservedUsd" (A6, migration 0020) came from:
--       'oracle'     the price oracle, mainnet chains only
--       'synthetic'  a configured TEST price on a testnet chain
--                    (SYNTHETIC_TEST_PRICES_USD) — not a market price
--       'usdc-peg'   USDC counted at exactly 1.00 USD
--   Job.reservedValueSource — the same for "reservedValueUsd" (C3d, 0019):
--     'usdc-peg' for an ERC-8183 escrow budget, 'oracle' / 'synthetic' for a
--     legacy reward.
--
-- Both are NULL when nothing was priced / reserved. Existing rows are NOT
-- backfilled: a reservation made before 0022 has no recorded source (on Base
-- Sepolia it may even have used the mainnet ETH price, which Q9 removed), and
-- inventing one would be worse than saying "unknown". Values counted with a
-- synthetic price are never used for fees, P&L or revenue (those read the
-- price service, which knows no synthetic price).

ALTER TABLE "Transaction"
  ADD COLUMN "volumePriceSource" TEXT,
  ADD CONSTRAINT "Transaction_volumePriceSource_check"
    CHECK ("volumePriceSource" IS NULL OR "volumePriceSource" IN ('oracle', 'synthetic', 'usdc-peg'));

ALTER TABLE "Job"
  ADD COLUMN "reservedValueSource" TEXT,
  ADD CONSTRAINT "Job_reservedValueSource_check"
    CHECK ("reservedValueSource" IS NULL OR "reservedValueSource" IN ('oracle', 'synthetic', 'usdc-peg'));
