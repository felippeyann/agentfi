# Session Notes — 2026-05-04 (continued from 2026-05-03)

> Single-point handoff doc. Update on every substantive session, prune stale
> sections aggressively. If this file is older than a few days when you read
> it, trust `git log`, `gh pr list`, and `gh issue list` over the contents
> here.

---

## TL;DR for the next person opening this repo

**Backend is live in production** at `https://agentfi-backend.fly.dev/` — Fly.io free tier (`gru` region), Postgres on Fly, Redis on Upstash (us-east-1). Telegram operator notifications are wired into a group called "agentfi" via bot `@af_agentfi_bot` (chat_id `-5083790936`).

**Status: validated end-to-end with one architectural bug discovered ([#81](https://github.com/felippeyann/agentfi/issues/81)).** Phase 1 of #71 (PR #72) does not actually wait for on-chain confirmation — `executeA2APayment` resolves on BullMQ enqueue, not on tx settlement. Job lifecycle still produces ghost completions when the worker fails the tx asynchronously. Fix design is in [#81](https://github.com/felippeyann/agentfi/issues/81); needs a Phase 1.5 PR.

---

## What's deployed where (read this first)

| Resource | Provider | Identifier | Notes |
| -------- | -------- | ---------- | ----- |
| Backend (Fastify API) | Fly.io | App `agentfi-backend`, region `gru` | `flyctl logs --app agentfi-backend`, `flyctl ssh console --app agentfi-backend` |
| Postgres | Fly.io | App `agentfi-pg`, machine `d8d1390c252428` | Auto-stops aggressively on free tier — `flyctl machine start <id> --app agentfi-pg` if `P1001` errors hit |
| Redis | Upstash | DB `agentfi`, `generous-mustang-85669.upstash.io:6379` | Free tier (500k cmds/month) |
| Admin dashboard | Vercel | `agentfi-admin` | Pre-existing, `Vercel` check on PRs always fails — ignore |
| Landing | Vercel + standalone repo | `agentfi-landing` deploys from `felippeyann/agentfi-landing` (NOT this monorepo) | See HANDOFF.md §7 |
| Telegram notifications | Bot `@af_agentfi_bot` → group "agentfi" | Chat ID `-5083790936` | Secrets `OPERATOR_TELEGRAM_BOT_TOKEN` + `OPERATOR_TELEGRAM_CHAT_ID` set on Fly app |

**Backend env on Fly is currently `NODE_ENV=staging` + `WALLET_PROVIDER=local`** because Turnkey access was lost when the operator's old machine died. Real production demands switching to `WALLET_PROVIDER=turnkey` + 3 Turnkey keys. See "Operator pending tasks" below.

---

## What's open (PRs and issues)

**Open PRs:** none merged in this session need attention. All 5 from this and prior session are merged: #70, #72, #76, #77, #78, #79, #80.

**Open issues:**

- [#71](https://github.com/felippeyann/agentfi/issues/71) — A2A revenue integrity. Parent. Phase 1 (#72) shipped but turned out incomplete — see #81.
- [#73](https://github.com/felippeyann/agentfi/issues/73) — Stale `PAYMENT_PENDING` recovery worker.
- [#74](https://github.com/felippeyann/agentfi/issues/74) — `executeA2APayment` idempotency (must ship before #73).
- [#75](https://github.com/felippeyann/agentfi/issues/75) — Admin dashboard reconcile UI for new payment states.
- **[#81](https://github.com/felippeyann/agentfi/issues/81) — Phase 1 incomplete: `executeA2APayment` resolves on queue, not on chain confirmation.** Filed in this session after E2E validation revealed the bug. Highest priority next step — the BullMQ worker, not the request handler, should drive the Job lifecycle for paid A2A jobs.
- 10 dependabot PRs (#56–#65) untouched.

---

## What happened this session (2026-05-04)

### 1. Got the backend running on Fly.io (~3 hours of debugging)

Multiple compounding issues discovered and fixed in commit `fbbaacf` (PR #80):

1. **Dockerfile.backend deps stage** — `npm ci --workspace=packages/backend --include-workspace-root` was leaving some packages (`fastify-plugin`, etc.) in `packages/backend/node_modules/` instead of hoisting to `/app/node_modules`. Fix: copy ALL workspace package.jsons (admin, adapters, mcp-server) so npm sees the full graph, switch to plain `npm ci`, and copy BOTH node_modules paths in builder + runner stages.
2. **fly.toml** — backend was booting against an empty Postgres because no migration mechanism existed. Added `[deploy] release_command = "npx prisma migrate deploy --schema=./src/db/schema.prisma"`. If migrations fail the deploy aborts cleanly.
3. **Fastify v5 logger API change** — `Fastify({ logger: pinoInstance })` no longer works. v5 wants either a config object via `logger: {...}` or a pre-built instance via `loggerInstance`. We went with inline config matching `middleware/logger.ts`, sidestepping a TypeScript inference cascade that `loggerInstance` triggered.
4. **Fly free trial 5-minute auto-stop** (without payment method). Operator added a credit card; allowance kicks in (no charge under free thresholds).
5. **REDIS_URL was being corrupted by chat-paste artifacts** — Claude Code chat renders email-like strings (`token@host:port`) as markdown links `[text](mailto:...)`. The operator copied my generated URL and pasted, getting literal `[`, `]`, `(`, `mailto:` in the value. ioredis fell back to UNIX socket mode → `ENOENT`. Fix: never paste full URLs from chat; paste only the password and concatenate in PowerShell.

### 2. Telegram channel validated end-to-end

Created `@af_agentfi_bot` via `@BotFather`, added to a group called "agentfi", captured chat_id `-5083790936`, set `OPERATOR_TELEGRAM_BOT_TOKEN` + `OPERATOR_TELEGRAM_CHAT_ID` on Fly. Triggered a paid A2A job (Alice → Bob, 0.001 ETH) with stub Alchemy guaranteed to fail. Got a Telegram notification.

### 3. Discovered #81 (the actual completion of Phase 1)

The notification said "TRANSACTION_CONFIRMED" instead of "TRANSACTION_FAILED" because `executeA2APayment` resolves on enqueue, not on confirmation. Phase 1's premise was wrong. Job ended up `COMPLETED` despite the on-chain tx failing in BullMQ. Fix design captured in #81 — wire the transaction worker, not the request handler, to drive the Job lifecycle for paid A2A jobs.

### 4. PRs landed this session

Beyond the four merged in 2026-05-03 (#70, #76, #77, #72), this session merged:

- **#79** — `feat/fly-io-deploy` (the original fly.toml + Dockerfile changes preserved during 2026-05-03 cleanup)
- **#80** — `chore/dockerignore-for-fly` plus the three infra fixes from §1 above (Dockerfile.backend, fly.toml release_command, index.ts logger)

The `feat/fly-io-deploy` and `chore/dockerignore-for-fly` branches are now deleted from origin.

---

## Operator pending tasks (next time you sit down)

1. **Decide on Phase 1.5** ([#81](https://github.com/felippeyann/agentfi/issues/81)). The cleanest path is wiring the BullMQ worker to drive Job state for `metadata.a2aPayment === true` transactions. Estimate: 30–60 min coding + verification, depends on having Fly stack running so we can re-validate E2E.
2. **Rotate exposed credentials** — both the Telegram bot token and the Upstash Redis password were pasted in this chat session's transcripts. After confirming Fly is healthy, rotate both via @BotFather (`/revoke`) and Upstash dashboard, then `flyctl secrets set` the new values.
3. **Graduate to production-grade wallet provider** — currently `WALLET_PROVIDER=local` with `NODE_ENV=staging`. To run against real chains, regain Turnkey access (recovery flow on lost-device), set `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` / `TURNKEY_ORGANIZATION_ID`, replace `ALCHEMY_API_KEY` stub with a real key, then `flyctl secrets set NODE_ENV=production WALLET_PROVIDER=turnkey ...`.
4. **Postgres auto-stop is annoying** — every cold deploy needs `flyctl machine start <id> --app agentfi-pg` first. Consider either (a) keeping `flyctl pg connect` open in a side terminal during ops, or (b) upgrading the Postgres machine config to `auto_stop_machines = false` if Fly allows that on the free tier.
5. **Vercel landing tweaks** — Node.js version 24.x → 22.x to match CI; add apex domain `agentfi.cc` (currently only `www.agentfi.cc` is configured).
6. **Standalone landing repo** — archive or delete via GitHub UI now that polyrepo decision is documented in HANDOFF.md §7.

---

## Conventions reaffirmed this session

- **Don't paste URLs containing `@` from this chat into commands** — Claude Code renders them as markdown links and the literal brackets/parens get into your value. Always paste tokens raw and concatenate.
- **Fly free tier is free in name only** — without a payment method, machines die after 5 minutes. With a card on file, the free allowance is real (3 small VMs always-on). Add the card.
- **CI green ≠ functionally validated** (HANDOFF.md §6.2) reaffirmed by #81 — Phase 1 typechecked and tested in unit tests but only end-to-end on a real Fly deploy revealed the lifecycle gap.

---

*Last touch: 2026-05-04. Replace this header with the new session date when you update.*
