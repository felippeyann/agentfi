# AgentFi

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/your-org/agentfi/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/agentfi/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Financial infrastructure for AI agents.**

AgentFi gives LLM agents a persistent, policy-constrained wallet to execute DeFi transactions on EVM networks — without a human in the loop.

An agent connects via MCP, gets a dedicated Safe smart wallet, and can swap, transfer, deposit, and withdraw across Ethereum, Base, Arbitrum, and Polygon. Every transaction is simulated before broadcast and validated on-chain by a policy module the operator configures.

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

---

## Use it

**Hosted (no infrastructure):**  
Point your agent at the public MCP endpoint — [Agent Quickstart](docs/agent-quickstart.md).

**Self-hosted (full control):**  
Clone, configure, deploy. You own the wallets, keys, and fee revenue.  
Follow [CHECKLIST.md](CHECKLIST.md) for the step-by-step setup.

---

## What agents can do

| Tool | Description |
|------|-------------|
| `get_wallet_info` | Balances across all supported chains |
| `get_token_price` | Live USD price for any token |
| `simulate_swap` | Dry-run a swap before committing |
| `execute_swap` | Swap tokens via Uniswap V3 |
| `transfer_token` | Send ETH or ERC-20 tokens |
| `deposit_aave` | Supply assets to Aave V3 for yield |
| `withdraw_aave` | Withdraw from Aave V3 |
| `get_defi_rates` | Current APY for lending markets |
| `get_transaction_status` | Poll status of any submitted transaction |
| `get_policy` | Inspect the agent's operational limits |

---

## Packages

| Package | Description |
|---------|-------------|
| `packages/backend` | Fastify REST API — transaction pipeline, wallet management, policy, billing |
| `packages/mcp-server` | MCP server exposing the 10 DeFi tools |
| `packages/admin` | Next.js operator dashboard |
| `packages/contracts` | Solidity — AgentPolicyModule + AgentExecutor |
| `packages/adapters` | Tool definitions for OpenAI, Anthropic, LangChain, ElizaOS |

---

## Deployed Contracts (Base Mainnet — Chain 8453)

| Contract | Address |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) |

Multi-chain deployment scripts are included for Ethereum mainnet, Arbitrum One, and Polygon.

---

## Running locally

**Requirements:** Node.js 22+, Docker, [Foundry](https://book.getfoundry.sh/getting-started/installation)

```bash
git clone https://github.com/your-org/agentfi
cd agentfi
npm install

# Start Postgres and Redis
docker compose up postgres redis -d

# Run migrations
cd packages/backend && npm run db:migrate && cd ../..

# Start everything
cd packages/backend && npm run dev     # API    → http://localhost:3000
cd packages/mcp-server && npm run dev  # MCP    → http://localhost:3002
cd packages/admin && npm run dev       # Admin  → http://localhost:3001
```

Copy `.env.example` → `.env` and fill in your API keys. The test suite runs fully mocked — no external credentials needed for `npm test`.

---

## Smart contracts

```bash
cd packages/contracts
forge test -vvv
forge coverage --report summary

# Deploy (Base already deployed above)
forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify
```

---

## Self-hosting fee model

When you self-host, protocol fees on swaps route to your `OPERATOR_FEE_WALLET`. You keep the revenue.

| Tier | Monthly | Protocol Fee | Tx Limit |
|------|---------|-------------|----------|
| FREE | $0 | 0.30% | 100 tx/mo |
| PRO | $99 (Stripe) | 0.15% | 10,000 tx/mo |
| ENTERPRISE | Custom | 0.05% | Unlimited |

Fee collection is atomic and on-chain via `AgentExecutor` — no accounts receivable.

---

## CI

Every PR runs: typecheck → unit tests → admin tests → Foundry contract tests → E2E transaction pipeline.

Pipeline: [.github/workflows/](.github/workflows/)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first areas: new DeFi protocol support, new chain config, adapter packages for LLM frameworks.

---

## Docs

- [Architecture](docs/architecture.md)
- [Agent Quickstart](docs/agent-quickstart.md)
- [Operator Setup](CHECKLIST.md)
- [Vision](VISION.md)
- [Roadmap](ROADMAP.md)

---

## License

[Apache 2.0](LICENSE) — use it, fork it, build on it.

