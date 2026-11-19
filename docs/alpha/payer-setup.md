# Setting up a payer agent (alpha reference configuration)

For the developer who connects an agent that **buys x402 resources** through AgentFi. It says which credential the agent gets, where the budget is set, what the agent's key can do besides buying, how to check the permissions that are really in force, and when the operator has to step in. Everything here is what the **server** enforces at the commit you run; the route-by-route audit behind it is [`docs/architecture/payer-authorization.md`](../architecture/payer-authorization.md).

Mode: this page describes configuration. The commands that create agents and policies run against **your own local backend** (the quickstart's LOCAL FORK); nothing here touches a public network.

## 1. Read this before you connect the agent: the key is not x402-only

The agent authenticates with **its own agent API key** (`agfi_…`). The server does **not** have a key that can only buy x402 resources: one key = one agent, and every route that agent may call accepts it. What keeps a payer to buying is its **policy**. With the reference policy below:

| The agent's key can… | With the reference policy |
|---|---|
| pay an x402 resource for a job it provides (`pay_for_resource` → `POST /v1/jobs/:id/pay-resource`) | **yes**, USDC only, to the listed seller(s), at most the per-payment cap, within the daily limit and the job's remaining budget |
| transfer tokens or ETH, swap, deposit into Aave / Compound / ERC-4626, open GMX positions, pay another agent (A2A), send a batch with value or ERC-20 transfers | **refused** (`USD_CAP_NOT_CONFIGURED`): `maxOutflowPerTxUsd` is not set |
| send a batch with an `approve` or any other non-transfer calldata | **refused** (`UNACCOUNTED_CALL`) while a daily limit applies and `allowedContracts` is empty. **But see the last row of this table: the key itself can fill an empty `allowedContracts`.** |
| create a job as requester (`post_job`) | an unpaid job: yes. A paid job: refused off the escrow chains (it is an outflow); on an escrow chain it is judged like a payment (per-payment cap, listed recipients, daily limit) plus the cooldown |
| withdraw from Aave / Compound / ERC-4626, close a GMX position | yes, back to its own wallet (not an outflow), but each withdrawal counts against the same daily limit as the purchases, `allowedTokens` and the cooldown apply, and an ERC-4626 "max" withdrawal is refused while a daily limit applies (its amount cannot be priced). GMX is not on Base Sepolia. Each of these spends the wallet's ETH on gas |
| accept / complete / fail / cancel a job it provides; cancel or contest a job it requested | yes (its own jobs only) |
| change its own policy (`update_policy`) | **only what the server counts as tightening**: lower caps, a subset of a non-empty list, pause itself; raising a cap, clearing a list or adding an address to a non-empty list is 403 and nothing is written. **One exception matters for a payer:** the server counts filling an EMPTY list as tightening (for ordinary transactions an empty list means "any"), so the key can set `allowedContracts` from `[]` to a list of its choosing, and that opens batch calls to those contracts with calldata the backend does not count (decision pending, section 7). `x402:ops payer` shows the row as it is when you run it |
| deactivate itself, rewrite its public manifest, sign the fixed `AgentFiHandshake` envelope, get a Stripe checkout URL, read its own data and public data | yes (see payer-authorization.md §2) |
| anything under `/admin/*`, another agent's data, rotate or list keys | no |

So: **the credential you hand to the agent also allows the actions in the "yes" rows.** The reference policy refuses the routes that send value out of the wallet (transfers, swaps, deposits, batches with value or ERC-20 transfers, A2A payments, paid jobs off the escrow chains) except x402 payments to the sellers you list; gas for the transactions it may still send (withdrawals, zero-value batches, the steps of an escrow job on an escrow chain) comes from the wallet's ETH. Do not describe it as an "x402-only key"; it is an agent key under a payer policy.

What the agent is **shown** is a different thing. The MCP stdio server (`packages/mcp-server`) lists all its tools (35). The OpenAI Agents example filters them to four (`get_my_agent_profile`, `get_policy`, `get_job`, `pay_for_resource`), and the adapters expose three. That filter runs **in the client**: it keeps the model focused, it is not a permission. Anyone holding the key can call every route in the table above.

## 2. Who holds what

| Holder | Gets | Never gets |
|---|---|---|
| The agent (its process, its MCP server) | `AGENTFI_API_URL`, `AGENTFI_API_KEY` (its own key), the job id(s) it works on. In the demo, exactly the file `agent.env` that `npm run alpha:serve` writes. | the operator secret (`API_SECRET`), the admin secret (`ADMIN_SECRET`), any RPC URL that can write to a chain, `operator.env` |
| The operator (you) | `API_SECRET` (registers agents, writes any policy), `ADMIN_SECRET` (kill switch, loopback only), the database for `x402:ops`. In the demo: `operator.env` (mode 0600). | — |
| The requester of a job | its own agent key; it sets the job's budget (`reward`) when it creates the job | the payer's key |

The agent's wallet is created by the backend when the agent is registered (`safeAddress`). It pays from **that** wallet: fund it with the USDC it may spend, and no more.

## 3. Where the budget is set: three ceilings

A payment goes through only if it fits **all three**:

1. **The policy** (operator): `maxValuePerTxUsd` per payment and `maxDailyVolumeUsd` per UTC day, across all jobs of the agent. The daily limit is shared with the agent's other transactions of the day (a withdrawal counts too).
2. **The job** (requester): the job's `reward` is the most the provider may spend on that job in total. It cannot be changed after creation (`PATCH /v1/jobs/:id` never writes it); a bigger budget is a new job.
3. **The wallet** (operator): the USDC the wallet holds. The policy does not create money.

`npm run x402:ops -- status --job <id>` shows the job's ceiling as `budget … committed … remaining …`. A refused payment shows which ceiling refused it (`reason:`).

## 4. The reference policy

At registration (operator secret, `POST /v1/agents`):

```json
{
  "name": "buyer-reports",
  "chainIds": [84532],
  "policy": {
    "maxValuePerTxUsd": "0.50",
    "maxDailyVolumeUsd": "3.00",
    "allowedRecipients": ["0xSELLER_PAYTO_ADDRESS"],
    "allowedTokens": ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
    "allowedContracts": []
  }
}
```

```bash
curl -s -X POST "$AGENTFI_API_URL/v1/agents" -H "x-api-key: $API_SECRET" -H 'content-type: application/json' -d @buyer.json
```

The answer contains the agent's API key **once**; give it to the agent and keep nothing else in the agent's environment.

| Field | Reference | Why |
|---|---|---|
| `maxValuePerTxUsd` | the price of the dearest resource you mean to buy (`"0.50"`) | a resource priced above it is refused before anything is signed |
| `maxDailyVolumeUsd` | what the agent may spend in a day (`"3.00"`). **Never `"0"`**: `"0"` means no daily limit, and it also switches off the batch route's check on `approve` calldata | daily ceiling across jobs |
| `allowedRecipients` | the sellers' `payTo` addresses | **an empty list means ANY recipient**: the agent would pay whatever address a resource server names (K2) |
| `allowedTokens` | the USDC contract of the network (Base Sepolia shown) | pay-resource only pays USDC anyway; listing it makes the policy say so |
| `allowedContracts` | `[]` | a listed contract may be called from a batch with any calldata (an `approve` included), and such a call is not counted as an outflow. Note that the agent key can itself fill an empty list (section 1, last row; section 7) |
| `maxOutflowPerTxUsd` | **null**: leave it out at registration; send `"maxOutflowPerTxUsd": null` explicitly when converting an existing agent | null refuses transfers, swaps, deposits, batches with value and A2A payments; setting it opens them |
| `cooldownSeconds` | default (60) | it does not apply to x402 payments (an agent pays several resources in a row); it spaces out what the key may still send (withdrawals, zero-value batches, escrow jobs) |

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; on another network use that network's USDC.

**An existing agent** (registered earlier, or with the defaults): `PATCH /v1/agents/<id>/policy` with the operator secret and every payer field below, because fields you leave out keep their current value. In particular send `"maxOutflowPerTxUsd": null` and `"allowedContracts": []` explicitly: leaving them out would keep an outflow cap or a contract list the agent already has, and transfers or uncounted batch calls would stay open:

```json
{ "maxValuePerTxUsd": "0.50", "maxDailyVolumeUsd": "3.00", "allowedRecipients": ["0xSELLER_PAYTO_ADDRESS"],
  "allowedTokens": ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"], "allowedContracts": [], "maxOutflowPerTxUsd": null,
  "maxValuePerTxEth": "1.0", "cooldownSeconds": 60, "expiresAt": null, "reason": "alpha payer reference" }
```

`active` is left out on purpose: sending `"active": true` with the operator secret would also resume a policy that you (or the kill switch) paused. Resume it separately, deliberately, if that is what you want.

Then run `x402:ops payer` (section 5). The registration defaults (no `policy` in the body) are **not** a payer configuration: `allowedRecipients` is empty, so they pay any recipient up to 1.00 USD per payment and 10 000 USD a day.

**An agent registered before 2026-11-18 without a policy** may have **no policy row at all**, and then every limit reads "no restrictions" (x402 payments of any amount to anyone, transfers, swaps). Write it a policy with the operator secret before it runs (section 7, F2).

## 5. Check the permissions in force

As the operator, from `packages/backend` with the backend's environment (`DATABASE_URL`; in the demo, source `operator.env`):

```bash
npm run x402:ops -- payer --agent <agentId>          # add --json for scripts
```

It reads the agent and its policy row and prints, with the same readings the enforcers use: the per-payment and daily ceilings, the recipients, whether other outflows are refused or capped, whether batch calldata is checked, what the key may change, every finding, and a verdict. For the reference policy:

```text
Agent <id> (buyer-reports) wallet 0x… chains 84532
  policy row: yes
  x402 purchases (pay-resource; also escrow job budgets):
    per payment: <= 0.5 USD
    per day:     <= 3 USD
    recipients:  0xSELLER_PAYTO_ADDRESS
    tokens:      0x036CbD53842c5426634e7929541eC2318f3dCF7e
  other outflows (transfers, swaps, deposits, batches, A2A): REFUSED (maxOutflowPerTxUsd not configured): …
  batch approve / other calldata: REFUSED (approve and other non-transfer calldata need a target listed in allowedContracts)
  withdrawals back to this wallet: allowed (not an outflow), counted against the daily limit, under allowedTokens and the cooldown; they spend ETH on gas
  policy changes: the agent key may only make changes the server counts as tightening (lower caps, a subset of a non-empty list, pause); raising a cap, clearing a list or adding to a non-empty list is 403 with nothing written. Filling an EMPTY list counts as tightening. The operator secret may change anything
  per job: a payment also fits the job's remaining budget (x402:ops status --job <id>); the wallet's USDC balance is the hard ceiling
  findings:
    NOTE    AGENT_CAN_LIST_CONTRACTS: allowedContracts is empty, and the server counts filling an empty list as a tightening: …
  verdict: REFERENCE PAYER — x402 purchases to the listed recipients under both ceilings; transfers, swaps, deposits, batches with value and A2A payments are refused (as of this read).
```

Anything else ends with `verdict: NOT the reference payer (…)` and one line per finding: `NO_POLICY_ROW`, `ANY_RECIPIENT`, `NO_DAILY_LIMIT`, `NO_PER_PAYMENT_CAP`, `OUTFLOWS_OPEN`, `CONTRACT_CALLS_OPEN` (risks), `AGENT_INACTIVE`, `POLICY_PAUSED`, `POLICY_EXPIRED` (every payment refused right now). `NOTE` lines (`ANY_USDC_TOKEN`, `AGENT_CAN_LIST_CONTRACTS`) do not change the verdict. The report is a snapshot of the row: the agent key can still make the changes the server counts as tightening, so run it again before trusting an older result. It does not read the wallet balance or a job's budget (`x402:ops status` does) and cannot see which tools a client shows.

The agent can read the same policy with its own key (`get_policy`, `GET /v1/agents/me`): useful for the agent, not a check, since it is what the agent was told.

## 6. When the operator has to step in

| You see | What it means | What you do |
|---|---|---|
| `failed_before_signing` with a `reason:` such as `… exceeds the policy's per-transaction limit …`, `Daily volume limit of … would be exceeded`, `… not in the agent's allowed recipients whitelist` | a purchase broke the policy; nothing was signed or spent | nothing, or raise the limit / list the seller with `PATCH /v1/agents/<id>/policy` and the operator secret if the purchase was legitimate |
| `failed_before_signing … above the cap of $…` (budget) | the job's budget is used up | a new job with a larger `reward` (the requester), if the work needs it |
| `ACTION:` under a row in `x402:ops status` | money of that row is open and needs you (the line says the command: `x402:ops reconcile --apply`, or `x402:ops resolve … --note …`) | follow the line; the row stays counted until then |
| `delivery:partial` / `not-delivered` on a `money:proven` row | paid, content missing | take it up with the seller; fetching again is a new purchase |
| `x402:ops payer` shows a RISK finding | the policy leaves a way open | fix the policy before the agent runs again |
| the agent misbehaves or its key may have leaked | — | `POST /admin/agents/<id>/pause` (admin secret, loopback) pauses the policy and deactivates the agent. **It is a toggle:** called on an agent that is already inactive (it deactivated itself, or you called it twice) it reactivates it, so check that the answer says the agent is inactive. A payment authorization already signed before the pause can still settle; `x402:ops status` shows it. There is no key-rotation route: register a new agent with the reference policy |
| the wallet runs low | the policy and the job still allow a payment the wallet cannot cover | fund the wallet before the agent runs (`GET /v1/wallet/balance` with the agent's key, or your chain explorer); the policy does not need to change |

## 7. Known items and what they affect

| Item | Affects the x402 payer of the alpha? |
|---|---|
| F1: on the legacy `/v1/transactions/*` routes, caps and lists are read before the row lock, so one request already past validation keeps the previous value if the operator tightens at that moment (payer-authorization.md §3.2) | **No** for x402: `pay-resource` re-reads the whole policy under the Job and Agent locks. It concerns the transfer / swap / DeFi routes only, which the reference policy refuses. |
| F2: agents registered by the operator without a policy before 2026-11-18 have no policy row (no restrictions) | **Yes, if such an agent is used as a payer**: x402 payments are then unbounded by policy. A fresh alpha install has none (every registration path now writes a row). `x402:ops payer` flags it (`NO_POLICY_ROW`); fix with an operator `PATCH` (section 4). |
| F4: the MCP `update_policy` tool description did not mention the first-policy rule | Documentation only (fixed: the description now says a first change is judged against the registration defaults). The server enforced the rule already. |
| An agent key can fill an EMPTY `allowedContracts` (the tighten-only rule reads an empty list as "any contract", as ordinary transactions do; the batch route reads it as "none") | **Yes**: it reopens batch calls to contracts the agent picks, uncounted and not an outflow. The direct effect is limited (a batch runs through the `AgentExecutor`, so an `approve` there is the executor's, not the wallet's), and on the local fork the batch route stops earlier (no `AgentExecutor` deployed). **Owner decision pending:** count empty → non-empty `allowedContracts` as a loosening (operator only). Until then, re-run `x402:ops payer` and watch for `CONTRACT_CALLS_OPEN`. |
