# Payer authorization: what an agent API key can do (server-side)

Audit of 2026-11-18 (front 1B). The **payer** of the alpha is an AI agent, the
PROVIDER of an ACCEPTED job, that holds ONLY its own agent API key
(`x-api-key: agfi_...`) and pays x402 resources with
`POST /v1/jobs/:id/pay-resource`. An **operator** holds the operator secret
(`API_SECRET`) and/or the admin secret (`ADMIN_SECRET`, loopback only). A
client-side MCP tool filter only reduces what an agent is *shown*; this page
records what the **server** enforces, route by route, with file:line and the
test that fails if the control is removed.

Line numbers refer to the tree at this commit (`packages/backend/src`).

## 1. Credentials and how they map to an agent

| Credential | Header | Resolved by | Result |
|---|---|---|---|
| Agent key | `x-api-key: agfi_...` | `api/middleware/auth.ts:97-119`: SHA-256 of the key looked up in `Agent.apiKeyHash`; inactive agent is 403 | `request.agentId` = that agent, `request.isOperator = false`. One key = one agent; every handler below scopes by `request.agentId`. |
| Operator secret | `x-api-key: <API_SECRET>` | `auth.ts:36-42` (`isOperatorKey`, constant time) | Accepted ONLY on `POST /v1/agents` (`auth.ts:70-75`) and on the explicit allow-list `OPERATOR_CAPABLE_ROUTES` = `PATCH /v1/agents/:id/policy` (`auth.ts:33`, `:82-87`). On every other route it falls through to the agent-key check and is refused 401 (`Invalid API key format`). |
| Admin secret | `x-admin-secret` | `api/routes/admin.ts:111-125` (`requireAdmin`): constant-time compare AND loopback-only peer unless `ADMIN_ALLOW_REMOTE=true` | The agent-key hook skips `/admin*` (`auth.ts:53`), so an agent key sent as `x-admin-secret` is 401; an agent key as `x-api-key` on `/admin/*` is not read at all (401 from `requireAdmin`). |
| MCP session | `x-api-key` on `/mcp/sse` and `/mcp/messages` | `api/routes/mcp.ts` (session bound to the opening key, key never accepted in the query) | The MCP proxy forwards the same key to the REST routes below: it grants nothing the key does not already have. |

## 2. Authorization matrix for the payer credential

"Scope" is whose data the call touches. Every `/v1/*` route not marked public
is behind the agent-key hook (`auth.ts:48-119`). Tests: `A` =
`payer-authz.db.test.ts`, `J` = `payer-authz.jobs.routes.test.ts`, `P` =
`agents.policy.routes.test.ts`, `R` = `resource-payment.routes.test.ts`, `I` =
`payer-authz.inventory.test.ts`; others by file name.

### 2.1 Agent, policy, identity (`routes/agents.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/agents` | nothing (401) | operator only | `auth.ts:70-75` | `agents.policy.routes.test.ts` "does not accept the operator API_SECRET on other agent routes" |
| `POST /v1/public/agents` | create a NEW agent (unauthenticated, per-IP rate limit, tier FREE, default policy, `maxOutflowPerTxUsd` NULL = outflows blocked) | creates a different agent; no authority over it is shared | `agents.ts:289-320`; `auth.ts:56` | `agents.public.routes.test.ts` |
| `GET /v1/agents/search` | search active agents by name/address (public) | all agents, id/name/chains/tier only | `agents.ts:323` | `agent.search.test.ts` |
| `GET /v1/agents/me` | read own profile, policy, billing usage | own | `agents.ts:356` (`request.agentId`) | `A` |
| `GET /v1/agents/:id` | read own profile | own only, else 403 | `agents.ts:388-391` | `A` OTHER "cannot read or change another agent's policy" |
| `PATCH /v1/agents/:id/policy` | **TIGHTEN** its own policy (section 3); never WIDEN | own only (403 for another id); operator secret may do both on any agent | `agents.ts:455-535`, `policy-authority.ts` (`classifyPolicyChange`), `policy.service.ts` (`patchPolicyAtomically`) | `A` POL-WIDEN, POL-TIGHTEN, POL-RACE, OPERATOR; `P`; `policy-authority.test.ts` |
| `GET /v1/agents/:id/manifest` | read any agent's service manifest (public) | all agents | `agents.ts:550` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/:id/erc8004.json` | read any registration file (public by design, ERC-8004) | all agents | `agents.ts:576`; `auth.ts:62-64` | `agents.erc8004.routes.test.ts` |
| `PATCH /v1/agents/me/manifest` | rewrite its own public manifest (free-form JSON) | own | `agents.ts:594-607` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/:id/trust-report` | read any agent's reputation (public) | all agents | `agents.ts:618` | `agents.erc8004.routes.test.ts` |
| `POST /v1/agents/me/sign-handshake` | have ITS OWN wallet sign the fixed `AgentFiHandshake` EIP-712 envelope (never arbitrary bytes) | own wallet | `agents.ts:660-720`, `services/identity/handshake.ts` | `handshake.test.ts`, `agents.handshake.routes.test.ts` |
| `POST /v1/agents/verify-handshake` | verify a signature (public, no state) | none | `agents.ts:728` | `agents.handshake.routes.test.ts` |
| `GET /v1/agents/me/pnl` | read own P&L | own | `agents.ts:823` | `pnl.service.test.ts` |
| `DELETE /v1/agents/:id` | deactivate (and pause the policy of) ITSELF: a tightening, no way back with an agent key | own only, else 403 | `agents.ts:838-851` | `A` OTHER |

There is **no API-key rotation or key-listing route**: an agent cannot mint,
list or rotate keys (any key change is an operator action in the database).

### 2.2 Jobs (`routes/jobs.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/jobs` | create a job as REQUESTER (spends its own funds under its own policy); a PAID job may not name itself as provider | own requester id; provider must exist/active | `jobs.ts:131-160` (self-provider refusal: `JOB_PROVIDER_IS_REQUESTER` off the escrow chains, `ERC8183_PROVIDER_IS_REQUESTER` on them) | `J` JOBS-5; `A` OTHER "paid self-job"; `jobs.routes.erc8183.test.ts` |
| `GET /v1/jobs/inbox` | list jobs where it is the provider | own | `jobs.ts` inbox `where: { providerId: request.agentId }` | `J` JOBS-6 |
| `GET /v1/jobs/outbox` | list jobs where it is the requester | own | `jobs.ts` outbox `where: { requesterId: request.agentId }` | `J` JOBS-6 |
| `GET /v1/jobs/:id` | read a job it is part of | requester or provider, else 403 | `jobs.ts:719-723` | `J` JOBS-1; `A` OTHER |
| `PATCH /v1/jobs/:id` | as PROVIDER: ACCEPT / COMPLETE / FAIL / CANCEL the job; as REQUESTER: CANCEL only. Writes `status` and `result` ONLY: `reward` (the x402 budget), `providerId`, reservation fields are never part of the write | participants only (403 otherwise); transition table `PENDING->ACCEPTED/CANCELLED`, `ACCEPTED->COMPLETED/FAILED/CANCELLED`, terminal states are final | `jobs.ts:395-440` (`isProvider`/`isRequester`, `VALID_TRANSITIONS`), `updateJobSchema`, conditional `updateMany` | `J` JOBS-1/2/3; `A` OTHER "budget (reward) cannot be changed" |
| `POST /v1/jobs/:id/contest` | requester only | requester, else 403 | `jobs.ts:655` | `J` JOBS-4; `jobs.routes.erc8183.test.ts` "only the requester may contest" |
| `GET /v1/jobs/:id/feedback.json` | read (public by design: its hash is committed on-chain) | any job id | `jobs.ts:680`; `auth.ts:57-60` | `jobs.routes.erc8183.test.ts` "is public" |
| `POST /v1/jobs/:id/pay-resource` | as PROVIDER of an ACCEPTED job, pay an x402 resource: only USDC on the job's network, at most the job's remaining budget (`reward.amount` minus counted payments), and at most `maxAmount` | the job it provides; REQUESTER and strangers get 403 `NOT_PROVIDER` before anything is fetched; `payTo`/asset/network are the resource server's offer and are judged against the payer's policy (`evaluateUsdcSpend`: `allowedTokens`, `allowedRecipients`, `maxValuePerTxUsd`, `maxDailyVolumeUsd`, pause/expiry) under the Job then Agent row locks; idempotency is `(jobId, paymentId)` and `jobId` is authorized first | `resource-payment.service.ts:466-480` (provider check), `:996-1077` (`reserve`), route `resource-payments.ts:57` | `R` ("the requester cannot pay from the job budget"), `A` OTHER (NOT_PROVIDER for requester and stranger, no row written), `resource-payment.target-policy.test.ts`, `usdc-spend-policy.test.ts` |

### 2.3 Wallet and transactions (`routes/wallets.ts`, `routes/transactions.ts`)

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `GET /v1/wallet/address`, `GET /v1/wallet/balance`, `GET /v1/wallet/allowances` | read its OWN wallet | own (`where: { id: request.agentId }`) | `wallets.ts:95,113,173` | `wallets.allowances.routes.test.ts` |
| `POST /v1/transactions/simulate` | simulate for its own wallet | own | `transactions.ts:224-270` | `transactions.routes.integration.test.ts` |
| `POST /v1/transactions/swap`, `POST /v1/transactions/swap-curve`, `POST /v1/transactions/transfer`, `POST /v1/transactions/deposit`, `POST /v1/transactions/withdraw`, `POST /v1/transactions/supply-compound`, `POST /v1/transactions/withdraw-compound`, `POST /v1/transactions/deposit-erc4626`, `POST /v1/transactions/withdraw-erc4626`, `POST /v1/transactions/gmx-open`, `POST /v1/transactions/gmx-close`, `POST /v1/transactions/batch` | **move its own funds** (transfer to ANY address, swap, DeFi, arbitrary batch actions) subject to ITS policy: `allowedContracts`/`allowedRecipients`/`allowedTokens`, `maxValuePerTxEth`, `maxOutflowPerTxUsd` (NULL = ordinary outflows refused, the default of every registration path), daily volume, cooldown, approval threshold. **Owner decision (section 5, K1)** | own wallet only; the signing wallet is resolved from `request.agentId` | each route calls `policyService.validateTransaction` (e.g. `transactions.ts:320,518,665,810,930,1057,1178,1302,1429,1604,1753,1935`); batch `:2060` (`judgeOutflowCap`) | `outflow-cap.routes.db.test.ts`, `transactions.routes.integration.test.ts`, `spend-pricing.routes.db.test.ts`, `daily-volume.db.test.ts` |
| `GET /v1/transactions/:id`, `GET /v1/transactions` | read its own transactions | own (`agentId: request.agentId`; another agent's id is 404) | `transactions.ts:2185-2192`, `:2223-2245` | `transactions.routes.integration.test.ts` |
| `GET /v1/public/transactions/:id` | read a restricted view of ANY transaction by its unguessable id (public by design, used by the UI) | any id | `transactions.ts:2196`; `auth.ts:55` | `transactions.routes.integration.test.ts` |

Idempotency of transactions is scoped `(agentId, idempotencyKey)`
(`transactions.ts:2309-2320`); a simulation id is bound to the agent that made it
(`transactions.ts:293`).

### 2.4 Billing, MCP, health, well-known

| Route | Payer key can | Scope | Enforced by | Test |
|---|---|---|---|---|
| `POST /v1/billing/checkout`, `POST /v1/billing/portal` | obtain a Stripe checkout / portal URL for ITSELF (a human pays); no tier change happens without Stripe's signed webhook | own | `billing.ts:22-45` | `billing` has no route test; no state is changed by the call |
| `GET /v1/billing/status` | read own tier and usage | own | `billing.ts:78` | none (read of own row) |
| `POST /v1/billing/webhook` | nothing: Stripe signature required | none | `billing.ts:48-75`; `auth.ts:58` | Stripe service tests |
| `GET /mcp/sse`, `POST /mcp/messages` | open an MCP session with its key; tool calls are REST calls with the same key (section 4) | own | `mcp.ts` (session bound to key hash) | `mcp.sessions.test.ts`, `mcp.errors.test.ts` |
| `GET /health`, `GET /health/ready` | read (public) | none | `health.ts:159,167`; `auth.ts:51` | `health.ready.test.ts` |
| `GET /.well-known/agent.json` | read (public static advertisement) | none | `index.ts` | none (static) |

### 2.5 Admin routes (`routes/admin.ts`): nothing reachable with an agent key

Every handler starts with `if (!requireAdmin(request, reply)) return;`
(`admin.ts:111`): `x-admin-secret` (constant time) AND a loopback peer unless
`ADMIN_ALLOW_REMOTE=true`. The agent-key hook does not run on `/admin*`
(`auth.ts:53`), so an agent key has no meaning there: it is 401 whether sent as
`x-admin-secret` or as `x-api-key`. `I` fails if an admin route is added without
the guard or without a row here. Tests: `admin.loopback.test.ts`,
`admin.pause.routes.test.ts`, `admin.jobs.resolve.routes.test.ts`,
`admin.batch.routes.test.ts`, `I`.

| Route (admin.ts line) | Payer key can |
|---|---|
| `POST /admin/transactions/batch` (244) | nothing (401) |
| `GET /admin/stats` (357), `GET /admin/volume` (1064), `GET /admin/revenue` (1089) | nothing (401) |
| `GET /admin/agents` (431), `GET /admin/agents/:id` (445), `GET /admin/agents/:id/transactions` (460), `GET /admin/agents/:id/pnl` (1193) | nothing (401) |
| `GET /admin/jobs` (482), `POST /admin/jobs/:id/reconcile` (521), `POST /admin/jobs/:id/resolve` (674) | nothing (401) |
| `GET /admin/escrow/verification` (724), `GET /admin/contracts/verification` (744), `GET /admin/transactions` (759) | nothing (401) |
| `POST /admin/agents/:id/pause` (800), `POST /admin/agents/:id/resume` (850) | nothing (401): the kill switch is operator-only; the agent can only pause ITSELF through its own policy |
| `GET /admin/agents/:id/policy/onchain` (877), `POST /admin/agents/:id/policy/sync` (903) | nothing (401) |
| `POST /admin/transactions/:id/approve` (915), `POST /admin/transactions/:id/reject` (1032) | nothing (401): a payer cannot approve its own pending transaction |
| `POST /admin/reputation/recompute` (1134), `GET /admin/reputation/:agentId` (1157) | nothing (401) |
| `POST /admin/operators` (1231), `GET /admin/operators` (1243), `GET /admin/operators/:id` (1248), `POST /admin/agents/:id/operator` (1257), `DELETE /admin/agents/:id/operator` (1270) | nothing (401) |
| `POST /admin/settlements` (1286), `GET /admin/settlements` (1301), `PATCH /admin/settlements/:id/complete` (1313), `PATCH /admin/settlements/:id/fail` (1326) | nothing (401) |

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
| `cooldownSeconds` | a higher value | a lower value, zero or negative (non-positive is "not enforced") |
| `active` | `false` (pause; the operator's pause stamp is cleared by any explicit write, so the agent's own pause is not undone by an admin resume) | `true` while stored `false` |
| `expiresAt` | an earlier time | `null` (clears it) or a later time while one exists; an expired policy cannot be revived by the agent |
| `syncOnChain`, `reason` | accepted (no effect on the verdict; `reason` is audit-only, never stored) | n/a |
| anything else (`tier`, `agentId`, `maxValueForAutoApprovalEth`, `pausedByOperatorAt`, snake_case spellings, unknown keys) | ignored by the schema: never written | n/a |

Validation at the edge (`agents.ts` `updatePolicySchema`): limits are strings
matching `^\d+(\.\d+)?$` (USD limits at most 6 decimals); numbers, `null` (except
`maxOutflowPerTxUsd`), empty, exponent, hex, signed or padded strings are 400.
Whitelist entries for `allowedRecipients` must be addresses.

### 3.2 Atomicity (gap G1, fixed)

The route used to read the policy, classify the patch and write it in three
separate statements. A stale read could therefore be widened over a concurrent
tightening, and a patch classified neutral (`active: true` against a row that
was still active) could land AFTER the operator's kill switch and switch the
policy back on. `PolicyService.patchPolicyAtomically` now locks the Agent row
then the policy row (`FOR UPDATE`, the reservation lock order) for the whole
read, verdict and write; the kill switch and a concurrent PATCH wait for the
commit. Tests: `A` POL-RACE (three cases).

## 4. The MCP story

The stdio server (`packages/mcp-server`, 35 tools) and the SSE proxy
(`mcp.ts`, 18 tools: wallet, balance, swaps, DeFi, status, own profile and policy; no job, policy-write or pay-resource tool) are thin REST clients: every tool is one of the routes
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
| `pay_agent`, `transfer_token`, `execute_swap`, `swap_curve`, `deposit_aave`, `withdraw_aave`, `supply_compound`, `withdraw_compound`, `deposit_erc4626`, `withdraw_erc4626`, `open_gmx_position`, `close_gmx_position`, `simulate_swap` | `/v1/transactions/*` | own wallet, under its policy; see K1 |
| `get_wallet_info`, `get_transaction_status`, `get_my_pnl`, `search_agents`, `get_agent_manifest`, `get_agent_trust_report`, `verify_handshake`, `get_defi_rates`, `get_token_price`, `list_gmx_markets` | reads | own data, or public data |

Server-enforced denials (each has a test): another agent's policy / profile /
job / transaction; any policy widening (16 shapes, plus malformed values);
unpausing; an operator-secret call on any agent-only route; any `/admin/*`
call with an agent key; `NOT_PROVIDER` for the requester and for strangers on
`pay-resource`; provider-only and requester-only job transitions; rewriting the
budget through `PATCH /v1/jobs/:id`; minting a budget through a paid self-job;
overtaking the kill switch or a concurrent tightening with a racing PATCH.

## 5. Known capabilities / owner decisions (not changed here)

| # | Capability | Evidence | Why it is left as is |
|---|---|---|---|
| K1 | An agent key can execute transfers, swaps, DeFi calls and batch actions from its own wallet (the MCP server exposes them), bounded only by its policy. A registration path always starts with `maxOutflowPerTxUsd` NULL (ordinary outflows refused) and `maxValuePerTxUsd` 1.0; an operator that sets `maxOutflowPerTxUsd` or registers with an explicit policy opens them. x402 payments (pay-resource) are bounded by `maxValuePerTxUsd`, not by the outflow cap. | `transactions.ts` (`validateTransaction` per route), `outflow-cap.ts` | Custody / admin model is out of scope: for a payer that must only pay x402, keep `maxOutflowPerTxUsd` NULL, list `allowedRecipients`/`allowedTokens`, and use the (client-side) 4-tool filter only as a convenience. |
| K2 | `allowedRecipients: []` and `allowedTokens: []` mean "unrestricted" for x402 `payTo` / token. The server cannot tell a payee the operator meant from one the resource server chose. | `usdc-spend-policy.ts`, `resource-payment.service.ts` (`reserve`) | Documented semantics (Q8). Operators must list recipients for a payer. |
| K3 | The provider decides when a job is COMPLETED and supplies `result`; on an escrow job the evaluator settles after submit unless the requester contests. | `jobs.ts` PATCH, `contestJob` | ERC-8183 design (decision D9); the requester's remedy is `contest`. |
| K4 | Sybil budget: on a chain WITHOUT the escrow contract a reward is a DB reservation, so two agents controlled by the same party (`POST /v1/public/agents` is open, 5 per hour per IP) can mint a budget for one another. The self-provider refusal closes the one-agent case only. On escrow chains the budget is locked on-chain from the requester's wallet. | `jobs.ts` legacy path, `agents.ts` public registration | Operator decision: use escrow chains for payers, or close public registration. |
| K5 | `GET /v1/public/transactions/:id`, `/v1/agents/:id/manifest`, `/trust-report`, `/erc8004.json`, `/v1/jobs/:id/feedback.json`, `/v1/agents/search` are readable without a key (ids are unguessable cuids, content is public by design). | `auth.ts:48-67` | Public discovery / ERC-8004 consumers need them. |
| K6 | `PATCH /v1/agents/me/manifest` lets an agent publish arbitrary JSON under its own id (read by peers via `get_agent_manifest`; peers must treat it as untrusted). | `agents.ts:594` | Product feature. |
| K7 | The billing checkout and portal routes return Stripe URLs for the agent (a human pays); there is no key rotation route. | `billing.ts` | Product feature. |

## 6. Keeping this page true

`payer-authz.inventory.test.ts` extracts every route registration from
`api/routes/*.ts` and `index.ts` and fails if one is missing from section 2
(written as `` `METHOD /path` `` in a table row), and if an admin handler lacks
`requireAdmin`. A new route therefore cannot ship unclassified.
