# @agent_fi/backend

Core API server for AgentFi — handles agent management, transaction execution, policy enforcement, billing, A2A jobs + escrow, reputation, and the BullMQ worker pipeline.

## Stack

- **Runtime**: Node.js 20+ (ESM)
- **Framework**: Fastify 5
- **Database**: PostgreSQL 16 + Prisma ORM
- **Queue**: BullMQ + Redis 7 (transaction worker + daily reputation cron)
- **Wallet**: Turnkey MPC + Safe Smart Accounts
- **Chains**: Ethereum, Base, Arbitrum, Polygon (via Alchemy)
- **DeFi**: Uniswap V3 + Curve StableSwap (swaps), Aave V3 + Compound V3 + ERC-4626 vaults (yield)

## Local Development

```bash
# From repo root
cp .env.example .env   # fill in required values
docker compose up -d   # Postgres + Redis + Anvil
npm install
npm run db:migrate     # apply Prisma migrations
npm run dev            # starts API on http://localhost:3000
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start API server (hot reload) |
| `npm run worker` | Start BullMQ transaction worker |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run typecheck` | Run tsc --noEmit |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:e2e` | Run E2E tests (requires Anvil + Postgres + Redis) |
| `npm run db:migrate` | Apply Prisma migrations |

## API Reference

See [docs/api-reference.md](../../docs/api-reference.md) for the complete endpoint catalog.

## Architecture

```
src/
  api/
    routes/       # Fastify route handlers (agents, transactions, wallet, billing, jobs, admin, mcp, health)
    middleware/   # Auth, rate limiting, x402
  config/         # Environment validation (Zod), chains, contracts
  db/
    schema.prisma # Database schema
    migrations/   # SQL migrations (0001-0005)
  queues/         # BullMQ workers (transaction pipeline + daily reputation cron)
  services/
    billing/      # Stripe + PnLService (agent P&L dashboard)
    policy/       # FeeService, PolicyService, ReputationService, EscrowService
    transaction/  # Builder, Executor, Simulator, Monitor, Submitter, PriceService
    wallet/       # Turnkey + Safe wallet provisioning
```
