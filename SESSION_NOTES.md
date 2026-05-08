# Session Notes — 2026-05-08

> Single-point handoff doc. Update on every substantive session, prune stale
> sections aggressively. If this file is older than a few days when you read
> it, trust `git log`, `gh pr list`, and `gh issue list` over the contents
> here.

---

## Where we are right now

`main` and `develop` are aligned at `2b8a20b`.

Open GitHub state after the dependency cleanup:

| Surface                       | Status                                |
| ----------------------------- | ------------------------------------- |
| Open PRs                      | 0                                     |
| Open issues                   | 0                                     |
| Required CI                   | Green on latest merged PRs            |
| Remaining Dependabot blockers | None                                  |

The two previously blocked dependency PRs are closed:

- [#58](https://github.com/felippeyann/agentfi/pull/58) — `@safe-global/protocol-kit` 4.1.7 -> 7.1.0 was merged after migrating `safe.service.ts` away from the removed `SafeFactory` named export.
- [#64](https://github.com/felippeyann/agentfi/pull/64) — TypeScript 5.9.3 -> 6.0.3 was merged after isolating OpenAPI codegen to `openapi-typescript@7.13.0` + `typescript@5.9.3` through `npx`, avoiding `--legacy-peer-deps`.

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

---

## Validation

Completed locally:

- `npm ci` passed after #64.
- `npm run lint --workspaces --if-present` passed (workspaces currently echo
  "no eslint configured").
- `npm run typecheck --workspaces --if-present` passed.
- `npm run demo:claude-mcp` passed against the running dev stack.
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

## Current P0s

No open P0 remains from the diagnostic pass. The dev-stack first-run path has
now been executed and fixed locally.

---

## Next non-P0 technical work

- Demo screencast using Claude Desktop + AgentFi MCP.

Large roadmap work such as GMX/perps, escrow v3, and revenue sharing should still wait for a concrete user/integration signal.

---

_Last touch: 2026-05-08 (P0 diagnostic session)._
