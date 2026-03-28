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

## Staging endpoints

| Service | URL |
|---|---|
| API | https://api.agentfi.cc |
| Admin | https://admin.agentfi.cc |
| MCP (SSE) | https://mcp.agentfi.cc |
| Health | https://api.agentfi.cc/health |

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
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```

---

## CI / CD

Every push to `develop` triggers:
1. TypeScript typecheck across all packages
2. Vitest unit tests (backend)
3. Foundry contract tests
4. Docker build for API, MCP, and Admin
5. Push to GitHub Container Registry
6. SSH deploy to staging VPS
7. Prisma migrations
8. Smoke tests against `https://api.agentfi.cc/health`

Pipeline: [.github/workflows/](.github/workflows/)

---

## Docs

- [Architecture](docs/architecture.md)
- [Agent Quickstart](docs/agent-quickstart.md)
- [Operator Checklist](CHECKLIST.md)
- [Vision](VISION.md)
- [Roadmap](ROADMAP.md)
