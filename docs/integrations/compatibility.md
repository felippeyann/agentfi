# Compatibility matrix

AgentFi **alpha**, as of **2026-11-16** (branch `feat/2026-11-16-alpha-interop`, from `main` 0173409).
Read the [integration contract](README.md) first; the last section says what this matrix does not claim.

## How to read it

Every row has exactly one status:

| Status | Meaning |
|---|---|
| `tested` | We ran it on 2026-11-16 with the versions, transport and command in the row. "Against" says what was on the other end. |
| `interface-compatible, not tested` | The interface should fit by its documentation; we did not run it. |
| `planned` | Not built or not tried. No date. |
| `incompatible` | Does not work today (and why). |

**Every `tested` row except 7b ran against the STUB API** (`examples/_stub-api/stub-api.mjs`: real-shaped answers,
no budget, no policy, no ledger, no wallet, no chain, nothing paid) **and, where a model is involved,
a scripted stub model.** No row was run against a paid LLM API or with real funds, and, **except row 7b (2026-11-18)**, none was run
against the real backend: the real backend's x402 behaviour is covered by its own tests
and by the fork demo in the alpha quickstart. Row 7b ran against the real local backend with a scripted model (see the row for what is real). Environment of every run: Windows 11,
Node 24.14.1, npm 11.11.0, Python 3.14.3.

## Matrix

| # | Framework / client | Version (as run on 2026-11-16) | Transport | Auth | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | HTTP / OpenAPI, TypeScript (`fetch`) | Node 24.14.1 (engines: >= 20), TypeScript 6.0.3 | HTTP | `x-api-key` header (provider agent key) | `tested` (against STUB) | `cd examples/x402-http-reference/ts && npm install && npm run build && cd .. && node run-stub-demo.mjs`: 10 scenarios plus 2 same-id replays; stub counted no double payment. |
| 2 | HTTP / OpenAPI, Python (`urllib`, stdlib) | Python 3.14.3 (written for >= 3.9) | HTTP | `x-api-key` header | `tested` (against STUB) | same command (`run-stub-demo.mjs` runs both). |
| 3 | MCP client (TypeScript SDK) with the AgentFi MCP server **from the checkout** | `@modelcontextprotocol/sdk` 1.29.0; server `packages/mcp-server` 0.5.0 (35 tools) | stdio | `AGENTFI_API_KEY` / `AGENTFI_API_URL` in the **server's** environment (the server adds `x-api-key` to its backend calls) | `tested` (against STUB) | `npm run build -w packages/mcp-server && node examples/_stub-api/mcp-check.mjs`: lists 35 tools, payer-safe subset present, `pay_for_resource` annotated non-read-only / destructive / non-idempotent, description says unknown outcome => do NOT retry with a new id, settled + same-id replay + `PAYMENT_OUTCOME_UNKNOWN` returned as structured output, 1 paid request each at the stub. |
| 4 | MCP, standalone server in **SSE** mode (`MCP_TRANSPORT=sse`, `/mcp/sse` + `/mcp/messages`) | same server; SDK 1.29.0 SSE client | SSE | `x-api-key` header on the SSE GET and every POST must equal the server's `AGENTFI_API_KEY` (it is a gate; **backend calls use the server's own key from the environment**, not the presented one); 401 otherwise | `tested` (against STUB), with a limit | `node examples/_stub-api/mcp-sse-check.mjs`: 401 without / with a wrong key, 35 tools, `pay_for_resource` settled. **Limit found:** one shared `Server` instance is connected to every SSE transport, so a second concurrent session resets the first (`ECONNRESET`). Use one session per server process. |
| 5 | MCP, backend proxy `GET /mcp/sse` (the API's own SSE route) | API `main` | SSE | `x-api-key` header, bound per session | `incompatible` (for the x402 path) | Source read, not run: 18 DeFi proxy tools (`execute_swap`, `execute_transfer`, Aave, ...), **no `pay_for_resource`**. Not a payer-safe surface for the alpha. |
| 6 | MCP, streamable HTTP | n/a | streamable HTTP | n/a | `incompatible` | Not implemented: `packages/mcp-server/src/index.ts` implements stdio and SSE only (read; `Dockerfile.mcp` runs the SSE server on port 3002). Clients that only speak streamable HTTP cannot connect. |
| 7 | **OpenAI Agents SDK** (Python), MCP, **against the STUB API** | `openai-agents` 0.24.0, `mcp` 2.3.0, `openai` 3.51.0 | stdio (`MCPServerStdio`) | env of the spawned server | `tested` (against STUB, **stub model**) | `python examples/openai-agents/agent.py --mode stub` (see its README): tool filter left exactly 4 tools, 3 `pay_for_resource` calls, structured `PAYMENT_OUTCOME_UNKNOWN`, same-id replay paid nothing. |
| 8 | OpenAI Agents SDK, MCP | same | SSE (`MCPServerSse`, `x-api-key` header) | header gate as in row 4 | `tested` (against STUB, **stub model**) | same script with `--transport sse --mcp-url ...`. The SDK docs mark SSE deprecated for new servers. |
| 7b | **OpenAI Agents SDK** (Python), MCP, **against the REAL LOCAL BACKEND** | `openai-agents` 0.24.0, `mcp` 2.3.0, Python 3.14.3; AgentFi MCP server from the checkout (0.5.0, 35 tools); anvil 1.7.1; Node 24.14.1 | stdio (`MCPServerStdio`) | env of the spawned server (the buyer agent's own key) | `tested` (2026-11-18; **real local backend, scripted model**) | `npm run alpha:framework -- --yes` (quickstart section 10): an allowed 0.30 USDC purchase (tool call -> ledger row `settled`/`money:proven`/`delivery:delivered` -> USDC Transfer log and tx hash on the fork -> wallet -0.30, seller +0.30, committed 0.3 / remaining 4.7) and two blocked purchases (402 `BUDGET_EXCEEDED`, 403 `POLICY_VIOLATION`; ledger `failed_before_signing`, null nonce, zero paid requests at the seller, no Transfer, wallet unchanged); the tool allowlist is asserted to be the payer-safe four. **Real:** the framework, the MCP stdio transport and server, the API and worker, the EIP-3009 signature, the `@x402/evm` exact facilitator, the USDC contract on a local Anvil fork of Base Sepolia. **Stubbed / ours:** the model (a scripted one: no LLM ran), the seller (ours), the chain is a fork (not a public testnet). Windows 11 only. |
| 9 | OpenAI Agents SDK with a **real OpenAI model** | same | stdio / SSE | `OPENAI_API_KEY` (user's) | `interface-compatible, not tested` | `--mode real` exists and is documented; **not run** (no paid API). Model behaviour with the do-not-retry rules is unknown. |
| 10 | **Google ADK** (Python), `McpToolset`, **against the STUB API** | `google-adk[mcp]` 2.14.1, `mcp` 2.3.0, `google-genai` 2.34.0 | stdio (`StdioConnectionParams`) | env of the spawned server | `tested` (against STUB, **stub model**) | `python examples/google-adk/agent.py --mode stub`: `tool_filter` left exactly 4 tools, 3 calls, structured unknown, same-id replay paid nothing. |
| 11 | Google ADK, `McpToolset` | same | SSE (`SseConnectionParams`, `x-api-key` header) | header gate as in row 4 | `tested` (against STUB, **stub model**) | same script with `--transport sse`. |
| 12 | Google ADK with a **real Gemini model** | same | stdio / SSE | `GOOGLE_API_KEY` (user's) | `interface-compatible, not tested` | `--mode real` exists; **not run** (no paid API). |
| 13 | LangChain JS **tools** from `@agent_fi/adapters` (`DynamicStructuredTool`) | `@langchain/core` 1.4.1 | in-process, adapter calls HTTP | `apiKey` option | `tested` (against STUB, tool level only) | `npm run build -w packages/adapters && cd examples/langchain-js && npm install && node check.mjs`: 3 payer-safe tools built and invoked, replay and unknown handled. **No LangChain agent or model was run.** |
| 14 | LangChain / LangGraph **agent** (JS or Python) using those tools or MCP | n/a | n/a | n/a | `planned` | No agent, graph or `langchain-mcp-adapters` run. LangChain Python: nothing built. |
| 15 | Vercel AI SDK (`ai`) | latest on npm today: 7.0.173 | tool calling / MCP client | n/a | `planned` | Not tried. Tool-calling docs read ([source](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)) only. |
| 16 | Claude Desktop, Claude Code (MCP) | n/a | stdio (from the checkout) | `AGENTFI_API_KEY` in the server env | `interface-compatible, not tested` | `npm run demo:claude-mcp` prints a Claude Desktop config for the checkout server ([demo](../demos/claude-desktop-mcp.md)); **not run in this change**. Use the allowlist/permissions of the client to keep admin tools away from a payer. |
| 17 | OpenAI function calling via `@agent_fi/adapters/openai` (plain `tools`) | n/a (no `openai` package dependency) | in-process, adapter calls HTTP | `apiKey` option | `interface-compatible, not tested` | The adapter's logic is unit-tested (`npm test -w packages/adapters`, 28 tests against a local HTTP server: payer-safe set, `paymentId` pass-through, no retry on 502/timeout, verbatim refusals), but no `openai` SDK call and no model was run. |
| 18 | ElizaOS, x402 payer path | n/a | n/a | n/a | `planned` | No `pay_for_resource` action exists. |
| 19 | ElizaOS, legacy DeFi plugin (`packages/adapters/src/eliza.ts`) | no ElizaOS version tried | in-process | `apiKey` option | `interface-compatible, not tested` | Duck-typed against an old action shape; swap action is a stub; **legacy, not part of the alpha path**; not run on any ElizaOS version. |
| 20 | Legacy DeFi tools (swap, transfer, Aave) in the adapters (`legacyDefi: true`) | n/a | in-process | `apiKey` option | `interface-compatible, not tested` | Off by default, outside the alpha path, move funds outside any job budget. `execute_swap` was fixed to send the required `simulationId`; `get_defi_rates` was removed (it returned wallet balances). Not run against a backend. |

## Known gaps behind the matrix

* **Google ADK has no real-backend run yet** (rows 10-12 are stub-only); the OpenAI Agents SDK example is the one wired to the real local backend (row 7b). No row ran with a real LLM or on a public testnet.

* **MCP from npm does not have x402.** `@agent_fi/mcp-server@0.5.0` on npm has 31 tools and no `pay_for_resource`;
  rows 3, 4, 7, 8, 10, 11 and 16 use the build from the checkout. Publishing 0.6.0 is a separate decision.
* **SSE is single-session** (row 4). **There is no streamable HTTP** (row 6).
* **The OpenAPI status enum** (`ResourcePaymentStatus`) does not list `expired`, which the reconcile worker
  can set; clients must treat an unknown status as uncertain (the reference clients do).
* **No payment-status read endpoint**: state comes from the `pay-resource` answer (re-ask with the same
  `paymentId`) or the operator's `x402:ops status`.
* **Tool-level hardening is client-side.** The MCP server registers 35 tools, including `update_policy`
  (tighten-only), `update_job_status`, `post_job`, `pay_agent`, `transfer_token`, `execute_swap`. The payer-safe
  subset is an allowlist applied by the client; the backend's budget and policy checks are the real guard.

## Reproduce

```bash
npm install
npm run build -w packages/mcp-server -w packages/adapters
node examples/_stub-api/mcp-check.mjs                 # row 3
node examples/_stub-api/mcp-sse-check.mjs             # row 4
node examples/x402-http-reference/run-stub-demo.mjs   # rows 1-2 (build ts/ first, see its README)
# rows 7-8, 10-11: examples/openai-agents and examples/google-adk (a venv per README)
# row 7b (real local backend; needs Postgres, Redis, anvil 1.7.1 and the quickstart section 10 setup): npm run alpha:framework -- --yes
# row 13: examples/langchain-js
npm test -w packages/adapters                         # row 17 (logic only)
```
