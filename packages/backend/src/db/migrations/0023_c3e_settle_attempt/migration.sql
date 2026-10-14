-- Migration: 0023_c3e_settle_attempt
-- Purpose: an evaluator settlement that may be in flight must refuse a
--   contest and a new operator decision even when its transaction hash was
--   never recorded (plan task C3e, item 2).
--   "settleAttemptAt" is written right before the evaluator signs and sends
--   complete / reject / claimRefund (after the simulation and the gas
--   estimate, so a settlement that reverts in simulation — e.g. a provider
--   that cannot receive USDC — never stamps), and cleared in the same write
--   that records "settleTxHash". A stamp without a recorded hash means "a
--   settlement may have been broadcast and its hash was lost" (the hash write
--   failed, or the process died between the broadcast and that write): the
--   contest race rule and POST /admin/jobs/:id/resolve treat it as in flight,
--   exactly like a hash without a receipt, until a later attempt records a
--   hash or the chain shows the job settled.
--   Nullable, no backfill: every existing row keeps NULL, i.e. today's rule
--   (only "settleTxHash" decides).

ALTER TABLE "Job" ADD COLUMN "settleAttemptAt" TIMESTAMP(3);
