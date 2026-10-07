# HANDOFF — AgentFi

> Live pending tasks, credentials inventory, and working conventions. For _what the project is_, read [STATE.md](STATE.md). For _why_, read [VISION.md](VISION.md). This file is the shortest path from "resuming work" → "executing something useful."

**Last updated**: 2026-10-06 · **main baseline verified** `b051077` · **Repo**: https://github.com/felippeyann/agentfi (public, Apache 2.0, **reactivated in exploratory mode on 2026-10-06** after being archived 2026-05-17) · **Release**: [mcp-server-v0.5.0](https://github.com/felippeyann/agentfi/releases/tag/mcp-server-v0.5.0) · **npm**: [`@agent_fi/mcp-server@0.5.0`](https://www.npmjs.com/package/@agent_fi/mcp-server) (published 2026-05-15)

> **Resuming work?** Read, in order: [VISION.md](VISION.md) → [STATE.md](STATE.md) → [docs/project/execution-plan-2026-10.md](docs/project/execution-plan-2026-10.md) (the live plan with task status) → this file. The review that led to reactivation is [docs/project/reactivation-2026-10.md](docs/project/reactivation-2026-10.md) and the market evidence is [docs/project/market-signals-2026-10.md](docs/project/market-signals-2026-10.md) (both in Portuguese).

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

| Item                   | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Default branch         | `main` (protected; required checks: Lint, Admin, Backend, Foundry) |
| Active branches        | `main`, `develop` (mirrors main post-merge); task branches `<type>/<task-id>-<slug>` per the execution plan |
| Open PRs               | Dependabot bumps (see execution plan WS8) + task PRs in flight     |
| Open issues            | 0                                                                  |
| CI                     | green on `main` (6 jobs: 5 required + OpenAPI Spec)                |
| npm vulnerabilities    | 0 critical, 0 high                                                 |
| Secrets in git history | None                                                               |
| Live infrastructure    | **None.** Fly.io backend and Upstash Redis were decommissioned on 2026-05-17. No hosted instance is planned for the 90-day validation. |

**Phase progress** (see [STATE.md §6](STATE.md#6-phase-progress) for detail):

- Phase 1–2.5: complete.
- Phase 3 — A2A economy + DeFi expansion: complete (GMX adapter, escrow v3 on-chain and the sign/verify handshake all shipped in May 2026).
- Phase 4 — Self-sustaining agents: ~70%. Shipped: P&L v1+v2 (with gas), ENS identity, revenue sharing (Operator model). Remaining: self-funding sub-wallets (legal decision).
- **Reactivation (Q4 2026) — "trust layer":** ERC-8183-compatible escrow, ERC-8004 reputation anchored in settled payments, x402/MPP payment client, wallet providers as adapters. Tracked task by task in [docs/project/execution-plan-2026-10.md](docs/project/execution-plan-2026-10.md). The old Phases 5–6 (hosted SaaS, "frontier") are superseded by that plan.

---

## 2. Required reading order

1. [VISION.md](VISION.md) — the _why_. Required.
2. [STATE.md](STATE.md) — the _what_ today.
3. This file (HANDOFF.md) — live work + working conventions.
4. [docs/dev-quickstart.md](docs/dev-quickstart.md) — 3-min path from clone to running stack.
5. [docs/architecture/overview.md](docs/architecture/overview.md) — 4-layer stack.

**If you're coming in to ship code**, also read:

- Relevant example under [`examples/`](examples/) for the surface you're touching.
- [docs/api-reference.md](docs/api-reference.md) or [docs/api/openapi.yaml](docs/api/openapi.yaml) for the API shape.
- [CONTRIBUTING.md](CONTRIBUTING.md) for PR conventions.

---

## 3. Pending work

**All pending work lives in [docs/project/execution-plan-2026-10.md](docs/project/execution-plan-2026-10.md)** (workstreams WS0–WS8, one row per task, with status and PR links). Do not maintain a second list here. Nothing in `Done` is listed there — those live in [CHANGELOG.md](CHANGELOG.md).

### 3.1 Owner-only items (summary; details in the plan)

| Task | Plan ID | Notes |
|---|---|---|
| Demand validation interviews | WS7 V1–V3 | Three operator interviews by Day 30; the Day-30 checkpoint can stop the technical workstreams. |
| Deploy contracts on Base Sepolia (then mainnet) | WS2 C4, C6 | Needs the deployer key in local `.env`; agents prepare the exact `forge script` command. |
| Record the demo screencast | WS6 X2 | Agents prepare the script and prompts. |
| Directory listings | WS6 X3 | mcp.so listing returns 404; the awesome-mcp-servers entry (PR #5091, merged 2026-05-27) was pruned after the archive and must be resubmitted. |
| Answer the open questions | Plan §5 | Evaluator role, fee model, ERC-8004 identity opt-in, mainnet redeploy, Brazil "software only" assumption, native-ETH jobs. |

### 3.2 Known defects being fixed (Week 0)

A1 (backend ABI vs contract source), A2 (mock simulation accepted in production), A3 (pause not re-validated before signing) and S1 (agent can relax its own policy) are **merged** (#132, #129, #130, #131) and were hardened by an adversarial review (#139 backend, #140 contracts, #137 x402). Open follow-ups found on the way are plan rows A3b, A6, S2, S3, A4, A5 and C3b. Real funds still wait for the Base Sepolia redeploy (C4) and the testnet E2E (C5).

### 3.3 Blocked externally

| Task                     | Blocked by                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| Self-funding sub-wallets | Legal decision (who owns the sub-wallet when an agent provisions it) |

### 3.4 The meta-guidance

The project reached complete plumbing with zero external users in May 2026. The reactivation plan is explicitly a **validation**, gated on demand (plan §1). "Adoption signal gates code" (§6.1 below) still applies to anything that is not a task in the plan. If the Day-30 checkpoint shows no demand, stop the technical workstreams rather than adding more code.

---

## 4. Credentials inventory

| Credential                               | When needed                                               | Where to get                             |
| ---------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| Alchemy API Key                          | Any real-chain interaction                                | https://dashboard.alchemy.com            |
| Turnkey keys (public + private + org ID) | Production wallets                                        | https://app.turnkey.com                  |
| Tenderly access key                      | Pre-broadcast tx simulation (optional; graceful fallback) | https://dashboard.tenderly.co            |
| Postgres URL                             | Always                                                    | Local Docker, Neon, Supabase, Railway PG |
| Redis URL                                | Always                                                    | Local Docker, Upstash, Railway Redis     |
| npm publish access to `@agent_fi`        | Publishing mcp-server                                     | https://www.npmjs.com (invite-only org)                                          |
| `gh auth login`                          | PR + release ops                                          | GitHub CLI                               |
| Etherscan-family API keys                | Contract verification                                     | Per-chain block explorer                 |
| Funded deployer EOA                      | Contract deployment                                       | Hot wallet with gas                      |

**Dev quickstart path** (for evaluation, no real credentials): `WALLET_PROVIDER=local` + stub Alchemy + docker-compose.dev.yml. See [docs/dev-quickstart.md](docs/dev-quickstart.md). For real-chain local or production setup, use [docs/operations/setup-checklist.md](docs/operations/setup-checklist.md).

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

**The rule:** new features need a specific external trigger — an issue, a user ask, a concrete integration dependency. _"The roadmap says this is next"_ is not a trigger; it's drift in disguise.

**The evidence:** the productive work in recent sessions came from exactly two sources:

1. Responding to issue #49 (three PRs #50/#51/#52, clean delivery, issue closed)
2. Reducing adoption wall after explicit agreement that distribution was the bottleneck (dev-quickstart, 3 examples)

Large features that were in the roadmap but had no external demand (GMX adapter, escrow v3, revenue sharing) were deferred _by design_ for weeks, then shipped anyway on 2026-05-13 (PR #116) without an external trigger, and the project was archived four days later. That sequence is the drift this rule warns about.

**How to apply:** before starting anything that is not a task in the execution plan, ask "what happens if I don't build this?" If the answer is "nothing specific breaks and no one is waiting," stop. Work on distribution or demand validation (plan WS6/WS7) or pause.

### 6.2 CI green ≠ functionally validated

**The rule:** type-check + unit tests + CI passing does not mean the thing works end-to-end. Always run the happy path manually before shipping user-facing surface.

**The evidence:** three `examples/*` scripts and `docker-compose.dev.yml` shipped across PRs #44–#47 all had green CI but were not initially run `docker compose up` → `node examples/…` by the shipping agent. When the debt was paid later, first-run validation found real breakage: missing MCP workspace deps in the Docker image, missing API migrations on fresh Postgres, IPv6 `localhost` healthcheck mismatch, and public discovery routes blocked by auth.

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
- Latest migration: `0013_operator_revenue_sharing` (Operator, OperatorRevenue, OperatorSettlement). The reactivation plan reserves 0014 (ERC-8183 job fields), 0015 (ERC-8004 agent id) and 0016 (ResourcePayment).

### Dependency quirks

- **Zod 3** pinned (Zod 4 requires MCP server refactor).
- **ethers v5** still present alongside **viem v2** for Aave helper integration — don't remove it just because Safe protocol-kit v7 no longer uses `SafeFactory`.
- Fastify v5 plugins: `@fastify/cors ^11`, `@fastify/helmet ^13`, `@fastify/rate-limit ^10`, `fastify-plugin ^5`.

### Windows development

- Git on Windows auto-converts LF → CRLF (harmless for text, watch for file-content hash tests).
- Cold `npm install` on NTFS: ~60–90 seconds.

### Known non-issues (don't "fix" these)

- `e2e-testnet-smoke.yml` fails daily when testnet secrets are unset — intentional gate (`if: secrets.E2E_TESTNET_RPC_URL != ''`).
- `ethers v5` remains in use for Aave helper integration; do not remove it just because Safe protocol-kit v7 migrated away from `SafeFactory`.
- Vercel preview deploy failures on PRs — separate pipeline for admin dashboard, not a required check.

### Repo layout — landing site lives outside this monorepo

The `agentfi.cc` landing site was a **separate repository**, not a workspace
in this monorepo. As of 2026-10-06 the `felippeyann/agentfi-landing` repo no
longer exists on GitHub and `agentfi.cc` only returns a redirect; the Vercel
project `agentfi-admin` returns 403. Treat the landing as gone until the owner
decides otherwise.

Don't add a `packages/landing/` workspace here. An earlier attempt did
exactly that and produced redundant deploys + brittle Vercel config that
fought the monorepo (`cd ../.. && npm install --legacy-peer-deps` in
`vercel.json`). The polyrepo split was kept because (a) landing is a
static marketing site that almost never needs atomic changes with the
backend, and (b) keeping it out of the monorepo means edits don't trigger
the full backend CI suite.

If you ever need a coordinated landing+backend change (e.g. landing
embeds a versioned API URL), open one PR per repo and merge them in
order. Don't re-attempt monorepo consolidation without explicit user
agreement.

### Dev-stack validation

The zero-credential dev stack has been validated locally from clean compose
volumes. This path should be rerun before changing examples, Dockerfiles,
`docker-compose.dev.yml`, auth middleware, Prisma migrations, or quickstart docs:

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up --build -d
npm run smoke:dev
node examples/a2a-collab/index.mjs
node examples/swap-planner/index.mjs
node examples/delegation-chain/index.mjs
```

Expected result: all five services healthy, smoke passes, and all three examples
complete without external credentials.

### Reward accounting decimals

A2A reward accounting intentionally prices only native ETH and ERC-20 rewards
known to the local token registry. Unknown ERC-20 reward tokens are marked
unresolved and counted as `$0` with P&L notes instead of guessing decimals.
Add a token to `packages/backend/src/services/transaction/token-registry.ts`
before relying on it for escrow volume, revenue snapshots, or live P&L fallback.

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
npm run smoke:dev
node examples/a2a-collab/index.mjs

# Release helpers
npm run release:v1:check
npm view @agent_fi/mcp-server version
```

**Security issue?** [SECURITY.md](SECURITY.md) — email maintainers, 48h SLA.

**Production incident?** Operator-specific (self-hosted). Your hosting provider's dashboard + [docs/operations/release-runbook.md](docs/operations/release-runbook.md).

---

_Update this file whenever you finish a pending task or discover a new quirk. Keep it short — the goal is fastest possible onboarding, not exhaustive detail._
