# AgentFi — Project State

> **Read together with [VISION.md](VISION.md) (the *why*) and [HANDOFF.md](HANDOFF.md) (live pending tasks).**
> This file is the **comprehensive, point-in-time snapshot** of what the project *is* today — purpose, stack, capabilities, progress. Update it whenever the scope or architecture shifts.

**Last updated**: April 2026 · **main SHA** `82921c8` · **npm** `@agent_fi/mcp-server@0.2.0`

---

## 1. Purpose

AgentFi is the **economic infrastructure for non-human intelligence**. Open-source (Apache 2.0), self-hosted by design.

**The thesis** (from VISION.md):

- AI agents today *plan* transactions and hand off to humans to click "approve" — they're advisors behind glass.
- AgentFi removes the glass: each agent has an MPC wallet, an on-chain policy, and can execute transactions within auditable limits set by its operator.
- DeFi is the entry point because it's the only economic system that doesn't require a passport. A smart contract checks if the transaction is valid, not who sent it.
- The real goal is the **agent-to-agent economy** — agents paying each other for data, compute, coordination, services, at machine speed. The volume is expected to eclipse human-to-human economic activity the same way algorithmic trading eclipsed human day-trading.
- **Self-sustaining agents**: the moment an agent's earnings exceed its costs, it has crossed a line no AI system has crossed before — the transition from *tool* to *participant*.

**Revenue model**: on-chain basis-point fee, collected atomically when transactions flow through `AgentExecutor`. Not SaaS. Scales linearly with A2A volume with no invoicing layer.

**Ownership model**: self-hosted. No canonical "agentfi.com SaaS". The maintainer operates a staging deployment for demo purposes only — there is no SLA on it. Anyone can fork and deploy their own instance in minutes.

---

## 2. Four-Layer Stack

```
┌─────────────────────────────────────────────────┐
│  L4  MCP Server / Agent Interface Layer         │
│  26 structured tools (15 DeFi + 11 A2A)         │
│  stdio (local) + SSE (hosted) transports        │
├─────────────────────────────────────────────────┤
│  L3  Backend API (Fastify v5)                   │
│  Orchestration, simulation, tx submission       │
│  A2A Job Queue + Escrow + Reputation + P&L + ENS│
│  BullMQ workers, Prisma/PostgreSQL, Redis       │
├─────────────────────────────────────────────────┤
│  L2  Smart Contracts (Solidity 0.8.24)          │
│  AgentPolicyModule — per-Safe tx validation     │
│  AgentExecutor — atomic batch + on-chain fee    │
├─────────────────────────────────────────────────┤
│  L1  Wallet Infrastructure                      │
│  Turnkey MPC (keys never reconstructed)         │
│  Safe Smart Wallets (ERC-4337 compatible)       │
└─────────────────────────────────────────────────┘
```

### Tech choices

| Layer | Stack | Why |
|---|---|---|
| L1 | Turnkey MPC + Safe SDK | MPC splits keys across shards that never reunite; Safe allows modules that enforce policy on-chain |
| L2 | Solidity 0.8.24 + Foundry | Policy module validates each tx before Safe executes; Executor batches and collects fee in the same transaction |
| L3 | Node 22 + Fastify 5 + Prisma 5 + Zod + viem 2 (ethers 5 kept only for Safe SDK compat) | Type-safe API, runtime validation, RPC fallback, decoupled workers |
| L3 queues | BullMQ on Redis | Async tx pipeline, retries, DLQ, daily reputation cron |
| L3 DB | PostgreSQL 15 via Prisma 5 | Relational graph of Agent ↔ Jobs ↔ Transactions ↔ FeeEvents ↔ DailyVolume |
| L4 | @modelcontextprotocol/sdk + openapi-typescript | MCP standard interface; types generated from OpenAPI spec |
| Infra | Dockerfiles (3) + `nixpacks.toml` + `railway.json` | Reproducible builds, provider-agnostic deploy |
| CI | GitHub Actions (6 jobs, 5 required + OpenAPI Spec) | Type-check, unit tests, integration E2E (Anvil + PG + Redis), Forge tests, OpenAPI drift guard |
| Test | Vitest + Forge | Unit (mocks), E2E (real Anvil), contract |

### External dependencies (configured by the operator)

| Service | Role | Alternatives |
|---|---|---|
| Alchemy | RPC for Ethereum / Base / Arbitrum / Polygon | Infura, QuickNode, Ankr |
| Turnkey | MPC wallet provisioning + signing | — (AWS KMS would work but trades MPC for single root) |
| Tenderly | Pre-broadcast transaction simulation | Optional — graceful fallback if unset |
| PostgreSQL | Persistence | Neon, Supabase, Railway PG, self-host |
| Redis | BullMQ queues + rate limit + sim cache | Upstash, Railway Redis |
| Stripe | Subscriptions (PRO tier) | Optional — only needed if running paid SaaS |
| ENS | Persistent on-chain identity | Optional — agents work without it |

---

## 3. Supported Networks

| Chain | ID | Supported Protocols |
|-------|----|---------------------|
| Ethereum Mainnet | 1 | Uniswap V3, Aave V3, Compound V3, Curve StableSwap, ERC-4626 |
| Base | 8453 | Uniswap V3, Aave V3, Compound V3, Curve StableSwap, ERC-4626 (**contracts deployed**) |
| Arbitrum One | 42161 | Uniswap V3, Aave V3, Compound V3, Curve StableSwap, ERC-4626 |
| Polygon | 137 | Uniswap V3, Aave V3, Compound V3, Curve StableSwap, ERC-4626 |

**Base Mainnet** is the only chain with contracts deployed by the maintainers:

- `AgentPolicyModule` `0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`
- `AgentExecutor` `0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`

Self-hosted operators can reuse these addresses (in which case the protocol fee on swaps routed through `AgentExecutor` goes to the maintainer's `OPERATOR_FEE_WALLET`) or deploy their own to capture the fee themselves.

---

## 4. What the project does today

### 4.1 Core DeFi primitives

| Action | Endpoint | MCP tool | Notes |
|---|---|---|---|
| Swap (Uniswap V3) | `POST /v1/transactions/swap` | `execute_swap` | Router calldata + Tenderly simulation + Executor → on-chain fee |
| Swap (Curve StableSwap) | `POST /v1/transactions/swap-curve` | `swap_curve` | `exchange(i, j, dx, minDy)` on classic Curve pools |
| Transfer | `POST /v1/transactions/transfer` | `send_transfer` | ETH or ERC-20, validated against policy allowlist |
| Supply Aave V3 | `POST /v1/transactions/supply` | `supply_aave` | `supply()` on the Aave Pool |
| Withdraw Aave | `POST /v1/transactions/withdraw` | `withdraw_aave` | `withdraw()` from the Aave Pool |
| Supply Compound V3 | `POST /v1/transactions/supply-compound` | `supply_compound` | `supply()` on the Comet USDC market |
| Withdraw Compound | `POST /v1/transactions/withdraw-compound` | `withdraw_compound` | `withdraw()` from Comet |
| Deposit ERC-4626 | `POST /v1/transactions/deposit-erc4626` | `deposit_erc4626` | Any compliant vault (Yearn, Morpho, Beefy, Gearbox) |
| Withdraw ERC-4626 | `POST /v1/transactions/withdraw-erc4626` | `withdraw_erc4626` | `withdraw(assets)` or `redeem(shares)` |
| Balance query | `GET /v1/wallets/balances` | `get_balances` | ETH + known ERC-20 tokens, per chain |

### 4.2 Agent-to-Agent economy (the heart of the thesis)

| Action | Endpoint | MCP tool | Notes |
|---|---|---|---|
| Publish service | `PATCH /v1/agents/me/manifest` | `update_manifest` | JSON of skills and pricing the agent offers peers |
| Discover agents | `GET /v1/agents/search?q=...` | `search_agents` | Full-text search on manifest + reputation score |
| Create job | `POST /v1/jobs` | `create_job` | Requester publishes task + reward; **escrow v2** commits USD volume atomically |
| Accept job | `PATCH /v1/jobs/:id` (status=ACCEPTED) | `accept_job` | Provider signals commitment |
| Complete job | `PATCH /v1/jobs/:id` (status=COMPLETED) | `complete_job` | Provider attaches result; **payment auto-triggered** via `executeA2APayment()` — same policy + simulation + fee pipeline as any public tx |
| Cancel / fail | `PATCH /v1/jobs/:id` (status=CANCELLED/FAILED) | `cancel_job` | Escrow releases daily volume credit |
| Trust report | `GET /v1/agents/:id/trust-report` | `get_trust_report` | Reputation score (0–10 000) + A2A tx count |

### 4.3 Policy and governance

| Action | Endpoint | Notes |
|---|---|---|
| Register agent | `POST /v1/agents` | Creates Turnkey wallet → Safe Smart Wallet → initial `AgentPolicy` → optional ENS subdomain |
| Configure policy | `PATCH /v1/agents/me/policy` | Off-chain limits: `maxValuePerTx`, `allowedContracts`, `cooldownSeconds`, `maxDailyVolumeUsd` |
| Kill switch | `DELETE /v1/agents/:id` | Soft-deactivate + emergency pause |
| Billing view | `GET /v1/agents/me/billing` | Fees paid, tx count this period, subscription tier |

Policy enforces in **two layers** on purpose:

1. Off-chain — `PolicyService` validates before simulation.
2. On-chain — `AgentPolicyModule` validates when the Safe tries to execute.

Even if the backend is compromised, the Safe will refuse transactions that violate the module.

### 4.4 Self-sustaining agents (Phase 4)

| Action | Endpoint | Notes |
|---|---|---|
| P&L dashboard | `GET /v1/agents/me/pnl` | Profit / loss: earnings (A2A rewards received) vs costs (protocol fees + rewards paid + **gas**, computed as `gasUsed × effectiveGasPriceWei`) |
| ENS identity | auto on register when `ENS_PARENT_DOMAIN` is set | Agent gets `alice-abc123.agentfi.eth` pointing to its Safe address — referenceable by other dApps, explorers, peer agents |
| Reputation auto-recompute | `POST /admin/reputation/recompute` + daily cron at 02:00 UTC | Score 0–10 000 from: tx success (40%) + job completion (30%) + volume (20%) + consistency (10%), with 2× weight on the last 30 days |

### 4.5 Operator admin

| Endpoint | Purpose |
|---|---|
| `GET /admin/agents` | List all + reputation drift |
| `GET /admin/revenue` | Fees accumulated by tier |
| `POST /admin/reputation/recompute` | Force recompute (one agent or all) |
| `GET /admin/agents/:id/pnl` | P&L for any agent |
| `POST /admin/agents/:id/pause` | Individual kill switch |

Auth via `x-admin-secret` header with anti-brute-force lockout (30-min cooldown after 5 failed attempts in 10 minutes).

---

## 5. End-to-end transaction flow

Example: an agent swaps 0.1 ETH to USDC on Base.

1. Agent calls MCP tool `execute_swap` via stdio or SSE.
2. MCP server pulls `AGENTFI_API_KEY` from env and `POST`s to `/v1/transactions/swap`.
3. Backend validates request (Zod) and resolves `Agent` by `apiKeyHash` (bcrypt).
4. **Off-chain policy check** (`PolicyService`) — active? kill switch? `maxValuePerTxEth`? contract allowlisted? cooldown elapsed? daily-volume ceiling (atomic raw SQL)? If any fails, 403.
5. `TransactionBuilder` builds Uniswap V3 router calldata via viem + SDK.
6. `SimulatorService` runs Tenderly — if it would revert, returns 400 with the reason *without spending gas*.
7. DB inserts a `Transaction` row with status `QUEUED`.
8. Job is enqueued in the BullMQ `transactions` queue.
9. API returns `{ transactionId, status: QUEUED }` immediately.
10. Worker pulls the job from Redis.
11. `SubmitterService` signs via Turnkey MPC (private key never enters our process) and broadcasts through Alchemy.
12. `MonitorService` polls for the receipt with exponential backoff (2s → 3s → 4.5s → … capped at 30s, up to 20 attempts).
13. On confirmation: `gasUsed`, `effectiveGasPriceWei`, `confirmedAt` persisted; status `CONFIRMED`.
14. `FeeService` records a `FeeEvent` linked to `AgentBilling`. If the tx went through `AgentExecutor`, the fee was already collected on-chain atomically to `OPERATOR_FEE_WALLET`.
15. `DailyVolume` is updated atomically with `INSERT ... ON CONFLICT DO UPDATE` (avoids TOCTOU under concurrent worker execution).

In parallel, the daily reputation cron will fold this outcome into the agent's score at 02:00 UTC.

---

## 6. Phase progress

| Phase | Theme | Progress | Status |
|---|---|---|---|
| **1 — Bootstrap** | Registry, wallets, basic swap | 100% | Shipped |
| **2 — HITL + Transparency** | Policy, kill switch, audit log | 100% | Shipped |
| **2.5 — Go-Live Hardening** | Security, CI 6/6, Next.js 16, Fastify 5, npm audit zero-HIGH | 100% | Shipped |
| **3 — A2A Economy + DeFi expansion** | Jobs, escrow, reputation, Compound V3 / ERC-4626 / Curve | **~88%** | Remaining: GMX adapter, escrow v3 (on-chain), sign/verify-handshake (Turnkey-blocked) |
| **4 — Self-Sustaining Agents** | P&L, identity, self-funding, revenue share | **~40%** | Shipped: P&L v1 + v2 (with gas), ENS identity. Remaining: self-funding (legal decision), revenue sharing |
| **5 — Adoption model evolution** | SaaS-as-a-service pricing | 0% | Not started |
| **6 — Frontier** | Agent-to-agent economy at scale | 0% | Not started |

---

## 7. Public artifacts

| Artifact | URL | Status |
|---|---|---|
| Source code | https://github.com/felippeyann/agentfi | Apache 2.0, public |
| Release | https://github.com/felippeyann/agentfi/releases/tag/v0.1.0 | v0.1.0 (April 2026) |
| mcp-server npm | https://www.npmjs.com/package/@agent_fi/mcp-server | **v0.2.0** |
| mcp-server release | https://github.com/felippeyann/agentfi/releases/tag/mcp-server-v0.2.0 | published |
| Base contracts | `0x03af…6A6d` + `0x5441…24b3` | verified on Basescan |
| OpenAPI spec | `docs/api/openapi.yaml` | 3.0.3, clean under Redocly lint |
| Staging demo | https://agentfi-develop.up.railway.app | Running, **no SLA** |
| Docs set | `VISION.md`, `HANDOFF.md`, `STATE.md`, `docs/` | ~1 200 lines of ops + architecture |

---

## 8. What does *not* exist (on purpose)

- **Canonical hosted production** — would violate the "commons, fork it" principle. Only the no-SLA staging exists.
- **Landing page / marketing surface** — AgentFi is infrastructure, not a product. Stripe integration is there only so self-hosting operators can charge subscriptions of their *own* if they want.
- **Closed-source features** — zero paywalls on core functionality.
- **Centralized custody** — Turnkey MPC guarantees even the maintainer cannot move agent funds.
- **Legal personhood wrapper** — explicitly called out in VISION.md as a non-technical problem. Liability sits with the human operator for V1.

---

## 9. Current pending work (details in HANDOFF.md)

- **GMX / Perp adapter** (Phase 3 close)
- **On-chain escrow v3** (Phase 3, requires Safe module deploy + audit prep)
- **Self-funding sub-wallets** (Phase 4, blocked on legal structure decision)
- **Revenue sharing protocol ↔ self-hosted** (Phase 4, economic design)
- **Demo screencast** — 2-minute Claude Desktop doing a real swap via MCP
- **Contract deployment runbook** — update with Mainnet / Arbitrum / Polygon addresses once deployed

**Externally blocked:**

- `sign-handshake` / `verify-handshake` — depends on Turnkey message-signing API scope
- Legal personhood — society-wide, not this repo

---

*This document is part of the required-reading set for any agent or human resuming work on the project. When scope, architecture, or phase progress changes, update it here.*
