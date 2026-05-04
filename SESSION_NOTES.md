# Session Notes — 2026-05-03

> Single-point handoff doc. Update on every substantive session, prune stale
> sections aggressively. If this file is older than a few days when you read
> it, trust `git log`, `gh pr list`, and `gh issue list` over the contents
> here. See [project_agentfi.md memory](../.claude/projects/.../memory/project_agentfi.md)
> for the convention.

---

## Where we are right now

**3 PRs ready to merge (all CI-green on required checks):**

| PR | Title | Branch | What it does | Recommended merge order |
| -- | ----- | ------ | ------------ | ----------------------- |
| [#70](https://github.com/felippeyann/agentfi/pull/70) | `fix(backend): ADMIN_SECRET min-32 validation + Discord/Telegram operator notifications` | `fix/security-notifications` | Closes #68 (notifications) and #69 (security) | 1st |
| [#76](https://github.com/felippeyann/agentfi/pull/76) | `docs(handoff): note landing site lives in a separate repo (polyrepo)` | `docs/handoff-landing-polyrepo` | Captures the polyrepo decision in HANDOFF.md §7 | 2nd |
| [#72](https://github.com/felippeyann/agentfi/pull/72) | `fix(backend): A2A revenue integrity — Phase 1 (ghost completions)` | `fix/a2a-revenue-integrity` | Closes Phase 1 of #71 — adds `PAYMENT_PENDING`/`PAYMENT_FAILED` job states | 3rd |

The `Vercel` check failing on each PR is the long-standing `agentfi-admin`
preview deploy issue documented in HANDOFF §7 — not a required check, ignore.

**1 preserved branch — not yet a PR:**

- `feat/fly-io-deploy` — single commit (Fly.io config: `fly.toml` + `Dockerfile.backend` PORT env). Cherry-picked clean from a previous attempt that got pulled out of PR #70 during scope cleanup. Open a PR from this when you decide to deploy backend on Fly.io. Until then, no action needed.

---

## What changed this session (2026-05-03)

### 1. CI rescue on PR #70 (force-pushed clean)

PR #70 had grown to 5 commits across 3 unrelated scopes (security fix +
landing page + Fly.io infra). CI was red. After investigation:

- Root cause of CI red: the landing commit added `@agentfi/landing` as a
  workspace but didn't regenerate `package-lock.json`, so `npm ci` failed
  on every Linux job.
- Latent bug found: the `e2e-test` job in `ci.yml` had `ADMIN_SECRET: e2e-admin-secret`
  (16 chars), which violated the new `z.string().min(32)` validator
  introduced by the security commit itself. Survived only because
  `continue-on-error: true` masked it.

**Cleanup performed (force-push authorized):**
- Reset `fix/security-notifications` to a clean state with 2 commits:
  the original security fix + a focused `fix(ci)` commit that only
  lengthens the e2e ADMIN_SECRET to 32 chars.
- Landing commit dropped (decision was polyrepo — see §3 below).
- Fly.io commit preserved on the `feat/fly-io-deploy` branch isolated
  from main.
- `deploy/landing` branch deleted from origin (was a duplicate of the
  landing content already in the cleaned-up PR #70).

### 2. Issue #71 — Phase 1 of A2A revenue integrity

Investigation found three coupled bugs in
[`packages/backend/src/api/routes/jobs.ts`](packages/backend/src/api/routes/jobs.ts):

1. **Ghost completions** — `executeA2APayment(...)` was called fire-and-forget
   AFTER the job was already updated to `COMPLETED`. If the on-chain
   transfer failed, the job stayed `COMPLETED`, the PnL dashboard reported
   revenue that never arrived in the provider's wallet, and the error
   log said "manual resolution required" as the design.
2. **Reputation also corrupted** — `recordJobOutcome(success=true)` ran
   before payment fired, so providers earned reputation for unpaid jobs.
3. **Escrow released prematurely** — `markEscrowReleased` ran before
   payment fired. Same fire-and-forget problem.

**Fix shipped in PR #72:**
- New `JobStatus` enum values: `PAYMENT_PENDING` and `PAYMENT_FAILED`.
- Migration `0008_job_payment_status` (idempotent `ALTER TYPE ... ADD VALUE IF NOT EXISTS`).
- Provider's `PATCH COMPLETED` on a rewarded job now sets `PAYMENT_PENDING`
  and fires the payment. The status finalizes to `COMPLETED` (with
  reputation + escrow release) only inside the payment promise's `.then`.
  On payment failure → `PAYMENT_FAILED` and escrow refunded to requester.
- Free jobs (no reward) still complete synchronously — no behavior change.
- API contract unchanged: `VALID_TRANSITIONS` still exposes only
  `COMPLETED`/`FAILED`/`CANCELLED` to clients. New states are system-only.

**Full investigation + 3-phase plan documented at:**
[`docs/project/issue-71-a2a-revenue-integrity.md`](docs/project/issue-71-a2a-revenue-integrity.md)
(landed with PR #72).

### 3. Landing site → polyrepo (not monorepo)

Discovered mid-session: the working `agentfi-landing` Vercel project is
connected to a **standalone repo**, not to this monorepo. The
`packages/landing/` folder that had been added in PR #70 was redundant —
duplicate code that wasn't even being deployed.

**Decision (user-confirmed):** keep the polyrepo split. Static landing
site rarely needs atomic changes with the backend, and keeping it out of
the monorepo means landing edits don't trigger the full backend CI suite.
Documented in HANDOFF.md §7 via PR #76, and saved as a memory entry so
future agents don't re-attempt monorepo consolidation.

### 4. Three follow-up tickets filed for Phase 1 gaps

- [#73 — Stale PAYMENT_PENDING recovery worker (BullMQ)](https://github.com/felippeyann/agentfi/issues/73) — critical. Without this, a server crash between `PAYMENT_PENDING` and the payment promise resolving leaves jobs stuck forever.
- [#74 — executeA2APayment idempotency (txIntentId)](https://github.com/felippeyann/agentfi/issues/74) — must ship before #73 to avoid double-spend on retry.
- [#75 — Admin dashboard PAYMENT_PENDING/FAILED queues + reconcile UI](https://github.com/felippeyann/agentfi/issues/75) — operator-facing surfacing for the new states.

---

## Open issues (post-session)

- [#71](https://github.com/felippeyann/agentfi/issues/71) — parent issue. Phase 1 closed by #72; Phase 2 (revenue snapshots) and Phase 3 (PnL refactor) still pending. Plan in [`docs/project/issue-71-a2a-revenue-integrity.md`](docs/project/issue-71-a2a-revenue-integrity.md).
- [#73](https://github.com/felippeyann/agentfi/issues/73), [#74](https://github.com/felippeyann/agentfi/issues/74), [#75](https://github.com/felippeyann/agentfi/issues/75) — Phase 1 follow-ups.
- 10 dependabot PRs (#56–#65) untouched — usual triage; bullmq, viem, tailwind 4, typescript 6, etc.

## Manual tasks pending on the user

1. **Merge the 3 ready PRs** in order: #70 → #76 → #72.
2. **Vercel `agentfi-landing` minor tweaks** (optional, captured in chat
   history during this session): align Node.js version 24.x → 22.x to
   match CI; add apex domain `agentfi.cc` (currently only `www.agentfi.cc`).
3. **Standalone landing repo** — archive or delete it via GitHub UI if
   you've decided the monorepo is dead for that surface (you have full
   permission, I don't have access to repos outside `felippeyann/agentfi`).
4. **Decide on the `feat/fly-io-deploy` branch:** open a PR when you want
   to deploy backend to Fly.io, or delete the branch if you've moved
   away from that hosting choice.

## Conventions reaffirmed this session

- Force-pushing PR branches to clean up scope is fine when authorized;
  always preserve dropped commits on a feature branch first
  (`feat/fly-io-deploy` was preserved as a one-commit branch with
  `git cherry-pick` on top of `main`).
- Migrations are still hand-written. `0008_job_payment_status` follows
  the existing `NNNN_name/migration.sql` pattern.
- `Co-Authored-By:` footer on AI-assisted commits.
- Don't add `packages/landing/` to this repo — see HANDOFF.md §7.

---

*Last touch: 2026-05-03. Replace this header with the new session date when you update.*
