-- Migration: 0004_job_cascade_delete
-- Purpose: Add ON DELETE CASCADE to Job -> Agent foreign keys so that
--          deleting an Agent automatically removes its related Job records.
--          Fixes CI test failures caused by FK constraint violations during
--          test cleanup (agent.search.test.ts, transaction.e2e.ts).

-- FK: Job.requesterId -> Agent.id — add ON DELETE CASCADE

ALTER TABLE "Job" DROP CONSTRAINT "Job_requesterId_fkey";
ALTER TABLE "Job" ADD CONSTRAINT "Job_requesterId_fkey"
  FOREIGN KEY ("requesterId") REFERENCES "Agent" ("id") ON DELETE CASCADE;

-- FK: Job.providerId -> Agent.id — add ON DELETE CASCADE

ALTER TABLE "Job" DROP CONSTRAINT "Job_providerId_fkey";
ALTER TABLE "Job" ADD CONSTRAINT "Job_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Agent" ("id") ON DELETE CASCADE;
