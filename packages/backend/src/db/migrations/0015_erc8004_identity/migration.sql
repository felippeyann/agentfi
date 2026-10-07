-- Migration: 0015_erc8004_identity
-- Purpose: R2 of the Q4-2026 execution plan — give the provider of an ERC-8183
--          escrow job an ERC-8004 identity and bind it to the on-chain job
--          (`AgentJobEscrow.setProviderAgentId`), so `ReputationHook` writes
--          feedback on settlement instead of skipping with "no-agent-id".
--          See docs/architecture/erc-8004-integration.md ("Backend flow (R2)").
--
-- Numbered 0015 although 0016/0017 are already applied on existing databases:
-- the number was reserved for R2 when 0016 was written. `prisma migrate deploy`
-- applies every migration that is missing from `_prisma_migrations`, in name
-- order, and does not require new migrations to sort after applied ones; the
-- statements below touch nothing that 0016/0017 created, so the order is
-- irrelevant to the result. Verified on a database that already had 0016/0017.
--
--   AgentIdentity — one ERC-8004 identity per (agent, chain): the Identity
--     Registry address, the minted tokenId (`erc8004AgentId`, decimal string,
--     NULL until the `Registered` event is parsed), status REGISTERING /
--     REGISTERED / FAILED, the `register` tx hash and the agentURI. The unique
--     (agentId, chainId) row is what serializes concurrent first jobs of the
--     same provider into a single mint (decision D7: minted lazily on the
--     first funded job, from the provider's own wallet).
--   Job.providerAgentId / providerAgentIdStatus / providerAgentIdError — the id
--     bound to the job and the binding state (BINDING, BOUND, FAILED, SKIPPED).
--   Job.deferredSubmitAt — the provider completed while the binding was still
--     in flight; `submit` is sent once the binding is terminal, because
--     `setProviderAgentId` is only valid while the job is Open/Funded.
--   TxType ERC8004_IDENTITY — the provider-signed `register` and
--     `setProviderAgentId` transactions (told apart by metadata.escrowStep).
--
-- Idempotent: IF NOT EXISTS guards keep this re-runnable in dev/CI.

ALTER TYPE "TxType" ADD VALUE IF NOT EXISTS 'ERC8004_IDENTITY';

DO $$
BEGIN
  CREATE TYPE "AgentIdentityStatus" AS ENUM ('REGISTERING', 'REGISTERED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AgentIdentity" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "registry" TEXT NOT NULL,
    "erc8004AgentId" TEXT,
    "status" "AgentIdentityStatus" NOT NULL,
    "agentURI" TEXT NOT NULL,
    "registerTxHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentIdentity_agentId_chainId_key"
  ON "AgentIdentity"("agentId", "chainId");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentIdentity_chainId_registry_erc8004AgentId_key"
  ON "AgentIdentity"("chainId", "registry", "erc8004AgentId");
CREATE INDEX IF NOT EXISTS "AgentIdentity_status_idx" ON "AgentIdentity"("status");

DO $$
BEGIN
  ALTER TABLE "AgentIdentity"
    ADD CONSTRAINT "AgentIdentity_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "providerAgentId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "providerAgentIdStatus" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "providerAgentIdError" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "deferredSubmitAt" TIMESTAMP(3);
