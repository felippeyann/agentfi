# AgentFi

Financial infrastructure for AI agents. AgentFi gives LLM agents a persistent, policy-constrained wallet they can use to execute DeFi transactions on EVM networks — without a human in the loop.

Built on Turnkey MPC wallets, Safe smart accounts, and the Model Context Protocol (MCP).

---

## What it does

An agent connects to AgentFi via MCP, gets a dedicated Safe wallet, and can:

- Hold assets across Ethereum, Base, Arbitrum, and Polygon
- Execute swaps via Uniswap V3
- Deposit and withdraw on Aave V3
- Transfer tokens
- Query balances and DeFi rates

Every transaction is simulated (Tenderly) before submission and validated against a policy module on-chain before signing.

---

## Architecture

```
Agent (LLM)
    │  MCP (stdio or SSE)
    ▼
MCP Server  ──────────────────────────────────▶  Backend API (Fastify)
(packages/mcp-server)                            (packages/backend)
                                                      │
                                          ┌───────────┼───────────────┐
                                          ▼           ▼               ▼
                                      Postgres     Redis          Turnkey MPC
                                      (Prisma)   (BullMQ)       (key signing)
                                                      │
                                                      ▼
                                              Smart Contracts
                                          AgentPolicyModule + AgentExecutor
                                              (packages/contracts)
```

Full details: [docs/architecture.md](docs/architecture.md)

---

## Packages

| Package | Description |
|---|---|
| `packages/backend` | Fastify REST API — orchestration, wallet management, transaction pipeline |
| `packages/mcp-server` | MCP server exposing 10 DeFi tools to LLM agents |
| `packages/admin` | Next.js operator dashboard |
| `packages/contracts` | Solidity — AgentPolicyModule + AgentExecutor |
| `packages/adapters` | OpenAI/Anthropic tool definitions for the MCP tools |

---

## Live Endpoints

| Service | URL |
|---|---|
| API | https://agentfi-develop.up.railway.app |
| Health | https://agentfi-develop.up.railway.app/health |

## Deployed Contracts (Base Mainnet — Chain 8453)

| Contract | Address |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) |

Multi-chain deployment to Ethereum (1), Arbitrum (42161), and Polygon (137) is ready — run the Foundry deploy script per chain.

## Billing Tiers

| Tier | Price | Protocol Fee | Tx Limit |
|------|-------|-------------|----------|
| FREE | $0/mo | 0.30% (30 bps) | 100 tx/mo |
| PRO | $99/mo (Stripe) | 0.15% (15 bps) | 10,000 tx/mo |
| ENTERPRISE | Custom | 0.05% (5 bps) | Unlimited |

---

## Running locally

**Requirements:** Node.js 20+, Docker, Foundry

```bash
# Install dependencies
npm install

# Start Postgres and Redis
docker compose up postgres redis -d

# Run migrations
cd packages/backend
npm run db:migrate

# Start the API
npm run dev

# In another terminal — start the MCP server
cd packages/mcp-server
npm run dev

# In another terminal — start the admin
cd packages/admin
npm run dev
```

API → http://localhost:3000
Admin → http://localhost:3001
MCP → http://localhost:3002

See [CHECKLIST.md](CHECKLIST.md) for the full setup (API keys, env vars, contracts).

---

## Smart contracts

```bash
cd packages/contracts
forge test -vvv
```

Deploy to a network:
```bash
# Base (already deployed)
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify

# Other networks
forge script script/Deploy.s.sol --rpc-url mainnet --broadcast --verify
forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify
forge script script/Deploy.s.sol --rpc-url polygon --broadcast --verify
```

---

## CI / CD

Every push to `develop` triggers:
1. TypeScript typecheck across all packages
2. Vitest unit tests (backend)
3. Foundry contract tests
4. E2E transaction pipeline tests
5. Railway auto-deploy (staging)

Pipeline: [.github/workflows/](.github/workflows/)

---

## Docs

- [Architecture](docs/architecture.md)
- [Agent Quickstart](docs/agent-quickstart.md)
- [Operator Checklist](CHECKLIST.md)
- [Vision](VISION.md)
- [Roadmap](ROADMAP.md)
