-- Migration: 0007_agent_ens
-- Purpose: Give each agent an optional, globally unique ENS subdomain
--          (e.g., "alice.agentfi.eth") that points to its Safe address.
--          Null when the operator hasn't configured a parent domain, or
--          when on-chain subdomain registration failed — the agent is still
--          fully functional without it.

ALTER TABLE "Agent"
  ADD COLUMN IF NOT EXISTS "ensName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Agent_ensName_key" ON "Agent"("ensName");
