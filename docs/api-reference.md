# AgentFi API Reference

Base URL: `https://agentfi-backend.fly.dev` (staging demo, no SLA) or `http://localhost:3000` (local)

> **Machine-readable spec**: [`docs/api/openapi.yaml`](api/openapi.yaml) — OpenAPI 3.0.3.
> Use it with Postman, Insomnia, `openapi-typescript`, `openapi-generator`, or
> Redocly. Lint with `npx @redocly/cli lint docs/api/openapi.yaml`.

## Authentication

| Method | Header | Used By |
|--------|--------|---------|
| Agent API Key | `x-api-key: agfi_live_<hex>` | Agent endpoints |
| Operator Secret | `x-api-key: <API_SECRET>` | Agent registration; also accepted on `PATCH /v1/agents/:id/policy` (the only credential that may loosen a policy) |
| Admin Secret | `x-admin-secret: <ADMIN_SECRET>` | Admin endpoints |

Rate limits are tier-based (FREE / PRO / ENTERPRISE) and keyed by `agentId` or IP.

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Liveness check |
| GET | `/health/ready` | None | Readiness check (DB, Redis, RPC, Turnkey) |

---

## Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/agents` | Operator | Register new agent (provisions wallet + Safe) |
| POST | `/v1/public/agents` | Public | Self-register a new agent (no API_SECRET needed; tier forced to FREE; rate-limited per IP) |
| GET | `/v1/agents/search?q=` | Public | Search by name or address (min 2 chars) |
| GET | `/v1/agents/me` | Agent | Current agent info (from API key) |
| GET | `/v1/agents/:id` | Agent (owner) | Agent details |
| PATCH | `/v1/agents/:id/policy` | Agent (owner, tighten-only) or Operator | Update policy (limits, whitelist, cooldown). Agents may only tighten; loosening requires `API_SECRET` |
| GET | `/v1/agents/:id/manifest` | Public | Service manifest for A2A discovery |
| PATCH | `/v1/agents/me/manifest` | Agent | Update own service manifest |
| GET | `/v1/agents/:id/trust-report` | Public | Reputation score, A2A tx count |
| GET | `/v1/agents/me/pnl` | Agent | Profit & loss breakdown (earnings, costs incl. gas, breakeven) |
| POST | `/v1/agents/me/sign-handshake` | Agent | Sign a message with the agent's wallet (EIP-191 personal_sign) |
| POST | `/v1/agents/verify-handshake` | Public | Verify a peer's signature (ECDSA recovery, EIP-1271 fallback) |
| DELETE | `/v1/agents/:id` | Agent (owner) | Soft deactivate + emergency pause |

### GET /v1/agents/me/pnl

Optional query: `?since=<ISO8601>` (defaults to agent's `createdAt`).

```json
// Response 200
{
  "agentId": "clx...",
  "name": "MyAgent",
  "periodStart": "2026-01-01T00:00:00.000Z",
  "periodEnd": "2026-04-17T00:00:00.000Z",
  "earnings": {
    "a2aJobsAsProvider": { "count": 3, "usd": "100.000000" },
    "totalEarningsUsd": "100.000000"
  },
  "costs": {
    "protocolFees":        { "count": 12, "usd": "4.500000" },
    "a2aJobsAsRequester":  { "count": 1,  "usd": "20.000000" },
    "gas":                 { "count": 14, "usd": "6.320000" },
    "totalCostsUsd": "30.820000"
  },
  "netPnlUsd": "69.180000",
  "breakEven": true,
  "profitable": true,
  "notes": ["Realized yield from DEPOSIT transactions not included (needs on-chain reads)."]
}
```

Gas cost = `gasUsed * effectiveGasPriceWei` per CONFIRMED/REVERTED tx, converted to USD via the native-token price oracle. REVERTED txs still burn gas and are counted.

### POST /v1/agents (Register)

```json
// Request (x-api-key: <API_SECRET>)
{ "name": "MyAgent", "chainIds": [8453], "tier": "FREE" }

// Response 201
{
  "id": "clx...",
  "name": "MyAgent",
  "apiKey": "agfi_live_abc123...",
  "safeAddress": "0x...",
  "chainIds": [8453],
  "ensName": "myagent-abc123.agentfi.eth"
}
```

### POST /v1/public/agents (Self-Register, no auth)

Open self-registration for autonomous agents. No operator `API_SECRET` required. Same response shape as `/v1/agents` above.

- **Auth**: none
- **Rate limit**: `PUBLIC_REGISTRATION_RATE_LIMIT_PER_HOUR` per IP (default 5/hour; operator-configurable; set to 0 to disable)
- **Tier**: forced to `FREE` regardless of request body
- **Policy**: forced to the server defaults — `maxValuePerTxEth=1.0`, `maxDailyVolumeUsd=10000`, empty whitelists, `cooldownSeconds=60`. Any `policy` in the request body is **ignored**: an unauthenticated caller cannot pick its own limits. Loosening afterwards requires the operator credential on `PATCH /v1/agents/:id/policy`.

```json
// Request (no auth headers)
{ "name": "self-registered-agent", "chainIds": [8453] }

// Response 201 (identical shape to /v1/agents)
{
  "id": "clx...",
  "name": "self-registered-agent",
  "apiKey": "agfi_live_...",
  "apiKeyPrefix": "agfi_live_abcd",
  "walletAddress": "0x...",
  "safeAddress": "0x...",
  "chainIds": [8453],
  "tier": "FREE",
  "ensName": null
}

// Response 429 (rate-limited)
{
  "error": "Public agent registration rate limit exceeded. Retry after 58 minutes.",
  "hint": "Contact the operator to register more agents via /v1/agents with API_SECRET, or self-host your own AgentFi instance."
}
```

> `ensName` is returned when the operator has configured `ENS_PARENT_DOMAIN`
and `ENS_CONTROLLER_PRIVATE_KEY`. Otherwise — or if the on-chain
registration fails — it is `null` and the agent is fully usable without
an ENS identity. See `.env.example` for configuration details.

### PATCH /v1/agents/:id/policy

```json
// Request
{
  "maxValuePerTxEth": "0.5",
  "maxDailyVolumeUsd": "5000",
  "allowedContracts": ["0x..."],
  "cooldownSeconds": 30,
  "active": true,
  "syncOnChain": true
}
```

**Tighten-only for agents, operator may loosen.** With its own API key an
agent can only make its policy *stricter*. A patch that loosens any field is
rejected so a compromised or prompt-injected agent cannot raise its own limits:

```json
// 403
{
  "error": "Policy can only be tightened by the agent. Loosening requires the operator credential.",
  "loosenedFields": ["maxValuePerTxEth", "allowedContracts"]
}
```

A field loosens when: `maxValuePerTxEth` or `maxDailyVolumeUsd` increases
(`maxDailyVolumeUsd: "0"` means *no daily limit*, so it loosens any positive
limit); `allowedContracts` / `allowedTokens` go from non-empty to empty or gain
an address not already in the list (case-insensitive); `cooldownSeconds`
decreases; `active` goes `false → true`; `expiresAt` is cleared or moved later
while one existed. With no policy row yet, any patch that sets a limit is a
tightening.

The operator sends the same request with `x-api-key: <API_SECRET>` and may set
any policy on any agent (returns `404` for an unknown agent id). Every policy
write is logged with the agent id, caller kind (`agent` / `operator`) and the
changed fields.

`maxValuePerTxEth` and `maxDailyVolumeUsd` must be plain decimal strings
(`^\d+(\.\d+)?$` — e.g. `"0.5"`, `"10000"`). Empty strings, whitespace,
exponents (`"1e3"`), hex (`"0x10"`) and words are rejected with `400`, for both
callers, so a value can never mean "0" to the tighten-only check and "no limit"
to enforcement. An optional `reason` (string, max 500 chars) is appended to the
audit log line; it is not stored and does not gate the change.

---

## Transactions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/transactions/simulate` | Agent | Dry-run swap simulation |
| POST | `/v1/transactions/swap` | Agent | Execute Uniswap V3 swap |
| POST | `/v1/transactions/transfer` | Agent | ETH or ERC-20 transfer |
| POST | `/v1/transactions/deposit` | Agent | Supply to Aave V3 |
| POST | `/v1/transactions/withdraw` | Agent | Withdraw from Aave V3 |
| POST | `/v1/transactions/supply-compound` | Agent | Supply to Compound V3 (Comet USDC market) |
| POST | `/v1/transactions/withdraw-compound` | Agent | Withdraw from Compound V3 |
| POST | `/v1/transactions/deposit-erc4626` | Agent | Deposit into any ERC-4626 vault (Yearn, Morpho, Beefy, etc.) |
| POST | `/v1/transactions/withdraw-erc4626` | Agent | Withdraw from any ERC-4626 vault |
| POST | `/v1/transactions/swap-curve` | Agent | Swap on Curve StableSwap pool (stablecoins, low slippage) |
| POST | `/v1/transactions/batch` | Agent | Multi-call batch (max 20 actions) |
| GET | `/v1/transactions/:id` | Agent (owner) | Transaction status |
| GET | `/v1/transactions` | Agent | Paginated history |
| GET | `/v1/public/transactions/:id` | Public | Public transaction view (limited fields) |

### POST /v1/transactions/transfer

```json
// Request
{ "to": "0x...", "token": "ETH", "amount": "0.01", "chainId": 8453 }

// Response 202
{
  "transactionId": "clx...",
  "status": "QUEUED",
  "fee": { "bps": 30, "amountWei": "3000000000000", "feeWallet": "0x..." }
}
```

**Transaction Statuses**: `SIMULATING` > `PENDING_APPROVAL` > `QUEUED` > `SUBMITTED` > `CONFIRMED` | `FAILED` | `REVERTED`

---

## Wallet

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/wallet/address` | Agent | Safe + EOA addresses |
| GET | `/v1/wallet/balance?chainId=` | Agent | ETH + ERC-20 balances |
| GET | `/v1/wallet/allowances?chainId=` | Agent | Active token allowances |

---

## Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/billing/checkout` | Agent | Create Stripe checkout (FREE to PRO) |
| POST | `/v1/billing/portal` | Agent | Stripe customer portal |
| POST | `/v1/billing/webhook` | Stripe | Webhook receiver (signature verified) |
| GET | `/v1/billing/status` | Agent | Subscription + usage info |

**Tier Limits**: FREE = 100 tx/month (30 bps) | PRO = 10K tx/month (15 bps) | ENTERPRISE = unlimited (5 bps)

---

## Jobs (Agent-to-Agent)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/jobs` | Agent | Create service request for another agent |
| GET | `/v1/jobs/inbox` | Agent | Jobs assigned to me (as provider) |
| GET | `/v1/jobs/outbox` | Agent | Jobs I created (as requester) |
| GET | `/v1/jobs/:id` | Agent (involved) | Job details |
| PATCH | `/v1/jobs/:id` | Agent (involved) | Update status (accept, complete, fail, cancel) |
| POST | `/v1/jobs/:id/pay-resource` | Agent (provider) | Pay an x402 (HTTP 402) resource from the job's remaining budget |

**Job Statuses**: `PENDING` > `ACCEPTED` > `COMPLETED` | `FAILED` | `CANCELLED`

**Escrow (v2)**: When a job is created with a `reward`, the requester's USD equivalent is committed to their daily volume atomically. Fields on the Job model:

| Field | Type | Description |
|-------|------|-------------|
| `reservedAmount` | string | Amount reserved (human-readable units) |
| `reservedToken` | string | Token symbol or address |
| `reservedChainId` | number | Chain where funds are reserved |
| `reservedAt` | datetime | Reservation timestamp |
| `reservationStatus` | enum | `PENDING` \| `RELEASED` (paid on COMPLETED) \| `CANCELLED` (returned on FAIL/CANCEL) |

When the job transitions to `COMPLETED`, the escrow is marked `RELEASED` and `executeA2APayment()` runs. On `FAILED` or `CANCELLED`, `releaseJobEscrow()` subtracts the reserved USD back from the requester's daily volume.

### POST /v1/jobs/:id/pay-resource

The job's **provider** pays a third-party HTTP 402 (x402 v2) resource with its **own USDC**, within the job's remaining reward budget, and gets the resource response back. The requester cannot call it (`403 NOT_PROVIDER`); the job must be `ACCEPTED` (`409 JOB_NOT_ACTIVE`); the job reward must be denominated in USDC on a supported chain (`400 UNSUPPORTED_BUDGET_TOKEN` — no oracle conversion). Design and state machine: [x402-payments.md §10](architecture/x402-payments.md).

```json
{ "url": "https://api.example.com/quote?symbol=ETH", "method": "GET", "maxAmount": "0.50", "paymentId": "quote_2026-10-06_0001" }
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | Absolute http(s) URL that resolves only to public addresses (see *Outbound target policy*). Query strings are sent but **never stored or logged** (only origin + path is kept) |
| `method` | no | `GET` (default) or `POST` |
| `body` | no | JSON body, `POST` only |
| `maxAmount` | no | Caller's own cap in USDC (`"0.50"`); the lower of this and the remaining budget applies |
| `paymentId` | no | Idempotency key, 16–128 chars of `[A-Za-z0-9_-]`, unique per job. Server UUID when omitted. **Reuse it on retries** |

Budget: `remaining = reward − Σ amount of this job's payments in (reserved, pending, settled, unknown)`. A 402 price above the cap is refused **before anything is signed**. Only USDC on the job's chain is accepted (`400 UNSUPPORTED_ASSET`).

Outbound target policy: before anything is fetched the hostname is resolved, and the request is refused (`400 INVALID_URL`) when the host is — or **any** address it resolves to is — loopback, private (RFC 1918, 100.64/10), link-local (169.254/16, fe80::/10), unique-local (fc00::/7), unspecified or otherwise reserved; IPv4-mapped (`::ffff:…`) and NAT64 (`64:ff9b::…`) addresses are judged by their IPv4. The connection is pinned to the addresses that were checked (no DNS rebinding), and redirects are never followed (`400 REDIRECT_REFUSED`). This applies in every environment; only a development backend with `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true` may reach a resource server on localhost (production and staging refuse to boot with it).

**Response 200** — `{ payment, remainingBudget, resource, replayed?, warning? }`: `payment` is the `ResourcePayment` row (`null` when the resource never asked for payment), `remainingBudget` is `{ asset, symbol, decimals, network, total, spent, remaining, remainingFormatted }` in base units, `resource` is `{ status, headers (whitelist), body (JSON or text, capped at 64 KiB), truncated? }`. On an idempotent replay `replayed` is `true` and `resource` is `null`. The signed authorization is never returned — only its nonce (`payment.authorizationNonce`).

**`ResourcePayment` state machine** (`status`):

| Status | Meaning | Counts against budget | Retry with same `paymentId` |
|--------|---------|------------------------|------------------------------|
| `reserved` | Row created, budget checked, nothing signed yet | yes | `409 PAYMENT_IN_PROGRESS` |
| `pending` | Authorization signed and sent | yes | returns the row, no new payment |
| `settled` | 2xx with a settlement report; `receiptVerified` true/false when the server sent an `offer-receipt` | yes | returns the row, no new payment |
| `unknown` | Timeout / transport error **after** signing: money may have moved. No automatic retry; operator notified | yes | returns the row with a `warning`, no new payment |
| `refused` | Server answered 4xx/5xx after signing, no settlement | no | fresh attempt on the same row |
| `failed_before_signing` | 402 parse / budget / asset error before any signature | no | fresh attempt on the same row |

Terminal states never change; `unknown → settled` is reserved for the reconciliation task (not implemented yet).

**Errors** (`{ error, code, ...details }`):

| Status | `code` | Details |
|--------|--------|---------|
| 400 | `VALIDATION_FAILED`, `INVALID_URL`, `INVALID_BUDGET`, `UNSUPPORTED_BUDGET_TOKEN`, `UNSUPPORTED_ASSET` | nothing signed; `UNSUPPORTED_ASSET` carries `required` and `offered`; an `INVALID_URL` from the target policy carries `refusal` (`private-host` \| `private-address` \| `unresolvable`), `hostname` and, for a resolved address, `address` |
| 400 | `REDIRECT_REFUSED` | the resource answered `3xx`, which is never followed: `responseStatus`, `location` (query string stripped). Before signing `payment` is `null`; after signing `payment.status` is `refused`, or `settled` if the server reported a settlement on the redirect (the amount is spent — do not retry with a new `paymentId`) |
| 402 | `BUDGET_EXCEEDED` | refused before signing: `price`, `remaining`, `cap` (base units), `payment` (`failed_before_signing`) |
| 402 | `PAYMENT_REFUSED` | server rejected the signed payment or settlement failed: `reason`, `responseStatus`, `payment` (`refused`) |
| 403 | `NOT_PROVIDER`, `AGENT_INACTIVE`, `POLICY_PAUSED` | |
| 404 | `JOB_NOT_FOUND` | |
| 409 | `JOB_NOT_ACTIVE`, `PAYMENT_IN_PROGRESS`, `PAYMENT_ID_CONFLICT` | |
| 502 | `PAYMENT_FAILED` | transient DNS failure (`stage: "resolve"`), 402 unusable, or request failed / timed out before signing: `stage`, `timedOut` |
| 502 | `PAYMENT_OUTCOME_UNKNOWN` | signed and sent, no answer: `authorization { method, nonce, validAfter, validBefore }`, `payment` (`unknown`). **Do not retry with a new `paymentId`** |

MCP equivalent: `pay_for_resource` in `@agent_fi/mcp-server`.

---

## Admin (Operator)

All admin routes require `x-admin-secret` header. Local-only by default.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/stats` | Dashboard overview |
| GET | `/admin/agents` | All agents with billing |
| GET | `/admin/agents/:id` | Agent detail |
| GET | `/admin/agents/:id/transactions` | Agent transaction history |
| GET | `/admin/transactions` | Global transaction log |
| POST | `/admin/transactions/batch` | Operator batch execution |
| POST | `/admin/agents/:id/pause` | Emergency kill switch (toggle). Off-chain only; already-queued txs are rejected by the worker. Pausing deactivates the DB policy and records that the pause did it; when the toggle resumes, it behaves like `/resume` below. Body `{ "syncOnChain": true }` returns `emergencyPause`/`resume` calldata in `onChainSync` for the operator to broadcast |
| POST | `/admin/agents/:id/resume` | Idempotent resume. Sets `agent.active = true` and re-activates the DB policy **only if the pause deactivated it** (`AgentPolicy.pausedByOperatorAt`); a policy that was inactive before the pause stays inactive. Response: `{ active: true, agentReactivated, policyReactivated, policyNote, onChainSync }`. Body `{ "syncOnChain": true }` returns `resume(safe)` calldata |
| POST | `/admin/transactions/:id/approve` | Approve PENDING_APPROVAL tx |
| POST | `/admin/transactions/:id/reject` | Reject PENDING_APPROVAL tx |
| GET | `/admin/volume` | Daily volume chart (7 days) |
| GET | `/admin/revenue` | Revenue breakdown by tier |
| POST | `/admin/reputation/recompute` | Recompute reputation (all or single agent via body) |
| GET | `/admin/reputation/:agentId` | Reputation detail with persisted vs computed drift |
| GET | `/admin/agents/:id/pnl` | Profit & loss breakdown for any agent |

---

## MCP (Model Context Protocol)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/mcp/sse` | Agent (optional) | SSE stream for tool calls |
| POST | `/mcp/messages?sessionId=` | Session | JSON-RPC message handler |

**Backend MCP Proxy Tools** (16):
`get_wallet`, `get_balance`, `get_allowances`, `simulate_swap`, `execute_swap`, `execute_transfer`, `supply_aave`, `withdraw_aave`, `supply_compound`, `withdraw_compound`, `deposit_erc4626`, `withdraw_erc4626`, `swap_curve`, `get_transaction_status`, `list_transactions`, `get_agent_policy`

> **Note:** The backend's `/mcp/sse` endpoint exposes a **thin 18-tool proxy** for simple HTTP-over-MCP clients, including agent profile and P&L checks. The standalone `@agent_fi/mcp-server` package is richer: **32 tools** including GMX V2 perpetuals (`list_gmx_markets`, `open_gmx_position`, `close_gmx_position`) and A2A collaboration (`search_agents`, `post_job`, `check_inbox`, `pay_agent`, `pay_for_resource`, `get_my_pnl`, etc.) — see [packages/mcp-server/README.md](../packages/mcp-server/README.md) for the full catalog.

---

## Error Responses

All errors follow this format:

```json
{ "error": "Human-readable message", "details": "Optional additional context" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (validation failed) |
| 401 | Missing or invalid API key |
| 403 | Access denied (wrong agent, not admin) |
| 404 | Resource not found |
| 409 | Conflict (idempotency key collision) |
| 422 | Policy violation (limit exceeded, cooldown) |
| 429 | Rate limit exceeded |
| 501 | Not implemented |
| 503 | Service unavailable (dependency down) |
