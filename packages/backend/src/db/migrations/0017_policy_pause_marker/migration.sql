-- Migration: 0017_policy_pause_marker
-- Purpose: Let the admin resume undo exactly what the admin pause did.
--          POST /admin/agents/:id/pause stamps this column when it flips an
--          *active* policy to inactive. POST /admin/agents/:id/resume (and
--          the pause toggle when it resumes) re-activates the policy only
--          while the stamp is present, then clears it. A policy that was
--          already inactive before the pause — agent soft-delete
--          (DELETE /v1/agents/:id), PATCH active=false, or a pause that
--          predates this column — carries no stamp and stays inactive after
--          resume; the API response says so (`policyReactivated: false`).

ALTER TABLE "AgentPolicy"
  ADD COLUMN IF NOT EXISTS "pausedByOperatorAt" TIMESTAMP(3);
