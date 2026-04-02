# AgentFi Production Release and Rollback Runbook

Date: 2026-04-01
Owner: Platform/Operations

This runbook defines a deterministic process for production deploys and emergency rollback.
It is designed for Railway deployment via GitHub Actions workflow Deploy Production.

---

## 1. Preconditions

1. Production environment has required GitHub secrets:
- RAILWAY_TOKEN
- RAILWAY_PROJECT_ID
- RAILWAY_PRODUCTION_ENVIRONMENT

2. Service variable is configured (optional):
- RAILWAY_PRODUCTION_SERVICE (default: backend)
- RAILWAY_PRODUCTION_WORKER_SERVICE (for dedicated worker deploy)

3. Production health baseline is green:
- API health endpoint responds
- Ready endpoint responds with all checks true

4. Release candidate commit has passed CI on develop/mainline:
- Typecheck green
- Backend tests green
- Contract tests green

---

## 2. Standard Production Release

Option A: Manual dispatch (recommended)

1. Open GitHub Actions and run workflow Deploy Production.
2. Provide input ref:
- Release tag (preferred): vX.Y.Z
- Or exact commit SHA for a controlled hotfix deploy.
3. Wait for workflow completion and verify Railway deployment state.
4. If worker service is configured, confirm worker deployment completed too.

Option B: Tag-triggered release

1. Create and push release tag:
- git tag vX.Y.Z
- git push origin vX.Y.Z
2. Confirm Deploy Production workflow executed successfully.

---

## 3. Post-Deploy Verification (must pass)

Run these checks immediately after deployment:

1. Liveness
- curl https://api.agentfi.cc/health

2. Readiness
- curl https://api.agentfi.cc/health/ready
- Expected: status ready and checks all true

3. Core API smoke test
- Verify one authenticated endpoint returns expected schema

4. Queue/worker sanity
- Confirm dedicated worker service is running if using metered Redis
- Confirm API replicas use TRANSACTION_WORKER_ENABLED=false

5. Error budget check (first 10-15 min)
- No sustained 5xx spikes
- No Redis max request limit errors
- No abnormal queue backlog growth

If any critical check fails, execute rollback immediately.

---

## 4. Rollback Playbook

Rollback target selection:

1. Identify last known good production ref (tag or commit SHA).
2. Prefer rollback to previous release tag.

Rollback execution:

1. Run Deploy Production workflow manually.
2. Set input ref to last known good ref.
3. Wait for workflow completion.

Rollback verification:

1. Re-run full post-deploy verification in Section 3.
2. Confirm error rates and queue behavior normalize.

Communication:

1. Record incident start/end time.
2. Record failed ref and rollback ref.
3. Open follow-up issue with root-cause and prevention actions.

---

## 5. Emergency Safeguards

If deployment is causing financial or policy risk:

1. Pause affected agents via admin controls.
2. Disable external automation clients until system is stable.
3. Keep worker active only if needed for safe drain/cleanup.

If Redis quota exhaustion is observed:

1. Ensure only dedicated worker polls BullMQ.
2. Reduce worker concurrency and increase drain delay temporarily.
3. Upgrade Redis plan if sustained production load requires it.

---

## 6. Operational Defaults

Recommended production topology for metered Redis:

1. API services:
- TRANSACTION_WORKER_ENABLED=false

2. Worker service:
- Start command: cd packages/backend && npm run worker
- TRANSACTION_WORKER_ENABLED=true
- Tune as needed:
  - TRANSACTION_WORKER_CONCURRENCY
  - TRANSACTION_WORKER_DRAIN_DELAY_SEC
  - TRANSACTION_WORKER_STALLED_INTERVAL_MS

---

## 7. Audit Trail Template

For each production release, capture:

1. Release ref deployed
2. Deployer (person or automation)
3. Time started/completed (UTC)
4. Verification results
5. Rollback performed? (yes/no)
6. Incident link (if any)

---

## 8. Alert Thresholds (Auth and Access)

Track these signals from app logs and gateway metrics:

1. Admin lockout events (`admin_login_blocked`)
- Warning: >= 3 events in 10 minutes from the same IP/user fingerprint
- Critical: >= 10 events in 10 minutes across multiple fingerprints

2. Invalid admin credential events (`admin_login_invalid_credentials`)
- Warning: >= 10 events in 5 minutes
- Critical: >= 30 events in 5 minutes

3. Unauthorized admin proxy responses (HTTP 401 from admin API routes)
- Warning: >= 20 responses in 5 minutes
- Critical: >= 100 responses in 5 minutes

Response playbook for warning or critical thresholds:

1. Verify whether the source is expected operator activity.
2. If suspicious, rotate `ADMIN_PASSWORD` immediately.
3. Review ingress controls and block abusive source IPs at edge/WAF.
4. Escalate incident and capture forensic timeline in the audit trail.
