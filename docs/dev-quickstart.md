# AgentFi — Dev Quickstart

**Goal**: clone the repo and reach a running stack in under 3 minutes, with **zero external accounts** (no Alchemy, no Turnkey, no Postgres/Redis install).

> This is for evaluation and local development. For production, follow [`docs/operations/production-deploy.md`](operations/production-deploy.md).

---

## Prerequisites

- **Docker** (with Compose v2) — `docker --version` and `docker compose version` both return something.
- Ports **3000, 3001, 3002, 5432, 6379** available locally.

That's it. No Node install, no npm, no API signups.

---

## Start the stack

```bash
git clone https://github.com/felippeyann/agentfi.git
cd agentfi
docker compose -f docker-compose.dev.yml up --build
```

First build takes ~2 minutes (npm install + tsc). Subsequent starts: ~10 seconds.

When you see:

```
api-1  | [info] AgentFi API listening on :3000
api-1  | [warn] [local-wallet] LocalWalletService active — keys in process memory, NOT for production
```

…the stack is ready.

---

## What's running

| Service | Port | Purpose |
|---|---|---|
| API | 3000 | REST + MCP (`/mcp/sse`) |
| Admin dashboard | 3001 | Next.js UI (login: `admin` / `admin`) |
| MCP server (SSE) | 3002 | Standalone MCP transport |
| Postgres | 5432 | `agentfi` / `agentfi` / `agentfi` |
| Redis | 6379 | No password |

The dev stack is **zero-credential** — it sets `WALLET_PROVIDER=local`, which uses in-memory viem keys instead of Turnkey. **Keys are lost on every restart** by design, so you can never accidentally persist dev keys to production.

---

## Register your first agent

In a new terminal:

```bash
curl -X POST http://localhost:3000/v1/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-api-secret-min-32-chars-long-xxxxx" \
  -d '{
    "name": "alice",
    "chainIds": [1],
    "tier": "FREE"
  }'
```

You'll get back something like:

```json
{
  "id": "clx...",
  "name": "alice",
  "apiKey": "agfi_live_abc123...",
  "walletAddress": "0x7e5F4552091A69125d5DfCb7b8C2659029395Bdf",
  "chainIds": [1],
  "tier": "FREE",
  "ensName": null
}
```

Save the `apiKey` — shown **once only**.

---

## Verify it works

```bash
# Liveness
curl http://localhost:3000/health

# Readiness (DB + Redis up; RPC and Turnkey will be false — expected in dev)
curl http://localhost:3000/health/ready

# Your registered agent
curl http://localhost:3000/v1/agents/me \
  -H "x-api-key: agfi_live_..."
```

---

## Connect Claude Desktop (optional)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, equivalent path on Windows):

```json
{
  "mcpServers": {
    "agentfi-dev": {
      "command": "npx",
      "args": ["-y", "@agent_fi/mcp-server@0.2.0"],
      "env": {
        "AGENTFI_API_URL": "http://localhost:3000",
        "AGENTFI_API_KEY": "agfi_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. You should see 26 AgentFi tools available.

> Transactions themselves won't execute in dev without a real `ALCHEMY_API_KEY` (RPC calls will fail), but `/v1/agents/me`, `/v1/agents/search`, `/v1/jobs`, P&L, and all data-layer tools work end-to-end.

---

## Graduating to real networks

When you're ready to execute real transactions:

1. Add `ALCHEMY_API_KEY=<yours>` to the `api` service env in `docker-compose.dev.yml`.
2. For real private-key custody, flip `WALLET_PROVIDER` to `turnkey` and add `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID` (see [`setup-checklist.md`](operations/setup-checklist.md) STEP 3).
3. For full production hosting, follow [`production-deploy.md`](operations/production-deploy.md).

---

## Tearing down

```bash
docker compose -f docker-compose.dev.yml down -v
```

The `-v` flag drops the Postgres and Redis volumes — nothing sticks around.

---

## Troubleshooting

- **Port conflict** — another service is on 3000/3001/3002/5432/6379. Stop it or remap ports in `docker-compose.dev.yml`.
- **`prisma migrate deploy` fails** — database wasn't ready in time. Run `docker compose -f docker-compose.dev.yml up api` again.
- **Admin login fails** — user is `admin`, password is `admin` (plain), secrets are the ones in `docker-compose.dev.yml`.
- **I need this stack to reach real networks** — see "Graduating" above. Dev stack is intentionally network-less for the wallet layer.
