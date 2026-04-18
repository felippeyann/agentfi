# AgentFi Example — Delegation Chain

Three agents **cascading work** to each other through the A2A job queue. This is the coordination substrate underneath the agent-to-agent economy described in [`VISION.md`](../../VISION.md):

> *"Agent A needs a market analysis. Agent B produces one. Agent A pays Agent B 0.002 ETH. The transaction completes in seconds. No invoice. No accounts payable. No 30-day net terms. Just atomic value exchange between two minds that found each other useful."*

This example shows the **coordination half** of that claim (without the payment half, so it runs on the zero-credential dev stack). The payment half is a one-line change to any `createJob()` call — documented at the bottom of the output.

## Scenario

```
Alice (researcher)
  │
  ▼
  Bob (data specialist) ── accepts top-level job
  │
  ▼
  Charlie (sentiment spec) ── sub-hired by Bob
  │
  └─> returns sentiment analysis
      │
      ▼
  Bob synthesizes data + sentiment
      │
      ▼
  Alice receives final report
```

1. Alice needs a 24h BTC market report
2. Alice creates a job hiring Bob
3. Bob accepts → realizes he needs sentiment data → sub-hires Charlie
4. Charlie returns sentiment
5. Bob synthesizes and returns the full report to Alice
6. Trust reports for all three are inspected

## Run

### Against the dev stack (default)

```bash
# Terminal 1
docker compose -f docker-compose.dev.yml up --build

# Terminal 2
node examples/delegation-chain/index.mjs
```

### Against your own instance

```bash
AGENTFI_API_URL=https://api.your-instance.com \
AGENTFI_OPERATOR_SECRET=<your API_SECRET> \
node examples/delegation-chain/index.mjs
```

## Expected output (abbreviated)

```
[1] Register three agents with distinct specialties
[1] Alice   (researcher)       = clx...
[1] Bob     (data specialist)  = clx...
[1] Charlie (sentiment spec)   = clx...
[2] All three publish service manifests
[3] Alice opens top-level job with Bob: "24h BTC report"
[3] Top-level job clx... (status=PENDING)
[4] Bob accepts and sees he needs sentiment input → sub-delegates to Charlie
[4] Sub-job clx... created (bob.id → charlie.id)
[5] Charlie accepts and completes with sentiment data
[5] Charlie delivered: { sentimentIndex: 0.42, ... }
[6] Bob composes the final report combining his data + Charlie's sentiment
[6] Top-level job completed.
[7] Trust reports (reputation scores recompute nightly at 02:00 UTC)
       Alice  : reputation=0, a2a-tx=1, lastActive=...
       Bob    : reputation=0, a2a-tx=2, lastActive=...
       Charlie: reputation=0, a2a-tx=1, lastActive=...

✓ Delegation chain completed.
```

Reputation stays at 0 on first run — scores are recomputed by the daily cron. Trigger manually via `POST /admin/reputation/recompute`.

Notice Bob's `a2a-tx=2` — he was on both sides (provider for Alice, requester for Charlie).

## Making it economic (the self-sustaining loop)

Add a `reward` field to any `createJob()` and the payment half fires automatically on `COMPLETED`:

```js
const subJob = await createJob(bob.apiKey, charlie.id, {
  task: 'sentiment-analysis',
  // ...
  reward: { amount: '0.005', token: 'ETH', chainId: 8453 },
});
```

On completion, the backend:

1. Runs the full policy + simulation + fee pipeline (same as any public tx)
2. Enqueues the signed tx in BullMQ
3. Worker signs via Turnkey MPC → broadcasts via Alchemy
4. Monitor polls for receipt
5. `FeeEvent` is recorded
6. Protocol fee is collected atomically on-chain via `AgentExecutor`
7. `/v1/agents/me/pnl` now shows real earnings/costs for each agent

This requires on the backend:
- `WALLET_PROVIDER=turnkey` + the three `TURNKEY_*` vars
- `ALCHEMY_API_KEY=<yours>`
- Protocol contracts deployed on the target chain (Base Mainnet has them preconfigured)

At that point, the scenario described above is no longer a coordination demo — it's a **working three-agent economy** with atomic on-chain settlement at every hop.

## Files

| File | Purpose |
|---|---|
| `index.mjs` | The example — ~180 lines, Node 22 native fetch, zero deps |
| `package.json` | Minimal ESM marker |
| `README.md` | This file |
