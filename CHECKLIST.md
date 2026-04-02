# AgentFi — Operator Setup Checklist

Work through this top to bottom. Each section links to where you sign up and what to copy into your `.env` file.

---

## STEP 1 — Copy the environment file

In the `agentfi/` folder, duplicate `.env.example` and rename it `.env`.
This is the file you'll fill in as you go through the steps below.
Never commit this file to git — it's already in .gitignore.

---

## STEP 2 — Alchemy (RPC Provider)

Used to broadcast transactions and read blockchain data.

1. Go to https://alchemy.com and create a free account.
2. Create a new app for each network you want:
   - Ethereum Mainnet
   - Base
   - Arbitrum One
   - Polygon
   (You can use one API key for all of them.)
3. Copy your API key into `.env`:

   ALCHEMY_API_KEY=your_key_here

---

## STEP 3 — Turnkey (MPC Wallet Provider)

This is what keeps agent private keys secure. Keys are split across MPC shards and never reconstructed anywhere.

1. Go to https://app.turnkey.com and create an account.
2. Create an Organization (this is your AgentFi tenant).
3. Go to API Keys → Create API Key.
4. You'll get a public/private key pair. Copy them into `.env`:

   TURNKEY_API_PUBLIC_KEY=your_public_key
   TURNKEY_API_PRIVATE_KEY=your_private_key
   TURNKEY_ORGANIZATION_ID=your_org_id

   The org ID is shown on the Organization page.

---

## STEP 4 — Tenderly (Transaction Simulation)

Every transaction is simulated before being submitted. Tenderly catches reverts before they cost gas.

1. Go to https://tenderly.co and create a free account.
2. Create a Project.
3. Go to Settings → API Access → Generate Access Key.
4. Copy into `.env`:

   TENDERLY_ACCESS_KEY=your_access_key
   TENDERLY_ACCOUNT=your_username_or_slug
   TENDERLY_PROJECT=your_project_slug

   The account slug and project slug are visible in the URL when you're inside a project:
   app.tenderly.co/YOUR_ACCOUNT/project/YOUR_PROJECT

---

## STEP 5 — Database (PostgreSQL)

Option A — Local (for testing only):
   docker-compose up postgres
   DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi

Option B — Hosted (recommended for production):
   Sign up at https://neon.tech (free tier, no credit card required).
   Create a database, copy the connection string into `.env`:
   DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require

---

## STEP 6 — Redis

Option A — Local:
   docker-compose up redis
   REDIS_URL=redis://localhost:6379

Option B — Hosted:
   Sign up at https://upstash.com (free tier).
   Create a Redis database, copy the URL into `.env`:
   REDIS_URL=rediss://default:password@your-endpoint.upstash.io:6379

---

## STEP 7 — Your Operator Fee Wallet

This is the Ethereum address where protocol fees land for executor-routed swaps.
It can be any wallet you control (MetaMask, hardware wallet, anything).

1. Open MetaMask (or any wallet) and copy your address.
2. Add to `.env`:

   OPERATOR_FEE_WALLET=0xYourAddressHere

When a swap is routed through `AgentExecutor`, the protocol fee
(0.30% FREE / 0.15% PRO / 0.05% ENTERPRISE) is routed here.

---

## STEP 8 — Stripe (for PRO subscriptions — optional but recommended)

This enables agents to pay for the PRO tier ($99/month) and is your subscription revenue stream.

1. Go to https://stripe.com and create an account.
2. In the Stripe dashboard, go to Products → Create Product.
   - Name: "AgentFi PRO"
   - Price: $99.00 / month recurring
   - Copy the Price ID (starts with price_...)
3. Go to Developers → API Keys.
   - Copy the Secret Key (sk_live_...)
4. Go to Developers → Webhooks → Add Endpoint.
   - URL: https://agentfi-develop.up.railway.app/v1/billing/webhook
   - Events to listen for: checkout.session.completed, customer.subscription.deleted, invoice.payment_failed
   - Copy the Webhook Signing Secret (whsec_...)
5. Copy into `.env`:

   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRO_PRICE_ID=price_...

For local testing, use Stripe CLI:
   stripe listen --forward-to localhost:3000/v1/billing/webhook

---

## STEP 9 — Secrets

Generate two random secrets (at least 32 characters each).
You can use: https://generate-secret.vercel.app/64

   API_SECRET=random_64_char_string
   ADMIN_SECRET=another_random_64_char_string
   NEXTAUTH_SECRET=another_random_64_char_string

---

## STEP 9 — Install dependencies

You need Node.js 20+ and Docker installed.

   node --version   # should be v20+
   docker --version

Then in the agentfi/ folder:

   npm install

---

## STEP 10 — Run locally

   docker-compose up postgres redis

In a second terminal:

   cd packages/backend
   npm run db:generate
   npm run db:migrate
   npm run dev

In a third terminal (optional, for the admin panel):

   cd packages/admin
   npm run dev

The API will be at http://localhost:3000
The admin panel will be at http://localhost:3001
The MCP server will be at http://localhost:3002

---

## STEP 11 — Install Foundry (for smart contracts)

   curl -L https://foundry.paradigm.xyz | bash
   foundryup

Run the contract tests:

   cd packages/contracts
   forge test -vvv

---

## STEP 12 — Deploy smart contracts

You need a funded wallet on each network you want to deploy to.
ETH/MATIC for gas — a few dollars worth is enough.

Add your deployer wallet private key temporarily (do not commit):

   PRIVATE_KEY=0x...
   OPERATOR_ADDRESS=0xYourFeeWalletAddress

Then:

   cd packages/contracts
   forge script script/Deploy.s.sol --rpc-url base --broadcast --verify

Repeat for other networks. The deployed addresses will be printed.
Copy them into `.env`:

   POLICY_MODULE_ADDRESS_8453=0x...
   EXECUTOR_ADDRESS_8453=0x...

---

## STEP 13 — Run preflight check before production

   npm run preflight

   npm run preflight:deploy-scenarios

   Optional deeper E2E checks:
   cd packages/backend
   npm run test:e2e               # local Anvil + local DB/Redis
   E2E_ANVIL_FORK_URL=<BASE_MAINNET_RPC_URL> npm run test:e2e:fork
   E2E_TESTNET_RPC_URL=<BASE_SEPOLIA_RPC_URL> \
   E2E_TESTNET_POLICY_MODULE_ADDRESS=0x... \
   E2E_TESTNET_EXECUTOR_ADDRESS=0x... \
   npm run test:e2e:testnet

The first command checks runtime dependencies (database, redis, RPC, Turnkey, contracts).
The second command validates deploy-config pass/fail scenarios used by CI.
Fix any red items before deploying.

---

## STEP 14 — Production hosting

The project is hosted on **Railway**. No VPS or manual server management needed.

**CI/CD via GitHub Actions (`.github/workflows/`):**
- `ci.yml` — typecheck, unit tests, contract tests on every push
- `deploy-staging.yml` — no-op; Railway auto-deploys on push to `develop`
- `deploy-production.yml` — deploys to Railway production on `v*.*.*` tags or manual dispatch (requires Railway secrets)

**Live services:**
- API: https://agentfi-develop.up.railway.app
- Health: https://agentfi-develop.up.railway.app/health

**To deploy staging:** push to `develop` — Railway handles deployment automatically.

**To deploy production:**
- Configure `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, and `RAILWAY_PRODUCTION_ENVIRONMENT` in repository secrets
- Optional: set repository variable `RAILWAY_PRODUCTION_SERVICE` (default: `backend`)
- Optional: set repository variable `RAILWAY_PRODUCTION_WORKER_SERVICE` (for dedicated worker deploy)
- Trigger `Deploy Production` manually (workflow_dispatch) or push a `v*.*.*` tag
- Follow `docs/production-release-runbook.md` for verification and rollback procedure
- Use `docs/release-go-no-go-template.md` to record go/no-go before dispatch

**Recommended for metered Redis (Upstash):**
- Run one dedicated backend worker process with `TRANSACTION_WORKER_ENABLED=true`
- Set `TRANSACTION_WORKER_ENABLED=false` on API replicas
- Keep `TRANSACTION_WORKER_STOP_ON_REDIS_QUOTA=true` to auto-stop on provider quota exhaustion
- Worker start command: `cd packages/backend && npm run worker`

---

## You're live when:

[ ] .env is fully filled
[ ] ADMIN_USERNAME, ADMIN_PASSWORD and NEXTAUTH_SECRET are configured
[ ] ADMIN_AUTH_* brute-force lockout settings are configured
[ ] npm run preflight shows all green
[ ] API /health/ready returns {"status":"ready"}
[ ] At least one agent is registered via POST /v1/agents
[ ] MCP server is accessible from your agent

---

Questions? Everything else can be handled in the codebase — ask Claude Code.
