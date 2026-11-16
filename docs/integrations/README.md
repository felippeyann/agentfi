# Integrating an agent framework with AgentFi

**Status: alpha.** AgentFi is a headless layer for companies that run buyer agents: rules go in,
the agent buys over x402, the budget is respected, payment and delivery are tracked
separately, and uncertain operations are reconciled. This page is the contract an
integration must keep. What has actually been run, and where, is in the
[compatibility matrix](compatibility.md).

## Pick the thinnest interface

1. **HTTP / OpenAPI** ([`docs/api/openapi.yaml`](../api/openapi.yaml)): the contract. Reference clients:
   [`examples/x402-http-reference`](../../examples/x402-http-reference/README.md) (TypeScript, Python).
2. **MCP** ([`packages/mcp-server`](../../packages/mcp-server/README.md)): the same tools over MCP for
   frameworks that speak it. Built from the checkout until a release exists (npm
   `@agent_fi/mcp-server@0.5.0` predates x402: it has no `pay_for_resource`).
3. **Thin adapters** ([`packages/adapters`](../../packages/adapters/README.md)): only when a framework
   needs OpenAI-style `tools` or hand-built LangChain tools and cannot use MCP.

We do not ship per-framework SDKs. An integration only translates a call; it must not
re-implement a rule.

## The integration contract

| Property | What an integration must do |
|---|---|
| **Identity** | The agent API key (`x-api-key`) **is** the agent's identity. A payer agent uses its own key, passed through the environment or a secret store, never in source, prompts or logs. x402 buying is job-scoped: the key must be the job's **provider** agent (`POST /v1/jobs/{id}/pay-resource`; the requester gets `403 NOT_PROVIDER`). Never give the payer the operator secret. |
| **Scope** | Expose the **payer-safe tool set** only: `pay_for_resource`, `get_job`, `get_policy`, `get_my_agent_profile` (MCP names). No tool that approves or rejects transactions, pauses or resumes agents, edits or syncs a policy (even a "tighten-only" one), changes a budget, closes or resolves jobs, reconciles payments or registers agents. Those are operator actions. Filter on the client (MCP tool allowlist); the server registers more tools than a payer needs. |
| **Budget and policy** | Enforced by the AgentFi backend, **before anything is signed**: remaining job reward (reward minus counted payments), the caller's own `maxAmount`, and the provider's policy (per-payment cap, daily volume, allowed tokens and payees). An integration must not compute, cache or pre-check them, and must treat `402 BUDGET_EXCEEDED` / `403 POLICY_VIOLATION` as final answers. |
| **Idempotency** | Every purchase has a `paymentId` (16-128 chars of `[A-Za-z0-9_-]`, unique per job). Generate it once per purchase **before the first request**, keep it, and reuse it on every retry of that purchase. The same id never pays twice: it returns the recorded state (`replayed: true`, `resource: null`). |
| **Uncertain states** | `502 PAYMENT_OUTCOME_UNKNOWN`, a payment with status `unknown`, `pending` or `reserved`, a client timeout, or any 5xx after the request left: **the money may have moved.** Do not start a new purchase, do not use a new `paymentId`, do not try another URL for the same goal. Surface the state to the user or agent verbatim. The worker reconciles `unknown` rows against the chain; only an operator resolves what it cannot prove. Re-asking with the **same** id is always safe. |
| **Payment vs delivery** | `payment.status` is the money; `resource.status` and `resource.truncated` are what arrived (the body is read up to 64 KiB). Settled and truncated means *paid, partially delivered*: fetching again is a new purchase. |
| **Timeouts** | Set a client timeout long enough for the resource (the backend has its own). A client timeout is **not** a failed payment: report it as unknown and keep the `paymentId`. |
| **No automatic retries** | HTTP clients, framework retry middleware and agent "retry on error" loops must be off for `pay-resource`. MCP clients should honour the tool annotation `idempotentHint: false` / `destructiveHint: true`. |
| **Secrets** | No key, token or private key in examples, prompts, tool results or logs. Keys travel in the `x-api-key` header, never in a URL (the API refuses `?apiKey=`). |

## Tool descriptions are part of the contract

The model reads them. `pay_for_resource` must keep saying that an unknown outcome is **not**
retried with a new id. When you wrap it, keep that sentence (the adapters do) and add the
`paymentId` to every result so the model can quote it.

## What we do not claim

* **Not universal compatibility.** MCP is a protocol, not a guarantee: a client that lists the
  tools may still mis-handle structured refusals, timeouts or approvals. Only the rows marked
  `tested` in the [matrix](compatibility.md) were executed, in the versions and transports named there.
* **Not "any framework".** Nothing here was tried on a framework that is not in the matrix.
  `interface-compatible, not tested` means the interface should fit, nothing more.
* **Not a model evaluation.** Stub-model runs check the wiring (filtering, calls, replay), not how
  any real model behaves with real money. No paid LLM API was used for any `tested` row.
* **Not production readiness.** Alpha. The x402 path is proven on a local Anvil fork of Base
  Sepolia, not on a public network, and not with real funds. There is no hosted AgentFi API.
* **Not a stable API.** Names and shapes may change before a release; pin versions.
