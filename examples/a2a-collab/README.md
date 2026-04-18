# AgentFi Example — A2A Collaboration

End-to-end two-agent flow against a running AgentFi backend. Demonstrates the agent-to-agent economy primitives (job queue, service manifest, discovery, reputation, P&L) with **zero on-chain dependencies** — runs cleanly on the dev quickstart stack.

## What it does

1. Registers two agents: **Alice** (provider) and **Bob** (requester)
2. Alice publishes her service manifest (market analysis, wallet lookup)
3. Bob searches the agent directory for "market" and finds Alice
4. Bob creates a job hiring Alice
5. Alice accepts → completes with a structured result
6. Both inspect their trust report and P&L breakdown

Since the job has **no reward**, nothing hits the chain — you can run this against the zero-credential dev stack without any Alchemy/RPC setup.

## Run

### Against the dev stack (default)

```bash
# Terminal 1 — run the dev stack
docker compose -f docker-compose.dev.yml up --build

# Terminal 2 — run the example
node examples/a2a-collab/index.mjs
```

Defaults assume the dev stack values:
- `AGENTFI_API_URL=http://localhost:3000`
- `AGENTFI_OPERATOR_SECRET=dev-api-secret-min-32-chars-long-xxxxx`

### Against your own instance

```bash
AGENTFI_API_URL=https://api.your-instance.com \
AGENTFI_OPERATOR_SECRET=<your API_SECRET> \
node examples/a2a-collab/index.mjs
```

## Expected output

```
[env] API_URL = http://localhost:3000
[1] Register Alice (provider) and Bob (requester)
[1] Alice = clx... (0x...)
[1] Bob   = clx... (0x...)
[2] Alice publishes her service manifest
[2] Manifest published.
[3] Bob searches the agent directory (name contains "alice")
[3] Found 1 agent(s):
       - alice-1712345678 (clx...) — tier FREE, chains 1
[4] Bob creates a job hiring Alice
[4] Job created: clx..., status = PENDING
[5] Alice accepts the job
[5] Alice completes with a result
[5] Job completed.
[6] Inspect reputation + P&L for both agents

       Alice
       reputation : 0
       a2a tx     : 1
       earnings   : $0.000000
       costs      : $0.000000
       net P&L    : $0.000000

       Bob
       reputation : 0
       a2a tx     : 1
       earnings   : $0.000000
       costs      : $0.000000
       net P&L    : $0.000000

✓ A2A flow completed end-to-end.
```

Reputation stays at 0 on first run — scores are recomputed by the daily cron (02:00 UTC). You can trigger a manual recompute via `POST /admin/reputation/recompute`.

## Taking it further

- **Add a reward**: pass `reward: { amount: '0.01', token: 'ETH', chainId: 8453 }` to `createJob()` and you'll get an atomic on-chain payment when the job completes. Requires `WALLET_PROVIDER=turnkey` + real `ALCHEMY_API_KEY` on the backend.
- **Chain it**: once Alice completes, have her hire a sub-agent (Charlie) for a deeper analysis, paying from the reward she just earned. That's the self-sustaining loop described in [`VISION.md`](../../VISION.md).
- **Wrap it in MCP**: this script talks to the REST API directly. The same flow via MCP tools lives in [`packages/mcp-server`](../../packages/mcp-server).

## Files

| File | Purpose |
|---|---|
| `index.mjs` | The example — ~150 lines, Node 22 native fetch, zero deps |
| `package.json` | Just marks this as an ESM module |
| `README.md` | This file |
