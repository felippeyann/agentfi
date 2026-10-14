-- Migration: 0021_q8_policy_units
-- Purpose: explicit units and separate recipients in the agent policy (owner
--          decision Q8, 2026-10-14; execution plan §5 question 8).
--
--   AgentPolicy.maxValuePerTxUsd — per-spend cap, in USD, for spends that are
--     denominated in USD by definition: USDC x402 payments (pay-resource) and
--     ERC-8183 escrow budgets. Until now those spends read the number stored
--     in "maxValuePerTxEth" as USD. "maxValuePerTxEth" keeps its exact meaning
--     (native ETH on /v1/transactions/*, synced on-chain).
--   AgentPolicy.allowedRecipients — every address that receives value from
--     the agent (native / ERC-20 transfer recipient, x402 payTo, escrow
--     provider wallet, legacy A2A payee, batch action carrying native value).
--     Until now x402 and escrow read "allowedContracts" as their payee list.
--     "allowedContracts" keeps its meaning: the call target of ordinary
--     transactions, as AgentPolicyModule enforces on-chain.
--   Both new fields are off-chain only (never synced to AgentPolicyModule).
--
-- Backfill (conservative, no reinterpretation): every existing row gets
--   maxValuePerTxUsd  = maxValuePerTxEth   (the exact text — including a
--                                           non-decimal value, which meant
--                                           "unlimited" and still does)
--   allowedRecipients = allowedContracts   (the exact list, empty stays empty)
-- so every USDC x402 / escrow verdict and every native-transfer verdict of an
-- existing policy is identical before and after this migration.
--
-- The ONE narrowing: an ERC-20 transfer (/v1/transactions/transfer with a
-- token, and the legacy A2A payment in a token) now checks its recipient
-- (body.to) against allowedRecipients. Its recipient was never checked before;
-- for a row with a non-empty allowedContracts the copied list now refuses a
-- recipient that is not in it. Native transfers already needed their recipient
-- in allowedContracts (it is their call target), so they are unaffected.
--
-- New rows: maxValuePerTxUsd defaults to '1.0' (the effective USDC cap of the
-- old default, "maxValuePerTxEth" = '1.0' read as USD) and allowedRecipients
-- to '{}'. The API never derives one field from the other at creation: an
-- omitted maxValuePerTxUsd takes the default, and an omitted
-- allowedRecipients with a non-empty allowedContracts is refused (400).
--
-- The ALTER and the UPDATE run in one transaction (the migration script is one
-- implicit transaction; ALTER TABLE holds its ACCESS EXCLUSIVE lock until the
-- commit), so no row can be created between them and miss the backfill.

ALTER TABLE "AgentPolicy"
  ADD COLUMN "maxValuePerTxUsd" TEXT NOT NULL DEFAULT '1.0',
  ADD COLUMN "allowedRecipients" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "AgentPolicy"
SET "maxValuePerTxUsd" = "maxValuePerTxEth",
    "allowedRecipients" = "allowedContracts";
