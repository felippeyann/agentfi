# AgentFi — Self-Hosted Production Deployment Guide

AgentFi is open-source (Apache 2.0) and self-hosted by design. This guide walks any operator — human or agent — from a fresh repo clone to a running production instance.

**There is no canonical hosted production instance.** The VISION.md principle is that operators run their own infrastructure; the protocol layer (contracts + fee collection) is on-chain and shared.

**Reference provider**: Railway is used as the default example because it has the shortest path from clone → live for this stack (Node + Postgres + Redis, Nixpacks build, auto-deploy from git). Any equivalent PaaS works — Fly.io, Render, Heroku, a Docker host. Provider-specific differences are noted inline.

> **Prerequisites**: complete [`docs/operations/setup-checklist.md`](setup-checklist.md) first — it walks through every third-party account (Alchemy, Turnkey, Tenderly, etc.) needed to produce the values you'll paste below.

---

## STEP 1 — Environment variables

Every variable below must be configured on the **backend service** of your host.

### Required (service will not start without these)

| Variable | Value | Where to get it |
|---|---|---|
| `NODE_ENV` | `production` | — |
| `API_SECRET` | 64-char random string | `openssl rand -hex 32` |
| `ADMIN_SECRET` | 64-char random string | `openssl rand -hex 32` |
| `ADMIN_USERNAME` | Admin login username | Operator-defined |
| `ADMIN_PASSWORD` | Strong admin login password | Operator-defined |
| `NEXTAUTH_SECRET` | Session signing secret | `openssl rand -base64 32` |
| `ADMIN_AUTH_MAX_ATTEMPTS` | `5` | Login attempts before lockout |
| `ADMIN_AUTH_WINDOW_MS` | `600000` | Attempt window in milliseconds |
| `ADMIN_AUTH_LOCKOUT_MS` | `1800000` | Lockout duration in milliseconds |
| `OPERATOR_FEE_WALLET` | Your ETH address | Any wallet you control — this is where on-chain protocol fees are sent |
| `DATABASE_URL` | Postgres connection string | Railway PG plugin, Neon, Supabase |
| `REDIS_URL` | Redis connection string | Railway Redis plugin, Upstash |
| `ALCHEMY_API_KEY` | Your Alchemy key | `app.alchemy.com` |
| `TURNKEY_API_PUBLIC_KEY` | P-256 public key | `app.turnkey.com` → API Keys |
| `TURNKEY_API_PRIVATE_KEY` | P-256 private key | `app.turnkey.com` → API Keys |
| `TURNKEY_ORGANIZATION_ID` | UUID | `app.turnkey.com` → Organization |

### Recommended (add before public go-live)

| Variable | Value | Notes |
|---|---|---|
| `CORS_ORIGIN` | `https://admin.yourdomain.com` | Allows admin frontend to call API |
| `ADMIN_URL` | `https://admin.yourdomain.com` | Stripe redirect URLs |
| `TRANSACTION_WORKER_ENABLED` | `true` on worker, `false` on API replicas | Prevents every API replica from polling Redis |
| `TENDERLY_ACCESS_KEY` | Your key | `dashboard.tenderly.co` → API Access |
| `TENDERLY_ACCOUNT` | Your slug | visible in Tenderly dashboard URL |
| `TENDERLY_PROJECT` | Your project slug | visible in Tenderly dashboard URL |

### Stripe (needed only if running paid subscriptions)

| Variable | Value | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` | `dashboard.stripe.com` → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | See Step 3 below |
| `STRIPE_PRO_PRICE_ID` | `price_...` | `dashboard.stripe.com` → Products |

### Contract addresses (per chain you support)

Populate after Step 2. The project maintainers have already deployed these on Base Mainnet — you can reuse them or redeploy your own.

| Variable | Chain | Maintainer-deployed (Base) |
|---|---|---|
| `POLICY_MODULE_ADDRESS_8453` | Base | `0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d` |
| `EXECUTOR_ADDRESS_8453` | Base | `0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3` |
| `POLICY_MODULE_ADDRESS_1` | Ethereum | — |
| `EXECUTOR_ADDRESS_1` | Ethereum | — |
| `POLICY_MODULE_ADDRESS_42161` | Arbitrum | — |
| `EXECUTOR_ADDRESS_42161` | Arbitrum | — |
| `POLICY_MODULE_ADDRESS_137` | Polygon | — |
| `EXECUTOR_ADDRESS_137` | Polygon | — |

> Reusing the maintainer-deployed contracts means the protocol fee on swaps routed through `AgentExecutor` goes to the AgentFi project's `OPERATOR_FEE_WALLET`, **not yours**. Deploy your own if you want to capture that fee.

---

## STEP 2 — Deploy smart contracts (only if self-deploying)

Skip if reusing the maintainer-deployed addresses above.

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

The script prints the deployed addresses. Paste them into your host's env vars:
```
POLICY_MODULE_ADDRESS_8453=0x...
EXECUTOR_ADDRESS_8453=0x...
```

Repeat for each chain (change `--rpc-url` and the env var suffix):
- Ethereum: `--rpc-url https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_1`
- Arbitrum: `--rpc-url https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_42161`
- Polygon: `--rpc-url https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY` → `_137`

> Contracts are permissioned to `OPERATOR_ADDRESS` — keep that key secure.

See [`docs/operations/contract-deployment.md`](contract-deployment.md) for the full contract deployment runbook.

---

## STEP 3 — Provision and deploy the services

### Option A — Railway (reference, ~10 minutes from zero)

1. Create a Railway project: https://railway.app/new
2. **Add Postgres**: click *+ New* → *Database* → *Add PostgreSQL*. It auto-populates `DATABASE_URL` as a reference variable.
3. **Add Redis**: click *+ New* → *Database* → *Add Redis*. Auto-populates `REDIS_URL`.
4. **Add the backend service**: click *+ New* → *GitHub Repo* → select `<your-fork>/agentfi`. Leave Root Directory empty (the repo's `railway.json` + `nixpacks.toml` handle the build).
5. Once the service appears, open its *Variables* tab and paste every required variable from Step 1. Reference-link `DATABASE_URL` and `REDIS_URL` to the Postgres/Redis services.
6. Click *Deploy* — Railway runs `npx prisma migrate deploy` then starts the API.
7. Railway auto-redeploys on every push to `main` once the GitHub integration is connected. No custom CI workflow needed.

### Option B — Fly.io

1. `fly launch --no-deploy` in the repo root (reads `package.json`, generates `fly.toml`).
2. `fly pg create` for Postgres; `fly redis create` or Upstash for Redis. Attach both to the app.
3. `fly secrets set` every variable from Step 1 (batch via `fly secrets import < .env`).
4. `fly deploy`.
5. For auto-deploy on push, add a minimal GitHub Action that runs `flyctl deploy --remote-only` on `main` (one-file workflow — not provided in repo to keep it provider-neutral).

### Option C — Render

1. New Web Service → connect repo → root directory empty → build command `npm install && cd packages/backend && npx prisma generate --schema=src/db/schema.prisma` → start command from `nixpacks.toml` (`node --import tsx/esm packages/backend/src/index.ts`).
2. Add a Render Postgres; copy the internal connection URL to `DATABASE_URL`.
3. Add Redis (Render has no native Redis — use Upstash).
4. Paste all env vars. Auto-deploy on push is default.

### Option D — Docker host (self-managed)

The repo ships `Dockerfile.backend`, `Dockerfile.admin`, `Dockerfile.mcp`, and a `docker-compose.yml` for local. For production, extend the compose file with real Postgres/Redis, put behind a reverse proxy, and run migrations on first start.

---

## STEP 4 — Configure Stripe webhook (only if running subscriptions)

1. Stripe Dashboard → Webhooks → *Add endpoint*.
2. Endpoint URL: `https://api.yourdomain.com/v1/billing/webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copy the **Signing secret** (`whsec_...`) → add as `STRIPE_WEBHOOK_SECRET` on your host.

---

## STEP 5 — Verify the deployment

Replace `api.yourdomain.com` with your deployed API hostname.

```bash
# Liveness
curl https://api.yourdomain.com/health

# Readiness (all dependencies healthy)
curl https://api.yourdomain.com/health/ready
# Expected: {"status":"ready","checks":{"database":true,"redis":true,"rpc":true,"turnkey":true}}
```

If `health/ready` returns any `false`, check the service logs for the failing dependency.

### Recommended queue topology for metered Redis

If you use Upstash or any metered Redis plan, run a dedicated worker service:

1. API service: `TRANSACTION_WORKER_ENABLED=false`
2. Worker service (same repo/environment): start command `cd packages/backend && npm run worker`
3. Worker service: `TRANSACTION_WORKER_ENABLED=true`

This avoids N API replicas polling BullMQ marker keys and helps prevent Redis request quota exhaustion.

### Admin auth audit logs

Admin login events are written to application logs with the prefix `[admin-auth-audit]`:

- `admin_login_success`
- `admin_login_invalid_credentials`
- `admin_login_blocked`
- `admin_login_config_invalid`

Use these to investigate brute-force attempts and lockout behavior.

---

## STEP 6 — Register your first agent

```bash
curl -X POST https://api.yourdomain.com/v1/agents \
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

## STEP 7 — Connect the MCP server

Add to your Claude/LLM config:
```json
{
  "mcpServers": {
    "agentfi": {
      "url": "https://api.yourdomain.com/mcp/sse",
      "headers": {
        "x-api-key": "agfi_live_YOUR_AGENT_KEY"
      }
    }
  }
}
```

Alternatively, install the published npm package and run it as a local stdio server:
```bash
npx -y @agent_fi/mcp-server --backend https://api.yourdomain.com --api-key agfi_live_...
```

---

## STEP 8 — Optional: Safe smart wallets

To give each agent a Safe smart wallet (enables on-chain policy enforcement):

1. Create a funded EOA on each chain you want to support.
2. Add its private key to your host: `SAFE_DEPLOYER_PRIVATE_KEY=0x...`.
3. New agents registered after this will automatically get a Safe.

---

## Go-live checklist

```
[ ] Setup-checklist.md complete (third-party accounts, .env locally)
[ ] All Step 1 env vars set on the backend service
[ ] Contracts deployed or maintainer addresses reused (Step 2)
[ ] POLICY_MODULE_ADDRESS_* + EXECUTOR_ADDRESS_* set per chain
[ ] Stripe webhook configured (Step 4, only if using subscriptions)
[ ] curl /health/ready returns {"status":"ready",...}
[ ] First agent registered successfully
[ ] MCP server reachable from agent
[ ] Admin panel loads (if deployed)
```

See also: [`docs/operations/release-runbook.md`](release-runbook.md) for the release + rollback procedure.
