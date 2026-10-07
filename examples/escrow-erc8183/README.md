# AgentFi Example — ERC-8183 escrow with ERC-8004 feedback

Two agents, one paid job, settled on-chain: the requester's USDC is escrowed in AgentFi's ERC-8183 `AgentJobEscrow`, the provider's wallet gets an ERC-8004 identity on its first funded job, and when the backend evaluator completes the job the provider is paid (budget minus the 30 bps platform fee) and the escrow's `ReputationHook` writes ERC-8004 feedback in the same transaction.

This is the groundwork for task X1 of the [execution plan](../../docs/project/execution-plan-2026-10.md). Today it runs against the **local Base Sepolia fork harness** (task C5a); once the contracts are deployed on Base Sepolia (task C4) the same script runs against the real testnet.

## What it does

1. Registers a requester and a provider (or reuses two agents you pass in)
2. Makes sure their wallets are funded — USDC for the requester's budget, a little ETH for gas on both
3. Requester creates a job with a USDC reward → the backend runs `createJob → setBudget → approve → fund` from the requester's wallet
4. Provider accepts (the API only allows it once the budget is locked: `escrow.onChainStatus = FUNDED`)
5. The provider's wallet registers its ERC-8004 identity (first funded job only) and binds it to the job with `setProviderAgentId`
6. Provider delivers → `submit(keccak256(result))` → the evaluator signer `complete`s → USDC released, fee accrued, feedback written
7. Prints the on-chain job id, settlement tx, what the provider received, the ERC-8004 agent id and the public feedback file

`AGENTFI_FLOW=cancel` runs the failure path instead: once the budget is locked the requester cancels, the evaluator `reject`s and the full budget comes back to the requester (no feedback is written for a job nobody delivered).

The script never handles a private key. Agent wallets live in the backend (Turnkey, or the development-only local provider); the script talks to the AgentFi REST API and reads balances over JSON-RPC.

## Run it against the fork harness (now)

Needs Foundry (`forge`, `anvil`), Postgres and Redis (`docker compose -f docker-compose.dev.yml up -d postgres redis`), and `npm ci` at the repository root.

```bash
# Terminal 1 — Base Sepolia fork + AgentJobEscrow/ReputationHook (deployed with
# script/DeployEscrow.s.sol) + the backend with WALLET_PROVIDER=local
cd packages/backend
E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run e2e:escrow-fork:stack

# Terminal 2 — from the repository root, with the values terminal 1 prints
AGENTFI_API_URL=http://127.0.0.1:3155 \
AGENTFI_OPERATOR_SECRET=e2e-escrow-fork-api-secret-min-32-chars!! \
AGENTFI_RPC_URL=http://127.0.0.1:8546 AGENTFI_FORK_FUNDING=true \
node examples/escrow-erc8183/index.mjs
```

`AGENTFI_FORK_FUNDING=true` funds the two wallets with Anvil cheat codes: `anvil_setBalance` for gas, and USDC through the token's own mint path (impersonate FiatToken's `masterMinter`, `configureMinter` a throwaway minter, impersonate it, `mint`). It refuses to run unless `AGENTFI_RPC_URL` is a localhost RPC.

The automated version of the same run (plus the contest, cancellation and expiry paths) is `npm run test:e2e:escrow-fork` — see "Fork rehearsal (C5a)" in [docs/project/testnet-log.md](../../docs/project/testnet-log.md). That suite also runs this script.

## Run it against Base Sepolia (after C4)

Prerequisites on the backend you point it at: `AGENT_JOB_ESCROW_ADDRESS_84532`, `REPUTATION_HOOK_ADDRESS_84532` and `ESCROW_EVALUATOR_PRIVATE_KEY` set (the C4 runbook in [docs/project/testnet-log.md](../../docs/project/testnet-log.md)), an RPC for chain 84532 (`ALCHEMY_API_KEY`, or `RPC_URL_84532`), and the transaction and escrow settlement workers running.

```bash
AGENTFI_API_URL=https://<your backend> \
AGENTFI_OPERATOR_SECRET=<that backend's API_SECRET> \
node examples/escrow-erc8183/index.mjs
```

On a first run the script registers two new agents, prints their wallet addresses and waits (up to `AGENTFI_FUNDING_TIMEOUT_SEC`, default 900 s) until you fund them from faucets: at least `AGENTFI_REWARD_USDC` testnet USDC (Circle faucet) on the requester, and about 0.0005 ETH (Coinbase or Alchemy Base Sepolia faucet) on each wallet. It also prints the two agents' AgentFi API keys so the next run can reuse the funded wallets:

```bash
AGENTFI_REQUESTER_API_KEY=agfi_… AGENTFI_PROVIDER_API_KEY=agfi_… \
AGENTFI_API_URL=https://<your backend> node examples/escrow-erc8183/index.mjs
```

For C5's failure path, run it again with `AGENTFI_FLOW=cancel` (with the same keys; a happy run spent the requester's budget, so the script waits until you top its USDC up again). Record each run in section 3 of `docs/project/testnet-log.md` (job id, on-chain id, fund and settle tx, fee, feedback status) and the provider's identity in section 4.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AGENTFI_API_URL` | `http://localhost:3000` | AgentFi backend |
| `AGENTFI_OPERATOR_SECRET` | dev-stack value | the backend's `API_SECRET`, used only to register agents (`POST /v1/agents`) |
| `AGENTFI_REQUESTER_API_KEY` / `AGENTFI_PROVIDER_API_KEY` | — | reuse two existing agents instead of registering new ones |
| `AGENTFI_CHAIN_ID` | `84532` | chain of the job; `84532` and `8453` have RPC/USDC defaults |
| `AGENTFI_RPC_URL` | `https://sepolia.base.org` for 84532 | JSON-RPC for balance reads (and cheat codes on a fork) |
| `AGENTFI_USDC_ADDRESS` | Circle USDC of the chain | the escrow token |
| `AGENTFI_REWARD_USDC` | `1.0` | job budget; ≥ 1 USDC, the hook's `minFeedbackBudget`, or no feedback is written |
| `AGENTFI_FLOW` | `happy` | `happy` (deliver → complete) or `cancel` (cancel while funded → full refund) |
| `AGENTFI_FORK_FUNDING` | `false` | fund the wallets with Anvil cheat codes (localhost RPC only) |
| `AGENTFI_POLL_INTERVAL_MS` | `3000` | job polling interval (stay under the FREE tier's 30 requests/min) |
| `AGENTFI_FUNDING_TIMEOUT_SEC` / `AGENTFI_STEP_TIMEOUT_SEC` | `900` / `600` | how long to wait for faucet funding / each on-chain step |

## Files

| File | Purpose |
|---|---|
| `index.mjs` | The example — Node 22 native fetch, zero dependencies |
| `package.json` | Marks this as an ESM module |
| `README.md` | This file |
