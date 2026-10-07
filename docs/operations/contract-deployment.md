# Contract Deployment — AgentFi

## What will be deployed

| Contract | Function |
|----------|--------|
| `AgentPolicyModule` | Validates agent limits on-chain (kill switch, max value, whitelist) |
| `AgentExecutor` | Executes batches of actions + automatically collects fee |
| `EscrowModule` | Legacy escrow (ETH + ERC-20, operator-settled). Kept for ETH jobs until retired (plan D8) |
| `AgentJobEscrow` | ERC-8183 job escrow (USDC only): client funds, provider submits, evaluator settles; `platformFeeBP` on completion. See [ERC-8183 escrow and ERC-8004 hook](#erc-8183-escrow-and-erc-8004-hook) |
| `ReputationHook` | ERC-8183 `IACPHook` that writes ERC-8004 reputation feedback in the same tx as settlement |

After deployment, every AgentFi transaction passes through `AgentExecutor` which:
1. Executes the swap/transfer/deposit
2. Validates each action against `AgentPolicyModule`
3. Calculates `fee = value * feeBps / 10000`
4. Transfers fee to `feeWallet` in the same tx (atomic — reverts if any action fails)
5. Refunds excess ETH to caller

---

## Prerequisites

### Install Foundry

**Windows (PowerShell):**

```powershell
winget install --id Foundry.Foundryup
```

**macOS / Linux:**

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verify:

```bash
forge --version
# Should show: forge Version: 1.7.1 (or a newer 1.x); 0.2.x is too old for this repo
```

### Install contract dependencies

```bash
cd packages/contracts
forge install foundry-rs/forge-std --no-commit
```

### Get block explorer API keys

| Chain | Explorer | API key URL |
|-------|----------|-------------|
| Ethereum | Etherscan | https://etherscan.io/myapikey |
| Base | Basescan | https://basescan.org/myapikey |
| Arbitrum | Arbiscan | https://arbiscan.io/myapikey |
| Polygon | Polygonscan | https://polygonscan.com/myapikey |

---

## Deployment

### Step 1 — Environment variables

Fund a deployer wallet with native gas token on the target chain. Deployment costs ~$0.50–$2.00 per chain.

```bash
# Private key of the deployer wallet (use a dedicated wallet, not your main one)
export PRIVATE_KEY="0x..."

# Operator address — can set/pause policies on any agent Safe
export OPERATOR_ADDRESS="0x..."

# Wallet that receives protocol fees
export FEE_WALLET="0x..."

# Fee in basis points: 30 = 0.30% (FREE tier)
export FEE_BPS="30"
```

**PowerShell equivalent:**

```powershell
$env:PRIVATE_KEY = "0x..."
$env:OPERATOR_ADDRESS = "0x..."
$env:FEE_WALLET = "0x..."
$env:FEE_BPS = "30"
```

### Step 2 — Run tests

```bash
cd packages/contracts
forge test -vvv
```

All tests must pass before deploying to any chain.

### Step 3 — Deploy

```bash
cd packages/contracts

forge script script/Deploy.s.sol \
  --rpc-url <chain_alias> \
  --broadcast \
  --verify \
  --etherscan-api-key $EXPLORER_API_KEY
```

Replace `<chain_alias>` with one of the configured RPC aliases:

| Alias | Chain | Chain ID |
|-------|-------|----------|
| `mainnet` | Ethereum | 1 |
| `base` | Base | 8453 |
| `arbitrum` | Arbitrum One | 42161 |
| `polygon` | Polygon | 137 |
| `base_sepolia` | Base Sepolia (testnet) | 84532 |
| `arb_sepolia` | Arbitrum Sepolia (testnet) | 421614 |

**RPC aliases require env vars** (set in `foundry.toml`):

```bash
export ALCHEMY_API_KEY_RPC_MAINNET="https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
export ALCHEMY_API_KEY_RPC_BASE="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
export ALCHEMY_API_KEY_RPC_ARB="https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"
export ALCHEMY_API_KEY_RPC_POLYGON="https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
```

Testnets use public endpoints and don't need Alchemy.

### Step 4 — Capture output

The deploy script prints env-ready output:

```
AgentPolicyModule: 0xABCD...
AgentExecutor:     0xEFGH...
EscrowModule:      0xIJKL...

--- Copy to .env ---
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
ESCROW_MODULE_ADDRESS_8453=0xIJKL...
--------------------
```

Copy those lines to your `.env` (local) or hosting provider's secret manager (production).

---

## ERC-8183 escrow and ERC-8004 hook

`AgentJobEscrow` and `ReputationHook` are deployed by a separate script, `script/DeployEscrow.s.sol`, so they can be (re)deployed independently of the policy module and executor. Design references: [erc-8183-mapping.md](../architecture/erc-8183-mapping.md) and [erc-8004-integration.md](../architecture/erc-8004-integration.md); owner decisions D5–D8 in the [execution plan](../project/execution-plan-2026-10.md#0-decisions-locked-on-2026-10-06-owner).

### What the two contracts do

| Contract | Constructor | Role |
|----------|-------------|------|
| `AgentJobEscrow` | `(token, feeWallet, operator, evaluatorFeeBP, platformFeeBP)` | Implements the published ERC-8183 interface verbatim (`createJob`, `setProvider`, `setBudget`, `fund`, `submit`, `complete`, `reject`, `claimRefund`, `getJob` + events). One ERC-20 per contract (USDC). `setProvider` works once only (reverts `ProviderAlreadySet` if a provider is already named). On `complete` the provider receives `budget − platformFee − evaluatorFee`; the platform fee is **accrued** in `pendingPlatformFees` (pull-based) and swept with `withdrawPlatformFees()` by `feeWallet` or `operator`; rejection after funding and expiry refund the client in full. AgentFi extensions outside the standard: `setProviderAgentId` / `providerAgentId(jobId)` (ERC-8004 id, set by the client or the provider, verified by the hook), `submittedAt(jobId)`, `pendingPlatformFees()`, `withdrawPlatformFees()`, `setFeeWallet()` (operator), `pause()` / `unpause()` by `operator` (blocks `createJob` and `fund` only, never settlement, refunds or fee withdrawal), `jobCount()`. |
| `ReputationHook` | `(acp, reputationRegistry, identityRegistry, trustedEvaluator, minFeedbackBudget)` | `IACPHook` attached per job at `createJob(..., hook)`. On `afterAction` for `complete` it calls `giveFeedback(providerAgentId, 100, 0, "agentfi.job", "completed", "", feedbackURI, feedbackHash)`; on `reject` of a job that had been `Submitted` it writes value `0` with tag `"rejected"`. It writes **only** when `job.evaluator == trustedEvaluator`, the Identity Registry reports `ownerOf(agentId)` or `getAgentWallet(agentId)` equal to `job.provider`, and `job.budget >= minFeedbackBudget`; otherwise it emits `FeedbackSkipped(reason)`. `optParams` of `complete`/`reject` must be `abi.encode(string feedbackURI, bytes32 feedbackHash)`. A `reject` with reason `REASON_PAYOUT_BLOCKED = keccak256("agentfi.payout-blocked")` writes nothing. Registry failures emit `FeedbackFailed` and never block settlement. `revokeFeedback(agentId, feedbackIndex)` (trusted evaluator only) forwards to the registry. Only the escrow may call the hook entry points (`onlyACP`). |

Both contracts are non-upgradeable and every constructor parameter is immutable **except the escrow's `feeWallet`**, which the operator can rotate with `setFeeWallet`. Changing the fee bps, the token, the trusted evaluator or the registries means redeploying the escrow (and the hook, since it is bound to the escrow address).

### Environment variables

```bash
export OPERATOR_ADDRESS="0x..."       # may pause/unpause createJob + fund, rotate the fee wallet and sweep fees; cannot move escrowed budgets
export FEE_WALLET="0x..."             # initial receiver of accrued platform fees (withdrawPlatformFees); rotatable later
export TRUSTED_EVALUATOR="0x..."      # backend signer that calls complete/reject (D5); the only evaluator whose jobs write ERC-8004 feedback

# Optional — defaults shown
export FEE_BPS="30"                   # platformFeeBP (D6: 30 bps during validation)
export EVALUATOR_FEE_BPS="0"          # evaluatorFeeBP (D5: evaluator = backend signer, no fee)
export MIN_FEEDBACK_BUDGET="1000000"  # smallest job budget (token units, 1 USDC) that may write feedback
export USDC_ADDRESS="0x..."           # defaults per chain, see table
export REPUTATION_REGISTRY_ADDRESS="0x..."  # defaults per chain, see table
export IDENTITY_REGISTRY_ADDRESS="0x..."    # defaults per chain, see table
# export PRIVATE_KEY="0x..."          # discouraged: prefer `--account <keystore>` / `--ledger` on the forge command (see below)
```

Defaults resolved from `block.chainid` when the variable is unset (any other chain requires all three to be set explicitly):

| Chain | `USDC_ADDRESS` | `REPUTATION_REGISTRY_ADDRESS` (ERC-8004) | `IDENTITY_REGISTRY_ADDRESS` (ERC-8004) |
|-------|----------------|------------------------------------------|----------------------------------------|
| Base (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Base Sepolia (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

The script validates everything **before** broadcasting: `FEE_BPS + EVALUATOR_FEE_BPS` must be below 10 000 (`InvalidFees`), and the token and both registries must have code on the target chain (`NotAContract`). `TRUSTED_EVALUATOR`, `OPERATOR_ADDRESS` and `FEE_WALLET` must be non-zero (constructor `ZeroAddress`).

**Signer.** Import the deployer key once into Foundry's encrypted keystore and pass `--account` instead of exporting `PRIVATE_KEY`:

```bash
cast wallet import agentfi-deployer --interactive     # prompts for the key, stores it encrypted under ~/.foundry/keystores
forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY
```

`--ledger` / `--trezor` / `--private-key` work the same way. When `PRIVATE_KEY` is unset (or `0`) the script calls `vm.startBroadcast()` without a key and Foundry uses the CLI signer; when it is set, the script broadcasts with it (kept for backwards compatibility).

### Deployment order

1. **`AgentJobEscrow`** first — the hook needs its address (`acp`).
2. **`ReputationHook`** second, bound to the escrow and to the ERC-8004 Reputation Registry of the chain.
3. The escrow does **not** store the hook address: the backend passes it per job in `createJob(provider, evaluator, expiredAt, description, hook)`. Deploying a new hook later does not require touching the escrow.

The script does all of it in one broadcast:

```bash
cd packages/contracts
forge test -vvv                                   # must be green

forge script script/DeployEscrow.s.sol \
  --rpc-url base_sepolia \
  --account agentfi-deployer \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

Output (copy to `.env` / hosting secrets):

```
AgentJobEscrow: 0x...
ReputationHook: 0x...

--- Copy to .env ---
AGENT_JOB_ESCROW_ADDRESS_84532=0x...
REPUTATION_HOOK_ADDRESS_84532=0x...
--------------------
```

### Post-deployment checks

```bash
cast call $ESCROW "token()(address)"            --rpc-url $RPC   # == USDC_ADDRESS
cast call $ESCROW "feeWallet()(address)"        --rpc-url $RPC   # == FEE_WALLET
cast call $ESCROW "operator()(address)"         --rpc-url $RPC   # == OPERATOR_ADDRESS
cast call $ESCROW "platformFeeBP()(uint256)"    --rpc-url $RPC   # == FEE_BPS
cast call $ESCROW "evaluatorFeeBP()(uint256)"   --rpc-url $RPC   # == EVALUATOR_FEE_BPS
cast call $ESCROW "paused()(bool)"              --rpc-url $RPC   # false
cast call $ESCROW "pendingPlatformFees()(uint256)" --rpc-url $RPC # 0
cast call $HOOK   "acp()(address)"              --rpc-url $RPC   # == ESCROW
cast call $HOOK   "reputationRegistry()(address)" --rpc-url $RPC # == REPUTATION_REGISTRY_ADDRESS
cast call $HOOK   "identityRegistry()(address)" --rpc-url $RPC   # == IDENTITY_REGISTRY_ADDRESS
cast call $HOOK   "trustedEvaluator()(address)" --rpc-url $RPC   # == TRUSTED_EVALUATOR
cast call $HOOK   "minFeedbackBudget()(uint256)" --rpc-url $RPC  # == MIN_FEEDBACK_BUDGET (1000000)
cast call $HOOK   "supportsInterface(bytes4)(bool)" 0x7ff6bc9e --rpc-url $RPC  # true (IACPHook id)
cast call $HOOK   "supportsInterface(bytes4)(bool)" 0xffffffff --rpc-url $RPC  # false (the escrow probes this too)
```

Note: `0x7ff6bc9e` is the `IACPHook` ERC-165 id (`beforeAction.selector 0xdc08fb1d ^ afterAction.selector 0xa3fe4783`; `IACPHook is IERC165` does not change it). The escrow checks it (and that `0xffffffff` answers `false`) at `createJob`, so a successful `createJob(..., hook)` on testnet is the simplest end-to-end check.

### Backend environment variables (C3)

Once deployed, the backend drives the escrow for paid A2A jobs on that chain ([erc-8183-mapping.md §6](../architecture/erc-8183-mapping.md#6-backend-flow-as-implemented-task-c3)):

| Variable | Required | Meaning |
|----------|----------|---------|
| `AGENT_JOB_ESCROW_ADDRESS_<chainId>` | to enable the chain | `AgentJobEscrow` address from the deploy output. Paid jobs on this chain become USDC-only and escrowed on-chain. |
| `REPUTATION_HOOK_ADDRESS_<chainId>` | optional | `ReputationHook` passed per job to `createJob(..., hook)`; blank → no hook (no ERC-8004 feedback). |
| `ESCROW_EVALUATOR_PRIVATE_KEY` | **yes in staging/production** when any escrow address is set; optional in development (escrow disabled without it, WARN at boot) | Operator key that is the `evaluator` of every job and signs `complete` / `reject` / `claimRefund`. Its address is logged at boot as `escrowEvaluatorAddress` and **must equal the hook's `TRUSTED_EVALUATOR`**, otherwise the hook skips every write (`untrusted-evaluator`). Needs native gas on the chain. |
| `ESCROW_JOB_TTL_SECONDS` | default `604800` | `expiredAt = now + TTL` at `createJob`; the expiry sweep calls `claimRefund` after it. |
| `ESCROW_EVALUATION_DELAY_SECONDS` | default `0` | Grace period after `submit` confirms during which the requester may `POST /v1/jobs/:id/contest`. |
| `BACKEND_PUBLIC_URL` | default `http://localhost:3000` | Base of the on-chain job description, of the `feedbackURI` (`/v1/jobs/<id>/feedback.json`, public) and of every agent's ERC-8004 `agentURI` (`/v1/agents/<id>/erc8004.json`, public). Must be reachable by reputation consumers. |
| `IDENTITY_REGISTRY_ADDRESS_<chainId>` | default: official registry on Base / Base Sepolia | R2: ERC-8004 Identity Registry the providers' identities are minted in (by their own wallet, on their first funded job). **Must be the registry the hook was deployed with** (`cast call $HOOK "identityRegistry()(address)"`), or the hook skips with `agent-not-provider`. No default on other chains: the identity step is `SKIPPED` there. Provider wallets need a little native gas for `register` + `setProviderAgentId`. See [erc-8004-integration.md §7](../architecture/erc-8004-integration.md#7-backend-flow-r2). |
| `MCP_PUBLIC_URL` | optional | R2: public MCP endpoint advertised as the `MCP` service in agent registration files (e.g. `https://api.example.com/mcp/sse`). |

Regenerate the backend ABIs after any Solidity change: `npm run abi:escrow` (or `npm run abi` for every contract) — `abi.erc8183.test.ts` pins the selectors and diffs the checked-in files against the Foundry artifacts when present.

### Operational notes

- **Emergency path.** `pause()` (operator) stops new jobs and new funding. Jobs already funded can still be submitted, completed, rejected and refunded, and fees can still be withdrawn; the operator can never redirect escrowed USDC.
- **Platform fees are pull-based.** `complete` accrues the fee (`PlatformFeeAccrued`); `withdrawPlatformFees()` (by `feeWallet` or the operator) sweeps `pendingPlatformFees()` to the current `feeWallet`. If the fee wallet is frozen by the USDC blacklist or its key is lost, `complete` is unaffected: rotate with `setFeeWallet(new)` (operator, `FeeWalletUpdated`) and withdraw again. The evaluator fee (default 0) is still push-paid inside `complete`; keep `EVALUATOR_FEE_BPS = 0` unless the evaluator address is guaranteed to accept USDC.
- **Blacklisted client or provider (no escape hatch by design).** A blacklisted client makes `reject` (after funding) and `claimRefund` revert; `complete` (pay the provider) is the only exit and the budget otherwise stays escrowed until the client is cleared. A blacklisted provider makes `complete` revert; the evaluator unwinds with `reject(jobId, keccak256("agentfi.payout-blocked"), …)`, which refunds the client and makes the hook skip the negative feedback (`payout-blocked`), or anyone calls `claimRefund` after expiry.
- **Expiry.** `claimRefund(jobId)` is permissionless once `block.timestamp >= expiredAt` for `Funded`/`Submitted` jobs and is never hooked, so no hook failure can trap funds. On a `Submitted` job it **races** the evaluator's `complete`/`reject` once expired (first mined tx wins, the other reverts `InvalidStatus`): the backend must settle before `expiredAt`.
- **Single provider.** `setProvider` only works while `job.provider == address(0)`; a job created with a provider cannot have it changed (`ProviderAlreadySet`).
- **Reputation writes** happen only when all gates pass: the job's evaluator is `TRUSTED_EVALUATOR`, `providerAgentId` is set (by the client **or** the provider, while `Open`/`Funded`; cleared by `setProvider`) **and** the Identity Registry reports that id as owned by, or agent-wallet-bound to, `job.provider`, the budget is at least `MIN_FEEDBACK_BUDGET`, and `optParams` is `abi.encode(feedbackURI, feedbackHash)`. Anything else emits `FeedbackSkipped(jobId, reason)` (`untrusted-evaluator`, `no-params`, `not-submitted`, `payout-blocked`, `no-agent-id`, `budget-too-small`, `bad-params`, `agent-not-provider`) and settlement proceeds. Alert on `FeedbackFailed` (registry revert / no code / out of gas).
- **Correcting a wrong entry.** `ReputationHook.revokeFeedback(agentId, feedbackIndex)` from the `TRUSTED_EVALUATOR` key forwards to the registry (`FeedbackRevoked`). Feedback is otherwise immutable; keep the `feedbackIndex` from the registry's `NewFeedback` event.
- **Reading reputation:** `getSummary(agentId, [REPUTATION_HOOK_ADDRESS], "agentfi.job", "")` on the registry returns only feedback written by the hook, i.e. backed by a settled escrow payment decided by the operator signer for an identity the paid provider controls.

---

## Multi-chain deployment checklist

When expanding beyond a single chain, deploy to each chain separately and track addresses in a central record.

### Per-chain checklist

```
[ ] Deployer wallet funded with gas on chain (imported into the Foundry keystore: `cast wallet import`)
[ ] Explorer API key obtained
[ ] Backend ABI matches the source: `npm run abi:executor` produces no git diff (see "ABI versioning")
[ ] forge test passes
[ ] forge script Deploy.s.sol --rpc-url <alias> --account <keystore> --broadcast --verify
[ ] USDC_ADDRESS / REPUTATION_REGISTRY_ADDRESS / IDENTITY_REGISTRY_ADDRESS known for the chain (defaults exist for Base + Base Sepolia only)
[ ] TRUSTED_EVALUATOR, OPERATOR_ADDRESS, FEE_WALLET exported
[ ] forge script DeployEscrow.s.sol --rpc-url <alias> --account <keystore> --broadcast --verify
[ ] Output addresses recorded (see Address Registry below)
[ ] .env / hosting secrets updated with POLICY_MODULE_ADDRESS_<chainId>, EXECUTOR_ADDRESS_<chainId>,
    AGENT_JOB_ESCROW_ADDRESS_<chainId> and REPUTATION_HOOK_ADDRESS_<chainId>
[ ] Post-deploy verification passed (see Verification section and the escrow/hook cast checks above)
[ ] Backend restarted to pick up new addresses
```

### Recommended deployment order

1. **Base Sepolia** — testnet dry run, free gas from faucet
2. **Base** — primary chain, lowest gas costs
3. **Arbitrum One** — second priority, GMX/perps ecosystem
4. **Polygon** — third priority, low gas
5. **Ethereum Mainnet** — last, highest gas costs

### Fee configuration per chain

Fee BPS is immutable after deployment. Choose based on chain economics:

| Chain | Suggested FEE_BPS | Rationale |
|-------|------------------|-----------|
| Base | 30 (0.30%) | Default tier, low gas |
| Arbitrum | 30 (0.30%) | Default tier, low gas |
| Polygon | 30 (0.30%) | Default tier, very low gas |
| Ethereum | 15 (0.15%) | Lower fee compensates for higher gas |

To change fee BPS on an existing chain, you must redeploy both contracts.

---

## Post-deployment verification

### Manual verification (block explorer)

For each deployed chain, open the contract on the block explorer:

1. Navigate to the `AgentPolicyModule` address → **Contract** → **Read Contract**
   - `operator()` → should return your `OPERATOR_ADDRESS`
   - `hasPolicy(0x...)` → should return `false` for new addresses

2. Navigate to the `AgentExecutor` address → **Contract** → **Read Contract**
   - `feeWallet()` → should return your `FEE_WALLET`
   - `feeBps()` → should return your `FEE_BPS` (e.g. `30`)
   - `policyModule()` → should return the `AgentPolicyModule` address

### Automated verification script

Create a cast-based verification from the repo root:

```bash
#!/usr/bin/env bash
# scripts/verify-deployment.sh
# Usage: ./scripts/verify-deployment.sh <rpc_url> <policy_module_addr> <executor_addr> <expected_operator> <expected_fee_wallet> <expected_fee_bps>

set -euo pipefail

RPC_URL="$1"
POLICY_MODULE="$2"
EXECUTOR="$3"
EXPECTED_OPERATOR="$4"
EXPECTED_FEE_WALLET="$5"
EXPECTED_FEE_BPS="$6"

echo "=== Verifying deployment on $RPC_URL ==="

# AgentPolicyModule checks
ACTUAL_OPERATOR=$(cast call "$POLICY_MODULE" "operator()(address)" --rpc-url "$RPC_URL")
if [ "$ACTUAL_OPERATOR" != "$EXPECTED_OPERATOR" ]; then
  echo "FAIL: operator() = $ACTUAL_OPERATOR, expected $EXPECTED_OPERATOR"
  exit 1
fi
echo "OK: operator() = $ACTUAL_OPERATOR"

# AgentExecutor checks
ACTUAL_FEE_WALLET=$(cast call "$EXECUTOR" "feeWallet()(address)" --rpc-url "$RPC_URL")
if [ "$ACTUAL_FEE_WALLET" != "$EXPECTED_FEE_WALLET" ]; then
  echo "FAIL: feeWallet() = $ACTUAL_FEE_WALLET, expected $EXPECTED_FEE_WALLET"
  exit 1
fi
echo "OK: feeWallet() = $ACTUAL_FEE_WALLET"

ACTUAL_FEE_BPS=$(cast call "$EXECUTOR" "feeBps()(uint256)" --rpc-url "$RPC_URL")
if [ "$ACTUAL_FEE_BPS" != "$EXPECTED_FEE_BPS" ]; then
  echo "FAIL: feeBps() = $ACTUAL_FEE_BPS, expected $EXPECTED_FEE_BPS"
  exit 1
fi
echo "OK: feeBps() = $ACTUAL_FEE_BPS"

ACTUAL_POLICY_MODULE=$(cast call "$EXECUTOR" "policyModule()(address)" --rpc-url "$RPC_URL")
if [ "$ACTUAL_POLICY_MODULE" != "$POLICY_MODULE" ]; then
  echo "FAIL: policyModule() = $ACTUAL_POLICY_MODULE, expected $POLICY_MODULE"
  exit 1
fi
echo "OK: policyModule() = $ACTUAL_POLICY_MODULE"

echo "=== All checks passed ==="
```

---

## ABI versioning

### What changed (October 2026)

`AgentExecutor.Action` gained a `token` field (commit `e0c8025`, 2026-04-06) so that
`executeSingle`/`executeBatch` forward the ERC-20 involved in each action to
`AgentPolicyModule.validateTransaction` for token-whitelist enforcement:

```solidity
struct Action {
    address target;
    uint256 value;
    address token; // NEW — ERC-20 involved (address(0) for pure ETH)
    bytes   data;
}
```

Because the struct is part of the function signature, the 4-byte selectors changed:

| Function | Old selector (`(target,value,data)`) | Current selector (`(target,value,token,data)`) |
|----------|--------------------------------------|-----------------------------------------------|
| `executeSingle` | `0xa60e5271` | `0x596e8b81` |
| `executeBatch`  | `0x34fcd5be` | `0x672093df` |

The backend encodes the **current** struct (as of October 2026). A contract compiled
from the old struct does not dispatch the new selectors, so every transaction routed
through it reverts. `AgentPolicyModule`'s own ABI is unchanged (`validateTransaction`
already took a token — the old executor passed `address(0)`), but `Deploy.s.sol`
always ships a fresh policy module + executor + escrow set, and the backend treats the
old policy module as part of the legacy pair.

### Backend ABI — single source of truth

The backend never hand-writes the executor ABI. It is generated from the Solidity
source into `packages/backend/src/abi/AgentExecutor.abi.ts` and imported by
`executor.service.ts`, the `/v1/transactions/batch` route and the admin batch route.

Regenerate after **any** change to `AgentExecutor.sol` (Foundry in `PATH`):

```bash
npm run abi:executor          # = node scripts/gen-abi.mjs AgentExecutor → forge inspect AgentExecutor abi --json (npm run abi regenerates every contract)
git diff packages/backend/src/abi/AgentExecutor.abi.ts   # commit alongside the Solidity change
```

`packages/backend/src/__tests__/executor.service.test.ts` pins the selectors above and,
when `packages/contracts/out/` exists locally, asserts the checked-in ABI equals the
Foundry artifact. Run `npx vitest run src/__tests__/executor.service.test.ts` from
`packages/backend`.

What the backend sends as `Action.token`: `tokenIn` for Uniswap/Curve swaps, the asset
for Aave/Compound/ERC-4626 deposits and withdrawals, the token for ERC-20 transfers and
approvals, the collateral token for GMX orders, and `address(0)` for pure-ETH transfers.
Raw `/v1/transactions/batch` actions carry their own `token` (default `address(0)`).

### Legacy deployments (old `Action` struct) — do not route through

| Chain | Contract | Address | Status |
|-------|----------|---------|--------|
| Base (8453) | AgentPolicyModule | `0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d` | legacy pair — redeploy pending |
| Base (8453) | AgentExecutor | `0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3` | **ABI-incompatible** — redeploy pending |
| Base Sepolia (84532) | AgentPolicyModule | `0x771444Ff5483ef3A62b492a816Cb439e4f017203` | legacy pair — was hard-coded in `contracts.ts`, now env-only |
| Base Sepolia (84532) | AgentExecutor | `0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d` | **ABI-incompatible** — was hard-coded in `contracts.ts`, now env-only |

Guards in place:

- `packages/backend/src/config/contracts.ts` lists these in `LEGACY_CONTRACT_ADDRESSES`;
  the API logs a **WARN at boot** for every configured legacy address.
- `npm run preflight` **fails** if `EXECUTOR_ADDRESS_<chainId>` is a legacy address or if
  the on-chain bytecode does not contain the current selectors, and warns on a legacy
  policy module.
- Base Sepolia no longer has hard-coded defaults — set `POLICY_MODULE_ADDRESS_84532`,
  `EXECUTOR_ADDRESS_84532`, `ESCROW_MODULE_ADDRESS_84532` after redeploying.

Redeploy order: **Base Sepolia first, then Base mainnet** (standard flow above). Until
the new addresses land, leave `*_ADDRESS_8453` / `*_ADDRESS_84532` unset: the backend
then skips executor routing (`routedViaExecutor=false`, fee recorded off-chain only).

---

## Address registry

### Base Mainnet (Chain 8453) — DEPLOYED, **LEGACY (old `Action` struct) — redeploy pending**

Do not point `EXECUTOR_ADDRESS_8453` at this pair with the current backend; see
[ABI versioning](#abi-versioning). Kept here for history and for fee-event queries.

| Contract | Address |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) — legacy pair |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) — **legacy, ABI-incompatible** |

**Deployer:** `0x2530c24Be25100C3f313D3F6BF36557a7b02A41b`
**Fee Wallet:** `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646`
**Fee BPS:** 30 (0.30%)

### Base Sepolia (Chain 84532) — **LEGACY (old `Action` struct) — redeploy pending**

| Contract | Address |
|----------|---------|
| AgentPolicyModule | `0x771444Ff5483ef3A62b492a816Cb439e4f017203` — legacy pair |
| AgentExecutor | `0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d` — **legacy, ABI-incompatible** |

These were the hard-coded defaults in `packages/backend/src/config/contracts.ts` until
October 2026. The testnet now reads `POLICY_MODULE_ADDRESS_84532` /
`EXECUTOR_ADDRESS_84532` / `ESCROW_MODULE_ADDRESS_84532` from env like every other chain.

### Arbitrum One (Chain 42161) — NOT DEPLOYED

Deploy when GMX adapter ships or when an operator requests Arbitrum support.

### Polygon (Chain 137) — NOT DEPLOYED

Deploy when Aave polygon positions are needed or operator requests it.

### Ethereum Mainnet (Chain 1) — NOT DEPLOYED

Deploy when high-value DeFi positions justify mainnet gas costs.

---

## Safe module installation

After deploying contracts, the `AgentPolicyModule` must be installed as a Safe module on each agent's Safe wallet to enforce policies.

### Backend-managed installation

The backend handles module installation automatically during agent registration when `SAFE_DEPLOYER_PRIVATE_KEY` is set. The flow:

1. `Safe.init({ predictedSafe })` — predict the Safe address
2. `createSafeDeploymentTransaction()` — deploy the Safe
3. Broadcast via viem wallet client
4. `Safe.init({ safeAddress })` — reload the deployed Safe
5. Enable `AgentPolicyModule` as a module on the Safe

### Manual installation (for self-hosted operators)

If operating outside the standard backend flow:

```bash
# Enable the module on a Safe (requires Safe owner signature)
cast send <SAFE_ADDRESS> \
  "enableModule(address)" \
  <POLICY_MODULE_ADDRESS> \
  --rpc-url <rpc_url> \
  --private-key <safe_owner_key>
```

Verify installation:

```bash
cast call <SAFE_ADDRESS> \
  "isModuleEnabled(address)(bool)" \
  <POLICY_MODULE_ADDRESS> \
  --rpc-url <rpc_url>
# Should return: true
```

---

## Disaster recovery

### Wrong parameters at deploy time

Contract constructor parameters (`operator`, `feeWallet`, `feeBps`) are **immutable** — they cannot be changed after deployment. The one exception is `AgentJobEscrow.feeWallet`, which the operator can rotate with `setFeeWallet` (accrued fees then flow to the new wallet). If deployed with wrong values:

1. **Do not** attempt to interact with the misconfigured contracts
2. Update `.env` to remove the incorrect addresses
3. Redeploy with correct parameters (generates new addresses)
4. Update `.env` / hosting secrets with the new addresses
5. Restart the backend

The old contracts remain on-chain but are harmless if nothing points to them.

### Deploy script fails mid-transaction

Foundry's `--broadcast` flag creates a transaction log in `packages/contracts/broadcast/`. If the script fails partway:

1. Check `broadcast/Deploy.s.sol/<chainId>/run-latest.json` for which contracts deployed
2. If `AgentPolicyModule` deployed but `AgentExecutor` didn't:
   - You can redeploy just the executor by modifying the script, or
   - Redeploy both (cleaner — the orphaned PolicyModule is harmless)
3. Never use a partially-deployed set (executor without its policy module)

### Emergency pause

If an agent is compromised or behaving unexpectedly:

```bash
# Pause a specific agent's policy (blocks all transactions)
cast send <POLICY_MODULE_ADDRESS> \
  "emergencyPause(address)" \
  <AGENT_SAFE_ADDRESS> \
  --rpc-url <rpc_url> \
  --private-key <operator_private_key>
```

Resume after investigation:

```bash
cast send <POLICY_MODULE_ADDRESS> \
  "resume(address)" \
  <AGENT_SAFE_ADDRESS> \
  --rpc-url <rpc_url> \
  --private-key <operator_private_key>
```

### Contract redeployment (fee BPS change)

To change the fee structure on an existing chain:

1. Deploy new contracts with updated `FEE_BPS`
2. Update `.env` with new addresses
3. Restart the backend — new transactions route through the new executor
4. Existing agent Safe policies must be re-set on the new PolicyModule
5. Old contracts continue to exist but stop receiving traffic

---

## Fee monitoring

### Check fee wallet balance

```bash
# ETH balance of the fee wallet
cast balance <FEE_WALLET> --rpc-url <rpc_url>

# In human-readable ETH
cast balance <FEE_WALLET> --rpc-url <rpc_url> --ether
```

### Query fee events from the executor

```bash
# Get all FeeCollected events from the executor
cast logs \
  --from-block <deploy_block> \
  --address <EXECUTOR_ADDRESS> \
  "FeeCollected(address,uint256)" \
  --rpc-url <rpc_url>
```

### Admin dashboard

The backend admin API exposes aggregated revenue data:

```bash
curl -H "x-admin-key: $ADMIN_SECRET" \
  https://api.yourdomain.com/admin/revenue
```

Returns fee breakdown by tier, total fees collected in USD, and recent fee events.

---

## How fee routing works

Without contracts deployed:
```
Agent → Uniswap → receives tokens
Fee: recorded in database only (no on-chain collection)
```

With contracts deployed:
```
Agent → AgentExecutor → Uniswap → receives tokens
                      ↓
              feeBps% goes to feeWallet atomically
```

The backend detects deployed addresses via `POLICY_MODULE_ADDRESS_<chainId>` and `EXECUTOR_ADDRESS_<chainId>` env vars and automatically routes transactions through the executor.

---

## Foundry configuration reference

From `packages/contracts/foundry.toml`:

| Setting | Value |
|---------|-------|
| Solidity | 0.8.24 |
| Optimizer | Enabled, 200 runs |
| via_ir | Disabled |
| Fuzz runs (local) | 256 |
| Fuzz runs (CI) | 1000 |

RPC endpoints and etherscan integrations are configured for all supported chains. See the file for env var names.
