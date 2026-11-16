# STUB AgentFi API (for the integration examples only)

**This is not AgentFi.** It signs nothing, pays nothing and has no budget, policy, ledger or
chain. It exists so the examples and checks in `examples/` and `docs/integrations/` can run
with no credentials, no funds and no LLM.

`stub-api.mjs` replays responses shaped like `docs/api/openapi.yaml` for
`POST /v1/jobs/{id}/pay-resource` (outcome chosen by the URL **path**: `/settled`, `/partial`,
`/free`, `/budget`, `/policy`, `/in-progress`, `/outstanding`, `/refused`, `/unknown`), plus
minimal `GET /v1/jobs/{id}`, `/v1/agents/me`, `/v1/wallet/balance`. It requires the dummy header
`x-api-key: agfi_stub_not_a_secret` (not a secret). Like the real backend it is idempotent per
`paymentId` (replay: `200`, `replayed: true`, `resource: null`), and `GET /__stub/stats` exposes
how many *paid* requests each path saw.

| File | Does |
|---|---|
| `stub-api.mjs` | the stub (`node stub-api.mjs --port 3000`, or `import { startStub }`) |
| `mcp-check.mjs` | MCP **stdio** check of the server built from this checkout against the stub: tools, payer-safe subset, annotations, `pay_for_resource` replay/uncertain |
| `mcp-sse-check.mjs` | MCP **SSE** check (auth 401s, tools, pay call, and what a second concurrent session does) |

```bash
npm install && npm run build -w packages/mcp-server
node examples/_stub-api/mcp-check.mjs
node examples/_stub-api/mcp-sse-check.mjs
```

When the real backend's answer shapes change, update the stub with them (the OpenAPI spec is the source).
