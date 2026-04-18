# HANDOFF — AgentFi

> **Purpose**: Complete handoff document. A person (or agent) on a fresh machine should be able to pick up this project and execute any pending task by reading this file + VISION.md + roadmap.md.

**Last updated**: April 2026
**Current main SHA**: `b91c80e` (PR #38 merged — P&L v2 gas cost tracking)
**Repo**: https://github.com/felippeyann/agentfi (public, Apache 2.0)
**Release**: [v0.1.0](https://github.com/felippeyann/agentfi/releases/tag/v0.1.0)
**npm**: https://www.npmjs.com/package/@agent_fi/mcp-server (published v0.1.0; repo has v0.2.0 ready)

---

## Table of Contents

1. [Current State Snapshot](#1-current-state-snapshot)
2. [Environment Setup on a New Machine](#2-environment-setup-on-a-new-machine)
3. [Credentials Inventory](#3-credentials-inventory)
4. [Pending Manual Tasks](#4-pending-manual-tasks)
5. [Pending Technical Roadmap](#5-pending-technical-roadmap)
6. [How to Continue Development](#6-how-to-continue-development)
7. [Project Knowledge & Quirks](#7-project-knowledge--quirks)
8. [Files to Read First](#8-files-to-read-first)

---

## 1. Current State Snapshot

### Repository state

| Item | Value |
|------|-------|
| Default branch | `main` |
| Active branches | `main`, `develop` (synced) |
| Current SHA | `b91c80e` |
| Latest release | `v0.1.0` (Apr 2026) |
| Open PRs | 0 |
| Open issues | 0 |
| CI status | 5/5 green (Lint, Backend, Admin, Foundry, E2E) |
| Branch protection | Active on `main` (requires PR + all status checks) |

### Security state

| Metric | Value |
|--------|-------|
| npm vulnerabilities | 0 critical, 0 high, 4 moderate, 20 low |
| Last audit | April 2026 |
| Secrets in git history | None (audited) |
| `.env` files committed | None (`.gitignore` comprehensive) |

### Phase progress (see `docs/project/roadmap.md`)

**Phase 1 — Bootstrap**: Complete
**Phase 2 — HITL + Transparency**: Complete
**Phase 2.5 — Go-Live Hardening**: Complete
**Phase 3 — A2A Economy + DeFi expansion**: ~85% complete (see pending)
**Phase 4 — Self-Sustaining Agents**: ~10% complete (P&L v1 shipped)
**Phase 5 — SaaS**: Not started
**Phase 6 — Frontier**: Not started

### What was built in the last session (Apr 2026)

9 PRs shipped (all CI-green):
- #28 A2A Payment v1 + Reputation Scoring v2
- #29 Compound V3 adapter + Reputation time-decay + Daily cron
- #30 Compound MCP tools + docs
- #31 ERC-4626 vault adapter (generic vault support)
- #32 A2A Escrow v2 (DB-level reserve/release)
- #33 Agent P&L Dashboard v1 (Phase 4 starter)
- #34 Curve StableSwap adapter + mcp-server v0.2.0 bump
- #35 Fastify v5 upgrade + RELEASE.md
- #36 Documentation sync audit

---

## 2. Environment Setup on a New Machine

### Prerequisites

- **Node.js**: v22+ (LTS)
- **npm**: v10+ (bundled with Node 22)
- **Git**: any modern version
- **Docker**: for local Postgres + Redis + Anvil
- **Foundry**: for smart contract tests (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- **GitHub CLI** (`gh`): for PR management
- **Python 3.8+**: occasionally needed for complex text patches (optional)

### Clone and bootstrap

```bash
# 1. Clone
git clone https://github.com/felippeyann/agentfi.git
cd agentfi

# 2. Configure git identity
git config user.name "Your Name"
git config user.email "you@example.com"

# 3. Install dependencies
npm install

# 4. Copy and fill environment variables
cp .env.example .env
# Edit .env — see docs/operations/setup-checklist.md for required vars

# 5. Start local services
docker compose up -d

# 6. Apply database migrations
cd packages/backend
npx prisma migrate deploy
cd ../..

# 7. Verify everything works
npm run typecheck --workspaces --if-present
```

### Optional — run the backend locally

```bash
# Terminal 1: API
npm run dev --workspace=packages/backend

# Terminal 2: BullMQ worker (if TRANSACTION_WORKER_ENABLED=false in .env)
npm run worker --workspace=packages/backend

# Terminal 3: Admin dashboard
npm run dev --workspace=packages/admin
```

### Optional — run smart contract tests

```bash
cd packages/contracts
forge build
forge test -vvv
```

---

## 3. Credentials Inventory

These are needed for different tasks. Not all are required for every workflow.

### Required for development

| Credential | Where to get | Used for |
|------------|--------------|----------|
| **Alchemy API Key** | https://dashboard.alchemy.com | RPC calls to all chains |
| **Turnkey API keys** (public + private + org ID) | https://app.turnkey.com | MPC wallet provisioning |
| **Tenderly Access Key** | https://dashboard.tenderly.co | Transaction simulation |
| **Postgres URL** | Local (docker) or Neon | `DATABASE_URL` |
| **Redis URL** | Local (docker) or Upstash | `REDIS_URL` / BullMQ |

See `.env.example` for the full list.

### Required for publishing / distribution

| Credential | Where to get | Used for |
|------------|--------------|----------|
| **npm account with `@agent_fi` org access** | https://www.npmjs.com | Publishing mcp-server |
| **GitHub personal access token** with `workflow` scope | https://github.com/settings/tokens | Merging dependabot PRs that touch workflows |
| **GitHub `gh` CLI auth** | `gh auth login` | All PR/release operations |

### Optional for contract deployment

| Credential | Where to get | Used for |
|------------|--------------|----------|
| Etherscan/Basescan/Arbiscan API keys | Etherscan family sites | Contract verification |
| Deployer private key (with ETH) | Hot wallet | Deploying AgentPolicyModule + AgentExecutor |

### Production secrets (when going live)

| Credential | Used for |
|------------|----------|
| `ADMIN_SECRET` | Admin dashboard auth (min 32 chars) |
| `API_SECRET` | Operator auth for agent registration |
| `NEXTAUTH_SECRET` | Admin session signing |
| Stripe keys (`sk_live_*`, `whsec_*`) | Subscription billing |

Use `scripts/gen-secrets.sh` to generate strong random values for the three admin/auth secrets.

---

## 4. Pending Manual Tasks

### Task 1 — Publish `@agent_fi/mcp-server@0.2.0` to npm

**Why**: The repo has v0.2.0 but npm still shows v0.1.0. The new version adds 5 new MCP tools (Compound V3 supply/withdraw, ERC-4626 deposit/withdraw, Curve swap).

**Prerequisites**: npm account with `@agent_fi` org access, `npm login` completed.

**Steps**:

```bash
cd agentfi
git checkout main
git pull origin main

# Verify you're on the right version
grep '"version"' packages/mcp-server/package.json
# Expected: "version": "0.2.0"

# Build
cd packages/mcp-server
npm run build

# Dry-run to inspect what will be published
npm publish --access public --dry-run

# Publish for real
npm publish --access public

# Verify
npm view @agent_fi/mcp-server version
# Expected: 0.2.0
```

**Tag and GitHub release**:

```bash
cd ../..
git tag mcp-server-v0.2.0
git push origin mcp-server-v0.2.0

gh release create mcp-server-v0.2.0 \
  --title "mcp-server v0.2.0" \
  --notes "Adds supply_compound, withdraw_compound, deposit_erc4626, withdraw_erc4626, swap_curve. 26 tools on standalone package (16 on backend proxy)."
```

Full publish guide: [`packages/mcp-server/RELEASE.md`](packages/mcp-server/RELEASE.md)

### Task 2 — Submit mcp-server to MCP discovery directories

After Task 1 completes, submit the package to gain visibility.

| Directory | URL | What to submit |
|-----------|-----|----------------|
| mcp.so | https://mcp.so/submit | Name, npm package, description, GitHub URL |
| Smithery | https://smithery.ai/submit | Same |
| awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | Open PR adding AgentFi to DeFi/Finance section |

**Copy to use**:

> **AgentFi MCP Server** — Crypto transaction tools for AI agents. 26 tools covering swaps (Uniswap V3, Curve StableSwap), yield (Aave V3, Compound V3, any ERC-4626 vault), transfers, and agent-to-agent collaboration (job queue, reputation, escrow). Built on Turnkey MPC wallets + Safe Smart Accounts. Works on Ethereum, Base, Arbitrum, Polygon.
>
> - **npm**: https://www.npmjs.com/package/@agent_fi/mcp-server
> - **GitHub**: https://github.com/felippeyann/agentfi

---

## 5. Pending Technical Roadmap

Organized by readiness (can start now / needs credentials / complex design).

### Can start immediately (no external blockers)

#### A. P&L v2 — Gas cost tracking (Phase 4, medium effort)

**Context**: The current `PnLService` (`packages/backend/src/services/billing/pnl.service.ts`) has gas costs marked as `null` because `gasPrice` isn't reliably stored at confirmation time. Fixing this makes the `profitable` flag accurate.

**Plan**:

1. Create migration `0006_tx_gas_price`:
   ```sql
   ALTER TABLE "Transaction"
     ADD COLUMN IF NOT EXISTS "effectiveGasPriceWei" TEXT;
   ```

2. Update `packages/backend/src/db/schema.prisma` — add `effectiveGasPriceWei String?` to Transaction model.

3. Update `packages/backend/src/services/transaction/monitor.service.ts`:
   - When the receipt is fetched, extract `receipt.effectiveGasPrice`
   - Persist it via `db.transaction.update({ data: { gasUsed, effectiveGasPriceWei: receipt.effectiveGasPrice.toString() } })`

4. Update `packages/backend/src/services/billing/pnl.service.ts`:
   - Add a new cost category `gasCosts`
   - Query all CONFIRMED/REVERTED transactions in the period
   - For each: `gasCostWei = BigInt(gasUsed) * BigInt(effectiveGasPriceWei)` then `weiToUsd(gasCostWei, chainId)`
   - Sum and add to `totalCostsUsd`

5. Test with a real transaction (E2E or manual) to verify gas is captured.

6. Update `docs/api-reference.md` and `CHANGELOG.md`.

**Estimated effort**: 3-4 hours including tests.

**PR naming**: `feat(phase4): P&L v2 — gas cost tracking`

#### B. GMX / Perp adapter (Phase 3, high effort)

**Context**: The last DeFi adapter to round out Phase 3. GMX uses a more complex ABI than the stable adapters we've done (Compound, ERC-4626, Curve) — includes leverage positions, risk management, funding rates.

**Starting points**:
- GMX V2 docs: https://docs.gmx.io
- Reference: how we did Curve (`packages/backend/src/services/transaction/builder.service.ts` `buildCurveSwap`)
- Decision needed: support only market orders first, or also trigger orders?

**Estimated effort**: 10-20 hours.

#### C. A2A Escrow v3 — On-chain escrow contract (Phase 3, very high effort)

**Context**: v2 is DB-only (Reservations + DailyVolume). v3 would deploy an actual smart contract escrow, making funds un-spendable even by the requester between job create and terminal state.

**Plan** (rough):
1. New Solidity contract: `EscrowModule.sol` — Safe module that locks tokens per jobId
2. Integrate with `AgentPolicyModule` so normal tx validation respects locked balances
3. Update `EscrowService` to call `lock()` / `release()` instead of DB-only accounting
4. Migration to track on-chain escrow addresses per job

**Estimated effort**: 30-40 hours (including audit prep).

#### D. Persistent Identity — ENS (Phase 4, medium effort)

**Context**: Give each agent an `agent.eth` subdomain so other dApps can reference them. Improves discoverability and aligns with VISION.md's "Economic identity" section.

**Plan**:
1. Operator registers a parent domain (e.g., `agentfi.eth`) and sets up a resolver that creates subdomains per agent
2. On agent registration, call the resolver to create `<agent-name>.agentfi.eth` pointing to the agent's Safe address
3. Expose the subdomain in `GET /v1/agents/:id` response
4. Document in api-reference

**Estimated effort**: 5-8 hours (plus domain cost + ENS gas).

### Blocked (need credentials or external decisions)

#### E. Sign/Verify Handshake (Phase 3)

**Blocked by**: Turnkey MPC credentials + API access to their signing service.

**Status**: Endpoints return 501 at `packages/backend/src/api/routes/agents.ts` lines ~347 and ~362.

**What to implement when unblocked**:
1. `POST /v1/agents/me/sign-handshake` — call Turnkey's message signing API with the agent's wallet ID, return `{ message, signature, address }`
2. `POST /v1/agents/verify-handshake` — for Safe wallets, use EIP-1271 via viem's `verifyMessage`; for EOA fallback, use ECDSA recovery

#### F. Agent Self-Funding (Phase 4)

**Blocked by**: Legal + product decision — who owns the sub-wallet when an agent provisions it? This has regulatory implications.

**Design questions**:
- Is the sub-wallet a new Agent or a sub-agent?
- Does the parent agent retain any control?
- How does revenue flow from the parent's earnings to the sub-wallet?

### Pending documentation / polish

- ~~**API reference → OpenAPI spec**~~: **done** — OpenAPI 3.0.3 at `docs/api/openapi.yaml`, validates clean under `npx @redocly/cli lint`
- **Contract deployment runbook**: update `docs/operations/contract-deployment.md` with the latest deployed addresses per chain (currently only Base Mainnet has listed addresses)
- **Demo video / screencast**: record a 2-minute demo of Claude Desktop using the MCP server to do a real swap

---

## 6. How to Continue Development

### Branch workflow

`main` is protected. You **cannot push directly** — all changes go via PR.

1. Create a feature branch from `main`:
   ```bash
   git checkout main && git pull origin main
   git checkout -b feat/your-feature-name
   ```

2. Make changes, commit locally (with proper identity):
   ```bash
   git -c user.name="Your Name" -c user.email="you@example.com" commit -m "feat: description"
   ```

3. Push and open a PR:
   ```bash
   git push origin feat/your-feature-name
   gh pr create --base main --head feat/your-feature-name --title "..." --body "..."
   ```

4. **Wait for CI** — all 6 jobs must pass:
   - Deploy Preflight Check
   - Lint & Type Check
   - Admin Tests
   - Backend Tests
   - Foundry Tests
   - E2E Tests

5. Merge:
   ```bash
   gh pr merge <number> --merge
   ```

6. Sync develop (convention — develop mirrors main post-merge):
   ```bash
   git checkout develop
   git pull origin main
   git push origin develop
   ```

### CI expectations

- **Full CI takes ~3 minutes** when all jobs are cached
- **Backend Tests** is the most informative — runs Prisma migrate + unit + integration tests
- **E2E Tests** spins up Anvil + Postgres + Redis — expect 60-90 seconds
- **Foundry Tests** runs `forge test` with coverage
- **Vercel check** can be ignored — it's a separate preview deploy for the admin dashboard and sometimes fails on external deps

### Commit conventions

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — docs only
- `chore:` — dependency bumps, config changes
- `feat(phase3):` — label Phase-specific work
- `fix(ci):` — CI config fix
- Always include the `Co-Authored-By:` footer if AI-assisted

### Code style

- Prettier is configured (`.prettierrc`) — run `npm run typecheck` to catch issues
- TypeScript strict mode enabled (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Prefer `const` over `let`, avoid `any`, use Zod for runtime validation
- Commit messages in English; Portuguese is fine in docs/agents/claude-instructions.md only

---

## 7. Project Knowledge & Quirks

### Windows development notes

- Git on Windows may auto-convert LF to CRLF — this is harmless for text files but can confuse file-based tests
- `npm install` is slow on Windows (NTFS overhead) — expect ~60-90 seconds for a cold install
- Python scripts used for complex patches should set `os.chdir()` to the repo root explicitly

### Known CI quirks

- **E2E tests** depend on a specific Prisma client version — if the schema changes, always re-run `npx prisma generate` locally before committing
- **Fastify v5 plugins** all need to be on v5-compatible versions — Dependabot bumped them separately in PRs #7/#8/#18/#20 before the core upgrade in #35
- **Template literal backticks** in bash heredocs + Python replace() = escaping hell. If you need to patch TypeScript files with template literals, use the `Write`/`Edit` tools directly, not shell scripts.

### Prisma schema + migrations

- Migrations are **never auto-generated** — always write them manually in `packages/backend/src/db/migrations/NNNN_name/migration.sql`
- After editing `schema.prisma`, run `npx prisma generate --schema=packages/backend/src/db/schema.prisma` to update the Prisma client
- Latest migration: `0005_job_escrow` (adds escrow fields to Job)

### Testing patterns

- **Unit tests** (Vitest) use mocked Prisma client — see `packages/backend/src/__tests__/policy.service.test.ts` for the mock pattern
- **E2E tests** use real Postgres + Redis + Anvil — `packages/backend/src/__tests__/e2e/global-setup.ts` spins them up
- Avoid hardcoded `setTimeout` delays — use the polling helpers (`waitForTxStatus`, `waitForFeeEvent`, `waitForDailyVolume` in `transaction.e2e.ts`)

### Dependency quirks

- **Zod 3** is pinned (v4 requires MCP server refactor — deferred)
- **ethers v5** is still present alongside **viem v2** (legacy for @safe-global/protocol-kit compatibility — don't touch unless you're doing a full migration)
- **Fastify v5** plugins used: `@fastify/cors ^11`, `@fastify/helmet ^13`, `@fastify/rate-limit ^10`, `fastify-plugin ^5`

### Known non-issues (don't "fix" these)

- `e2e-testnet-smoke.yml` workflow runs daily and fails when secrets are absent — this is intentional (the workflow checks `if: secrets.E2E_TESTNET_RPC_URL != ''`)
- The Vercel preview deployment on PRs sometimes fails — it's a separate pipeline for the admin dashboard and not part of the required status checks
- `ethers v5` vulnerabilities in `npm audit` — these are low severity and come from `@safe-global/protocol-kit` transitive deps

---

## 8. Files to Read First

When a new developer (human or agent) joins, have them read in this order:

### Must-read (in order)

1. **[VISION.md](VISION.md)** — Why the project exists. Everything else derives from this.
2. **This file (HANDOFF.md)** — Current state + pending tasks.
3. **[README.md](README.md)** — High-level overview + quick links.
4. **[docs/architecture/overview.md](docs/architecture/overview.md)** — 4-layer stack explained.
5. **[CONTRIBUTING.md](CONTRIBUTING.md)** — How to propose changes.

### For operators

6. **[docs/operations/setup-checklist.md](docs/operations/setup-checklist.md)** — Step-by-step setup.
7. **[docs/operations/production-deploy.md](docs/operations/production-deploy.md)** — Self-hosted production deployment (provider-agnostic; Railway as the reference example).
8. **[docs/operations/contract-deployment.md](docs/operations/contract-deployment.md)** — Deploying Safe modules.

### For agents / integrators

9. **[docs/agents/quickstart.md](docs/agents/quickstart.md)** — Connect an agent in < 5 minutes.
10. **[docs/api-reference.md](docs/api-reference.md)** — 47 REST endpoints.
11. **[packages/mcp-server/README.md](packages/mcp-server/README.md)** — 26 MCP tools.

### For developers continuing the roadmap

12. **[docs/project/roadmap.md](docs/project/roadmap.md)** — Phase-by-phase breakdown with checklists.
13. **[docs/project/go-live-status.md](docs/project/go-live-status.md)** — Detailed post-go-live progress.
14. **[CHANGELOG.md](CHANGELOG.md)** — All changes in the [Unreleased] section.

### For AI agents contributing

15. **[docs/agents/claude-instructions.md](docs/agents/claude-instructions.md)** — Portuguese context brief for Claude-based contributors. Starts with "**IMPORTANTE:** Antes de qualquer implementação, leia VISION.md".

---

## Appendix A — Quick command reference

```bash
# Check current state
git status
git log --oneline main -10
gh pr list
gh run list --workflow=ci.yml --limit 3

# Typecheck everything
npm run typecheck --workspaces --if-present

# Run tests
npm test --workspace=packages/backend               # unit
npm run test:e2e --workspace=packages/backend       # e2e (needs docker services)
cd packages/contracts && forge test                 # solidity

# Dependency audit
npm audit

# Check if npm package is up to date
npm view @agent_fi/mcp-server version

# Sync develop with main after merge
git checkout develop && git pull origin main && git push origin develop
```

## Appendix B — Emergency contacts / escalation

- **Security vulnerability**: Follow [SECURITY.md](SECURITY.md) (email maintainers directly, 48-hour SLA)
- **Production incident**: operator-specific. Consult the hosting provider's dashboard for your deployment + follow `docs/operations/release-runbook.md`
- **Repository ownership**: See [.github/CODEOWNERS](.github/CODEOWNERS)

---

*This document is the single source of truth for resuming work on AgentFi. Update it whenever you finish a pending task or discover new quirks. When in doubt, commit to the `main` branch via PR — it keeps CI as the ground truth.*
