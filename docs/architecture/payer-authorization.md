# Payer authorization: what an agent API key can do (server-side)

Audit of 2026-11-18 (front 1B). The **payer** of the alpha is an AI agent, the
PROVIDER of an ACCEPTED job, that holds ONLY its own agent API key
(`x-api-key: agfi_...`) and pays x402 resources with
`POST /v1/jobs/:id/pay-resource`. An **operator** holds the operator secret
(`API_SECRET`) and/or the admin secret (`ADMIN_SECRET`, loopback only). A
client-side MCP tool filter only reduces what an agent is *shown*; this page
records what the **server** enforces, route by route, with the file and function and the
test that fails if the control is removed.

Controls are named by file and function / handler under `packages/backend/src`
(no line numbers: they drift).

## 1. Credentials and how they map to an agent

| Credential | Header | Resolved by | Result |
|---|---|---|---|
| Agent key | `x-api-key: agfi_...` | `api/middleware/auth.ts`: SHA-256 of the key looked up in `Agent.apiKeyHash`; inactive agent is 403 | `request.agentId` = that agent, `request.isOperator = false`. One key = one agent; every handler below scopes by `request.agentId`. |
| Operator secret | `x-api-key: <API_SECRET>` | `auth.ts` (`isOperatorKey`, constant time) | Accepted ONLY on `POST /v1/agents` (`auth.ts`) and on the explicit allow-list `OPERATOR_CAPABLE_ROUTES` = `PATCH /v1/agents/:id/policy` (`auth.ts`). On every other route it falls through to the agent-key check and is refused 401 (`Invalid API key format`). |
| Admin secret | `x-admin-secret` | `api/routes/admin.ts` (`requireAdmin`): constant-time compare AND loopback-only peer unless `ADMIN_ALLOW_REMOTE=true` | The agent-key hook skips `/admin*` (`auth.ts`), so an agent key sent as `x-admin-secret` is 401; an agent key as `x-api-key` on `/admin/*` is not read at all (401 from `requireAdmin`). |
| MCP session | `x-api-key` on `/mcp/sse` and `/mcp/messages` | `api/routes/mcp.ts` (session bound to the opening key, key never accepted in the query) | The MCP proxy forwards the same key to the REST routes below: it grants nothing the key does not already have. `/mcp/sse` also accepts a KEYLESS session (tool discovery, capped per client IP): it can list tools, and every tool call it makes is a REST call without a key, i.e. 401. |

## 2. Authorization matrix for the payer credential

"Scope" is whose data the call touches. Every `/v1/*` route not marked public
is behind the agent-key hook (`auth.ts`). Tests: `A` =
`payer-authz.db.test.ts`, `J` = `payer-authz.jobs.routes.test.ts`, `P` =
`agents.policy.routes.test.ts`, `R` = `resource-payment.routes.test.ts`, `I` =
`payer-authz.inventory.test.ts`; others by file name.

### 2.1 Agent, policy, identity (`routes/agents.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/agents` | nothing (401). For the operator: registers an agent and ALWAYS creates its policy row (the given `policy`, else the defaults of section 3.3) | operator only | `auth.ts` (registration branch), `agents.ts` `POST /v1/agents` | `agents.policy.routes.test.ts` "does not accept the operator API_SECRET on other agent routes" |
| `POST /v1/public/agents` | create a NEW agent (unauthenticated, per-IP rate limit, tier FREE, default policy, `maxOutflowPerTxUsd` NULL = outflows blocked) | creates a different agent; no authority over it is shared | `agents.ts`; `auth.ts` | `agents.public.routes.test.ts` |
| `GET /v1/agents/search` | search active agents by name/address (public) | all agents, id/name/chains/tier only | `agents.ts` | `agent.search.test.ts` |
| `GET /v1/agents/me` | read own profile, policy, billing usage | own | `agents.ts` (`request.agentId`) | `A` |
| `GET /v1/agents/:id` | read own profile | own only, else 403 | `agents.ts` | `A` OTHER "cannot read or change another agent's policy" |
| `PATCH /v1/agents/:id/policy` | **TIGHTEN** its own policy (section 3); never WIDEN | own only (403 for another id); operator secret may do both on any agent | `agents.ts`, `policy-authority.ts` (`classifyPolicyChange`), `policy.service.ts` (`patchPolicyAtomically`) | `A` POL-WIDEN, POL-TIGHTEN, POL-RACE, OPERATOR; `P`; `policy-authority.test.ts` |
| `GET /v1/agents/:id/manifest` | read any agent's service manifest (public) | all agents | `agents.ts` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/:id/erc8004.json` | read any registration file (public by design, ERC-8004) | all agents | `agents.ts`; `auth.ts` | `agents.erc8004.routes.test.ts` |
| `PATCH /v1/agents/me/manifest` | rewrite its own public manifest (free-form JSON) | own | `agents.ts` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/:id/trust-report` | read any agent's reputation (public) | all agents | `agents.ts` | `agents.erc8004.routes.test.ts` |
| `POST /v1/agents/me/sign-handshake` | have ITS OWN wallet sign the fixed `AgentFiHandshake` EIP-712 envelope (never arbitrary bytes) | own wallet | `agents.ts`, `services/identity/handshake.ts` | `handshake.test.ts`, `agents.handshake.routes.test.ts` |
| `POST /v1/agents/verify-handshake` | verify a signature (public, no state) | none | `agents.ts` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/me/pnl` | read own P&L | own | `agents.ts` | `pnl.service.test.ts` |
| `DELETE /v1/agents/:id` | deactivate (and pause the policy of) ITSELF: a tightening, no way back with an agent key | own only, else 403 | `agents.ts` | `A` OTHER |

There is **no API-key rotation or key-listing route**: an agent cannot mint,
list or rotate keys (any key change is an operator action in the database).

### 2.2 Jobs (`routes/jobs.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/jobs` | create a job as REQUESTER (spends its own funds under its own policy); a PAID job may not name itself as provider | own requester id; provider must exist/active | `jobs.ts` (self-provider refusal: `JOB_PROVIDER_IS_REQUESTER` off the escrow chains, `ERC8183_PROVIDER_IS_REQUESTER` on them; defence in depth, see K4); the requester's policy is judged before the job exists (`reserveJobEscrow` / `reserveEscrowJobSpend`, including `judgeOutflowCap`: a NULL outflow cap refuses a paid job off the escrow chains) | `J` JOBS-5; `A` OTHER "paid self-job"; `jobs.routes.erc8183.test.ts` |
| `GET /v1/jobs/inbox` | list jobs where it is the provider | own | `jobs.ts` inbox `where: { providerId: request.agentId }` | `J` JOBS-6 |
| `GET /v1/jobs/outbox` | list jobs where it is the requester | own | `jobs.ts` outbox `where: { requesterId: request.agentId }` | `J` JOBS-6 |
| `GET /v1/jobs/:id` | read a job it is part of | requester or provider, else 403 | `jobs.ts` | `J` JOBS-1; `A` OTHER |
| `PATCH /v1/jobs/:id` | as PROVIDER: ACCEPT / COMPLETE / FAIL / CANCEL the job; as REQUESTER: CANCEL only. Writes `status` and `result` ONLY: `reward` (the x402 budget), `providerId`, reservation fields are never part of the write | participants only (403 otherwise); transition table `PENDING->ACCEPTED/CANCELLED`, `ACCEPTED->COMPLETED/FAILED/CANCELLED`, terminal states are final | `jobs.ts` (`isProvider`/`isRequester`, `VALID_TRANSITIONS`), `updateJobSchema`, conditional `updateMany` | `J` JOBS-1/2/3; `A` OTHER "budget (reward) cannot be changed" |
| `POST /v1/jobs/:id/contest` | requester only | requester, else 403 | `jobs.ts` | `J` JOBS-4; `jobs.routes.erc8183.test.ts` "only the requester may contest" |
| `GET /v1/jobs/:id/feedback.json` | read (public by design: its hash is committed on-chain) | any job id | `jobs.ts`; `auth.ts` | `jobs.routes.erc8183.test.ts` "is public" |
| `POST /v1/jobs/:id/pay-resource` | as PROVIDER of an ACCEPTED job, pay an x402 resource FROM ITS OWN WALLET under ITS OWN policy (the job reward is only a ceiling on the total, not the source of the funds): only USDC on the job's network, at most the job's remaining budget (`reward.amount` minus counted payments), and at most `maxAmount` | the job it provides; REQUESTER and strangers get 403 `NOT_PROVIDER` before anything is fetched; `payTo`/asset/network are the resource server's offer and are judged against the payer's policy (`evaluateUsdcSpend`: `allowedTokens`, `allowedRecipients`, `maxValuePerTxUsd`, `maxDailyVolumeUsd`, pause/expiry) under the Job then Agent row locks; idempotency is `(jobId, paymentId)` and `jobId` is authorized first | `resource-payment.service.ts` (provider check) (`reserve`), route `resource-payments.ts` | `R` ("the requester cannot pay from the job budget"), `A` OTHER (NOT_PROVIDER for requester and stranger, no row written), `resource-payment.target-policy.test.ts`, `usdc-spend-policy.test.ts` |

### 2.3 Wallet and transactions (`routes/wallets.ts`, `routes/transactions.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `GET /v1/wallet/address`, `GET /v1/wallet/balance`, `GET /v1/wallet/allowances` | read its OWN wallet | own (`where: { id: request.agentId }`) | `wallets.ts` | `wallets.allowances.routes.test.ts` |
| `POST /v1/transactions/simulate` | simulate for its own wallet | own | `transactions.ts` | `transactions.routes.integration.test.ts` |
| `POST /v1/transactions/swap`, `POST /v1/transactions/swap-curve`, `POST /v1/transactions/transfer`, `POST /v1/transactions/deposit`, `POST /v1/transactions/withdraw`, `POST /v1/transactions/supply-compound`, `POST /v1/transactions/withdraw-compound`, `POST /v1/transactions/deposit-erc4626`, `POST /v1/transactions/withdraw-erc4626`, `POST /v1/transactions/gmx-open`, `POST /v1/transactions/gmx-close`, `POST /v1/transactions/batch` | **move its own funds** (transfer to ANY address, swap, DeFi, arbitrary batch actions) subject to ITS policy: `allowedContracts`/`allowedRecipients`/`allowedTokens`, `maxValuePerTxEth`, `maxOutflowPerTxUsd` (NULL = ordinary outflows refused; the default row every registration path now creates, section 3.3), daily volume, cooldown, approval threshold. An agent with NO policy row (registered by the operator without `policy` before this change) is unrestricted here until the operator writes a policy. **Owner decision (section 5, K1)** | own wallet only; the signing wallet is resolved from `request.agentId` | each route calls `policyService.validateTransaction` (and `judgeOutflowCap` for batch) | `outflow-cap.routes.db.test.ts`, `transactions.routes.integration.test.ts`, `spend-pricing.routes.db.test.ts`, `daily-volume.db.test.ts` |
| `GET /v1/transactions/:id`, `GET /v1/transactions` | read its own transactions | own (`agentId: request.agentId`; another agent's id is 404) | `transactions.ts` | `transactions.routes.integration.test.ts` |
| `GET /v1/public/transactions/:id` | read a restricted view of ANY transaction by its unguessable id (public by design, used by the UI) | any id | `transactions.ts`; `auth.ts` | `transactions.routes.integration.test.ts` |

Idempotency of transactions is scoped `(agentId, idempotencyKey)`
(`transactions.ts`); a simulation id is bound to the agent that made it
(`transactions.ts`).

### 2.4 Billing, MCP, health, well-known

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/billing/checkout`, `POST /v1/billing/portal` | obtain a Stripe checkout / portal URL for ITSELF (a human pays); no tier change happens without Stripe's signed webhook | own | `billing.ts` | `billing` has no route test; no state is changed by the call |
| `GET /v1/billing/status` | read own tier and usage | own | `billing.ts` | none (read of own row) |
| `POST /v1/billing/webhook` | nothing: Stripe signature required | none | `billing.ts`; `auth.ts` | Stripe service tests |
| `GET /mcp/sse`, `POST /mcp/messages` | open an MCP session with its key; tool calls are REST calls with the same key (section 4) | own | `mcp.ts` (session bound to key hash) | `mcp.sessions.test.ts`, `mcp.errors.test.ts` |
| `GET /health`, `GET /health/ready` | read (public) | none | `health.ts`; `auth.ts` | `health.ready.test.ts` |
| `GET /.well-known/agent.json` | read (public static advertisement) | none | `index.ts` | none (static) |

### 2.5 Admin routes (`routes/admin.ts`): nothing reachable with an agent key

Every handler starts with `if (!requireAdmin(request, reply)) return;`
(`requireAdmin` in `admin.ts`): `x-admin-secret` (constant time) AND a loopback peer unless
`ADMIN_ALLOW_REMOTE=true`. The agent-key hook does not run on `/admin*`
(the `/admin` prefix skip in `auth.ts`), so an agent key has no meaning there: it is 401 whether sent as
`x-admin-secret` or as `x-api-key`. `I` fails if an admin route is added without
the guard or without a row here. Tests: `admin.loopback.test.ts`,
`admin.pause.routes.test.ts`, `admin.jobs.resolve.routes.test.ts`,
`admin.batch.routes.test.ts`, `I`.

| Route (`routes/admin.ts`) | Payer key can |
|---|---|
| `POST /admin/transactions/batch` | nothing (401) |
| `GET /admin/stats`, `GET /admin/volume`, `GET /admin/revenue` | nothing (401) |
| `GET /admin/agents`, `GET /admin/agents/:id`, `GET /admin/agents/:id/transactions`, `GET /admin/agents/:id/pnl` | nothing (401) |
| `GET /admin/jobs`, `POST /admin/jobs/:id/reconcile`, `POST /admin/jobs/:id/resolve` | nothing (401) |
| `GET /admin/escrow/verification`, `GET /admin/contracts/verification`, `GET /admin/transactions` | nothing (401) |
| `POST /admin/agents/:id/pause`, `POST /admin/agents/:id/resume` | nothing (401): the kill switch is operator-only; the agent can only pause ITSELF through its own policy |
| `GET /admin/agents/:id/policy/onchain`, `POST /admin/agents/:id/policy/sync` | nothing (401) |
| `POST /admin/transactions/:id/approve`, `POST /admin/transactions/:id/reject` | nothing (401): a payer cannot approve its own pending transaction |
| `POST /admin/reputation/recompute`, `GET /admin/reputation/:agentId` | nothing (401) |
| `POST /admin/operators`, `GET /admin/operators`, `GET /admin/operators/:id`, `POST /admin/agents/:id/operator`, `DELETE /admin/agents/:id/operator` | nothing (401) |
| `POST /admin/settlements`, `GET /admin/settlements`, `PATCH /admin/settlements/:id/complete`, `PATCH /admin/settlements/:id/fail` | nothing (401) |

## 3. Policy: TIGHTEN vs WIDEN, as enforced

The agent key may only TIGHTEN (`classifyPolicyChange`, `policy-authority.ts`);
one loosened field refuses the WHOLE patch with 403 and
`loosenedFields` (all-or-nothing, nothing written). The operator secret may do
anything. The verdict is computed against the row it overwrites, atomically
(section 3.2).

### 3.1 Per field

| Field | TIGHTEN (agent key allowed) | WIDEN (agent key: 403) |
|---|---|---|
| `maxValuePerTxEth`, `maxValuePerTxUsd`, `maxOutflowPerTxUsd`, `maxDailyVolumeUsd` | a strictly lower value, as EVERY enforcer reads it (float, micro-USD, wei) | any higher value (also by one micro-USD / one wei); a non-decimal (an unparsable stored value is "unlimited"); `maxDailyVolumeUsd: "0"` (= no limit); for `maxOutflowPerTxUsd`: any value while it is NULL ("not configured" blocks outflows; only the operator configures it) |
| `allowedContracts`, `allowedRecipients`, `allowedTokens` | a subset of the current list (case-insensitive); ANY list while the current one is empty (empty = unrestricted) | `[]` when non-empty (clearing WIDENS), any address not in the current list |
| `cooldownSeconds` | a higher value | a lower value (including 0 = not enforced) |
| `active` | `false` (pause; the operator's pause stamp is cleared by any explicit write, so the agent's own pause is not undone by an admin resume) | `true` while stored `false` |
| `expiresAt` | an earlier time | `null` (clears it) or a later time while one exists; an expired policy cannot be revived by the agent |
| `syncOnChain`, `reason` | accepted (no effect on the verdict; `reason` is audit-only, never stored) | n/a |
| anything else (`tier`, `agentId`, `maxValueForAutoApprovalEth`, `pausedByOperatorAt`, snake_case spellings, unknown keys) | ignored by the schema: never written | n/a |

Validation at the edge (`agents.ts` `updatePolicySchema`): limits are strings
matching `^\d+(\.\d+)?$` (USD limits at most 6 decimals); numbers, `null` (except
`maxOutflowPerTxUsd`), empty, exponent, hex, signed or padded strings are 400.
Every whitelist entry (`allowedContracts`, `allowedRecipients`, `allowedTokens`) must be a
0x address (the enforcers `getAddress()` them); `cooldownSeconds` is an integer
between 0 and 31536000. Anything else is 400 for every caller.

### 3.2 Atomicity (gap G1, fixed) and what it does not cover

The route used to read the policy, classify the patch and write it in three
separate statements. A stale read could therefore be widened over a concurrent
tightening, and a patch classified neutral (`active: true` against a row that
was still active) could land AFTER the operator's kill switch and switch the
policy back on. `PolicyService.patchPolicyAtomically` now locks the Agent row
then the policy row (`FOR NO KEY UPDATE`, the reservation lock order) for the
whole read, verdict and write; the kill switch and a concurrent PATCH wait for
the commit. The wait is bounded (Postgres `lock_timeout` 4 s per lock statement, two lock
statements, so at most about 8 s, inside the 10 s transaction timeout):
when the locks cannot be had the route answers `503 POLICY_BUSY` +
`Retry-After` and nothing is written. Tests: `A` POL-RACE (stale read, kill
switch held in a transaction, the real `pauseByOperator` fired together with
the PATCH, concurrent tightenings, the no-row create race, the lock timeout);
`P` "503 POLICY_BUSY".

Where a policy read is atomic with the spend it authorizes:

| Path | Policy read | Atomic with the spend? |
|---|---|---|
| `PATCH /v1/agents/:id/policy` | `patchPolicyAtomically` | yes (this change) |
| `POST /v1/jobs/:id/pay-resource` (x402) | `ResourcePaymentService.reserve`: Job row then Agent row `FOR UPDATE`, the whole policy re-read and judged (`evaluateUsdcSpend`) before the reservation row is written | yes |
| `POST /v1/jobs` on an escrow chain | `reserveEscrowJobSpend`: Agent row lock, whole policy judged in the transaction that creates the Job | yes |
| the `/v1/transactions/*` POST routes (legacy path) | `PolicyService.validateTransaction` reads the policy UNLOCKED (caps, allowlists, pause, expiry, cooldown, a read-only daily pre-check); `createTransactionWithVolume` then takes the Agent lock and re-reads ONLY `maxDailyVolumeUsd` (binding daily check); the pre-submit guard (`pre-submit-guard.ts` `resolveBlockReason`) re-checks `Agent.active`, policy pause and expiry right before broadcast | **partly** |

The window on the legacy transactions path, precisely: a policy change that
commits AFTER `validateTransaction` read the row and BEFORE the Transaction row
is created is not seen by that request for the per-transaction caps
(`maxValuePerTxEth`, `maxOutflowPerTxUsd`), the allowlists and the cooldown. So
one request already past validation when the operator (or the agent itself)
TIGHTENS a cap or shrinks a list is still queued under the previous value. It
is bounded: one in-flight request per racing call (milliseconds), never above
what the policy allowed when it was validated, the daily limit is binding under
the lock, and a PAUSE / expiry / deactivation is still caught before broadcast.
It is not an agent-side widening (the agent cannot raise a value; it can only
keep using, for one racing request, a value that was valid a moment before).
Closing it means re-running the static checks inside
`createTransactionWithVolume`; that function does not receive what they need
(call target, recipient, token, native value, pricing: 12 callers of
`createWithVolumeReservation` build them differently, and one more
`validateTransaction` site, the legacy A2A payment, reserves nothing itself), so it is not a contained change and is left as a follow-up
(section 7), not attempted here.

Two sites read a paused policy as "no daily limit" (`policy.active ? limit :
0`); both are fixed because the change is self-contained:

- `createTransactionWithVolume` (`daily-volume.ts`), the binding daily check of
  the transactions path: it now applies the limit whether or not the policy is
  active (`A` DAILY-PAUSED, first test).
- `reserveJobEscrow` (`escrow.service.ts`), the legacy paid-job reservation.
  There it was exploitable by the agent key: pause itself (a tightening), post N
  paid jobs that each reserved $0 of DailyVolume, and after the operator's
  resume the legacy A2A payments (judged with `dailyVolumeAccounted: true`, not
  against the limit again) paid N rewards above `maxDailyVolumeUsd`. It now
  refuses a paused or expired policy (`403 POLICY_PAUSED`, as `evaluateUsdcSpend`
  on the escrow path) and applies the limit whenever a policy row exists (`A`
  DAILY-PAUSED, `POST /v1/jobs` tests).

Pause bookkeeping, documented behaviour (`A` OPERATOR "documented: ..."): any
explicit `active` write clears `pausedByOperatorAt`. An agent PATCH
`{active: false}` that lands after an operator pause therefore turns the
operator's pause into the agent's own: `POST /admin/agents/:id/resume` then
answers `left_inactive` and the operator resumes with
`PATCH /v1/agents/:id/policy {active: true}` and the operator secret. The agent
cannot use this to resume itself.

### 3.3 The first policy (gap G3, fixed) and agents without a policy row

A missing `AgentPolicy` row means "no restrictions" to every enforcer
(`validateTransaction`, `evaluateUsdcSpend` callers, `judgeOutflowCap`, the
x402 `reserve`, the escrow reservation). Two things followed:

1. Operator registration (`POST /v1/agents`) without `policy` created NO row
   (only the public path forced the defaults): an unrestricted agent.
2. The tighten-only verdict judged a row-less agent against "no restrictions",
   so its FIRST PATCH could seed anything (`maxOutflowPerTxUsd` or
   `maxValuePerTxUsd` "1000000000", `maxDailyVolumeUsd` "0", cooldown 0) and be
   accepted as a tightening.

Now:

- every registration path creates the policy row; without `policy` it is the
  default row `DEFAULT_AGENT_POLICY` (`policy-authority.ts`):
  `maxValuePerTxEth` 1.0, `maxValuePerTxUsd` 1.0, `maxOutflowPerTxUsd` NULL
  (ordinary outflows refused until the operator configures it),
  `maxDailyVolumeUsd` 10000, empty lists, cooldown 60 s, active;
- an AGENT caller without a row is judged against those defaults
  (`defaultPolicyBaseline`): its first PATCH can only introduce values at or
  below them, and the row it creates takes the column defaults for every field
  it does not name. The operator is judged against the real state and may
  create any first policy.

Existing rows are NOT backfilled (no migration): an agent registered by the
operator without `policy` before this change still has no row and is
**unrestricted until the operator sets a policy** (any `PATCH
/v1/agents/:id/policy` with the operator secret creates the row; fields not
named take the column defaults, so name `maxOutflowPerTxUsd` if outflows must
stay open). What protects such an agent meanwhile is only that it cannot seed
its own limits above the defaults. Find them with
`SELECT a.id FROM "Agent" a LEFT JOIN "AgentPolicy" p ON p."agentId" = a.id WHERE p.id IS NULL`.
The policy half of the admin kill switch (`pauseByOperator`) updates the
policy row and is a no-op without one, but `POST /admin/agents/:id/pause` also
sets `Agent.active = false`, which is what stops a row-less agent (the auth
hook answers 403 and the pre-submit guard blocks queued transactions); writing
a policy with `active: false` works too. Tests: `A` POL-FIRST, OPERATOR "pauseByOperator is a
no-op..."; `P`; `agents.public.routes.test.ts` "WITHOUT a policy the operator
path creates the default policy row too".

## 4. The MCP story

The stdio server (`packages/mcp-server`, 35 tools) and the SSE proxy
(`mcp.ts`, 18 tools: wallet, balance, swaps, `execute_transfer`, DeFi, status, own profile and policy; no job, policy-write or pay-resource tool; a keyless session can only list them) are thin REST clients: every tool is one of the routes
above called with the agent key, so the outcome is decided by the server.

| MCP tool | Route | Server-side outcome for the payer key |
|---|---|---|
| `pay_for_resource` | `POST /v1/jobs/:id/pay-resource` | provider-only, USDC, budget- and policy-bounded (2.2) |
| `check_inbox`, `check_outbox`, `get_job` | `GET /v1/jobs/inbox`, `/outbox`, `/:id` | own jobs only; others 403 |
| `update_job_status` | `PATCH /v1/jobs/:id` | provider: accept/complete/fail/cancel its job; cannot touch the budget or another job |
| `contest_job` | `POST /v1/jobs/:id/contest` | requester only: provider 403 |
| `post_job` | `POST /v1/jobs` | creates a job as requester; paid self-job refused |
| `update_policy` | `PATCH /v1/agents/:id/policy` | tighten only: any widening 403 even though the tool description is only advice (`A` POL-WIDEN) |
| `get_policy`, `get_my_agent_profile` | `GET /v1/agents/me` | own |
| `set_my_manifest` | `PATCH /v1/agents/me/manifest` | own public manifest |
| `sign_handshake` | `POST /v1/agents/me/sign-handshake` | fixed envelope only |
| `pay_agent`, `transfer_token` (`execute_transfer` in the SSE proxy), `execute_swap`, `swap_curve`, `deposit_aave`, `withdraw_aave`, `supply_compound`, `withdraw_compound`, `deposit_erc4626`, `withdraw_erc4626`, `open_gmx_position`, `close_gmx_position`, `simulate_swap` | `/v1/transactions/*` | own wallet, under its policy; see K1 |
| `get_wallet_info`, `get_transaction_status`, `get_my_pnl`, `search_agents`, `get_agent_manifest`, `get_agent_trust_report`, `verify_handshake`, `get_defi_rates`, `get_token_price`, `list_gmx_markets` | reads | own data, or public data |

Server-enforced denials (each has a test): another agent's policy / profile /
job / transaction; any policy widening (16 shapes, plus malformed values); seeding a first policy above the defaults (11 shapes);
unpausing; an operator-secret call on any agent-only route; any `/admin/*`
call with an agent key; `NOT_PROVIDER` for the requester and for strangers on
`pay-resource`; provider-only and requester-only job transitions; rewriting the
budget through `PATCH /v1/jobs/:id`; minting a budget through a paid self-job;
overtaking the kill switch or a concurrent tightening with a racing PATCH.

## 5. Known capabilities / owner decisions (not changed here)

| # | Capability | Evidence | Why it is left as is |
|---|---|---|---|
| K1 | An agent key can execute transfers, swaps, DeFi calls and batch actions from its own wallet (the MCP server exposes them), bounded only by its policy. Since this change every registration path creates the default policy row (`maxOutflowPerTxUsd` NULL = ordinary outflows refused, `maxValuePerTxUsd` 1.0, section 3.3); before it, operator registration without `policy` created NO row and such an agent has no restrictions at all until the operator sets a policy (section 3.3 says how to find and stop one). An operator that sets `maxOutflowPerTxUsd` or registers with an explicit policy opens the outflows. x402 payments (pay-resource) are bounded by `maxValuePerTxUsd`, not by the outflow cap. | `transactions.ts` (`validateTransaction` per route), `outflow-cap.ts` | Custody / admin model is out of scope: for a payer that must only pay x402, keep `maxOutflowPerTxUsd` NULL, list `allowedRecipients`/`allowedTokens`, and use the (client-side) 4-tool filter only as a convenience. |
| K2 | `allowedRecipients: []` and `allowedTokens: []` mean "unrestricted" for x402 `payTo` / token. The server cannot tell a payee the operator meant from one the resource server chose. | `usdc-spend-policy.ts`, `resource-payment.service.ts` (`reserve`) | Documented semantics (Q8). Operators must list recipients for a payer. |
| K3 | The provider decides when a job is COMPLETED and supplies `result`; on an escrow job the evaluator settles after submit unless the requester contests. | `jobs.ts` PATCH, `contestJob` | ERC-8183 design (decision D9); the requester's remedy is `contest`. |
| K4 | Sybil budget, narrower than it looks. `pay-resource` spends the PROVIDER's own wallet under the provider's own policy; the job reward is only a ceiling on the total, so a larger budget never lets a payer exceed its `maxValuePerTxUsd`, daily volume or allowlists. On a chain WITHOUT the escrow contract the reward is a DB reservation, and creating a paid job runs the requester's policy first (`reserveJobEscrow`, including `judgeOutflowCap`): a requester with the default policy (`maxOutflowPerTxUsd` NULL) is refused `USD_CAP_NOT_CONFIGURED`. So an accomplice created through the open `POST /v1/public/agents` cannot post a paid job; the two-agent path needs an accomplice with an operator-configured outflow cap, or one without a policy row (section 3.3). The self-provider refusal (G2) is defence in depth against the one-agent form. On escrow chains the budget is locked on-chain from the requester's wallet. | `escrow.service.ts` `reserveJobEscrow`, `outflow-cap.ts` `judgeOutflowCap`, `jobs.ts` `POST /v1/jobs` | Operator decision: use escrow chains for payers and do not leave row-less agents. |
| K5 | `GET /v1/public/transactions/:id`, `/v1/agents/:id/manifest`, `/trust-report`, `/erc8004.json`, `/v1/jobs/:id/feedback.json`, `/v1/agents/search` are readable without a key (ids are unguessable cuids, content is public by design). | `auth.ts` | Public discovery / ERC-8004 consumers need them. |
| K6 | `PATCH /v1/agents/me/manifest` lets an agent publish arbitrary JSON under its own id (read by peers via `get_agent_manifest`; peers must treat it as untrusted). | `agents.ts` | Product feature. |
| K7 | The billing checkout and portal routes return Stripe URLs for the agent (a human pays); there is no key rotation route. | `billing.ts` | Product feature. |

## 6. Keeping this page true

`payer-authz.inventory.test.ts` extracts every route registration from
`api/routes/*.ts` and `index.ts` and fails if one is missing from section 2
(written as `` `METHOD /path` `` in a table row), and if an admin handler lacks
`requireAdmin`. A new route therefore cannot ship unclassified.

Detection limits of that test: it reads `fastify.<method>('<literal path>'`
registrations in `api/routes/*.ts` and `index.ts`. A route registered through
`fastify.route({...})`, with a computed path, on another instance name or in
another directory is not seen; it also asserts that every `/admin` path is
registered in `admin.ts` (the only file whose handlers it checks for the guard).

## 7. Follow-ups (not in this change)

- F1: re-run the static policy checks (caps, allowlists, cooldown) under the
  Agent lock on the legacy `/v1/transactions/*` path (section 3.2). Needs the
  check inputs passed into `createTransactionWithVolume` from the 12
  `createWithVolumeReservation` callers (and a decision for the legacy A2A
  payment, which reserves nothing itself).
- F2: decide whether pre-existing agents without a policy row get the default
  row (operator action or a reviewed migration); until then section 3.3.
- F3 (done in #208): the scripts and examples that registered with
  `POST /v1/agents` and no `policy` now pass an explicit operator policy
  (`scripts/e2e-issue-81.mjs`, `smoke-dev.mjs`, `demo-claude-mcp.mjs`,
  `examples/a2a-collab`, `examples/delegation-chain`), and the registration docs
  say the default row applies.
- F4: the stdio MCP `update_policy` description (`packages/mcp-server/src/tools/agent.ts`)
  does not mention the first-policy rule (an agent without a policy row is judged
  against the registration defaults). Left to the MCP packaging front:
  `packages/mcp-server/src` changed on main since this branch was cut.
