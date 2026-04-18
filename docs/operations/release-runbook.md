# AgentFi Production Release and Rollback Runbook

Owner: the operator running the deployment (self-hosted by default).

This runbook defines a deterministic process for production deploys and emergency rollback. AgentFi is self-hosted software — there is no canonical production instance maintained by the project. This runbook applies to **any operator** (human or agent) deploying their own instance.

**Reference deployment**: Railway is used as the example throughout, because it has the shortest path from a repo clone to a running service (auto-deploy on git push, managed Postgres + Redis plugins, Nixpacks build). The same steps map to Fly.io, Render, or a Docker host; differences are noted inline.

---

## 1. Preconditions

1. Hosting provider configured:
   - Railway: project connected to the GitHub repo, `production` environment created, services for **backend**, **Postgres**, **Redis** exist and point to the repo root (auto-deploy on `main`).
   - Or equivalent on another provider (see `docs/operations/production-deploy.md`).

2. Environment variables configured on the backend service (never commit these):
   - See `docs/operations/production-deploy.md` Section 1 for the complete list.

3. Production health baseline is green on the current deployed ref:
   - `GET /health` responds 200
   - `GET /health/ready` responds with `status: "ready"` and all checks true

4. Release candidate commit has passed CI on `main`:
   - Lint & Type Check, Backend Tests, Foundry Tests, Admin Tests, E2E Tests all green

---

## 2. Standard Production Release

AgentFi uses native provider git integration — **no custom deploy workflow**. A push to `main` (or a tag, depending on provider config) triggers the deploy automatically.

Option A: Merge-triggered release (default for Railway/Render/Fly with auto-deploy enabled)

1. Merge the release PR into `main` once CI is green.
2. Hosting provider detects the push and starts a build.
3. Wait for the build to complete in the provider dashboard.
4. Run Post-Deploy Verification (Section 3).

Option B: Tag-triggered release (for providers configured to deploy on tags, or for audit-traced releases)

1. Create and push a release tag via the release helper:
   ```bash
   npm run release:v1:tag -- X.Y.Z --push
   ```
   Notes:
   - The helper runs typecheck/tests before tagging (unless `--skip-check` is provided).
   - It refuses to tag when uncommitted tracked changes exist (except local `.claude/` and `docs/railway_logs/` artifacts).

2. Manual commands remain available if needed:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. Confirm the provider dashboard picked up the tag and completed the build.
4. Run Post-Deploy Verification (Section 3).

---

## 3. Post-Deploy Verification (must pass)

Replace `api.example.com` with your deployed API hostname.

1. Liveness
   ```bash
   curl https://api.example.com/health
   ```

2. Readiness
   ```bash
   curl https://api.example.com/health/ready
   ```
   Expected: `status: "ready"` and all checks `true`.

3. Core API smoke test — verify one authenticated endpoint returns expected schema.

4. Queue/worker sanity
   - Dedicated worker service running if using metered Redis.
   - API replicas use `TRANSACTION_WORKER_ENABLED=false`.

5. Error budget check (first 10–15 min)
   - No sustained 5xx spikes.
   - No Redis max request limit errors.
   - No abnormal queue backlog growth.

If any critical check fails, execute rollback immediately.

---

## 4. Rollback Playbook

Rollback target selection:

1. Identify last known good production ref (tag or commit SHA).
2. Prefer rollback to previous release tag.

Rollback execution:

1. Provider dashboard → Deployments → Redeploy the last known good ref.
   - Railway: Deployments tab → three-dot menu on the good build → Redeploy.
   - Fly/Render: equivalent "redeploy previous" action.
2. If the provider doesn't offer one-click redeploy, revert the merge commit on `main` and let auto-deploy trigger again.

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
   - `TRANSACTION_WORKER_ENABLED=false`

2. Worker service:
   - Start command: `cd packages/backend && npm run worker`
   - `TRANSACTION_WORKER_ENABLED=true`
   - Tune as needed:
     - `TRANSACTION_WORKER_CONCURRENCY`
     - `TRANSACTION_WORKER_DRAIN_DELAY_SEC`
     - `TRANSACTION_WORKER_STALLED_INTERVAL_MS`

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

---

## 9. Go/No-Go Release Template

Use this paste-ready template before dispatching production deploys:

- `docs/release-go-no-go-template.md`
