# HANDOFF — AgentFi

> Live pending tasks, credentials inventory, and working conventions. For *what the project is*, read [STATE.md](STATE.md). For *why*, read [VISION.md](VISION.md). This file is the shortest path from "resuming work" → "executing something useful."

**Last updated**: April 2026 · **main SHA** `700c76c` · **Repo**: https://github.com/felippeyann/agentfi (public, Apache 2.0) · **Release**: [v0.1.0](https://github.com/felippeyann/agentfi/releases/tag/v0.1.0) · **npm**: [`@agent_fi/mcp-server@0.3.0`](https://www.npmjs.com/package/@agent_fi/mcp-server)

---

## Table of Contents

1. [Snapshot](#1-snapshot)
2. [Required reading order](#2-required-reading-order)
3. [Pending work](#3-pending-work)
4. [Credentials inventory](#4-credentials-inventory)
5. [Working conventions](#5-working-conventions)
6. [Principles (learned the hard way)](#6-principles-learned-the-hard-way)
7. [Known quirks and non-issues](#7-known-quirks-and-non-issues)

---

## 1. Snapshot

| Item | Value |
|---|---|
| Default branch | `main` (protected; required checks: Lint, Admin, Backend, Foundry) |
| Active branches | `main`, `develop` (mirrors main post-merge) |
| Open PRs | 0 |
| Open issues | 0 |
| CI | 6/6 green (5 required + OpenAPI Spec) |
| npm vulnerabilities | 0 critical, 0 high |
| Secrets in git history | None |

**Phase progress** (see [STATE.md §6](STATE.md#6-phase-progress) for detail):

- Phase 1–2.5: complete.
- Phase 3 — A2A economy + DeFi expansion: ~85%. Remaining: GMX adapter, escrow v3 (on-chain), sign/verify-handshake (blocked on Turnkey).
- Phase 4 — Self-sustaining agents: ~40%. Shipped: P&L v1+v2 (with gas), ENS identity. Remaining: self-funding (legal decision), revenue sharing.
- Phase 5–6: not started.

---

## 2. Required reading order

1. [VISION.md](VISION.md) — the *why*. Required.
2. [STATE.md](STATE.md) — the *what* today.
3. This file (HANDOFF.md) — live work + working conventions.
4. [docs/dev-quickstart.md](docs/dev-quickstart.md) — 3-min path from clone to running stack.
5. [docs/architecture/overview.md](docs/architecture/overview.md) — 4-layer stack.

**If you're coming in to ship code**, also read:
- Relevant example under [`examples/`](examples/) for the surface you're touching.
- [docs/api-reference.md](docs/api-reference.md) or [docs/api/openapi.yaml](docs/api/openapi.yaml) for the API shape.
- [CONTRIBUTING.md](CONTRIBUTING.md) for PR conventions.

---

## 3. Pending work

Pending work is split into four buckets. Nothing in `Done` is listed here — those live in [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`.

### 3.1 Manual tasks (user-only)

| Task | Blocker | Notes |
|---|---|---|
| Awaiting mcp.so review | External | [Listing](https://mcp.so/server/agentfi-mcp-server/felippeyann) submitted; status `created`. |
| Awaiting awesome-mcp-servers merge | External | [PR #5091](https://github.com/punkpeye/awesome-mcp-servers/pull/5091) open. Typical turnaround 1–7 days. |
| Demo screencast | — | 2-minute Claude Desktop doing a real swap via MCP. Highest remaining non-code leverage. |
| Setup-checklist review | — | `docs/operations/setup-checklist.md` predates `WALLET_PROVIDER=local` — some steps are now optional for dev. |
| Branch pruning | — | ~12 merged branches on origin waiting deletion. Cosmetic. |

### 3.2 Technical — unblocked

Ranked by closure value, not effort.

| Task | Phase | Effort | Value |
|---|---|---|---|
| Verify dev stack + 3 examples run end-to-end | — | ~15 min | **High** — CI-green ≠ functionally validated. See §6 for context. |
| GMX / Perp adapter | 3 | 10–20 h | Closes Phase 3 DeFi surface. |
| Escrow v3 on-chain (`EscrowModule.sol` + integration) | 3 | 30–40 h (incl. audit prep) | Closes Phase 3; funds un-spendable until terminal state. |
| Revenue sharing (protocol ↔ self-hosted) | 4 | Design + impl | Aligns incentives per VISION.md. |
| Contract deployment runbook | Polish | Low | `docs/operations/contract-deployment.md` only lists Base addresses. |

### 3.3 Technical — blocked externally

| Task | Blocked by |
|---|---|
| Self-funding sub-wallets | Legal decision (who owns the sub-wallet when an agent provisions it) |

### 3.4 The meta-guidance

The live project state has **completed plumbing but zero users**. Adding more code without adoption signal is drift. Before starting anything in §3.2 beyond the "verify examples" task, confirm there is either (a) a specific user asking, or (b) a specific integration depending on it. Otherwise the leverage is in distribution, which is §3.1.

---

## 4. Credentials inventory

| Credential | When needed | Where to get |
|---|---|---|
| Alchemy API Key | Any real-chain interaction | https://dashboard.alchemy.com |
| Turnkey keys (public + private + org ID) | Production wallets | https://app.turnkey.com |
| Tenderly access key | Pre-broadcast tx simulation (optional; graceful fallback) | https://dashboard.tenderly.co |
| Postgres URL | Always | Local Docker, Neon, Supabase, Railway PG |
| Redis URL | Always | Local Docker, Upstash, Railway Redis |
| npm publish access to `@agent_fi` | Publishing mcp-server | https://www.npmjs.com (invite-only org) |
| `gh auth login` | PR + release ops | GitHub CLI |
| Etherscan-family API keys | Contract verification | Per-chain block explorer |
| Funded deployer EOA | Contract deployment | Hot wallet with gas |

**Dev quickstart path** (for evaluation, no real credentials): `WALLET_PROVIDER=local` + stub Alchemy + docker-compose.dev.yml. See [docs/dev-quickstart.md](docs/dev-quickstart.md).

**Production secrets to generate once**: use `scripts/gen-secrets.sh` for `API_SECRET`, `ADMIN_SECRET`, `NEXTAUTH_SECRET`.

---

## 5. Working conventions

### Branch workflow

`main` is protected. Every change goes via PR.

```bash
git checkout main && git pull origin main
git checkout -b <type>/<short-name>
# ... work ...
git push -u origin <branch>
gh pr create --base main --head <branch> --title "..." --body "..."
# wait for CI green
gh pr merge <number> --merge
git checkout develop && git pull origin main && git push origin develop  # sync mirror
```

### Commit conventions

- `feat:` — new feature · `fix:` — bug fix · `docs:` — docs only · `chore:` — deps/config
- Scope optional: `feat(phase4):`, `fix(ci):`, `docs(examples):`.
- Always include `Co-Authored-By:` footer when AI-assisted.
- Subject imperative, no trailing period.

### Code style

- Prettier configured; run `npm run typecheck --workspaces --if-present` before pushing.
- TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- `const > let`, avoid `any`, use Zod for runtime validation.
- Commit messages in English. Portuguese only in `docs/agents/claude-instructions.md`.

### Test expectations

- Unit tests use mocked Prisma — see `packages/backend/src/__tests__/policy.service.test.ts` for the pattern.
- E2E tests use real Postgres + Redis + Anvil via `packages/backend/src/__tests__/e2e/global-setup.ts`.
- Avoid hardcoded `setTimeout` — use polling helpers in `transaction.e2e.ts`.

### CI expectations

- Full CI ~3 min when cached.
- Required: Lint & Type Check, Admin Tests, Backend Tests, Foundry Tests (ruleset on `main`).
- Not required but run: E2E Tests, OpenAPI Spec.
- Vercel preview sometimes fails — ignore, not part of required checks.

---

## 6. Principles (learned the hard way)

These are session-level lessons captured so future agents don't repeat the same mistakes. Each one has a specific event behind it, not just theory.

### 6.1 Adoption signal gates code

**The rule:** new features need a specific external trigger — an issue, a user ask, a concrete integration dependency. *"The roadmap says this is next"* is not a trigger; it's drift in disguise.

**The evidence:** the productive work in recent sessions came from exactly two sources:
1. Responding to issue #49 (three PRs #50/#51/#52, clean delivery, issue closed)
2. Reducing adoption wall after explicit agreement that distribution was the bottleneck (dev-quickstart, 3 examples)

Large features that were in the roadmap but had no external demand (GMX adapter, escrow v3) were deferred *by design*. Shipping them would have consumed context budget without validating any hypothesis.

**How to apply:** before starting anything in §3.2, ask "what happens if I don't build this?" If the answer is "nothing specific breaks and no one is waiting," stop. Work on §3.1 (distribution / manual tasks) or pause.

### 6.2 CI green ≠ functionally validated

**The rule:** type-check + unit tests + CI passing does not mean the thing works end-to-end. Always run the happy path manually before shipping user-facing surface.

**The evidence:** three `examples/*` scripts and `docker-compose.dev.yml` shipped across PRs #44–#47 all had green CI but were never actually run `docker compose up` → `node examples/…` by the shipping agent. This was flagged in the session review as validation debt. The next session still owes paying it.

**How to apply:** for anything a new user or evaluator might run (examples, quickstarts, install commands), execute the full path locally at least once before merging. For backend-only changes, CI is usually sufficient.

### 6.3 Breaking changes ship alone

**The rule:** a release that contains a breaking change should contain only the breaking change. Don't bundle features.

**The evidence:** PR #52 bumped `@agent_fi/mcp-server` to 0.3.0 for a single clean reason: `request_policy_update` → `update_policy` rename. Users upgrading know exactly what changed. If we'd bundled GMX or new adapters in that release, the CHANGELOG entry would have been noisy and downstream clients would have had more to diff.

**How to apply:** `0.x.0` releases should have one-sentence CHANGELOG reasons. New tools, adapters, and improvements go in `0.x.1` / `0.x+1.0` patches/minors after the breaking change is out.

### 6.4 Drift is usually a diagnostic error

**The rule:** when a task is classified as "blocked" or "can't be done," check the diagnostic first. It's often wrong.

**The evidence:** HANDOFF classified sign/verify-handshake as "Turnkey-blocked" for months. When PR #51 touched it, we discovered Turnkey's SDK exposes `signRawPayload` — no new access scope, no real blocker. The classification was a diagnostic error from an older session that never got revisited.

**How to apply:** when §3.3 says something is blocked, spend 15 minutes verifying the blocker is real before accepting the classification. If it's not, move the task to §3.2 and consider doing it.

### 6.5 Docs consolidation pays off

**The rule:** stale docs poison LLM context more than code does. Archive or prune aggressively.

**The evidence:** consolidation PR #48 moved `docs/railway_logs/`, `docs/project/release-notes-hitl.md`, and `docs/project/go-live-status.md` into `docs/_archive/` because they were snapshots from infra that had been removed or frozen moments in time. The replacement was a clear triad (VISION → STATE → HANDOFF) that a new agent can read top-to-bottom without getting misled.

**How to apply:** when a doc stops being the live truth, update it in place, archive it to `docs/_archive/`, or delete it. Do not leave it in a navigable path hoping readers will intuit that it's stale.

---

## 7. Known quirks and non-issues

### Prisma schema and migrations
- Migrations are **never auto-generated** — write them manually in `packages/backend/src/db/migrations/NNNN_name/migration.sql`.
- After editing `schema.prisma`, run `npx prisma generate --schema=packages/backend/src/db/schema.prisma`.
- Latest migration: `0007_agent_ens` (adds `ensName` to Agent).

### Dependency quirks
- **Zod 3** pinned (Zod 4 requires MCP server refactor).
- **ethers v5** still present alongside **viem v2** (legacy for @safe-global/protocol-kit compat — don't touch unless doing a full migration).
- Fastify v5 plugins: `@fastify/cors ^11`, `@fastify/helmet ^13`, `@fastify/rate-limit ^10`, `fastify-plugin ^5`.

### Windows development
- Git on Windows auto-converts LF → CRLF (harmless for text, watch for file-content hash tests).
- Cold `npm install` on NTFS: ~60–90 seconds.

### Known non-issues (don't "fix" these)
- `e2e-testnet-smoke.yml` fails daily when testnet secrets are unset — intentional gate (`if: secrets.E2E_TESTNET_RPC_URL != ''`).
- `ethers v5` low-severity vulns in `npm audit` — transitive via `@safe-global/protocol-kit`.
- Vercel preview deploy failures on PRs — separate pipeline for admin dashboard, not a required check.

### Validation debt from the last session
The three `examples/*` scripts and `docker-compose.dev.yml` passed typecheck/syntax/CI but were **not run end-to-end** by the agent that shipped them. Before shipping new examples or touching the dev stack, run through the quickstart + all three examples manually. If something breaks, fixing that comes first.

---

## Appendix — Quick commands

```bash
# State
git log --oneline main -10
gh pr list
gh run list --workflow=ci.yml --limit 3

# Typecheck + test
npm run typecheck --workspaces --if-present
npm test --workspace=packages/backend

# Dev stack
docker compose -f docker-compose.dev.yml up --build
node examples/a2a-collab/index.mjs

# Release helpers
npm run release:v1:check
npm view @agent_fi/mcp-server version
```

**Security issue?** [SECURITY.md](SECURITY.md) — email maintainers, 48h SLA.

**Production incident?** Operator-specific (self-hosted). Your hosting provider's dashboard + [docs/operations/release-runbook.md](docs/operations/release-runbook.md).

---

*Update this file whenever you finish a pending task or discover a new quirk. Keep it short — the goal is fastest possible onboarding, not exhaustive detail.*
