# AgentFi — Production Deployment Guide

This document covers everything needed to go live on Railway.
Work through each section in order. All steps are one-time unless noted.

---

## Status: What's already done

- [x] Backend API (Fastify + BullMQ + Prisma)
- [x] MCP Server (10 DeFi tools)
- [x] Admin Panel (Next.js dashboard)
- [x] CI pipeline (lint, unit tests, E2E tests, Foundry)
- [x] Railway auto-deploy on push to `develop`
- [x] Database migrations run automatically on deploy

---

## STEP 1 — Set Railway environment variables

Go to the Railway dashboard → your project → **Variables** tab.
Add every variable below. The values come from your third-party accounts.

### Required (deploy will fail without these)

| Variable | Value | Where to get it |
|---|---|---|
| `NODE_ENV` | `production` | — |
| `API_SECRET` | 64-char random string | `openssl rand -hex 32` |
| `ADMIN_SECRET` | 64-char random string | `openssl rand -hex 32` |
| `OPERATOR_FEE_WALLET` | Your ETH address | Any wallet you control |
| `DATABASE_URL` | Neon connection string | Railway Postgres plugin or neon.tech |
| `REDIS_URL` | Redis connection string | Railway Redis plugin or upstash.com |
| `ALCHEMY_API_KEY` | Your Alchemy key | app.alchemy.com |
| `TURNKEY_API_PUBLIC_KEY` | P-256 public key | app.turnkey.com → API Keys |
| `TURNKEY_API_PRIVATE_KEY` | P-256 private key | app.turnkey.com → API Keys |
| `TURNKEY_ORGANIZATION_ID` | UUID | app.turnkey.com → Organization |

### Recommended (add before go-live)

| Variable | Value | Notes |
|---|---|---|
| `CORS_ORIGIN` | `https://admin.agentfi.cc` | Allows admin frontend to call API |
| `ADMIN_URL` | `https://admin.agentfi.cc` | Stripe redirect URLs |
| `TRANSACTION_WORKER_ENABLED` | `true` on worker, `false` on API replicas | Prevents every API replica from polling Redis |
| `TENDERLY_ACCESS_KEY` | Your key | dashboard.tenderly.co → API Access |
| `TENDERLY_ACCOUNT` | Your slug | visible in Tenderly dashboard URL |
| `TENDERLY_PROJECT` | Your project slug | visible in Tenderly dashboard URL |

### Stripe (needed for PRO subscriptions)

| Variable | Value | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` | dashboard.stripe.com → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | See Step 3 below |
| `STRIPE_PRO_PRICE_ID` | `price_...` | dashboard.stripe.com → Products |

### Contract addresses (needed for on-chain execution)

Populate after Step 2:

| Variable | Chain |
|---|---|
| `POLICY_MODULE_ADDRESS_8453` | Base |
| `EXECUTOR_ADDRESS_8453` | Base |
| `POLICY_MODULE_ADDRESS_1` | Ethereum Mainnet |
| `EXECUTOR_ADDRESS_1` | Ethereum Mainnet |
| `POLICY_MODULE_ADDRESS_42161` | Arbitrum One |
| `EXECUTOR_ADDRESS_42161` | Arbitrum One |
| `POLICY_MODULE_ADDRESS_137` | Polygon |
| `EXECUTOR_ADDRESS_137` | Polygon |

---

## STEP 2 — Deploy smart contracts

The contracts enforce per-agent policies on-chain. They must be deployed to each chain you want to support.

### Prerequisites
- Foundry installed (`forge --version`)
- A funded deployer wallet (needs ETH/MATIC for gas on each chain)
- RPC URLs configured (Alchemy works)

### Set temporary deployment env vars
```bash
export PRIVATE_KEY=0xYourDeployerPrivateKey
export OPERATOR_ADDRESS=0xYourFeeWalletAddress
export FEE_WALLET=0xYourFeeWalletAddress
export FEE_BPS=30
```

### Deploy to Base (recommended first)
```bash
cd packages/contracts

forge script script/Deploy.s.sol \
  --rpc-url https://base-mainnet.g.alchemy.com/v2/YOUR_KEY \
  --broadcast \
  --verify \
  --verifier-url https://api.basescan.org/api \
  --etherscan-api-key YOUR_BASESCAN_KEY
```

The script prints the deployed addresses. Copy them into Railway:
```
POLICY_MODULE_ADDRESS_8453=0x...
EXECUTOR_ADDRESS_8453=0x...
```

Repeat for each chain (change `--rpc-url` and the env var suffix):
- Ethereum: `--rpc-url https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_1`
- Arbitrum: `--rpc-url https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_42161`
- Polygon: `--rpc-url https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_137`

> The contracts are permissioned to `OPERATOR_ADDRESS` — keep that key secure.

---

## STEP 3 — Configure Stripe webhook

1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **Add endpoint**
3. Endpoint URL: `https://api.agentfi.cc/v1/billing/webhook`
4. Select events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. Copy the **Signing secret** (`whsec_...`) → add as `STRIPE_WEBHOOK_SECRET` in Railway

---

## STEP 4 — Verify the deployment

After pushing to `develop` (Railway auto-deploys):

```bash
# Liveness
curl https://api.agentfi.cc/health

# Readiness (all dependencies healthy)
curl https://api.agentfi.cc/health/ready

# Expected: {"status":"ready","checks":{"database":true,"redis":true,"rpc":true,"turnkey":true}}
```

If `health/ready` shows any `false`, check Railway logs for the failing service.

---

## STEP 4.1 — Recommended queue topology for metered Redis

If you use Upstash or any metered Redis plan, run a dedicated worker service:

1. API service: set `TRANSACTION_WORKER_ENABLED=false`
2. Worker service (same repo/environment): start command `cd packages/backend && npm run worker`
3. Worker service: set `TRANSACTION_WORKER_ENABLED=true`

This avoids N API replicas polling BullMQ marker keys and helps prevent Redis request quota exhaustion.

---

## STEP 4.2 — Follow release and rollback runbook

Use the operational runbook for every production deployment and incident rollback:

- `docs/production-release-runbook.md`

---

## STEP 5 — Register your first agent

```bash
curl -X POST https://api.agentfi.cc/v1/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_SECRET" \
  -d '{
    "name": "My First Agent",
    "chainIds": [8453],
    "tier": "FREE"
  }'
```

Save the `apiKey` from the response — it is shown **once only**.

---

## STEP 6 — Connect the MCP server

The MCP server is auto-deployed by Railway alongside the backend.

Add to your Claude/LLM config:
```json
{
  "mcpServers": {
    "agentfi": {
      "url": "https://mcp.agentfi.cc/mcp/sse",
      "headers": {
        "x-api-key": "agfi_live_YOUR_AGENT_KEY"
      }
    }
  }
}
```

---

## STEP 7 — Optional: Safe smart wallets

To give each agent a Safe smart wallet (enables on-chain policy enforcement):

1. Create a funded EOA on each chain you want to support
2. Add its private key to Railway: `SAFE_DEPLOYER_PRIVATE_KEY=0x...`
3. New agents registered after this will automatically get a Safe

---

## Production URLs

| Service | URL |
|---|---|
| API | https://api.agentfi.cc |
| Admin Panel | https://admin.agentfi.cc |
| MCP Server | https://mcp.agentfi.cc |
| Health | https://api.agentfi.cc/health/ready |
| Agent card | https://api.agentfi.cc/.well-known/agent.json |

---

## Go-live checklist

```
[ ] Railway env vars set (Step 1)
[ ] Contracts deployed to Base at minimum (Step 2)
[ ] POLICY_MODULE_ADDRESS_8453 + EXECUTOR_ADDRESS_8453 in Railway
[ ] Stripe webhook configured (Step 3)
[ ] curl /health/ready returns {"status":"ready",...}
[ ] First agent registered successfully
[ ] MCP server reachable from agent
[ ] Admin panel loads at https://admin.agentfi.cc
```
