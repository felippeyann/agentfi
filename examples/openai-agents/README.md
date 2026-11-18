# AgentFi x OpenAI Agents SDK (Python, via MCP)

A payer agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/mcp/)
that talks to AgentFi through the MCP server **built from this checkout**, restricted to the
**payer-safe tool subset**.

| | Pinned, as run on 2026-11-16 |
|---|---|
| `openai-agents` | **0.24.0** (PyPI latest that day) |
| `mcp` (pulled in) | 2.3.0 |
| Python | 3.14.3 (what we ran; the SDK's docs state no minimum) |
| AgentFi MCP server | this checkout (`packages/mcp-server`, 0.5.0 in `package.json`, 35 tools). **npm `@agent_fi/mcp-server@0.5.0` has no `pay_for_resource`: build from the checkout.** |

## What is real and what is stubbed

| Piece | Stub mode (`--mode stub`, default) | Real mode (`--mode real`) |
|---|---|---|
| Agents SDK, `MCPServerStdio` / `MCPServerSse`, tool filter | real | real |
| AgentFi MCP server (stdio, from `dist/`) | real | real |
| AgentFi **API** behind the MCP server | **STUB** ([`../_stub-api`](../_stub-api/stub-api.mjs)): no wallet, no chain, nothing paid | your own AgentFi API |
| The model | **scripted** `Model` subclass (3 fixed tool calls, then a message). No LLM, no OpenAI key, no cost | OpenAI model of your choice (`OPENAI_MODEL`, default `gpt-4.1-mini`) with **your** `OPENAI_API_KEY`. **Not run by the AgentFi maintainers.** |

Stub mode proves the *plumbing* (filtering, tool call, structured results, same-id replay), not
that any model behaves well. Tracing is disabled in stub mode (it would call the OpenAI backend).

## Run the stub mode

```bash
# at the repo root
npm install && npm run build -w packages/mcp-server
node examples/_stub-api/stub-api.mjs --port 3000 &          # the STUB API (key: agfi_stub_not_a_secret)

python -m venv .venv && . .venv/bin/activate                 # Windows (Git Bash): . .venv/Scripts/activate
pip install -r examples/openai-agents/requirements.txt
AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=agfi_stub_not_a_secret \
  python examples/openai-agents/agent.py --mode stub
```

Recorded output (Windows 11, Python 3.14.3, openai-agents 0.24.0, 2026-11-16; tool results trimmed):

```
[tools exposed to the agent] ['get_policy', 'get_my_agent_profile', 'get_job', 'pay_for_resource']
[tool call] pay_for_resource {"job_id": "job_stub_1", "url": "http://stub-seller.example/settled", "payment_id": "oa-stub-settled-0000001"}
[tool call] pay_for_resource {"job_id": "job_stub_1", "url": "http://stub-seller.example/unknown", "payment_id": "oa-stub-unknown-0000001"}
[tool result] {"paid": false, "httpStatus": 502, "paymentId": "oa-stub-unknown-0000001", "code": "PAYMENT_OUTCOME_UNKNOWN", ...
[tool call] pay_for_resource {... "payment_id": "oa-stub-unknown-0000001"}        <- same id: replay
[final] [stub model] purchases done. Payment states / codes in order (money only; delivery is separate): ['settled', 'PAYMENT_OUTCOME_UNKNOWN', 'unknown']. ...
stub counters: {"paidRequests":{"/settled":1,"/unknown":1}}                          <- the replay paid nothing
```

`--transport sse --mcp-url http://127.0.0.1:3002/mcp/sse` was also run against the standalone
server started with `MCP_TRANSPORT=sse` (the SDK marks SSE as deprecated for new servers;
AgentFi's standalone server implements stdio and SSE, **not** streamable HTTP).

## Against the real local backend (scripted model; run 2026-11-18)

```bash
python3 -m venv .venv && .venv/bin/pip install -r examples/openai-agents/requirements.txt   # Windows (Git Bash, what was run): python -m venv .venv && .venv/Scripts/pip ...
ALPHA_PYTHON=.venv/bin/python X402_DEMO_DATABASE_URL=<private test db> X402_DEMO_REDIS_URL=<private redis db> npm run alpha:framework -- --yes      # Windows: ALPHA_PYTHON=.venv/Scripts/python.exe
```

`--backend env-file --env-file <agent.env> --scenario allowed|blocked` reads the API URL, the buyer agent's key, job ids and seller URL that `npm run alpha:serve` writes; the driver `npm run alpha:framework` starts the backend, runs both scenarios and checks ledger, chain and seller. Real: this SDK, the MCP stdio server, the API, worker, EIP-3009 signature, `@x402/evm` facilitator, USDC on a local Anvil fork. Not real: the model (scripted), the seller (ours), the chain (a fork). It WIPES the database and Redis DB you point it at. Details and expected output: [docs/alpha/quickstart.md](../../docs/alpha/quickstart.md) section 10.

## Real mode (yours to run, not run by us)

```bash
export OPENAI_API_KEY=...        # yours; costs tokens
python examples/openai-agents/agent.py --mode real --prompt "Buy <url> for job <id>"
```

Point `AGENTFI_API_URL` / `AGENTFI_API_KEY` at an API you run, with the **provider** agent's key. The scripted model against the REAL LOCAL BACKEND of the fork demo is the section above. See [docs/alpha/quickstart.md](../../docs/alpha/quickstart.md) for the limits. Never put keys
in the source. Consider `require_approval={"always": {"tool_names": ["pay_for_resource"]}}` on the
MCP server object and handle approvals in your app, so a human confirms each spend.

## Why only four tools

The MCP server registers 35 tools: `update_policy`, `update_job_status`, `post_job`, `pay_agent`,
`transfer_token`, `execute_swap`, ... A buyer agent needs `pay_for_resource`, `get_job`, `get_policy`
and `get_my_agent_profile`. The allowlist (`create_static_tool_filter`) is enforced client-side, so
the model cannot see or call anything else; the assertion in `agent.py` fails if the filter drifts.
The real guard is still the backend: it enforces budget and policy before signing.
