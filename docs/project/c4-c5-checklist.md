# C4 / C5 checklist — Base Sepolia (owner)

The short version of the runbook in [testnet-log.md](testnet-log.md) §2 (C4)
and §5.4 (C5). Tick each line. If a result differs from what is written here,
stop: the step and its log are the evidence. Nothing here is mainnet.
Addresses and transaction hashes go into the repository. Keys never do: not
in the repository, not in a chat, not in an issue.

Gate: **G2** = ERC-8004 feedback written on Base Sepolia by a settled job,
with the transaction hashes recorded in `testnet-log.md` §3–4. The fork
rehearsals (§5.2, §5.5, the C3d fork run) do not count as G2 evidence.

## Authorisation package (owner, before anything is executed)

This checklist separates the decision to run C4 / C5 from running it. Nothing below §0 is executed until the owner has approved this package, explicitly and in writing (the round note or a PR comment). The detail behind each line — evidence, gas, acceptance matrix, recovery — is in [c5-escrow-validation.md](c5-escrow-validation.md). The package covers the **escrow validation only**: completed work, cancellation, and contest → operator resolution.

| Item | Proposal to approve |
|---|---|
| **Commit and build** | The merge commit of the PR that added `c5-escrow-validation.md` (contracts unchanged since `162cb06`). Foundry 1.7.1, solc 0.8.24, optimizer 200, no metadata; expected code version `ddc6936bc680…`. Runtime keccak of the artifacts: escrow `0xe9366fa6…89be`, hook `0xcbe9fd33…f54a` (all four in the doc §2). Gate: `npm run contracts:code:check` matches (0.12); deploy, backend and runner from that same checkout |
| **Network** | Base Sepolia, chain 84532 only; RPC `https://sepolia.base.org` for the runner's reads, a valid Alchemy key for the backend; mainnet out of scope (its contest window stays open, plan §5-9) |
| **Contracts** | `AgentJobEscrow` + `ReputationHook` (`DeployEscrow.s.sol`). Recommended: **not** `AgentPolicyModule` / `AgentExecutor` (decision §9-1 of the doc; escrow jobs do not use them) |
| **Addresses** (all new; public addresses only) | deployer (new keystore key) · operator (new, keystore, in no `.env`) · fee wallet (new, owner-controlled) · evaluator (`cast wallet new`, key only in `packages/backend/.env`) · requester and provider (created by the runner's `setup`, Turnkey, EOA mode). Not reused: Anvil test accounts, the legacy Base Sepolia pair, the Base mainnet deployer / fee wallet. Each address is recorded in testnet-log §1 / §4 as it is created |
| **Amounts** | escrow budgets: completed **2.0**, contest **1.5**, cancel **1.0** USDC (4.5 locked at most; net requester −2.0, provider +1.994, escrow fee +0.006 kept in the escrow). ETH from faucets: deployer **0.005**, evaluator **0.003**, requester **0.002**, provider **0.002** (0.012 total; measured need at today's 0.006 gwei is < 0.0001) |
| **Policies** | requester: `maxValuePerTxUsd 2`, `maxDailyVolumeUsd 5`, `cooldownSeconds 0`, `allowedRecipients [provider wallet]`; provider: `maxValuePerTxUsd 1`, `maxDailyVolumeUsd 1`, `cooldownSeconds 0`; both `maxOutflowPerTxUsd` **null** (no ordinary outflow possible) |
| **Window** | `ESCROW_EVALUATION_DELAY_SECONDS=3600` (Q6 / D12), checked by the runner against the backend before every step and on every settlement (≥ 3600 s after `submit`) |
| **Transactions** (real network) | C4: 2 (escrow, hook) [+3 with the module / executor]. C5: completed 8 (requester createJob, setBudget, approve, fund; provider ERC-8004 register, setProviderAgentId, submit; evaluator complete) · contest 7 (requester 4; provider setProviderAgentId, submit; evaluator reject) · cancel 5–6 (requester 4; provider setProviderAgentId may land or revert; evaluator reject). 22–23 in total, plus the faucet drips. No transfer from or to any owner wallet; no fee withdrawal |
| **Contest decision** | `refund` + `quality-rejected` by the operator, after the job has been held past the window (recommended; `pay` is the alternative) |
| **Missing before C4** | the four owner addresses and their keys (§3.3 of the doc); faucet ETH / USDC; Turnkey organization + API key pair; a valid Alchemy key with Base Sepolia; `API_SECRET` / `ADMIN_SECRET`; the `agentfi_c5` database and an empty Redis index; optional Etherscan API V2 key |
| **Success** | every scenario `verify` PASS, `reconcile` PASS (doc §7), the authority checks PASS, testnet-log §1 / §3 / §4 filled; then G2 may be marked passed |
| **Stop** | any runner `STOP` (wrong network; configuration or bytecode not verified; unexpected recipient or party; insufficient balance; event, timing, nonce or ETH divergence; run-integrity breach — doc §5). On a stop nothing more is sent and no new job is created; the owner decides |

Approving this package authorises only what it lists. Anything else (another scenario, a different amount, a fee withdrawal, a mainnet step) needs its own approval.

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
| 0.11 | `SAFE_DEPLOYER_PRIVATE_KEY` unset or empty. D19: Safe mode does not work (the module enablement is signed by the deployer, who is not a Safe owner) and is FATAL in production / staging; with C5's `NODE_ENV=development` a set key only warns, and every new agent would get an orphaned Safe paid by the deployer before falling back to its EOA. dotenv never overrides a variable already exported, so clear the shell too: `unset SAFE_DEPLOYER_PRIVATE_KEY` in every terminal that starts the API or the worker | `printenv SAFE_DEPLOYER_PRIVATE_KEY` and `grep -s '^SAFE_DEPLOYER_PRIVATE_KEY=.' packages/backend/.env` both print nothing |
| 0.12 | The authorised commit is checked out and the embedded contract code matches its build: `cd packages/contracts && forge build && cd ../.. && npm run contracts:code:check` | `[contracts:code] … matches the artifacts (version …)`, exit 0 |

## 1. C4 — deploy (testnet-log.md §2)

| # | Step | Expected result | Evidence to keep |
|---|---|---|---|
| 1.1 | `cd packages/contracts && forge test` | `356 tests passed, 0 failed, 2 skipped` | the last line |
| 1.2 | Export `EXPECTED_CHAIN_ID=84532`, `OPERATOR_ADDRESS`, `FEE_WALLET`, `TRUSTED_EVALUATOR` (the address), `EXECUTOR_FEE_BPS=30` | — | — |
| 1.3 | **Only if the package includes the policy module / executor** (doc §9-1; not needed for the escrow validation): `forge script script/Deploy.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast [--verify]` | `Executor bound:` = the `AgentExecutor:` line; `Legacy EscrowModule: skip`; copy block with `POLICY_MODULE_ADDRESS_84532`, `EXECUTOR_ADDRESS_84532`, `POLICY_OPERATOR_ADDRESS_84532`, `OPERATOR_FEE_WALLET`. Run it from the commit the backend will run: `npm run contracts:code:check` passes there (S9: only this build's bytecode is accepted). Measured on a fork: 3 txs, 1 939 833 gas | the copy block; `broadcast/Deploy.s.sol/84532/run-latest.json` |
| 1.4 | `forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast [--verify]` | `Hook gas requirement: 597937`, `Hook bind requirement: 140794`; copy block with `AGENT_JOB_ESCROW_ADDRESS_84532`, `REPUTATION_HOOK_ADDRESS_84532`. Measured on a fork: 2 txs, 3 724 419 gas | the copy block; `broadcast/DeployEscrow.s.sol/84532/run-latest.json` |
| 1.5 | Only with 1.3: `bash ../../scripts/verify-deployment.sh …` (§2.7) | `=== Results: 5 passed, 0 failed ===` (incl. the module's `executor()` = the executor) | output |
| 1.6 | The `cast call` block of contract-deployment.md "Post-deployment checks" | every value equals its comment: `token()` = USDC `0x036C…CF7e`, hook `acp()` = escrow, `trustedEvaluator()` = your evaluator, `canonicalAgentId` / `penalties` = 0 | output |
| 1.7 | Record: testnet-log.md §1 (addresses, deploy tx hashes, deployer, constructor params), STATE.md §3, contract-deployment.md registry | — | a docs PR |

Failure stops: `WrongChain` / missing `EXPECTED_CHAIN_ID` / `SignerConflict` mean nothing was sent. Fix the cause and rerun.

## 2. C5 — backend on Base Sepolia (testnet-log.md §5.4)

| # | Step | Expected result | Evidence to keep |
|---|---|---|---|
| 2.1 | `docker compose -f docker-compose.dev.yml up -d postgres redis`; `… stop api`; `… exec -T postgres psql -U agentfi -d postgres -c "CREATE DATABASE agentfi_c5"`; `… exec -T redis redis-cli -n 5 flushdb` (DB 5 held a stale queue key on 2026-10-15) | `CREATE DATABASE`; `OK`; `… redis-cli -n 5 dbsize` → `0` | — |
| 2.2 | Write `packages/backend/.env` from §5.4 step 3: `NODE_ENV=development`, `WALLET_PROVIDER=turnkey`, the three `TURNKEY_*`, a **valid** `ALCHEMY_API_KEY` with Base Sepolia enabled (a placeholder makes every "is this transaction known?" lookup uncertain), the C4 copy blocks (without the 1.3 block, leave `POLICY_MODULE_ADDRESS_84532` / `EXECUTOR_ADDRESS_84532` / `POLICY_OPERATOR_ADDRESS_84532` unset), `ESCROW_EVALUATOR_PRIVATE_KEY`, `REDIS_URL=redis://localhost:6379/5`, **`ESCROW_EVALUATION_DELAY_SECONDS=3600`** (contest window on for the whole run, owner decision Q6/D12), **`SYNTHETIC_TEST_PRICES_USD=84532:native=2500,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1`** (testnet-only synthetic prices so the daily limit can count ordinary spends, Q9/D15 — never in production; the boot refuses it there) | file exists, git-ignored (`git status` does not list it) | — |
| 2.3 | `cd packages/backend && npx prisma generate && npx prisma migrate deploy` | every migration applied, **0001 to 0025** | output |
| 2.4 | Terminal A: `TRANSACTION_WORKER_ENABLED=false npx tsx src/index.ts` | `ERC-8183 escrow enabled — evaluator signer configured` with `escrowEvaluatorAddress` = `TRUSTED_EVALUATOR`; **`ERC-8183 boot check: escrow (+ ReputationHook where configured) match the configuration`** with `chainIds: [84532]` and **`ERC-8183 configuration verified — escrow signatures allowed on this chain`** with `chainId: 84532` (Q7/D13); only with 1.3: **`AgentExecutor / AgentPolicyModule verified against this build — executor-routed transactions and policy syncs allowed`** with `chainId: 84532` (S9: this build's bytecode, bound executor, `POLICY_OPERATOR_ADDRESS_84532`; a mismatch would only log in `development` — check for `would be FATAL`); `AgentFi API running on port 3000` | the log lines |
| 2.5 | Terminal B: `TRANSACTION_WORKER_ENABLED=true npx tsx src/worker.ts` | `Transaction worker started`, `Payment recovery worker started`, `Escrow settlement worker started`, `Escrow expiry sweep scheduled`, the same boot-check lines (escrow and S9), **no `CONFIG DRIFT`** | the log lines |
| 2.6 | `curl http://localhost:3000/health/ready` | `"turnkey":true` and `escrowConfig` with `{"chainId":84532,"state":"verified","allowed":true,…}` | output |
| 2.7 | Third terminal, `packages/backend`: export `C5_ESCROW`, `C5_HOOK` (C4 copy block), `C5_EVALUATOR`, `C5_OPERATOR`, `C5_FEE_WALLET`, and the two secrets read from `.env` without printing them (doc §6.3); `npm run c5:escrow -- preflight` | every line `PASS` (chain 84532, this build's bytecode, escrow / hook configuration, backend verified, window 3600, TTL, Turnkey, evaluator gas) | the output |
| 2.8 | `npm run c5:escrow -- setup` | two agents registered with the approved policies; their wallet addresses and the funding request printed; API keys written to `c5-run/agent-keys.secret.json`, never printed | the addresses (testnet-log §4 later) |
| 2.9 | Faucets: the requester ≥ 4.5 USDC and 0.002 ETH, the provider 0.002 ETH — to the printed addresses only; then `npm run c5:escrow -- snapshot` | the snapshot table (balances, nonces, block) | the output |
| 2.10 | `npm run c5:escrow -- run happy` (≈ 70 min); once it prints `binding=BOUND`, in two more terminals `run contest` (≈ 70 min, held past the hour) and `run cancel` (≈ 5 min) | each ends `acceptance … all checks passed` (contest: `HELD past the window`, after the authority checks PASS) | `c5-run/evidence/*.json` |
| 2.11 | When `run contest` prints `HELD`: `npm run c5:escrow -- resolve contest` (refund + `quality-rejected`); optional before it: restart the worker (terminal B) and see the job stay held | 202, then `REJECTED`, `acceptance … all checks passed` | `evidence/contest.json` |
| 2.12 | `npm run c5:escrow -- reconcile` | `Reconcile … all checks passed` and three testnet-log rows printed | `evidence/reconcile.json` |
| 2.13 | Record testnet-log.md §1 (C4), §3 (the three rows), §4 (provider identity, `register` tx, `agentURI` = `http://localhost:3000/v1/agents/<id>/erc8004.json`); keep `c5-run/state.json`, `scenarios/` and `evidence/` (no secret in them; never commit `agent-keys.secret.json`) | — | a docs PR |
| 2.14 | `docker compose -f docker-compose.dev.yml start api` | dev API back | — |

A runner `STOP` at any step ends the run there: nothing more is sent, and the owner decides. Rerunning a command after an interruption resumes it without creating a new job (doc §6.4). The `examples/escrow-erc8183` script still works for a demonstration, but it creates new agents and a new job on every run: it is not the validation path.

## 3. Known behaviour to expect (not defects)

- The default agent policy caps an escrow job at `maxValuePerTxUsd` (Q8, migration 0021): **1 USDC** with the default `"1.0"`. Its 60 s cooldown also refuses a second job right after the first. The example registers its agents with a USD cap that covers the budget and no cooldown. Agents you register by hand need the same (`maxValuePerTxUsd`, not `maxValuePerTxEth`), set with the operator credential; an agent created with a non-empty `allowedContracts` must also name `allowedRecipients` (the provider wallets it may pay, or `[]`).
- **Ordinary outflows need `maxOutflowPerTxUsd`** (§5-6, migration 0025). Every policy — existing rows after `prisma migrate deploy`, and every agent registered without the field, public self-registration included — has it `null` ("not configured"), and then every ordinary outflow (transfer, swap / Curve input, Aave / Compound / ERC-4626 deposit, GMX collateral, batch native value or ERC-20 transfer, legacy A2A payment and its paid-job creation) is refused with `403 USD_CAP_NOT_CONFIGURED` before anything is simulated or reserved. Escrow jobs (ERC-8183, `maxValuePerTxUsd`), x402 payments and withdrawals are not affected, so the C5 escrow flow and the example run without it. If C5 also exercises ordinary transfers or swaps, the operator sets it per agent: `PATCH /v1/agents/<id>/policy` with `{ "maxOutflowPerTxUsd": "<USD>" }` and `x-api-key: <API_SECRET>` (an agent cannot set it from `null`; it may only lower it), or in the operator registration body's `policy`. Nothing is inferred from the ETH or the USDC cap; choose the value per agent. With the field set, an outflow that has no trusted price — on Base Sepolia, any asset missing from `SYNTHETIC_TEST_PRICES_USD` — is refused `503 PRICE_UNAVAILABLE` even without a daily limit.
- On Base Sepolia no oracle price is used (Q9/D15). Escrow jobs count USDC at exactly 1.00 (`usdc-peg`). Ordinary transfers, swaps and batches are priced only with `SYNTHETIC_TEST_PRICES_USD` (step 2.2) and recorded with the source `synthetic`; an asset that is not configured is refused with `503 PRICE_UNAVAILABLE` while the agent has a daily limit, and so is a `"max"` withdrawal and a legacy (non-escrow) reward without a price. Batch calldata other than an ERC-20 transfer needs its target in `allowedContracts` (`403 UNACCOUNTED_CALL` otherwise); the policy module is never a batch target (`403 POLICY_MODULE_TARGET`, S8).
- `POST /admin/transactions/batch` requires `agentId`: the batch is signed by that agent's wallet (#174). It is **not** the on-chain policy path any more (S8): it refuses the policy module as a target. To push an agent's stored policy (or the kill switch) to `AgentPolicyModule`, use `POST /admin/agents/<id>/policy/sync` (or the pause route with `{"syncOnChain": true}`); the agent's own wallet sends the calls, so the agent needs native gas. `GET /admin/agents/<id>/policy/onchain` shows both sides. The module applies the cooldown once per execution (a whole batch) and accepts validations only from its bound executor (fixed before C4, owner decision 2026-10-14).
- S9: each process verifies the executor, the policy module, the escrow and the hook against **this build's runtime bytecode** and their bindings (executor ↔ module, `feeWallet` = `OPERATOR_FEE_WALLET`, `feeBps` = 30, module `operator()` = `POLICY_OPERATOR_ADDRESS_84532`, hook ↔ escrow) at boot and every `ESCROW_CONFIG_RECHECK_SECONDS`. While a chain is not verified, ETH-value swaps and batches routed through the executor, `POST /admin/transactions/batch` and the policy sync answer `503 CONTRACTS_UNVERIFIED` (queued ones wait); ordinary direct transfers are unaffected. `GET /admin/contracts/verification` (admin secret, localhost) shows the state with the reason. Contracts deployed from another commit, or any legacy deployment, never verify.
- "Is this transaction known?" asks **every** RPC candidate and answers "unknown" only when all of them say so (#176). Keep `ALCHEMY_API_KEY` valid for Base Sepolia and set no `RPC_URL_84532` / `INFURA_API_KEY` you do not serve: a candidate that always errors makes drops, retries and settlement re-sends wait as "uncertain" (logged) instead of guessing.
- A contest is refused from `expiresAt` minus the expiry margin, and a job whose delivery was accepted in time but is not settled at `expiresAt` is **held** (`delivery-held` alert) instead of refunded by the backend: the late submit / settlement pays the provider, or the operator resolves it (#176).
- The on-chain URIs point at `http://localhost:3000` (D10). Third parties cannot open them; the hashes and transactions are the evidence.
- The contest window is one hour (Q6): every happy-path settlement arrives about an hour after `submit`. The value is for this validation only; mainnet's is an owner decision.
- While the RPC cannot confirm the deployed escrow / hook configuration (boot, or an outage later), new escrow jobs answer `503 ESCROW_CONFIG_UNVERIFIED` with `Retry-After`, and queued escrow transactions and evaluator settlements wait (Q7). Already broadcast transactions are still confirmed and reconciled. `curl http://localhost:3000/health/ready` shows the per-chain state under `escrowConfig`.

## 4. Done when

- [ ] testnet-log.md §1 has the deployed contract addresses (escrow and hook; the module and executor only with 1.3) and their deploy tx hashes
- [ ] §3 has the three rows printed by `reconcile`: completed (`feedback written`), contest (`written`, resolution `quality-rejected`), cancel (`skipped:no-params`)
- [ ] §4 has the provider identity
- [ ] `evidence/happy.json`, `contest.json`, `cancel.json` and `reconcile.json` all `PASS`, kept with the docs PR (secrets excluded)
- [ ] plan rows C4 and C5 marked done with a link to the docs PR; gate G2 marked passed only then
