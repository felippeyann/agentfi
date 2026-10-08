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

Prerequisites on the maintainer's machine (checked 2026-10-06): Foundry 1.7.1 at `~/.foundry/bin`; no `.env` and no keystore yet. Full reference: [docs/operations/contract-deployment.md](../operations/contract-deployment.md), sections "Deployment" and "ERC-8183 escrow and ERC-8004 hook".

1. **Keys and addresses (testnet only).**
   - Deployer EOA with Base Sepolia ETH (about 0.05 ETH covers both scripts; faucets: Coinbase Developer Platform faucet, Alchemy Base Sepolia faucet).
   - Backend evaluator EOA: generate a fresh key with `cast wallet new`, fund it with a little test ETH (it pays gas for `complete`/`reject`/`claimRefund`). This is the `TRUSTED_EVALUATOR` of the hook and the `ESCROW_EVALUATOR_PRIVATE_KEY` of the backend (C3). On testnet it is acceptable to also use it as `OPERATOR_ADDRESS`; on mainnet use separate keys.
   - `FEE_WALLET` = the address you want fees swept to (`OPERATOR_FEE_WALLET` in the backend `.env`).
   - `BASESCAN_API_KEY` for verification (optional but recommended).
2. **Signer.** Preferred: `cast wallet import agentfi-deployer --interactive` (encrypted keystore, key never in the environment). `Deploy.s.sol` only reads `PRIVATE_KEY` from the environment, so for step 4 export it in the shell session (or put it in `packages/contracts/.env`, which is git-ignored) and unset it afterwards.
3. **Tests.** In `packages/contracts`: `forge test` must show 312 passed, 1 skipped (the skipped one is the R3c fork suite; optionally run it against the real registries with `BASE_SEPOLIA_FORK_URL=https://sepolia.base.org forge test --match-contract ReputationHookForkTest -vv`: 3 passed).
4. **Policy module + executor (new ABI).**

   ```bash
   cd packages/contracts
   export OPERATOR_ADDRESS=0x... FEE_WALLET=0x... FEE_BPS=30 PRIVATE_KEY=0x...
   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY
   unset PRIVATE_KEY
   ```

   Ignore the `EscrowModule` address this script also prints (legacy, kept only for ETH jobs).
5. **Escrow + hook.**

   ```bash
   export OPERATOR_ADDRESS=0x... FEE_WALLET=0x... TRUSTED_EVALUATOR=0x...
   forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY
   ```

   Leave `FEEDBACK_GAS_LIMIT` (500000) and `IDENTITY_CALL_GAS_LIMIT` (50000) unset unless there is a reason to change them (R3c; the script refuses values outside 250000–2000000 / 20000–200000 before broadcasting). The script prints `Hook gas requirement: 597937` and `Hook bind requirement: 140794` with the defaults (C2b; 667937 before).

6. **Checks.** Run the `cast call` list from the deployment doc ("Post-deployment checks") and `scripts/verify-deployment.sh https://sepolia.base.org <policyModule> <executor> <operator> <feeWallet> 30`.
7. **Record.** Fill section 1 of this file, update `STATE.md` §3 and the address registry in `docs/operations/contract-deployment.md`, and set in the backend `.env`: `POLICY_MODULE_ADDRESS_84532`, `EXECUTOR_ADDRESS_84532`, `AGENT_JOB_ESCROW_ADDRESS_84532`, `REPUTATION_HOOK_ADDRESS_84532`, `ESCROW_EVALUATOR_PRIVATE_KEY`, `ALCHEMY_API_KEY`.

Alternative: if you prefer the agent to broadcast, put the deployer key in `packages/contracts/.env` as `PRIVATE_KEY=` (git-ignored) together with the three addresses above and say so in chat; the agent runs steps 3–7 and fills this file. The key is never pasted in chat.

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

Prerequisites: Foundry 1.7.1 (`forge`, `anvil`), `git submodule update --init packages/contracts/lib/forge-std`, Postgres + Redis (`docker compose -f docker-compose.dev.yml up -d postgres redis`), `npm ci`. The public RPC `https://sepolia.base.org` serves archive state for the pinned block (occasional rate limiting: rerun).

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

### 5.4 What C5 on Base Sepolia still needs from the owner

1. C4: deployer key/keystore with Base Sepolia ETH, a fresh evaluator EOA (`cast wallet new`, a little ETH), the fee wallet address, `BASESCAN_API_KEY` (optional) — section 2 above.
2. Backend `.env`: `ALCHEMY_API_KEY` (or `RPC_URL_84532`), `AGENT_JOB_ESCROW_ADDRESS_84532`, `REPUTATION_HOOK_ADDRESS_84532`, `ESCROW_EVALUATOR_PRIVATE_KEY`, `BACKEND_PUBLIC_URL` reachable from the internet if the `feedbackURI` / `agentURI` should resolve for third parties, transaction worker enabled.
3. Faucet funds for the two agents of `examples/escrow-erc8183`: ≥ 1 USDC (Circle faucet) on the requester, ~0.0005 ETH on each wallet; then `node examples/escrow-erc8183/index.mjs` against that backend (happy path) and again with `AGENTFI_FLOW=cancel` (failure path: full refund), and record the rows of sections 3 and 4. A contest on testnet needs the backend's `ESCROW_EVALUATION_DELAY_SECONDS` > 0 and a `POST /v1/jobs/:id/contest` inside that window (the fork suite automates it).
