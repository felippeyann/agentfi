# AgentFi — Operator Setup Checklist

This checklist is for operators preparing a **real AgentFi instance**: real RPC,
real wallet custody, real Postgres/Redis, and production-grade secrets.

If you only want to evaluate the project or develop locally, do **not** start
here. Use the [Dev Quickstart](../dev-quickstart.md). It runs the full API,
admin, MCP, Postgres, and Redis stack with `WALLET_PROVIDER=local` and no
external accounts.

---

## 0. Choose Your Mode

| Mode | Use when | Wallet provider | External accounts |
| --- | --- | --- | --- |
| Dev quickstart | You want to inspect or hack locally | `local` | None |
| Real-chain local | You want to test with real RPC/custody from your machine | `turnkey` | Alchemy, Turnkey, Postgres, Redis |
| Production | You operate a self-hosted public/private instance | `turnkey` | Alchemy, Turnkey, Postgres, Redis, optional Tenderly/Stripe |

Hard rule: `WALLET_PROVIDER=local` is development-only. The backend refuses to
boot with `NODE_ENV=production` and `WALLET_PROVIDER=local` because local wallet
keys live only in process memory and are lost on restart.

---

## 1. Local Environment File

For real-chain local development, copy the example env file:

```bash
cp .env.example .env
```

Never commit `.env`; it is already ignored.

For production, configure the same values in your hosting provider's secret/env
manager. Do not upload a local `.env` file as an artifact.

---

## 2. Required Secrets

Generate strong operator/admin/session secrets:

```bash
bash scripts/gen-secrets.sh
```

On Windows, run that from Git Bash or WSL. The script requires `openssl`.

Paste the generated values into `.env` for local runs, or into your hosting
provider for production:

```env
API_SECRET=...
ADMIN_SECRET=...
NEXTAUTH_SECRET=...
```

Also set admin login credentials before exposing the admin UI:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
```

Production should also set the brute-force lockout variables explicitly:

```env
ADMIN_AUTH_MAX_ATTEMPTS=5
ADMIN_AUTH_WINDOW_MS=600000
ADMIN_AUTH_LOCKOUT_MS=1800000
```

---

## 3. RPC Provider

AgentFi uses chain RPC for reads and broadcasts. Alchemy is the documented
provider; equivalent RPC providers can be wired by extending config.

1. Create an account at <https://alchemy.com>.
2. Create an app/key for the networks you will support.
3. Set:

```env
ALCHEMY_API_KEY=your_key_here
```

The zero-credential dev compose uses `ALCHEMY_API_KEY=stub`; that is enough for
DB/A2A/P&L flows but not for real transactions.

---

## 4. Wallet Custody

Production custody uses Turnkey MPC. Keys are split across shards and are not
reconstructed in the AgentFi process.

1. Create an account at <https://app.turnkey.com>.
2. Create an organization.
3. Create an API key.
4. Set:

```env
WALLET_PROVIDER=turnkey
TURNKEY_API_PUBLIC_KEY=your_public_key
TURNKEY_API_PRIVATE_KEY=your_private_key
TURNKEY_ORGANIZATION_ID=your_org_id
```

For local-only hacking, use [Dev Quickstart](../dev-quickstart.md) instead of
putting Turnkey placeholders in `.env`.

---

## 5. Database

AgentFi requires Postgres.

Local real-chain testing:

```bash
docker compose up postgres
```

```env
DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi
```

Production: use a managed Postgres provider such as Railway Postgres, Neon,
Supabase, or a self-managed Postgres instance:

```env
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
```

Migrations are applied with:

```bash
npx prisma migrate deploy --schema=packages/backend/src/db/schema.prisma
```

Railway and the backend Docker dev compose already run migrations during start.

---

## 6. Redis

Redis backs queues, rate limiting, and simulation cache.

Local real-chain testing:

```bash
docker compose up redis
```

```env
REDIS_URL=redis://localhost:6379
```

Production: use a managed Redis provider such as Railway Redis or Upstash:

```env
REDIS_URL=rediss://default:password@your-endpoint.upstash.io:6379
```

For metered Redis plans, run one dedicated worker process:

```env
# API replicas
TRANSACTION_WORKER_ENABLED=false

# worker service
TRANSACTION_WORKER_ENABLED=true
TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA=true
```

Worker command:

```bash
cd packages/backend && npm run worker
```

---

## 7. Operator Fee Wallet

`OPERATOR_FEE_WALLET` is where executor-routed protocol fees land. It can be
any EVM address you control.

```env
OPERATOR_FEE_WALLET=0xYourAddressHere
```

If you reuse the maintainer-deployed Base contracts, fees routed through those
contracts go to the maintainer's configured fee wallet. Deploy your own
contracts if you want to capture those fees.

---

## 8. Contract Addresses

Base Mainnet has maintainer-deployed contracts:

```env
POLICY_MODULE_ADDRESS_8453=0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d
EXECUTOR_ADDRESS_8453=0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3
```

To deploy your own contracts:

1. Install Foundry.
2. Fund a deployer wallet on each target chain.
3. Follow [contract-deployment.md](contract-deployment.md).
4. Set the resulting `POLICY_MODULE_ADDRESS_*` and `EXECUTOR_ADDRESS_*` values.

Optional Safe deployment for new agents:

```env
SAFE_DEPLOYER_PRIVATE_KEY=0x...
```

Without `SAFE_DEPLOYER_PRIVATE_KEY`, agent registration falls back to the
agent's Turnkey EOA address.

---

## 9. Tenderly Simulation

Tenderly is optional but recommended before public go-live. If configured,
AgentFi simulates transactions before broadcast; if omitted, simulation falls
back where supported.

1. Create a Tenderly account and project at <https://tenderly.co>.
2. Generate an access key.
3. Set:

```env
TENDERLY_ACCESS_KEY=your_access_key
TENDERLY_ACCOUNT=your_username_or_slug
TENDERLY_PROJECT=your_project_slug
```

---

## 10. Stripe Billing

Stripe is optional and only needed if you run paid PRO subscriptions.

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
```

Webhook endpoint:

```text
https://api.yourdomain.com/v1/billing/webhook
```

Listen for:

- `checkout.session.completed`
- `customer.subscription.deleted`
- `invoice.payment_failed`

For local webhook testing:

```bash
stripe listen --forward-to localhost:3000/v1/billing/webhook
```

---

## 11. Install and Run Locally With Real Credentials

Prerequisites:

- Node.js 20+
- Docker with Compose v2

Install dependencies:

```bash
npm ci
```

Start Postgres and Redis:

```bash
docker compose up postgres redis
```

Apply migrations and start the backend:

```bash
npx dotenv -e .env -- npx prisma migrate deploy --schema=packages/backend/src/db/schema.prisma
npx dotenv -e .env -- npm run dev -w packages/backend
```

Optional admin UI:

```bash
npx dotenv -e .env -- npm run dev -w packages/admin
```

Local URLs:

| Service | URL |
| --- | --- |
| API | `http://localhost:3000` |
| Admin | `http://localhost:3001` |
| MCP SSE | `http://localhost:3000/mcp/sse` |

If you want the standalone MCP SSE service, run `packages/mcp-server` separately
or use `docker-compose.dev.yml` for the zero-credential stack.

---

## 12. Production Hosting

AgentFi is self-hosted. There is no canonical hosted production instance.

Use [production-deploy.md](production-deploy.md) for provider-specific steps.
The short version:

1. Provision Postgres and Redis.
2. Create a backend service from this repo.
3. Configure all required env vars from this checklist.
4. Run migrations before start, or use a provider start command that does it.
5. Add an admin frontend if desired.
6. Configure native provider auto-deploy on `main` or release tags.

The repo does not ship a production deploy GitHub Action. Operators should use
their host's native GitHub integration or their own provider-specific workflow.

---

## 13. Verification

Before exposing the instance:

```bash
npm run typecheck --workspaces --if-present
npx dotenv -e .env -- npm run test -w packages/backend
npx dotenv -e .env -- npm run preflight
```

Then verify the deployed API:

```bash
curl https://api.yourdomain.com/health
curl https://api.yourdomain.com/health/ready
```

Register the first agent:

```bash
curl -X POST https://api.yourdomain.com/v1/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_SECRET" \
  -d '{
    "name": "my-first-agent",
    "chainIds": [8453],
    "tier": "FREE"
  }'
```

Save the returned `apiKey`; it is shown once.

---

## Go-Live Checklist

```text
[ ] NODE_ENV=production
[ ] WALLET_PROVIDER=turnkey
[ ] Turnkey credentials configured
[ ] ALCHEMY_API_KEY configured
[ ] DATABASE_URL configured and migrations applied
[ ] REDIS_URL configured
[ ] API_SECRET, ADMIN_SECRET, NEXTAUTH_SECRET generated
[ ] ADMIN_USERNAME and strong ADMIN_PASSWORD configured
[ ] OPERATOR_FEE_WALLET configured
[ ] Contract addresses configured or consciously omitted for non-executor flows
[ ] TRANSACTION_WORKER_ENABLED topology chosen
[ ] Stripe configured if subscriptions are enabled
[ ] Tenderly configured or consciously skipped
[ ] /health returns ok
[ ] /health/ready returns ready
[ ] First agent registered successfully
[ ] MCP reachable from an agent client
```

See also:

- [Dev Quickstart](../dev-quickstart.md)
- [Self-Hosted Production Deployment](production-deploy.md)
- [Release Runbook](release-runbook.md)
