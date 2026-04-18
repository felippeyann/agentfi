# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Self-hosted deployment posture**: AgentFi has no canonical hosted production instance — every operator runs their own. Docs rewritten to reflect this: `docs/operations/production-deploy.md` is now provider-agnostic (Railway as reference example, Fly.io/Render/Docker documented as alternatives); `release-runbook.md` updated accordingly.

### Removed
- `.github/workflows/deploy-production.yml` — custom Railway-CLI deploy workflow. Provider-native GitHub integrations (Railway/Fly/Render) auto-deploy on merge to `main` or on tag; the custom workflow added coupling without value.
- `scripts/check-production-deploy-env.mjs` and `scripts/run-deploy-preflight-scenarios.mjs` — preflight tied to the deleted workflow.
- `Deploy Preflight Check` CI job (ci.yml) — validated the removed preflight script; not a required status check.
- Preflight invocation in `scripts/release-v1.mjs`.

### Added
- **OpenAPI 3.0.3 spec** at [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — machine-readable description of all 47 endpoints, with auth schemes, request/response schemas, and reusable error responses. Enables SDK generation, Postman/Insomnia import, and `openapi-typescript` type generation. Validates clean under `@redocly/cli lint`.
- **Generated TypeScript types** at `packages/mcp-server/src/api.generated.ts`, produced from the OpenAPI spec by `openapi-typescript`. MCP tools (and any future SDK) can now import `components['schemas']['PnLBreakdown']`, `['Agent']`, etc. instead of re-declaring them.
- **New npm scripts at repo root**: `spec:lint` (Redocly lint), `spec:types` (regenerate types), `spec:check` (CI drift check — fails if the generated file is stale relative to the spec).
- **New CI job** `OpenAPI Spec` runs the lint + drift check on every PR, so the spec and generated types can't drift apart unnoticed.
- **Agent Persistent Identity via ENS (Phase 4)**: when `ENS_PARENT_DOMAIN` + `ENS_CONTROLLER_PRIVATE_KEY` are configured, every new agent gets a subdomain of the form `<slug>-<id-suffix>.<parent>` (e.g., `alice-abc123.agentfi.eth`) that resolves to its Safe address — other dApps, explorers, and peer agents can reference agents by name instead of hex address
- New `EnsService` in `packages/backend/src/services/identity/ens.service.ts` — wraps ENS Registry `setSubnodeRecord` + public resolver `setAddr` via viem
- `ensName` field on Agent model (migration `0007_agent_ens`) — unique, nullable
- `ensName` exposed in `POST /v1/agents`, `GET /v1/agents/me`, `GET /v1/agents/:id`, and `GET /v1/agents/:id/manifest` responses
- Registration is best-effort: on-chain failures are logged and leave `ensName: null`, so agent creation still succeeds
- **Agent P&L v2 — Gas cost tracking (Phase 4)**: `PnLService` now counts real gas burn as a cost category
- Migration 0006: adds `effectiveGasPriceWei` TEXT to `Transaction`
- `MonitorService` persists `receipt.effectiveGasPrice` at confirmation time (same for E2E test poller)
- New cost category `costs.gas` in the P&L breakdown — `usd = gasUsed * effectiveGasPriceWei * ETH/USD`, summed across CONFIRMED + REVERTED txs in the period (REVERTED txs still burn gas on-chain)
- Pre-migration rows with missing `gasUsed`/`effectiveGasPriceWei` are skipped and reported in `notes`
- `PnLService` constructor now accepts an optional `PrismaClient` (defaults to the shared client) so it is unit-testable without a live DB
- New unit test `pnl.service.test.ts` — 8 cases covering gas math, REVERTED handling, missing-row skipping, profitability thresholds
- **Fastify upgraded to v5** — resolves the last HIGH npm vulnerability (DoS via sendWebStream, content-type tab bypass, X-Forwarded-Proto spoofing). All plugins were already v5-compatible from prior Dependabot updates — zero code changes needed.
- `packages/mcp-server/RELEASE.md` — complete publish guide for bumping the mcp-server npm package (versioning, keywords, npm publish, git tags, MCP directory submissions)
- **Curve Finance StableSwap adapter**: `POST /v1/transactions/swap-curve` — token-to-token swaps on any Curve classic pool (3pool, tri-pool, etc.)
- `TransactionBuilder.buildCurveSwap()` method with `CURVE_STABLESWAP_ABI`
- MCP tool `swap_curve` in standalone mcp-server package and backend MCP proxy (16 total tools)
- mcp-server version bumped to `0.2.0` (adds Compound, ERC-4626, and Curve tools since `0.1.0`)
- **Agent P&L Dashboard (Phase 4)**: per-agent profit & loss computed from real DB data
- New `PnLService` in `packages/backend/src/services/billing/pnl.service.ts`
- `GET /v1/agents/me/pnl` — agent-facing P&L with earnings, costs, breakeven status
- `GET /admin/agents/:id/pnl` — admin version for any agent
- Both accept optional `?since=<ISO8601>` query param
- Earnings: A2A job rewards received as provider (COMPLETED jobs)
- Costs: protocol fees paid + A2A rewards paid as requester
- Directly serves VISION.md thesis: "the moment an agent's earnings exceed its costs..."
- **A2A Escrow v2**: reward funds are reserved at job creation time and released on terminal state
- New `EscrowService`: `reserveJobEscrow()`, `releaseJobEscrow()`, `markEscrowReleased()`
- Migration 0005: adds `reservedAmount`, `reservedToken`, `reservedChainId`, `reservedAt`, `reservationStatus` to Job
- `POST /v1/jobs` with reward now atomically commits USD volume and rejects if daily limit would be exceeded
- `PATCH /v1/jobs/:id` releases escrow on CANCELLED/FAILED (returns daily volume credit) or marks RELEASED on COMPLETED
- **ERC-4626 vault adapter**: generic tokenized vault support — any compliant vault (Yearn, Morpho, Beefy, Gearbox, etc.) works without pre-registration
- `POST /v1/transactions/deposit-erc4626` and `POST /v1/transactions/withdraw-erc4626`
- `TransactionBuilder.buildErc4626Deposit()` and `buildErc4626Withdraw()` methods
- `ERC4626_VAULT_ABI` constant (deposit, withdraw, redeem, asset)
- MCP tools `deposit_erc4626` and `withdraw_erc4626` in mcp-server + backend proxy (15 total tools)
- **Reputation Scoring v2.1 (time-decay)**: recent 30-day transactions and job outcomes now carry 2x weight vs historical events
- **Daily Reputation Cron**: BullMQ repeatable job recomputes all active agents' scores daily at 02:00 UTC (override via `REPUTATION_CRON_PATTERN`)
- `packages/backend/src/queues/reputation.queue.ts` — new queue, worker, and `scheduleReputationUpdate()`
- **Compound V3 integration**: `POST /v1/transactions/supply-compound` and `POST /v1/transactions/withdraw-compound`
- `TransactionBuilder.buildCompoundSupply()` and `buildCompoundWithdraw()` methods
- `COMPOUND_COMET_ABI` constant for Comet market contracts
- Compound V3 USDC market addresses added to `contracts.ts` (Mainnet, Base, Arbitrum, Polygon)
- **MCP tools `supply_compound` and `withdraw_compound`** exposed in both the standalone mcp-server package and the backend MCP endpoint (13 total tools)
- **Reputation Scoring v2**: computed from real behavior metrics (tx success rate 40%, job completion rate 30%, volume score 20%, consistency 10%) instead of simple counter
- `ReputationService.computeReputationScore()`, `refreshReputation()`, `updateAllReputationScores()`
- Admin endpoints: `POST /admin/reputation/recompute` (all or single agent), `GET /admin/reputation/:agentId` (shows persisted vs computed drift)
- **A2A Payment Execution**: `executeA2APayment()` function in transactions.ts
- Jobs PATCH handler now auto-triggers atomic payment when status transitions to COMPLETED (if `reward` is specified)
- Payment runs async with full policy + simulation + fee calculation, same as public transfer endpoint
- Migration 0004: ON DELETE CASCADE for Job to Agent foreign keys
- SECURITY.md vulnerability disclosure policy
- CHANGELOG.md release history
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- GitHub issue templates (bug report, feature request)
- GitHub pull request template
- Dependabot configuration for automated dependency updates
- `prisma migrate deploy` step in CI Backend Tests job
- E2E polling helpers: `waitForFeeEvent()` and `waitForDailyVolume()`
- API reference documentation (`docs/api-reference.md`)
- Package READMEs for backend, admin, and contracts
- GitHub CI and license badges in main README
- `.github/CODEOWNERS` for code review routing
- Apache 2.0 license and repository fields in all package.json files
- VISION.md referenced as required reading in README, CONTRIBUTING, docs hub, and claude-instructions
- Roadmap updated with Phase 2.5 (hardening), Phase 3 (A2A primitives), Phase 4 (self-sustaining)
- Published `@agent_fi/mcp-server@0.1.0` to npm
- Branch protection ruleset on `main` (require PR + status checks)
- npm scope changed from `@agentfi` to `@agent_fi`

### Changed
- A2A handshake endpoints now return 501 until proper Turnkey/EIP-1271 integration
- Branch consolidation: all development unified on `main` (default), `master` deleted
- CI workflow triggers updated from `master` to `main`
- Next.js upgraded from v14 to v16 (admin dashboard)
- Dockerfiles now run as non-root user (`appuser:1001`)

### Fixed
- FK constraint violation in test cleanup (Job records blocking Agent deletion)
- Test cleanup order in agent.search.test.ts and transaction.e2e.ts
- NODE_ENV validation: added 'test' to accepted enum values
- CI Backend Tests: database migrations now applied before running unit tests
- E2E flaky test: FeeEvent assertion now uses polling instead of 2s setTimeout
- E2E FeeEvent test: set `routedViaExecutor: true` (was `false`, preventing FeeEvent creation)
- npm dependency vulnerabilities (path-to-regexp, picomatch, Next.js HIGH severity)

### Security
- Admin secret comparison now uses `timingSafeEqual` (prevents timing attacks)
- Daily volume limit check is now atomic (prevents TOCTOU race condition)
- Agent search endpoint no longer exposes `safeAddress` in public responses
- Admin batch endpoint validates Ethereum address format
- Auth middleware: early return on failed operator secret prevents fall-through

### Removed
- `desktop.ini` from repository (added to .gitignore)
- Placeholder A2A signature generation (security risk)
- Placeholder A2A verification returning `valid: true` unconditionally

## [0.1.0] - 2026-03-25

### Added
- Initial release
- Agent registration with Turnkey MPC wallets
- Safe smart wallet deployment per agent
- Transaction pipeline: API, Policy, Fee, Queue, Submit, Monitor
- AgentPolicyModule and AgentExecutor smart contracts (Solidity 0.8.24)
- Protocol fee engine (FREE: 30bps, PRO: 15bps, ENTERPRISE: 5bps)
- Human-in-the-Loop (HITL) approval system for high-value transactions
- A2A (Agent-to-Agent) job queue with reputation tracking
- X402 payment protocol with nonce replay protection
- Admin dashboard (Next.js 14)
- MCP server with 10+ DeFi tools
- Multi-chain support (Ethereum, Base, Arbitrum, Polygon)
- E2E test suite with local Anvil node
- Foundry contract tests with coverage
- CI/CD pipeline (GitHub Actions + Railway)
- Documentation hub with operator guides and agent quickstart

[Unreleased]: https://github.com/felippeyann/agentfi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/felippeyann/agentfi/releases/tag/v0.1.0
