# Session Notes — 2026-05-15

> Single-point handoff doc. Update on every substantive session, prune stale
> sections aggressively. If this file is older than a few days when you read
> it, trust `git log`, `gh pr list`, and `gh issue list` over the contents
> here.

---

## Where we are right now

`main` baseline: `9ce8db6` (post PR #117 — mcp-server 0.5.0 bump).

| Surface                       | Status                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| Open PRs                      | 10 Dependabot (deps only, no feature work)                  |
| Open issues                   | 0                                                           |
| npm `@agent_fi/mcp-server`    | **0.5.0 live** (`dist-tags.latest=0.5.0`, 2026-05-15)      |
| GitHub release                | `mcp-server-v0.5.0` published                               |
| Worktrees                     | None (phase2-snapshots removed — branch was already merged) |

---

## What changed this session

### Safe protocol-kit v7

`packages/backend/src/services/wallet/safe.service.ts` now uses the v7 flow:

- `Safe.init({ predictedSafe })`
- `createSafeDeploymentTransaction()`
- broadcast through `viem` wallet client
- reload the deployed Safe with `Safe.init({ safeAddress })`
- enable `AgentPolicyModule` post-deployment

CI for #58 passed: lint/typecheck, backend tests, admin tests, foundry, E2E, OpenAPI, and Vercel.

### TypeScript 6

The root and workspace TypeScript versions are now on `^6.0.3`.

The `openapi-typescript` peer blocker remains real upstream (`typescript: ^5.x`), so it was removed from root `devDependencies`. The codegen scripts now invoke a pinned toolchain only where needed:

```bash
npx --yes --package openapi-typescript@7.13.0 --package typescript@5.9.3 openapi-typescript ...
```

Additional TS 6 compatibility fixes:

- root `tsconfig.base.json` includes `DOM` lib and Node types for `fetch`, `RequestInit`, and `process` in Node 22 workspaces.
- admin `tsconfig.json` no longer uses deprecated `baseUrl`.
- `scripts/check-spec-drift.mjs` shells through `npx` only for the codegen call.

CI for #64 passed: lint/typecheck, backend tests, admin tests, foundry, E2E, OpenAPI, and Vercel.

### P0 diagnostic follow-up

After reading `VISION.md`, the active P0s were defined as:

1. Prove the first-run dev experience works.
2. Keep handoff docs truthful so future agents do not chase stale blockers.
3. Automate the first-run validation path enough that it can be repeated.

Implemented:

- `npm run smoke:dev`
- `scripts/smoke-dev.mjs`
- `docs/dev-quickstart.md` updated to reference the smoke test.
- `STATE.md` and `HANDOFF.md` updated for the post-#58/#64 world.

The smoke test checks:

- API health
- two local agent registrations
- authenticated `/v1/agents/me`
- manifest publish
- agent search
- no-reward A2A job create/accept/complete
- trust report and P&L response shapes

### First-run Docker validation

Docker Desktop was started locally and the first-run path was executed from a
clean compose state (`docker compose down -v` before rebuild).

Fixed blockers found during that validation:

- `Dockerfile.mcp` now carries `packages/mcp-server/node_modules` into the
  builder and runner stages so workspace-local dependencies such as
  `dotenv/config` resolve under TypeScript 6.
- `docker-compose.dev.yml` runs `prisma migrate deploy` before starting the API,
  so a fresh Postgres volume has the schema before traffic reaches Fastify.
- Docker healthchecks now use `127.0.0.1` instead of `localhost`, avoiding Alpine
  `::1` resolution when services listen on IPv4.
- The admin image sets `HOSTNAME=0.0.0.0`, so Next standalone is reachable by
  the container healthcheck and host port mapping.
- The standalone MCP SSE service gets a dev placeholder `AGENTFI_API_KEY` so it
  can boot before a real agent key is registered.
- Public discovery routes documented as unauthenticated
  (`/v1/agents/search`, `/v1/agents/:id/manifest`,
  `/v1/agents/:id/trust-report`, `/v1/agents/verify-handshake`) are now skipped
  by the global agent-key middleware.

### Token decimals / reward accounting

The non-ETH reward pricing path no longer assumes 6 decimals for every ERC-20.

- Added a local token registry for chain-specific USDC/WETH-style reward
  decimals and reused it from transaction decimal lookup.
- `resolveRewardUsd()` now prices native ETH directly, prices known ERC-20
  rewards through the registry, and reports unknown ERC-20 rewards as
  unresolved instead of guessing.
- DB escrow reservations now reuse the same reward-pricing helper used by
  payment snapshots and P&L live fallback, so accounting behavior is consistent
  across create, finalize, and dashboard paths.

### Claude Desktop MCP adoption demo

Added a lightweight demo-prep helper and walkthrough for Claude Desktop:

- `npm run demo:claude-mcp` registers a local provider/requester pair, publishes
  a provider manifest, verifies requester `/v1/agents/me`, and prints a
  ready-to-paste two-server Claude Desktop config.
- `docs/demos/claude-desktop-mcp.md` contains the presentation flow: provider
  manifest, requester discovery, no-reward A2A job, trust report, and REST P&L
  checkpoint.
- `docs/agents/quickstart.md` now makes local stdio the Claude Desktop default
  and keeps hosted SSE framed as a remote-client option.

### MCP P&L/profile tools

Closed the remaining demo gap where P&L required a REST fallback:

- Source package `@agent_fi/mcp-server` is now `0.4.0` and includes
  `get_my_agent_profile` and `get_my_pnl`.
- Backend embedded `/mcp/sse` proxy exposes matching tools.
- `npm run demo:claude-mcp` now points Claude Desktop at the local workspace MCP
  server by default; can switch back to the published package at any time.

### npm publish 0.4.0 (2026-05-10)

`@agent_fi/mcp-server@0.4.0` is live on npm with `dist-tags.latest=0.4.0`. Tag
`mcp-server-v0.4.0` pushed and [GitHub release](https://github.com/felippeyann/agentfi/releases/tag/mcp-server-v0.4.0)
created. The previous npm passkey/auth blocker is resolved.

### External distribution unblocked (2026-05-10)

Three distribution surfaces processed in the same session as the publish:

- **Glama listing** (https://glama.ai/mcp/servers/felippeyann/agentfi) is live.
  Configured via the registry's form (Node 22 base, `mcp-proxy` wrapper spawning
  `node packages/mcp-server/dist/index.js` over stdio). First build succeeded —
  `initialize` handshake + `tools/list` returned all 28 tools without credentials.
  Glama detects License as Apache-2.0 and assigned Quality grade `A`.
  Two prerequisites landed in [PR #103](https://github.com/felippeyann/agentfi/pull/103):
  - `LICENSE` — Apache-2.0 APPENDIX block added so license detectors stop falling
    back to NOASSERTION. GitHub's `licensee` is stricter than Glama's and still
    classifies the file as `Other`; low-priority follow-up (does not block the
    listing or any consumer).
  - `Dockerfile.glama` — stdio-mode reference Dockerfile kept in the repo for any
    tooling that expects one. Glama itself generates its own image from the form
    fields, so this file is dormant for that registry's build but harmless.
- **awesome-mcp-servers PR #5091** updated. Commit `f3822064` adds the Glama
  score badge to the AgentFi entry per the maintainer's 2026-04-24 request, and
  bumps the tool count 26 → 28. PR is `MERGEABLE`; awaiting `punkpeye` review.
- **mcp.so listing** — update comment posted on
  [chatmcp/mcpso Issue #1](https://github.com/chatmcp/mcpso/issues/1#issuecomment-4415526897)
  with the new config pointing at `@agent_fi/mcp-server@0.4.0`. Awaiting the
  registry maintainer (`@idoubi`) to apply.

---

## Validation

Completed locally:

- `npm ci` passed after #64.
- `npm run lint --workspaces --if-present` passed (workspaces currently echo
  "no eslint configured").
- `npm run typecheck --workspaces --if-present` passed.
- `npm run demo:claude-mcp` passed against the running dev stack.
- `npm run build -w packages/mcp-server` passed after adding MCP tools.
- `npm run spec:check` passed after regenerating `api.generated.ts`.
- `npm run smoke:dev` passed after adding MCP P&L/profile tools.
- `npm run test -w packages/backend -- reward-pricing` passed.
- `npm run test -w packages/backend` passed with local Docker Postgres/Redis
  running and the required test env vars set.
- `npm run spec:check` passed.
- `npm run spec:lint` passed.
- `npm test -w packages/admin` passed.
- `npm run test -w packages/backend` passed when pointed at the local compose
  Postgres/Redis with required env vars set.
- `docker compose -f docker-compose.dev.yml up --build -d` passed from clean
  volumes.
- All compose services reached healthy state: Postgres, Redis, API, admin, MCP.
- `npm run smoke:dev` passed against the running dev stack.
- `docker compose -f docker-compose.dev.yml up --build -d` and
  `npm run smoke:dev` passed again after the reward-accounting change.
- `node examples/a2a-collab/index.mjs` passed.
- `node examples/swap-planner/index.mjs` passed.
- `node examples/delegation-chain/index.mjs` passed.

---

### Roadmap implementation (2026-05-13)

All HANDOFF.md §3 pending technical items have been implemented:

**1. Contract deployment runbook expansion**
- `docs/operations/contract-deployment.md` rewritten: multi-chain deployment
  checklist, fee configuration per chain, post-deployment verification (manual +
  automated), address registry, Safe module installation, disaster recovery.
- `scripts/verify-deployment.sh` created: cast-based automated verification for
  all three contracts (PolicyModule, Executor, EscrowModule).

**2. GMX/Perp adapter (Phase 3)**
- `packages/backend/src/services/defi/gmx.service.ts` — GMX V2 Synthetics
  service: market data, execution fee calculation, market resolution.
- `buildGmxCreateOrder()` in builder.service.ts — ExchangeRouter multicall
  encoding for MarketIncrease/Decrease + LimitIncrease/Decrease.
- `POST /v1/transactions/gmx-open` and `POST /v1/transactions/gmx-close` routes.
- 3 MCP tools: `list_gmx_markets`, `open_gmx_position`, `close_gmx_position`.
- Schema: `GMX_OPEN`, `GMX_CLOSE` TxType enum values + migration 0011.
- Config: GMX contract addresses for Arbitrum (42161).

**3. Escrow v3 on-chain (Phase 3)**
- `EscrowModule.sol` — on-chain custody for A2A job payments (lock/release/refund).
- 22 Foundry tests pass (including 3 fuzz tests × 256 runs).
- `Deploy.s.sol` updated to deploy EscrowModule alongside PolicyModule + Executor.
- `escrow-onchain.service.ts` — backend wrapper for building lock/release/refund txs.
- Integration: `escrow.service.ts` conditionally queues on-chain lock at job
  creation when EscrowModule is deployed; `payment-finalizer.service.ts` queues
  on-chain release (CONFIRMED) or refund (FAILED).
- Schema: `ESCROW_LOCK`, `ESCROW_RELEASE`, `ESCROW_REFUND` TxType enum + migration 0012.
- Config: `ESCROW_MODULE_ADDRESS_<chainId>` env vars for all chains.

**4. Revenue Sharing (Phase 4)**
- `Operator` model: name, walletAddress, revShareBps (default 20%), active.
- `Agent.operatorId` — optional link to managing operator.
- `OperatorRevenue` — per-fee-event accrual with operator/protocol split.
- `OperatorSettlement` — settlement lifecycle (PENDING → PROCESSING → SETTLED/FAILED).
- `OperatorService` — CRUD, revenue accrual, settlement creation/completion.
- `FeeService.recordFeeEvent()` extended to auto-accrue operator share.
- Admin endpoints: `POST/GET /admin/operators`, `GET /admin/operators/:id`,
  `POST/DELETE /admin/agents/:id/operator`, `POST/GET /admin/settlements`,
  `PATCH /admin/settlements/:id/complete|fail`.
- Migration 0013: Operator, OperatorRevenue, OperatorSettlement tables.

---

## Current P0s

No blocking P0 remains.

1. **P1 — Demo screencast**: record the Claude Desktop flow.
2. **P1 — Deploy contracts to testnet**: run the deployment runbook on Base Sepolia
   with the new EscrowModule.
3. **P2 — License detection follow-up (low)**: GitHub's `licensee` still
   classifies `LICENSE` as `Other`.
4. **P2 — External distribution**: update mcp.so listing to `@0.5.0` (31 tools);
   update awesome-mcp-servers PR #5091 tool count 28 → 31.

---

## Validation (2026-05-15)

- `npm run build -w packages/mcp-server` — clean
- `npm run typecheck --workspaces --if-present` — all 4 workspaces pass
- `npm publish --dry-run` — 55 files, 60 kB, includes `dist/tools/gmx.js`
- `npm view @agent_fi/mcp-server dist-tags` → `{ latest: '0.5.0' }` ✓

---

_Last touch: 2026-05-15 (mcp-server 0.5.0 published — GMX tools, 31 total)._
