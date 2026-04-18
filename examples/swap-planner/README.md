# AgentFi Example — Swap Planner

Shows the **DeFi planning pipeline** end-to-end — agent registration with a policy, Uniswap V3 calldata construction, pre-broadcast simulation — without any transaction actually hitting chain.

Runs cleanly on the zero-credential dev stack. Graduates to real execution by switching the last endpoint (same body).

## What it does

1. Registers an agent on **Base Mainnet** with a strict policy:
   - `maxValuePerTxEth: 0.5`
   - `maxDailyVolumeUsd: 1000`
   - Only Uniswap V3 router is allowed
   - Only USDC + WETH are whitelisted tokens
2. Inspects the agent record to show the policy is live in the DB
3. Simulates a swap of **10 USDC → WETH** on Base via Uniswap V3
4. Prints the simulation result (success, gas estimate, simulation ID)

**No funds move. Nothing is broadcast.** This is the planning pipeline, which is what a well-behaved agent runs *before* committing to any transaction.

## Why it works on the dev stack

Three graceful degradations:

- `fromToken` is USDC Base, which is in the backend's `KNOWN_DECIMALS` map → decimals resolve without an on-chain `decimals()` call (no RPC needed)
- Tenderly gracefully degrades when unconfigured — simulator returns `{ success: true, simulationId: 'mock_...', _isMock: true }`
- `WALLET_PROVIDER=local` handles the wallet layer without Turnkey

## Run

### Against the dev stack (default)

```bash
# Terminal 1
docker compose -f docker-compose.dev.yml up --build

# Terminal 2
node examples/swap-planner/index.mjs
```

### Against your own instance

```bash
AGENTFI_API_URL=https://api.your-instance.com \
AGENTFI_OPERATOR_SECRET=<your API_SECRET> \
node examples/swap-planner/index.mjs
```

## Expected output

```
[env] API_URL = http://localhost:3000
[1] Register an agent with a strict policy on Base
[1] Agent clx... provisioned
[1]   wallet address: 0x...
[1]   tier:           FREE
[1]   max per tx:     0.5 ETH
[1]   allowed router: Uniswap V3 (0x2626664c2603336E57B271c5C0b26F421741e481)
[2] Inspect the agent record (policy lives in DB, checked off-chain)
       chains:           [ 8453 ]
       tier:             FREE
       policy:           { maxValuePerTxEth: '0.5', ... }
       allowedContracts: [ '0x2626...e481' ]
       allowedTokens:    [ '0x8335...2913', '0x4200...0006' ]
[3] Simulate swap: 10 USDC → WETH on Base via Uniswap V3
[3] Simulation result:
       success:       true
       gasEstimate:   100000
       gasPrice:      1000000000
       simulationId:  mock_1713477600000
       note         : mocked result — set TENDERLY_ACCESS_KEY+ACCOUNT+PROJECT for real simulations

✓ Planning pipeline completed.
```

## Graduating to real execution

Two env changes + one endpoint swap:

1. On the backend:
   - `WALLET_PROVIDER=turnkey` + `TURNKEY_API_PUBLIC_KEY` + `TURNKEY_API_PRIVATE_KEY` + `TURNKEY_ORGANIZATION_ID`
   - `ALCHEMY_API_KEY=<yours>` (free tier works)
   - Optional: `TENDERLY_ACCESS_KEY` + `TENDERLY_ACCOUNT` + `TENDERLY_PROJECT` for real simulation
2. In the example (or your real agent):
   - Change `/v1/transactions/simulate` to `/v1/transactions/swap` — the request body is identical

The backend will then:
- Run the same policy + builder path
- Run a real Tenderly simulation (not the mock)
- Enqueue the signed tx in BullMQ
- Worker signs via Turnkey MPC → broadcasts via Alchemy
- Monitor polls for the receipt
- `FeeEvent` is recorded; protocol fee is collected on-chain atomically via `AgentExecutor`

## Files

| File | Purpose |
|---|---|
| `index.mjs` | The example — ~130 lines, Node 22 native fetch, zero deps |
| `package.json` | Minimal ESM marker |
| `README.md` | This file |
