# Testnet log — Base Sepolia (chain 84532)

> Evidence file for gates G2 and G5 of the [execution plan](execution-plan-2026-10.md). One row per on-chain action by the maintainer or the backend: addresses and transaction hashes only, never keys. Created 2026-10-06; empty until C4 runs.

## 1. Deployments (task C4)

| Date | Contract | Address | Deploy tx | Deployer | Notes |
|---|---|---|---|---|---|
| pending | `AgentPolicyModule` | | | | `script/Deploy.s.sol` (new `Action` struct pair) |
| pending | `AgentExecutor` | | | | same broadcast; `FEE_BPS=30` |
| pending | `AgentJobEscrow` | | | | `script/DeployEscrow.s.sol`; token USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; `platformFeeBP=30`, `evaluatorFeeBP=0` |
| pending | `ReputationHook` | | | | bound to the escrow; `trustedEvaluator` = backend evaluator EOA; `minFeedbackBudget=1000000` |

Constructor parameters actually used (fill in after the broadcast): `OPERATOR_ADDRESS`, `FEE_WALLET`, `TRUSTED_EVALUATOR`, `FEE_BPS`, `EVALUATOR_FEE_BPS`, `MIN_FEEDBACK_BUDGET`, `REPUTATION_REGISTRY_ADDRESS` (default `0x8004B663056A597Dffe9eCcC1965A193B7388713`), `IDENTITY_REGISTRY_ADDRESS` (default `0x8004A818BFB912233c491871b3d84c89A494BD9e`).

## 2. C4 runbook (owner runs it; the agent prepared it)

Prerequisites on the maintainer's machine (checked 2026-10-06): Foundry 1.7.1 at `~/.foundry/bin`; no `.env` and no keystore yet. Full reference: [docs/operations/contract-deployment.md](../operations/contract-deployment.md), sections "Deployment" and "ERC-8183 escrow and ERC-8004 hook".

1. **Keys and addresses (testnet only).**
   - Deployer EOA with Base Sepolia ETH (about 0.05 ETH covers both scripts; faucets: Coinbase Developer Platform faucet, Alchemy Base Sepolia faucet).
   - Backend evaluator EOA: generate a fresh key with `cast wallet new`, fund it with a little test ETH (it pays gas for `complete`/`reject`/`claimRefund`). This is the `TRUSTED_EVALUATOR` of the hook and the `ESCROW_EVALUATOR_PRIVATE_KEY` of the backend (C3). On testnet it is acceptable to also use it as `OPERATOR_ADDRESS`; on mainnet use separate keys.
   - `FEE_WALLET` = the address you want fees swept to (`OPERATOR_FEE_WALLET` in the backend `.env`).
   - `BASESCAN_API_KEY` for verification (optional but recommended).
2. **Signer.** Preferred: `cast wallet import agentfi-deployer --interactive` (encrypted keystore, key never in the environment). `Deploy.s.sol` only reads `PRIVATE_KEY` from the environment, so for step 4 export it in the shell session (or put it in `packages/contracts/.env`, which is git-ignored) and unset it afterwards.
3. **Tests.** In `packages/contracts`: `forge test` must show 291 passed.
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
