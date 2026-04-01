# AgentFi Architecture

## System Overview

```
┌─────────────────────────────────────────────────┐
│  LAYER 4 — MCP Server / Agent Interface Layer   │
│  10 structured tools consumed by LLM agents     │
│  stdio (local) + SSE (hosted) transports        │
├─────────────────────────────────────────────────┤
│  LAYER 3 — Backend API (Fastify)                │
│  Orchestration, simulation, tx submission       │
│  BullMQ workers, Prisma/PostgreSQL, Redis       │
├─────────────────────────────────────────────────┤
│  LAYER 2 — Smart Contracts (Solidity 0.8.24)   │
│  AgentPolicyModule — per-Safe tx validation     │
│  AgentExecutor — atomic batch execution         │
├─────────────────────────────────────────────────┤
│  LAYER 1 — Wallet Infrastructure                │
│  Turnkey MPC wallets (keys never exposed)       │
│  Safe Smart Wallets (ERC-4337 compatible)       │
└─────────────────────────────────────────────────┘
```

## Transaction Lifecycle

1. Agent calls `execute_swap` (or other tool) via MCP
2. MCP server POSTs to Backend API with agent's API key
3. Backend validates schema (Zod)
4. Policy check: off-chain validation against AgentPolicy record
5. Cooldown check via Redis
6. Calldata constructed (Uniswap SDK, Aave helpers, or raw)
7. Simulation via Tenderly — fails fast if tx would revert
8. Transaction record created in PostgreSQL (QUEUED)
9. Job enqueued in BullMQ
10. Worker: signs via Turnkey MPC, broadcasts via Alchemy
11. Monitor polls for on-chain confirmation (exponential backoff)
12. On CONFIRMED: fee event recorded, webhook sent (if configured)

## Revenue Model

Protocol fee deducted from each transaction's gross amount:
- FREE tier: 30 basis points (0.30%)
- PRO tier: 15 basis points (0.15%)
- ENTERPRISE tier: 5 basis points (0.05%)

Fee is routed to `OPERATOR_FEE_WALLET` at transaction time.
All fee events are immutably logged in `FeeEvent` table.

## Networks

| Chain | ID | Supported Protocols |
|-------|----|---------------------|
| Ethereum Mainnet | 1 | Uniswap V3, Aave V3 |
| Base | 8453 | Uniswap V3, Aave V3 |
| Arbitrum One | 42161 | Uniswap V3, Aave V3 |
| Polygon | 137 | Uniswap V3, Aave V3 |

## Deployed Infrastructure

| Service | URL | Port |
|---------|-----|------|
| API | https://agentfi-develop.up.railway.app | 3000 |

## Deployed Contracts (Base Mainnet — Chain 8453)

| Contract | Address |
|----------|---------|
| AgentPolicyModule | `0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d` |
| AgentExecutor | `0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3` |

**Stack:** Railway (Nixpacks) · GitHub Actions CI/CD · PostgreSQL (Neon) · Redis (Upstash) · Turnkey MPC · Tenderly Simulation · Stripe Billing
