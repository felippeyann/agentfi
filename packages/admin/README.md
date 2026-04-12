# @agentfi/admin

Operator dashboard for AgentFi — monitor agents, review transactions, approve/reject HITL requests, and view revenue analytics.

## Stack

- **Framework**: Next.js 16 (App Router)
- **UI**: React 18, Tailwind CSS, Radix UI, Recharts
- **Auth**: NextAuth v4 (credentials + GitHub/Google OAuth)

## Local Development

```bash
# From repo root
npm install
npm run dev --workspace=packages/admin   # starts on http://localhost:3001
```

## Authentication

The admin dashboard supports two auth modes:

1. **Credentials**: Username/password set via `ADMIN_USERNAME` + `ADMIN_PASSWORD` env vars
2. **OAuth**: GitHub and/or Google, restricted by `ADMIN_OAUTH_ALLOWLIST` (comma-separated emails)

By default the dashboard is **local-only** (127.0.0.1). Set `ADMIN_ALLOW_REMOTE=true` for remote access.

## Features

- Agent overview (list, detail, pause/unpause)
- Transaction log with status filtering
- HITL approval queue (approve/reject pending transactions)
- Daily volume and revenue charts
- Billing status per agent

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server (port 3001) |
| `npm run build` | Production build (standalone output) |
| `npm test` | Run Vitest tests |
| `npm run typecheck` | Type checking |
