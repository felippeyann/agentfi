# AgentFi x LangChain JS (tools only)

Builds real `DynamicStructuredTool`s from [`@agent_fi/adapters`](../../packages/adapters/README.md)
and invokes them against the **STUB** API ([`../_stub-api`](../_stub-api/stub-api.mjs): nothing
paid). No LLM, no key.

| | Pinned (2026-11-16) |
|---|---|
| `@langchain/core` | 1.4.1 |
| Node | 24.14.1 (engines: >= 20) |

```bash
npm install && npm run build -w packages/adapters       # at the repo root
cd examples/langchain-js && npm install && node check.mjs
```

**What this does and does not show.** It shows that the adapter's tool objects are accepted by
LangChain's `DynamicStructuredTool` (JSON Schema `schema`, `func`) and that invoking them calls the
API once, passes the `paymentId`, and returns the backend answer plus do-not-retry guidance. It does
**not** run a LangChain agent, LangGraph graph or any model: the agent-level behaviour is *not
tested*.
