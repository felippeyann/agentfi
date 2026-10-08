# Testnet log — Base Sepolia (chain 84532)

> Evidence file for gates G2 and G5 of the [execution plan](execution-plan-2026-10.md). One row per on-chain action by the maintainer or the backend: addresses and transaction hashes only, never keys. Created 2026-10-06; empty until C4 runs.

## 1. Deployments (task C4)

| Date | Contract | Address | Deploy tx | Deployer | Notes |
|---|---|---|---|---|---|
| pending | `AgentPolicyModule` | | | | `script/Deploy.s.sol` (new `Action` struct pair; `EXPECTED_CHAIN_ID=84532`; legacy `EscrowModule` not deployed unless `DEPLOY_LEGACY_ESCROW_MODULE=true`) |
| pending | `AgentExecutor` | | | | same broadcast; `EXECUTOR_FEE_BPS=30` (its own variable since C2b; `FEE_BPS` is the escrow's) |
| pending | `AgentJobEscrow` | | | | `script/DeployEscrow.s.sol` (`EXPECTED_CHAIN_ID=84532`); token USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; `platformFeeBP=30`, `evaluatorFeeBP=0` |
| pending | `ReputationHook` | | | | bound to the escrow; `trustedEvaluator` = backend evaluator EOA; `minFeedbackBudget=1000000`; `feedbackGasLimit=500000`, `identityCallGasLimit=50000` (R3c); C2b: `feedbackGasRequirement()` = 597937, `canonicalBindGasRequirement()` = 140794, `REASON_QUALITY_REJECTED()` = `keccak256("agentfi.quality-rejected")` |

Constructor parameters actually used (fill in after the broadcast): `EXPECTED_CHAIN_ID` (mandatory, both scripts), `OPERATOR_ADDRESS`, `FEE_WALLET`, `EXECUTOR_FEE_BPS` (`Deploy.s.sol`), `TRUSTED_EVALUATOR`, `FEE_BPS`, `EVALUATOR_FEE_BPS`, `MIN_FEEDBACK_BUDGET`, `FEEDBACK_GAS_LIMIT` (default `500000`), `IDENTITY_CALL_GAS_LIMIT` (default `50000`), `REPUTATION_REGISTRY_ADDRESS` (default `0x8004B663056A597Dffe9eCcC1965A193B7388713`), `IDENTITY_REGISTRY_ADDRESS` (default `0x8004A818BFB912233c491871b3d84c89A494BD9e`).

## 2. C4 runbook (owner runs it; the agent prepared it)

Deploys `AgentPolicyModule` + `AgentExecutor` (`script/Deploy.s.sol`) and `AgentJobEscrow` + `ReputationHook` (`script/DeployEscrow.s.sol`) on Base Sepolia. Run it in **Git Bash** (any bash works) from the repository root of an up-to-date `main` checkout. Background and every option: [docs/operations/contract-deployment.md](../operations/contract-deployment.md). This runbook was dry-run as written on an Anvil fork on 2026-10-08 (§5.5).

### 2.0 Prerequisites

```bash
git submodule update --init --recursive        # packages/contracts/lib/forge-std (pinned submodule)
export PATH="$HOME/.foundry/bin:$PATH"
forge --version                                # forge Version: 1.7.1
```

Without the submodule `forge build` fails on `forge-std/Script.sol`. Do not run `forge install`: the dependency is the pinned submodule.

The two password prompts below (`cast wallet import --interactive` and `forge script --account`) read from the terminal: type them yourself in a terminal window (Git Bash, Windows Terminal, PowerShell). They do not work through a coding agent's shell or CI, which have no terminal attached.

### 2.1 Keys and addresses (testnet only)

| What | How | Used as |
|---|---|---|
| Deployer | `cast wallet import agentfi-deployer --interactive` (paste the private key, choose a password; stored encrypted under `~/.foundry/keystores/agentfi-deployer`). `cast wallet address --account agentfi-deployer` shows its address. Fund it with ~0.01 Base Sepolia ETH: both scripts together need about 7.1 M gas (forge estimated 0.00007 ETH at the fork's gas price in the dry-run) | `--account agentfi-deployer` on both `forge script` commands |
| Evaluator | `cast wallet new` prints a fresh address and private key. Fund the address with ~0.01 ETH: it pays the gas of every `complete` / `reject` / `claimRefund` (the backend alerts below 0.0005 ETH) | address → `TRUSTED_EVALUATOR` (hook, below); private key → `ESCROW_EVALUATOR_PRIVATE_KEY`, only in `packages/backend/.env` (§5.4, plan D5) |
| Operator | the evaluator address is acceptable on testnet; use a separate key on mainnet | `OPERATOR_ADDRESS` |
| Fee wallet | any address you control | `FEE_WALLET` (= backend `OPERATOR_FEE_WALLET`) |
| Etherscan key (optional) | one Etherscan API V2 key from <https://etherscan.io/myapikey>; it covers Base Sepolia. Basescan V1 keys / endpoints no longer work | `ETHERSCAN_API_KEY` |

Base Sepolia ETH faucets: Coinbase Developer Platform (<https://portal.cdp.coinbase.com/products/faucet>), Alchemy (<https://www.alchemy.com/faucets/base-sepolia>).

### 2.2 Signer: the keystore *or* `PRIVATE_KEY`, never both

The commands below sign with the keystore (`--account`). Forge also reads `packages/contracts/.env` on its own, so make sure neither the shell nor that file carries a `PRIVATE_KEY`:

```bash
unset PRIVATE_KEY
grep -s PRIVATE_KEY packages/contracts/.env    # must print nothing
```

If a `PRIVATE_KEY` is still present, both scripts print a `WARNING: PRIVATE_KEY is set …` block; when it belongs to a different address than `--account`, they stop before broadcasting with `SignerConflict(<keystore address>, <PRIVATE_KEY address>)`. Remove it and rerun: nothing was sent. (The alternative without a keystore is `PRIVATE_KEY` in the shell and no `--account`; the scripts accept it with the warning, but the key then sits in your environment. It is the only option when an agent runs the deploy for you, because an agent cannot answer the password prompt; delete the key from the shell or file afterwards.)

### 2.3 Tests

```bash
cd packages/contracts
forge test
```

Last line: `341 tests passed, 0 failed, 2 skipped (343 total tests)`. The two skipped suites are the Base Sepolia fork suites; to run them against the real registries: `BASE_SEPOLIA_FORK_URL=https://sepolia.base.org forge test --match-path "test/*.fork.t.sol"` → `14 tests passed, 0 failed, 0 skipped` (the public RPC sometimes rate-limits: rerun).

### 2.4 Environment (same shell for both scripts)

```bash
export EXPECTED_CHAIN_ID=84532
export OPERATOR_ADDRESS=0x...        # 2.1
export FEE_WALLET=0x...              # 2.1
export TRUSTED_EVALUATOR=0x...       # the evaluator ADDRESS from 2.1 (never its key)
export EXECUTOR_FEE_BPS=30           # Deploy.s.sol only; the escrow fee FEE_BPS defaults to 30
export ETHERSCAN_API_KEY=...         # only with --verify (2.1)
```

Leave every other variable unset: the escrow script then uses USDC `0x036C…CF7e`, the ERC-8004 registries of Base Sepolia, `FEE_BPS=30`, `EVALUATOR_FEE_BPS=0`, `MIN_FEEDBACK_BUDGET=1000000`, `FEEDBACK_GAS_LIMIT=500000` and `IDENTITY_CALL_GAS_LIMIT=50000` (R3c; values outside 250000–2000000 / 20000–200000 are refused before broadcasting). Both scripts stop before sending anything if the RPC is not chain 84532 (`WrongChain`) or `EXPECTED_CHAIN_ID` is missing.

### 2.5 Policy module + executor

```bash
forge script script/Deploy.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify
```

Without an Etherscan key, drop `--verify` (the contracts work unverified; see "Verify later" below). Enter the keystore password when asked. The output ends with:

```
--- Copy to .env ---
POLICY_MODULE_ADDRESS_84532=0x…
EXECUTOR_ADDRESS_84532=0x…
OPERATOR_FEE_WALLET=0x…
--------------------
```

There is no `EscrowModule` line: the legacy ETH escrow is deployed only with `DEPLOY_LEGACY_ESCROW_MODULE=true` (plan D8; C4 and C5 do not need it), so leave `ESCROW_MODULE_ADDRESS_84532` unset in the backend.

### 2.6 Escrow + hook

```bash
forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify
```

(Same `--verify` rule.) The output prints the configuration, then `Hook gas requirement:  597937` and `Hook bind requirement: 140794` with the default gas limits, and ends with:

```
--- Copy to .env ---
AGENT_JOB_ESCROW_ADDRESS_84532=0x…
REPUTATION_HOOK_ADDRESS_84532=0x…
--------------------
```

**Verify later.** If you deployed without `--verify` and get a key afterwards, export `ETHERSCAN_API_KEY` and run the same command with `--resume --verify` instead of `--broadcast --verify` (once per script). `--resume` reads `broadcast/<script>/84532/run-latest.json` and sends no new transaction when the deployment already went through.

### 2.7 Post-deployment checks

Still in `packages/contracts`, with the variables from 2.4 and the addresses from the two copy blocks:

```bash
RPC=https://sepolia.base.org
POLICY=0x...      # POLICY_MODULE_ADDRESS_84532
EXECUTOR=0x...    # EXECUTOR_ADDRESS_84532
ESCROW=0x...      # AGENT_JOB_ESCROW_ADDRESS_84532
HOOK=0x...        # REPUTATION_HOOK_ADDRESS_84532
bash ../../scripts/verify-deployment.sh "$RPC" "$POLICY" "$EXECUTOR" "$OPERATOR_ADDRESS" "$FEE_WALLET" "$EXECUTOR_FEE_BPS"
```

Expected: `=== Results: 4 passed, 0 failed ===`. Then paste the escrow and hook block from [contract-deployment.md, "Post-deployment checks"](../operations/contract-deployment.md#post-deployment-checks) into the same shell (it uses `ESCROW`, `HOOK`, `RPC` and `TRUSTED_EVALUATOR`); every line carries its expected value as a comment, including the hook's gas requirements, `canonicalAgentId` and `penalties` (both 0 on a fresh hook). `cast` prints large numbers with their scientific form appended (`1000000 [1e6]`).

### 2.8 Record

1. Section 1 of this file: addresses, deploy tx hashes (`broadcast/Deploy.s.sol/84532/run-latest.json` and `broadcast/DeployEscrow.s.sol/84532/run-latest.json`, field `transactions[].hash`), deployer address, constructor parameters.
2. `STATE.md` §3 (Base Sepolia row) and the address registry in `docs/operations/contract-deployment.md`.
3. Keep both copy blocks and the evaluator key for the backend `.env` of C5 (§5.4).

**Backend boot check (C3d).** Once C3d is merged, the backend compares the hook's on-chain configuration (`acp`, `trustedEvaluator`, `identityRegistry`) with its own env at boot (`AGENT_JOB_ESCROW_ADDRESS_84532`, the address of `ESCROW_EVALUATOR_PRIVATE_KEY`, `IDENTITY_REGISTRY_ADDRESS_84532` or its default), so a hook deployed with the wrong `TRUSTED_EVALUATOR` shows up at the first boot of §5.4 instead of as silently skipped feedback. Details: [erc-8183-mapping.md](../architecture/erc-8183-mapping.md) §6.

## 3. Jobs settled on testnet (tasks C5, G2, G5)

| Date | AgentFi job id | `onChainJobId` | fund tx | settle tx | outcome | platform fee (USDC units) | feedback (`written` / `skipped:<reason>` / `failed`) | created by |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## 4. ERC-8004 identities registered (task R2)

| Date | AgentFi agent id | `erc8004AgentId` | register tx | `agentURI` |
|---|---|---|---|---|
| | | | | |

## 5. Fork rehearsal (C5a) — local Anvil fork, no real funds

Everything C5 will do on Base Sepolia, rehearsed on a local Anvil fork of Base Sepolia so the real run only needs the owner's keys. Not testnet evidence: nothing below was broadcast to a public network, and the tables above stay empty until C4/C5.

**What is real and what is not.** The fork (chain id 84532) carries the real state: Circle's testnet USDC `0x036C…CF7e`, the ERC-8004 Identity Registry `0x8004A818…BD9e` and Reputation Registry `0x8004B663…8713` (both implementation v2.0.0). `AgentJobEscrow` + `ReputationHook` are deployed fresh on the fork with the **same script and env names as the C4 runbook** (`script/DeployEscrow.s.sol`, `OPERATOR_ADDRESS`, `FEE_WALLET`, `TRUSTED_EVALUATOR`), signed with an Anvil test key (`--private-key`, the runbook's `--account` equivalent). The backend is the real `src/index.ts` (API + transaction worker + escrow settlement worker + payment recovery) in a child process with `WALLET_PROVIDER=local`, `RPC_URL_84532` pointing at Anvil, `AGENT_JOB_ESCROW_ADDRESS_84532` / `REPUTATION_HOOK_ADDRESS_84532` from the deploy and `ESCROW_EVALUATOR_PRIVATE_KEY` = an Anvil test key; the test drives it over HTTP like two agents.

| Role | Anvil test account | Address |
|---|---|---|
| Deployer (`forge script --private-key`) | 0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| `OPERATOR_ADDRESS` | 1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| `FEE_WALLET` / backend `OPERATOR_FEE_WALLET` | 2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| `TRUSTED_EVALUATOR` / backend `ESCROW_EVALUATOR_PRIVATE_KEY` | 3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |

Cheat codes (fork only): native ETH with `anvil_setBalance`; **USDC with `anvil_setStorageAt` on FiatToken v2.2's balance mapping, slot 9** (`balanceAndBlacklistStates`: balance in the low 255 bits) — verified with `balanceOf` after every write. The alternative also works and is what `examples/escrow-erc8183` uses (no keccak needed in a zero-dependency script): impersonate the token's `masterMinter` (`0xD52081E4…4E1c` at the fork block), `configureMinter` a throwaway minter, impersonate it, `mint`. The harness also aligns the fork's clock with the wall clock (`anvil_setTime`; the backend derives `expiredAt` from it) and clears the EIP-7702 delegations that sweeper bots have put on Anvil accounts 1–3 on the real Base Sepolia (`anvil_setCode(addr, "0x")`).

### 5.1 Commands

Prerequisites: Foundry 1.7.1 (`forge`, `anvil`), `git submodule update --init --recursive`, Postgres + Redis (`docker compose -f docker-compose.dev.yml up -d postgres redis`), `npm ci`. The public RPC `https://sepolia.base.org` serves archive state for the pinned block (occasional rate limiting: rerun).

```bash
cd packages/backend

# Automated rehearsal (≈ 3 min): happy, cancellation, example script, contest, expiry
E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run test:e2e:escrow-fork

# Same stack kept running for manual use (Ctrl+C stops it)
E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run e2e:escrow-fork:stack
# …then, from the repository root, with the values it prints:
AGENTFI_API_URL=http://127.0.0.1:3155 \
AGENTFI_OPERATOR_SECRET=e2e-escrow-fork-api-secret-min-32-chars!! \
AGENTFI_RPC_URL=http://127.0.0.1:8546 AGENTFI_FORK_FUNDING=true \
node examples/escrow-erc8183/index.mjs
```

Without `E2E_ANVIL_FORK_URL` the suite is reported as skipped and exits 0 (CI). Knobs: `E2E_ANVIL_FORK_BLOCK_NUMBER` (default `47822000`, `latest` = unpinned), `E2E_ESCROW_ANVIL_PORT` (8546), `E2E_ESCROW_BACKEND_PORT` (3155), `E2E_DATABASE_URL` (default `…/agentfi_e2e_escrow`, created if missing and **emptied on every run**; `agentfi` is refused), `E2E_ESCROW_REDIS_URL` (default `redis://localhost:6379/13`, **flushed on every run**; DB 0 is refused because the docker-compose API worker consumes the same queue names there). Backend logs: `%TEMP%/agentfi-escrow-fork/backend-<name>-<ts>.log` (`/tmp/…` on Linux/macOS). An interrupted run on Windows can leave Anvil/the backend running; the next run stops with "port … is already in use".

### 5.2 What the rehearsal proved (2026-10-07, fork block 47 822 000)

Deployment (deterministic for the pinned block): `AgentJobEscrow` `0x70449abF99B0b470F0280D5E3036265cB849d77C`, `ReputationHook` `0x47D053c18726916e47f07D444B2D645235647677`; post-deploy reads match the runbook (`token()` = USDC, `platformFeeBP()` = 30, `operator()`, hook `acp()` / `trustedEvaluator()` / registries / `minFeedbackBudget()` = 1 000 000). Result: **6/6 passed in 198 s** (suite total; the ERC-8004 agent ids below are the next free ids on the registry at that block). **R3c rerun (2026-10-07, same block, gas-capped hook):** 6/6 passed in 203 s; same deployment addresses; the post-deploy reads now also check `feedbackGasLimit()` = 500 000 and `identityCallGasLimit()` = 50 000; happy path `FeedbackWritten` and `getSummary(#9599, …)` = (1, 100, 0), contest `getSummary(#9603, …, "rejected")` = (1, 0, 0) as before.

| Path | Backend env | What is asserted |
|---|---|---|
| Happy (2.5 USDC) | `ESCROW_EVALUATION_DELAY_SECONDS=0` | `createJob → setBudget → approve → fund` from the requester wallet; `getJob` Funded with client/provider/evaluator/hook/budget; provider `ACCEPTED` only once FUNDED; R2 `register(agentURI)` from the provider wallet (ERC-8004 agent **#9599**) + `setProviderAgentId`; `submit`; evaluator `complete`. On-chain: status Completed, provider +2 492 500 units (budget − 7 500), requester −2 500 000, `pendingPlatformFees` +7 500 (= 30 bps, still in the escrow), `PaymentReleased` / `PlatformFeeAccrued`, hook `FeedbackWritten(jobId, 9599, 100)`, registry `NewFeedback` (client = hook, value 100, `agentfi.job` / `completed`, feedbackURI = `/v1/jobs/:id/feedback.json`), `providerAgentId(jobId)` = 9599, `ownerOf` = `getAgentWallet` = provider wallet, `tokenURI` = `/v1/agents/:id/erc8004.json`, `getSummary(9599, [hook], "agentfi.job", "")` = (1, 100, 0). Off-chain: `keccak256(GET /v1/jobs/:id/feedback.json)` = the `feedbackHash` in `NewFeedback`; the file's `proofOfPayment.txHash` = the `JobFunded` tx; `escrow.platformFeeAmount` = 7 500, `feedbackStatus` = `written`; the registration file lists the identity. |
| Cancellation while FUNDED | delay 0 | requester `CANCELLED` → evaluator `reject(…, "0x")` → Rejected, full refund, fee unchanged, no `NewFeedback`, hook `FeedbackSkipped` (`skipped:no-params`), `feedback.json` 404; the provider's in-flight binding ends `SKIPPED`. |
| Example script | delay 0 | `examples/escrow-erc8183/index.mjs` exits 0 against the same backend in both flows, `happy` and `AGENTFI_FLOW=cancel` (fork funding via `masterMinter`). |
| Contest while SUBMITTED | `ESCROW_EVALUATION_DELAY_SECONDS=20` | provider completes while the ERC-8004 binding is still in flight → `submit` **deferred** (R2) and released after `BOUND`; requester `POST /contest` inside the window → evaluator `reject` → Rejected, full refund, hook `FeedbackWritten(value 0)`, `NewFeedback` `rejected`, `getSummary(#9603, [hook], "agentfi.job", "rejected")` = (1, 0, 0), feedback file `outcome: rejected` with matching hash. |
| Expiry | `ESCROW_JOB_TTL_SECONDS=60`, `PAYMENT_RECOVERY_INTERVAL_SEC=5` | FUNDED job, chain time moved past `expiredAt` (`evm_increaseTime`), the sweep's evaluator `claimRefund` → Expired, full refund, no hook call, job `FAILED`. |

### 5.3 Bugs it found (fixed in the C5a PR)

1. **No settlement could ever be enqueued.** The escrow settlement queue used BullMQ `jobId = "<action>:<jobId>"`; BullMQ 5 rejects custom ids with `:` (unless they split into exactly three parts), so every `complete` / `reject` / `claimRefund` enqueue threw `Custom Id cannot contain :`: jobs stuck `PAYMENT_PENDING`/`SUBMITTED`, no cancellation/contest refund, no expiry sweep. Now `<action>-<jobId>` (regression test runs BullMQ's own validation).
2. **ERC-8004 feedback silently lost on every settlement.** The evaluator sent viem's default gas = `eth_estimateGas`, the lowest limit at which `complete` succeeds — and at that limit the hook's `giveFeedback` runs out of gas inside its try/catch, so the hook emits `FeedbackFailed(jobId, "")` and payment settles without feedback. Measured on the fork: estimate 246 770 → `FeedbackFailed`; full path 340 231 (`giveFeedback` 179 416). The evaluator signer now sends estimate + 400 000 (`EVALUATOR_GAS_HEADROOM`; unused gas is not charged).

**Recommendation before C4 (contract change) — done in R3c.** Bug 2 was fixed for AgentFi's own evaluator, but the hook still let *any* caller that trusts gas estimation lose the feedback (another evaluator client, a manual `cast send`, future third-party evaluators). R3c fixed it in the contract before deployment: every registry call forwards a fixed gas cap (`feedbackGasLimit` 500 000 to `giveFeedback`, `identityCallGasLimit` 50 000 to each identity call) and, once the cheap gates pass, the hook reverts the whole settlement with `InsufficientGasForFeedback` when the caller's gas cannot cover those caps (`feedbackGasRequirement` = 667 937 inside the hook). Estimators now converge on the full path: on this fork the lowest gas at which `complete` succeeds (777 522 for the escrow call) writes the feedback and one unit less reverts (`test/ReputationHook.fork.t.sol`); a registry that burns gas still cannot block settlement (it costs at most its cap). Design and measurements: [erc-8004-integration.md §4](../architecture/erc-8004-integration.md#4-agentfi-design-feedback-written-by-the-escrow-hook) "Gas policy". The backend's 400 000 headroom stays as insurance.

**Observation (not a bug).** On Base Sepolia CoinGecko has no prices, so a USDC reward resolves to $0: the requester's daily-volume reservation is skipped (`Escrow: USD value resolved to 0`) and the revenue snapshot stays NULL. Expected on testnet; on Base mainnet USDC is priced.

### 5.4 C5 runbook — Base Sepolia (owner runs it after C4)

The real-network version of the rehearsal: the backend on your machine, **Turnkey** agent wallets (D11: keys survive restarts, the production signing path is exercised), on-chain URIs pointing at `http://localhost:3000` (D10), funds from faucets. Run from the repository root in Git Bash unless a step says otherwise; it needs C4 (§2) done and its two copy blocks plus the evaluator key at hand, Docker, Node 22+ and `npm ci` at the repository root.

**1. Turnkey (D11).** Sign up at <https://app.turnkey.com>; sign-up creates your organization. In the dashboard copy the organization id (a UUID) and create an API key for your user (an API key pair generated in the browser): the public key is 66 hex characters starting with `02` or `03`, the private key 64 hex characters and is shown only once. Use your root user's key, or a user whose Turnkey policies allow creating wallets, signing transactions and signing raw payloads. Swapped values boot fine and fail at the first registration with `invalid public key. Did you switch your public and private key?`. What the backend does with it: every `POST /v1/agents` creates one Turnkey wallet named `agentfi-<agent name>-<timestamp>` holding one Ethereum account (`m/44'/60'/0'/0/0`); that account is the agent's wallet (`safeAddress` in the registration response, `walletAddress` in `/v1/agents/me`) and signs the agent's escrow and ERC-8004 transactions inside Turnkey. Agents and their funds therefore survive backend restarts and can be reused across runs.

**2. Postgres, Redis and the dev stack.** The dev compose stack provides Postgres and Redis, but its `api` container already listens on port 3000 and runs a transaction worker on Redis DB 0 under the same queue names, so it would take C5's jobs. Keep the databases, stop the dev API, and give C5 its own database and Redis DB:

```bash
docker compose -f docker-compose.dev.yml up -d postgres redis
docker compose -f docker-compose.dev.yml stop api
docker compose -f docker-compose.dev.yml exec -T postgres psql -U agentfi -d postgres -c "CREATE DATABASE agentfi_c5"
```

`-T` keeps `exec` from asking for a TTY, which Git Bash (mintty) cannot provide. Compose names the stack after the folder of the checkout (`agentfi` for the usual clone); if the dev stack was started from a folder with another name, add `-p <that name>` (`docker ps` shows it as the prefix of `…-postgres-1`) or these commands address an empty project. If you need the dev API to keep running, use another port instead (`API_PORT=3010` and `BACKEND_PUBLIC_URL=http://localhost:3010` in step 3; the on-chain URIs then carry that port, still localhost as D10 intends) and the dedicated Redis DB all the same. Start the dev API again after the run: `docker compose -f docker-compose.dev.yml start api`.

**3. `packages/backend/.env`.** The backend loads `.env` from the directory it is started in, and it is started from `packages/backend`, so the file is `packages/backend/.env` (git-ignored; not the repository-root `.env`). Create it with:

```env
NODE_ENV=development
API_PORT=3000
BACKEND_PUBLIC_URL=http://localhost:3000
# openssl rand -hex 32, twice (>= 32 characters each)
API_SECRET=<random>
ADMIN_SECRET=<random>
DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_c5
REDIS_URL=redis://localhost:6379/5
# Always required: any non-empty value boots. A real Alchemy key with Base Sepolia
# enabled adds base-sepolia.g.alchemy.com behind RPC_URL_84532; the public
# https://sepolia.base.org is always the last fallback.
ALCHEMY_API_KEY=<your Alchemy key>
# Optional primary RPC for chain 84532 (e.g. your Alchemy or another provider's https URL)
RPC_URL_84532=
WALLET_PROVIDER=turnkey
TURNKEY_API_PUBLIC_KEY=<step 1>
TURNKEY_API_PRIVATE_KEY=<step 1>
TURNKEY_ORGANIZATION_ID=<step 1>
# Leave empty: escrow steps are signed by the agent's own EOA
SAFE_DEPLOYER_PRIVATE_KEY=
# C4 copy blocks (§2.5, §2.6)
OPERATOR_FEE_WALLET=<FEE_WALLET>
POLICY_MODULE_ADDRESS_84532=<§2.5>
EXECUTOR_ADDRESS_84532=<§2.5>
AGENT_JOB_ESCROW_ADDRESS_84532=<§2.6>
REPUTATION_HOOK_ADDRESS_84532=<§2.6>
# The evaluator private key from §2.1 (its address is the hook's TRUSTED_EVALUATOR)
ESCROW_EVALUATOR_PRIVATE_KEY=<0x + 64 hex>
```

That is the full list the boot needs (`API_SECRET`, `ADMIN_SECRET`, `DATABASE_URL`, `REDIS_URL`, `ALCHEMY_API_KEY`, `OPERATOR_FEE_WALLET`, and the three `TURNKEY_*` with `WALLET_PROVIDER=turnkey`) plus what C5 uses. Everything else keeps its default: `ESCROW_EVALUATION_DELAY_SECONDS=0` (settle as soon as `submit` confirms), `ESCROW_JOB_TTL_SECONDS=604800`, `IDENTITY_REGISTRY_ADDRESS_84532` = the official registry the hook was deployed with, `RATE_LIMIT_FREE=30` requests/min per agent (the example polls every 3 s). `NODE_ENV=development` is explicit on purpose: unset it means development too, with a loud warning.

**4. Prisma client and schema** (once per checkout / database):

```bash
cd packages/backend
npx prisma generate          # npm ci does not generate the client
npx prisma migrate deploy    # applies every migration (0001…0018) to agentfi_c5
```

Both read `DATABASE_URL` from `packages/backend/.env`.

**5. API and worker, two terminals in `packages/backend`** (the C3c topology: the worker process signs, settles, recovers and sweeps; the API only queues):

```bash
# terminal A — API
TRANSACTION_WORKER_ENABLED=false npx tsx src/index.ts
# terminal B — worker
TRANSACTION_WORKER_ENABLED=true npx tsx src/worker.ts
```

The value on the command line wins over `.env` (dotenv never overrides a variable that is already set), so one `.env` serves both. Expected: the API logs `Transaction worker disabled for this process (TRANSACTION_WORKER_ENABLED=false)`, `ERC-8183 escrow enabled — evaluator signer configured` with `escrowEvaluatorAddress` = your `TRUSTED_EVALUATOR`, and `AgentFi API running on port 3000`; the worker logs `Transaction worker started`, `Payment recovery worker started`, `Escrow settlement worker started`, `Escrow expiry sweep scheduled` and `Transaction worker process is running`. `curl http://localhost:3000/health/ready` answers `"turnkey":true` once the Turnkey credentials work (its `rpc` check reads Ethereum mainnet through Alchemy, so it says `false` with a placeholder `ALCHEMY_API_KEY`; that does not affect Base Sepolia).

**6. Happy path** (third terminal, repository root):

```bash
AGENTFI_API_URL=http://localhost:3000 AGENTFI_OPERATOR_SECRET=<API_SECRET> node examples/escrow-erc8183/index.mjs
```

The script registers a requester and a provider (two Turnkey wallets), prints both API keys (keep them for step 7) and waits up to 15 minutes for funds: send the **requester** at least 1 USDC (Circle faucet, <https://faucet.circle.com>, network Base Sepolia) and 0.0005 ETH, the **provider** 0.0005 ETH (faucets in §2.1). It then runs `createJob → setBudget → approve → fund`, the provider's ERC-8004 `register` + `setProviderAgentId`, `submit`, and the evaluator's `complete`, and ends with `✓ Escrow flow completed end to end.` (`feedback written`).

**7. Failure path** (same two agents; the happy run spent the requester's USDC, so the script waits until you send it 1 USDC again):

```bash
AGENTFI_FLOW=cancel AGENTFI_REQUESTER_API_KEY=agfi_... AGENTFI_PROVIDER_API_KEY=agfi_... AGENTFI_API_URL=http://localhost:3000 node examples/escrow-erc8183/index.mjs
```

Ends with `✓ Escrow cancellation refunded end to end.` (requester refunded in full, no feedback). Contest handling: see [erc-8183-mapping.md](../architecture/erc-8183-mapping.md) §6.

**8. Record** one row per run in section 3 (AgentFi job id, `onChainJobId`, settle tx and fee as printed; the fund tx is `proofOfPayment.txHash` in `GET /v1/jobs/<job id>/feedback.json` for the happy run, and the requester wallet's `fund` transaction on <https://sepolia.basescan.org> for both) and the provider's identity in section 4 (the ERC-8004 agent id printed in step 6; its `register` tx on the provider wallet's Basescan page; `agentURI` = `http://localhost:3000/v1/agents/<provider id>/erc8004.json`).

**Local wallet provider: fork rehearsal only.** `WALLET_PROVIDER=local` (the fork harness of §5.1, and the dry-run of §5.5) keeps each agent's key in the memory of the process that created it. Every restart loses the keys, so agents registered before can no longer sign (register new ones), and an API and a worker in separate processes cannot share them: the worker fails with `[local-wallet] wallet … not found`. With the local provider run one process that does both (`TRANSACTION_WORKER_ENABLED=true npx tsx src/index.ts`, no `worker.ts`), as the harness does. `NODE_ENV=production` and `staging` refuse it.

### 5.5 Dry-run of §2 and §5.4 on 2026-10-08 (H14) — local fork, no real funds

The two runbooks above were executed as written on `main` 90bb831 + the H14 branch, against `anvil --fork-url https://sepolia.base.org --chain-id 84532 --port 8548` (fork of block 47 860 069). Substitutions, and nothing else: the RPC (`http://127.0.0.1:8548` for `base_sepolia` / `https://sepolia.base.org`); a throwaway keystore holding Anvil account 0 (`cast wallet import … --private-key … --unsafe-password …`, then `--account … --password …`, because a coding agent has no terminal for the prompts; deleted afterwards); fresh `cast wallet new` keys for the evaluator (= operator) and the fee wallet; faucets → `anvil_setBalance` and the example's `AGENTFI_FORK_FUNDING=true`; no `--verify` and no Etherscan key; **`WALLET_PROVIDER=local` instead of Turnkey** (no Turnkey credentials exist for the dry-run); the dev stack was left running, so the step-2 alternative was used (`API_PORT=3160`, `BACKEND_PUBLIC_URL=http://localhost:3160`), with database `agentfi_h14` and Redis DB 6.

| Step | Result |
|---|---|
| §2.0–2.3 | submodule present; forge 1.7.1; `forge test` 341 passed, 2 skipped; fork suites with `BASE_SEPOLIA_FORK_URL` 14 passed; no `PRIVATE_KEY` anywhere |
| §2.5 `Deploy.s.sol` | `Legacy EscrowModule: skip`, copy block with `POLICY_MODULE_ADDRESS_84532` / `EXECUTOR_ADDRESS_84532` / `OPERATOR_FEE_WALLET` only; no `ETHERSCAN_API_KEY` needed without `--verify` |
| §2.6 `DeployEscrow.s.sol` | `Hook gas requirement: 597937`, `Hook bind requirement: 140794`, copy block as documented; deployer nonce +4 for both scripts (forge estimated 2.25 M + 4.87 M gas) |
| §2.6 "Verify later" | `--resume` (without `--verify`) sent nothing: deployer nonce unchanged |
| §2.2 negative checks | `PRIVATE_KEY` of another address in `packages/contracts/.env` + `--account … --broadcast` → `SignerConflict(0xf39F…2266, 0x7099…79C8)`, nonce unchanged; the same address → the `WARNING: PRIVATE_KEY is set` block and `Deployer (PRIVATE_KEY)` |
| §2.7 | `verify-deployment.sh` from `packages/contracts`: 4 passed, 0 failed; all 23 `cast call` checks of contract-deployment.md returned the documented values |
| §5.4 steps 3–4 | `.env` generated from the step-3 block (only the substitutions above); `npx prisma generate`; `npx prisma migrate deploy` printed `Environment variables loaded from .env` and applied 18 migrations to the empty database |
| §5.4 step 5 (API + worker) | both processes booted with the documented log lines and `escrowEvaluatorAddress` = the evaluator; `/health/ready` `turnkey: true` (local provider), `rpc: false` (placeholder Alchemy key, as noted in step 5) |
| §5.4 step 6 on API + worker **with the local provider** | failed as the local-provider note predicts: `create FAILED: [local-wallet] wallet … not found` (the wallet was created in the API process, the worker signs). Not a Turnkey problem; it is why the local provider runs as one process |
| §5.4 steps 6–7, single process (`TRANSACTION_WORKER_ENABLED=true npx tsx src/index.ts`) | happy: on-chain job #1 Completed, provider +0.997 USDC, ERC-8004 agent #9604 bound, `feedback written`, `getSummary(9604, [hook], "agentfi.job", "")` = (1, 100, 0), `canonicalAgentId(provider)` = 9604, `pendingPlatformFees` = 3000; API keys printed in step 1; cancel with the reused keys: job #2 Rejected, 1.000000 USDC refunded, `feedback skipped:no-params` |

Observation (not a runbook defect): in the cancel run the provider already had identity #9604, so its `setProviderAgentId` for job #2 was broadcast after the evaluator's `reject` and reverted on-chain (31 590 gas paid by the provider wallet; binding `FAILED`, payment unaffected). In the C5a rehearsal the same race ended `SKIPPED` because the identity was still being registered.

Not verified here: anything Turnkey does (wallet creation, signing, the `turnkey` readiness check against the real API), the faucets, Etherscan verification (`--verify`, `--resume --verify`), the interactive password prompts, and the dev-stack `stop api` / `start api` commands (the dev stack served other work and stayed up).
