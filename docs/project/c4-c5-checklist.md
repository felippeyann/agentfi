# C4 / C5 checklist — Base Sepolia (owner)

The short version of the runbook in [testnet-log.md](testnet-log.md) §2 (C4)
and §5.4 (C5). Tick each line. If a result differs from what is written here,
stop: the step and its log are the evidence. Nothing here is mainnet.
Addresses and transaction hashes go into the repository. Keys never do: not
in the repository, not in a chat, not in an issue.

Gate: **G2** = ERC-8004 feedback written on Base Sepolia by a settled job,
with the transaction hashes recorded in `testnet-log.md` §3–4. The fork
rehearsals (§5.2, §5.5, the C3d fork run) do not count as G2 evidence.

## 0. Before you start

| # | Prerequisite | Check |
|---|---|---|
| 0.1 | Up-to-date `main` checkout, Git Bash, Docker, Node 22+ | `git status` clean; `node -v` ≥ 22 |
| 0.2 | Foundry 1.7.1 and the pinned submodule | `forge --version` → 1.7.1; `git submodule update --init --recursive` |
| 0.3 | `npm ci` at the repository root | exits 0 |
| 0.4 | Deployer key in a Foundry keystore: `cast wallet import agentfi-deployer --interactive`, typed in your own terminal | `cast wallet address --account agentfi-deployer` prints the address |
| 0.5 | Evaluator key: `cast wallet new`. Its address is `TRUSTED_EVALUATOR`; its key is `ESCROW_EVALUATOR_PRIVATE_KEY` in `packages/backend/.env` only | address noted |
| 0.6 | Fee wallet address (any address you control) | address noted |
| 0.7 | Faucet ETH: about 0.01 to the deployer and 0.01 to the evaluator | Basescan balance > 0 |
| 0.8 | No `PRIVATE_KEY` anywhere: `unset PRIVATE_KEY`; `grep -s PRIVATE_KEY packages/contracts/.env` | prints nothing |
| 0.9 | Turnkey (D11): organization id, API public key (66 hex chars, starts `02`/`03`), private key (64 hex chars) | values at hand, not pasted anywhere else |
| 0.10 | Optional: Etherscan API V2 key | only needed for `--verify` |

## 1. C4 — deploy (testnet-log.md §2)

| # | Step | Expected result | Evidence to keep |
|---|---|---|---|
| 1.1 | `cd packages/contracts && forge test` | `341 tests passed, 0 failed, 2 skipped` | the last line |
| 1.2 | Export `EXPECTED_CHAIN_ID=84532`, `OPERATOR_ADDRESS`, `FEE_WALLET`, `TRUSTED_EVALUATOR` (the address), `EXECUTOR_FEE_BPS=30` | — | — |
| 1.3 | `forge script script/Deploy.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast [--verify]` | `Legacy EscrowModule: skip`; copy block with `POLICY_MODULE_ADDRESS_84532`, `EXECUTOR_ADDRESS_84532`, `OPERATOR_FEE_WALLET` | the copy block; `broadcast/Deploy.s.sol/84532/run-latest.json` |
| 1.4 | `forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast [--verify]` | `Hook gas requirement: 597937`, `Hook bind requirement: 140794`; copy block with `AGENT_JOB_ESCROW_ADDRESS_84532`, `REPUTATION_HOOK_ADDRESS_84532` | the copy block; `broadcast/DeployEscrow.s.sol/84532/run-latest.json` |
| 1.5 | `bash ../../scripts/verify-deployment.sh …` (§2.7) | `=== Results: 4 passed, 0 failed ===` | output |
| 1.6 | The `cast call` block of contract-deployment.md "Post-deployment checks" | every value equals its comment: `token()` = USDC `0x036C…CF7e`, hook `acp()` = escrow, `trustedEvaluator()` = your evaluator, `canonicalAgentId` / `penalties` = 0 | output |
| 1.7 | Record: testnet-log.md §1 (addresses, deploy tx hashes, deployer, constructor params), STATE.md §3, contract-deployment.md registry | — | a docs PR |

Failure stops: `WrongChain` / missing `EXPECTED_CHAIN_ID` / `SignerConflict` mean nothing was sent. Fix the cause and rerun.

## 2. C5 — backend on Base Sepolia (testnet-log.md §5.4)

| # | Step | Expected result | Evidence to keep |
|---|---|---|---|
| 2.1 | `docker compose -f docker-compose.dev.yml up -d postgres redis`; `… stop api`; `… exec -T postgres psql -U agentfi -d postgres -c "CREATE DATABASE agentfi_c5"` | `CREATE DATABASE` | — |
| 2.2 | Write `packages/backend/.env` from §5.4 step 3: `NODE_ENV=development`, `WALLET_PROVIDER=turnkey`, the three `TURNKEY_*`, the C4 copy blocks, `ESCROW_EVALUATOR_PRIVATE_KEY`, `REDIS_URL=redis://localhost:6379/5`, **`ESCROW_EVALUATION_DELAY_SECONDS=3600`** (contest window on for the whole run, owner decision Q6) | file exists, git-ignored (`git status` does not list it) | — |
| 2.3 | `cd packages/backend && npx prisma generate && npx prisma migrate deploy` | every migration applied, **0001 to 0020** | output |
| 2.4 | Terminal A: `TRANSACTION_WORKER_ENABLED=false npx tsx src/index.ts` | `ERC-8183 escrow enabled — evaluator signer configured` with `escrowEvaluatorAddress` = `TRUSTED_EVALUATOR`; **`ERC-8183 boot check: escrow + ReputationHook match the configuration`** with `chainIds: [84532]`; `AgentFi API running on port 3000` | the log lines |
| 2.5 | Terminal B: `TRANSACTION_WORKER_ENABLED=true npx tsx src/worker.ts` | `Transaction worker started`, `Payment recovery worker started`, `Escrow settlement worker started`, `Escrow expiry sweep scheduled`, the same boot-check line, **no `CONFIG DRIFT`** | the log lines |
| 2.6 | `curl http://localhost:3000/health/ready` | `"turnkey":true` | output |
| 2.7 | Happy path: `AGENTFI_STEP_TIMEOUT_SEC=4500 AGENTFI_API_URL=http://localhost:3000 AGENTFI_OPERATOR_SECRET=<API_SECRET> node examples/escrow-erc8183/index.mjs`. When it waits: send the requester ≥ 1 USDC (faucet.circle.com) and 0.0005 ETH, the provider 0.0005 ETH. After `submit` the script waits about one hour (the contest window): `escrow.onChainStatus` stays `SUBMITTED`, then the evaluator completes | `✓ Escrow flow completed end to end.` and `feedback written` | the printed job id, `onChainJobId`, settle tx, fee, provider ERC-8004 agent id; both API keys (keep them private) |
| 2.8 | Failure path: send the requester 1 USDC again, then `AGENTFI_FLOW=cancel AGENTFI_REQUESTER_API_KEY=… AGENTFI_PROVIDER_API_KEY=… AGENTFI_API_URL=http://localhost:3000 node examples/escrow-erc8183/index.mjs` | `✓ Escrow cancellation refunded end to end.`, full refund, no feedback | job id, `onChainJobId`, reject tx |
| 2.9 | On Basescan: the hook's `FeedbackWritten` in the happy run's settle tx; the registry's `NewFeedback` (value 100) | events present | tx links |
| 2.10 | Record testnet-log.md §3 (one row per run) and §4 (provider identity, `register` tx, `agentURI` = `http://localhost:3000/v1/agents/<id>/erc8004.json`) | — | a docs PR |
| 2.11 | `docker compose -f docker-compose.dev.yml start api` | dev API back | — |

**Optional: D9 on the real network** (stronger evidence; not required by G2).
1. Nothing to restart: the contest window (`ESCROW_EVALUATION_DELAY_SECONDS=3600`, step 2.2) is on for the whole run.
2. Run a third job up to `SUBMITTED` by hand through the API, the way the contest scenario of `packages/backend/src/__tests__/e2e/escrow-erc8183.fork.e2e.ts` does. The example script has no contest flow.
3. Within the hour after `submit` confirms, the requester calls `POST /v1/jobs/<id>/contest` (after it the evaluator has completed the job and the contest is a `409`).
4. Check that nothing settles while it is held: `escrow.onChainStatus` stays `CONTESTED` and the chain says Submitted.
5. Resolve with `POST /admin/jobs/<id>/resolve` `{"decision":"refund","verdict":"quality-rejected","note":"C5 contest test"}`, using the `x-admin-secret` header, from localhost.
6. Expected: `JobRejected(agentfi.quality-rejected)`, full refund, `FeedbackWritten` value 0.

Record it as a separate row.

## 3. Known behaviour to expect (not defects)

- The default agent policy caps an escrow job at `maxValuePerTxUsd` (Q8, migration 0021): **1 USDC** with the default `"1.0"`. Its 60 s cooldown also refuses a second job right after the first. The example registers its agents with a USD cap that covers the budget and no cooldown. Agents you register by hand need the same (`maxValuePerTxUsd`, not `maxValuePerTxEth`), set with the operator credential; an agent created with a non-empty `allowedContracts` must also name `allowedRecipients` (the provider wallets it may pay, or `[]`).
- On Base Sepolia CoinGecko has no prices. Escrow jobs price USDC at exactly 1.00 (C3d), so the daily volume is counted. A legacy (non-escrow) reward without a price is refused when a daily limit is set.
- The on-chain URIs point at `http://localhost:3000` (D10). Third parties cannot open them; the hashes and transactions are the evidence.
- The contest window is one hour (Q6): every happy-path settlement arrives about an hour after `submit`. The value is for this validation only; mainnet's is an owner decision.
- While the RPC cannot confirm the deployed escrow / hook configuration (boot, or an outage later), new escrow jobs answer `503 ESCROW_CONFIG_UNVERIFIED` with `Retry-After`, and queued escrow transactions and evaluator settlements wait (Q7). Already broadcast transactions are still confirmed and reconciled. `curl http://localhost:3000/health/ready` shows the per-chain state under `escrowConfig`.

## 4. Done when

- [ ] testnet-log.md §1 has the four contract addresses and deploy tx hashes
- [ ] §3 has the happy row with `feedback written` and the cancel row with `skipped:no-params`
- [ ] §4 has the provider identity
- [ ] plan rows C4 and C5 marked done with a link to the docs PR; gate G2 marked passed only then
