# Contract Deployment — AgentFi

## What will be deployed

| Contract | Function |
|----------|--------|
| `AgentPolicyModule` | Validates agent limits on-chain (kill switch, max value, whitelist) |
| `AgentExecutor` | Executes batches of actions + automatically collects fee |
| `EscrowModule` | Holds A2A job payment funds in on-chain custody (lock/release/refund) |

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
# Should show: forge 0.2.x (...)
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

--- Copy to .env ---
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
--------------------
```

Copy those lines to your `.env` (local) or hosting provider's secret manager (production).

---

## Multi-chain deployment checklist

When expanding beyond a single chain, deploy to each chain separately and track addresses in a central record.

### Per-chain checklist

```
[ ] Deployer wallet funded with gas on chain
[ ] Explorer API key obtained
[ ] forge test passes
[ ] forge script Deploy.s.sol --rpc-url <alias> --broadcast --verify
[ ] Output addresses recorded (see Address Registry below)
[ ] .env / hosting secrets updated with POLICY_MODULE_ADDRESS_<chainId> and EXECUTOR_ADDRESS_<chainId>
[ ] Post-deploy verification passed (see Verification section)
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

## Address registry

### Base Mainnet (Chain 8453) — DEPLOYED

| Contract | Address |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) |

**Deployer:** `0x2530c24Be25100C3f313D3F6BF36557a7b02A41b`
**Fee Wallet:** `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646`
**Fee BPS:** 30 (0.30%)

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

Contract constructor parameters (`operator`, `feeWallet`, `feeBps`) are **immutable** — they cannot be changed after deployment. If deployed with wrong values:

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
