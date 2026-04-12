# @agentfi/backend

Core API server for AgentFi — handles agent management, transaction execution, policy enforcement, billing, and the BullMQ worker pipeline.

## Stack

- **Runtime**: Node.js 20+ (ESM)
- **Framework**: Fastify 4
- **Database**: PostgreSQL 16 + Prisma ORM
- **Queue**: BullMQ + Redis 7
- **Wallet**: Turnkey MPC + Safe Smart Accounts
- **Chains**: Ethereum, Base, Arbitrum, Polygon (via Alchemy)

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

See [docs/api-reference.md](../../docs/api-reference.md) for the complete endpoint catalog (47 routes).

## Architecture

```
src/
  api/
    routes/       # Fastify route handlers (agents, transactions, wallet, billing, jobs, admin)
    middleware/    # Auth, rate limiting, x402
  config/         # Environment validation (Zod)
  db/
    schema.prisma # Database schema
    migrations/   # SQL migrations (0001-0004)
  queues/         # BullMQ workers (transaction pipeline)
  services/       # Business logic (fee, policy, price, wallet, transaction)
```
