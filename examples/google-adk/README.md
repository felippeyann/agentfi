# AgentFi x Google ADK (Python, `McpToolset`)

A payer agent built with [Google ADK](https://adk.dev/tools-custom/mcp-tools/) (Agent Development Kit)
that talks to AgentFi through the MCP server **built from this checkout**, restricted to the
**payer-safe tool subset** with `tool_filter`.

| | Pinned, as run on 2026-11-16 |
|---|---|
| `google-adk[mcp]` | **2.14.1** (PyPI latest that day; the `[mcp]` extra provides `McpToolset`) |
| `mcp` (pulled in) | 2.3.0 |
| `google-genai` (pulled in) | 2.34.0 |
| Python | 3.14.3 (what we ran; ADK docs: 3.10+) |
| AgentFi MCP server | this checkout (`packages/mcp-server`, 0.5.0 in `package.json`, 35 tools). **npm `@agent_fi/mcp-server@0.5.0` has no `pay_for_resource`: build from the checkout.** |

## What is real and what is stubbed

| Piece | Stub mode (`--mode stub`, default) | Real mode (`--mode real`) |
|---|---|---|
| ADK `LlmAgent`, `InMemoryRunner`, `McpToolset` (stdio / SSE), `tool_filter` | real | real |
| AgentFi MCP server (stdio, from `dist/`) | real | real |
| AgentFi **API** behind the MCP server | **STUB** ([`../_stub-api`](../_stub-api/stub-api.mjs)): no wallet, no chain, nothing paid | your own AgentFi API |
| The model | **scripted** `BaseLlm` subclass (3 fixed tool calls, then a message). No Gemini, no key, no cost | Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) with **your** `GOOGLE_API_KEY`. **Not run by the AgentFi maintainers.** |

Stub mode proves the *plumbing* (filtering, tool call, structured results, same-id replay), not
that any model behaves well.

## Run the stub mode

```bash
# at the repo root
npm install && npm run build -w packages/mcp-server
node examples/_stub-api/stub-api.mjs --port 3000 &          # the STUB API (key: agfi_stub_not_a_secret)

python -m venv .venv && . .venv/bin/activate                 # Windows: .venv\Scripts\activate
pip install -r examples/google-adk/requirements.txt
AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=agfi_stub_not_a_secret \
  python examples/google-adk/agent.py --mode stub
```

Recorded output (Windows 11, Python 3.14.3, google-adk 2.14.1, 2026-11-16):

```
[tools exposed to the agent] ['get_job', 'get_my_agent_profile', 'get_policy', 'pay_for_resource']
[tool call] pay_for_resource {"job_id": "job_stub_1", "url": "http://stub-seller.example/settled", "payment_id": "adk-stub-settled-0000001"}
[tool result] code=None payment.status=settled replayed=None
[tool call] pay_for_resource {"job_id": "job_stub_1", "url": "http://stub-seller.example/unknown", "payment_id": "adk-stub-unknown-0000001"}
[tool result] code=PAYMENT_OUTCOME_UNKNOWN payment.status=unknown replayed=None
[tool call] pay_for_resource {... "payment_id": "adk-stub-unknown-0000001"}        <- same id: replay
[tool result] code=None payment.status=unknown replayed=True
[final] [stub model] purchases done. Payment states / codes in order (money only; delivery is separate): ['settled', 'PAYMENT_OUTCOME_UNKNOWN', 'unknown']. ...
stub counters: {"paidRequests":{"/settled":1,"/unknown":1}}                         <- the replay paid nothing
```

(ADK prints "Skipping missing token usage metadata" lines in stub mode: the scripted model reports no token usage.)
`--transport sse --mcp-url http://127.0.0.1:3002/mcp/sse` was also run (`SseConnectionParams` with the
`x-api-key` header) against the standalone server started with `MCP_TRANSPORT=sse`. ADK also has
`StreamableHTTPConnectionParams`, but AgentFi's standalone server does **not** implement streamable HTTP.

## Real mode (yours to run, not run by us)

```bash
export GOOGLE_API_KEY=...        # yours; costs tokens
python examples/google-adk/agent.py --mode real --prompt "Buy <url> for job <id>"
```

Point `AGENTFI_API_URL` / `AGENTFI_API_KEY` at an API you run, with the **provider** agent's key. A real-backend run is not reproducible outside the alpha demo today. Everything marked tested ran against the STUB. See [docs/alpha/quickstart.md](../../docs/alpha/quickstart.md) for the limits. Never put keys
in the source. `McpToolset(require_confirmation=True)` makes a human confirm each tool call (needs a
UI that handles confirmations; left commented out in `agent.py`).

## Why only four tools

The MCP server registers 35 tools: `update_policy`, `update_job_status`, `post_job`, `pay_agent`,
`transfer_token`, `execute_swap`, ... A buyer agent needs `pay_for_resource`, `get_job`, `get_policy`
and `get_my_agent_profile`. `tool_filter=[...]` is an allowlist enforced client-side, so the model
cannot see or call anything else; the assertion in `agent.py` fails if the filter drifts. The real
guard is still the backend: it enforces budget and policy before signing.
