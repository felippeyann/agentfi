# @agent_fi/adapters

Thin TypeScript adapters that translate an LLM tool call into one AgentFi HTTP call.
**Alpha.** Not published to npm: build it from this repository.

```bash
npm install                                  # at the repo root
npm run build -w packages/adapters           # emits packages/adapters/dist
npm test -w packages/adapters                # 23 unit tests, no network, no LLM
```

> Prefer the **MCP server** (`packages/mcp-server`, built from the checkout) or the plain
> **HTTP API** when your framework supports either: they are the maintained, tested
> interfaces. See [`docs/integrations/`](../../docs/integrations/README.md) and the
> [compatibility matrix](../../docs/integrations/compatibility.md). These adapters exist for
> code that calls a model with OpenAI-style `tools` or builds LangChain tools by hand.

## What it is, and what it is not

* **Thin.** One tool call is one HTTP request. No retries, no budget math, no policy
  checks. The AgentFi backend enforces the budget, the agent policy, idempotency and
  reconciliation.
* **Payer-safe by default.** The default tool set is `agentfi_pay_for_resource` plus two
  read-only tools. There is no tool that approves, rejects, pauses, edits a policy or a
  budget, resolves a job, reconciles a payment or registers an agent. Those are operator
  actions; do not add them to the paying agent.
* **Identity = API key.** `apiKey` is the agent's key. For x402 buying it must be the key of
  the job's **provider** agent (the payer), never the requester's or the operator's.

## Configuration

```typescript
const config = {
  apiKey: process.env.AGENTFI_API_KEY!,           // payer agent key (identity)
  apiUrl: process.env.AGENTFI_API_URL,            // an AgentFi API you run; default http://localhost:3000
  timeoutMs: 60_000,                              // optional, per request
};
```

There is **no hosted AgentFi API** to default to. The old default
`https://agentfi-backend.fly.dev` was decommissioned (2026-05-17) and has been removed.
Run the API yourself: [Dev Quickstart](../../docs/dev-quickstart.md).

## OpenAI function calling

```typescript
import { getAgentFiTools, handleAgentFiToolCall } from '@agent_fi/adapters/openai';

const tools = getAgentFiTools();                  // pass to chat.completions.create({ tools })

// For each tool_call returned by the model:
const result = await handleAgentFiToolCall(call.function.name, call.function.arguments, config);
// `result` is a JSON string: send it back as the `tool` message.
```

## LangChain (JS)

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentFiToolkit } from '@agent_fi/adapters/langchain';

const tools = new AgentFiToolkit(config).getToolFields().map((f) => new DynamicStructuredTool(f));
```

`getToolFields()` returns `{ name, description, schema (JSON Schema), func }`. The package
has no LangChain dependency. (`getTools()`, the old duck-typed shape, is kept for old callers.)

## Tools

| Tool | Tier | Maps to |
|---|---|---|
| `agentfi_pay_for_resource` | alpha | `POST /v1/jobs/{id}/pay-resource` |
| `agentfi_get_job` | alpha, read-only | `GET /v1/jobs/{id}` |
| `agentfi_get_wallet_info` | alpha, read-only | `GET /v1/wallet/balance` |
| `agentfi_simulate_swap`, `agentfi_execute_swap`, `agentfi_transfer_token`, `agentfi_deposit_aave`, `agentfi_get_transaction_status` | **legacy**, opt-in with `legacyDefi: true` | `/v1/transactions/*` |

The legacy DeFi tools are **not part of the alpha path**: they move funds outside any job
budget and are not covered by the x402 guarantees. They are off by default and kept only so
existing users are not broken. (`agentfi_get_defi_rates` was removed: it was wired to the
wallet-balance endpoint and returned balances labelled as rates.)

### `agentfi_pay_for_resource`

Arguments: `job_id`, `url` (required); `method`, `body`, `max_amount` (USDC cap, e.g. `"0.50"`),
`payment_id` (idempotency key, 16-128 chars of `[A-Za-z0-9_-]`).

* The adapter **passes `payment_id` through**; if omitted it generates one and returns it as
  `paymentId`, so a timeout can be answered with "reuse this id".
* The result is the backend body **verbatim**, plus `httpStatus` and, for the states that need
  it, a `guidance` sentence. Payment and delivery stay separate: `payment.status` is the money
  (`settled`, `unknown`, ...); `resource.status` / `resource.truncated` is what arrived.
* **Never retried.** A `502 PAYMENT_OUTCOME_UNKNOWN`, any 5xx, or a client timeout (reported
  as `CLIENT_OUTCOME_UNKNOWN` with `httpStatus: null`) means the money may have moved. The
  guidance tells the model not to retry with a new `payment_id`; calling again with the **same**
  id only returns the recorded state and never pays twice. The operator/worker reconciles.
* Budget, policy and recipient checks are the backend's. A `402 BUDGET_EXCEEDED` or
  `403 POLICY_VIOLATION` comes back as data and nothing was signed.

## Per-file audit (2026-11-16, against `docs/api/openapi.yaml`)

| File | Verdict | Notes |
|---|---|---|
| `client.ts` | ready | Dead default URL removed (default `http://localhost:3000`); one request, no retry; non-2xx keeps status and body. |
| `pay-resource.ts` (new) | ready | 1:1 with `pay-resource`; unit-tested incl. no-retry and timeout. Not exercised against a real backend by this package (see the compatibility matrix). |
| `tools.ts` (new) | ready | Catalog shared by OpenAI and LangChain shapes; payer-safe default. |
| `openai.ts` | ready (alpha tools); legacy tools opt-in | Function-calling shape only; no OpenAI SDK dependency, not run against a live model. |
| `langchain.ts` | ready as field objects; not an AgentExecutor drop-in | The old class returned duck-typed objects, not LangChain tools; the README's `getAgentFiLangChainTools` never existed. |
| `eliza.ts` | **legacy, untested** | Swap action is a stub; rates query a retired third-party hosted service; no x402; not run on any ElizaOS version. |
| legacy DeFi tools | **legacy** | `execute_swap` previously dropped the required `simulationId` (broken); fixed. `defi_rates` removed (misrouted). |

## License

[Apache 2.0](../../LICENSE)
