# Contract Deployment — AgentFi on Base

## What will be deployed

| Contract | Function |
|----------|--------|
| `AgentPolicyModule` | Validates agent limits on-chain (kill switch, max value, whitelist) |
| `AgentExecutor` | Executes batches of actions + automatically collects fee → sends to your wallet |

After deployment, every AgentFi transaction passes through `AgentExecutor` which:
1. Executes the swap/transfer/deposit
2. Calculates `fee = value * 30bps / 10000`
3. Transfers fee to `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646` in the same tx
4. Returns any excess to the agent

---

## STEP 1 — Install Foundry (Windows)

Open PowerShell as Administrator and run:

```powershell
# Install via winget (simplest on Windows)
winget install --id Foundry.Foundryup

# Or via curl (Git Bash / WSL)
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Verify:
```powershell
forge --version
# Should show: forge 0.2.x (...)
```

If `forge` is not recognized after installing, close and reopen the terminal.

---

## STEP 2 — Install contract dependencies

```powershell
cd "packages/contracts"
forge install foundry-rs/forge-std --no-commit
```

---

## STEP 3 — Environment variables for deployment

You need a wallet with ETH on Base to pay for gas.
Deployment costs ~$0.50-$2.00 on Base.

Open PowerShell and define the variables:

```powershell
# Private key of the wallet that will pay for gas
# ATTENTION: use a wallet only for deployment, not your main one
$env:PRIVATE_KEY = "0xYOUR_PRIVATE_KEY_HERE"

# Your MetaMask address (operator — can pause agents)
$env:OPERATOR_ADDRESS = "0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646"

# Wallet that receives fees (same as OPERATOR_FEE_WALLET)
$env:FEE_WALLET = "0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646"

# Fee in basis points: 30 = 0.30% (FREE tier)
$env:FEE_BPS = "30"
```

---

## STEP 4 — Test locally before deploying

```powershell
cd "packages/contracts"
forge test -vvv
```

All tests must pass before deploying.

---

## STEP 5 — Deploy on Base

```powershell
cd "packages/contracts"

forge script script/Deploy.s.sol `
  --rpc-url https://mainnet.base.org `
  --broadcast `
  --verify `
  --etherscan-api-key YOUR_BASESCAN_API_KEY
```

> To get a free Basescan API key: https://basescan.org/myapikey

The output will show something like this:
```
AgentPolicyModule: 0xABCD...
AgentExecutor:     0xEFGH...

--- Copy to .env ---
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
```

---

## STEP 6 — Update the .env

Copy the lines printed in the output to the `.env` file:

```
POLICY_MODULE_ADDRESS_8453=0xABCD...
EXECUTOR_ADDRESS_8453=0xEFGH...
```

---

## STEP 7 — Verify the deployment

After deploying, verify the contracts on Basescan:
- `AgentPolicyModule`: https://basescan.org/address/0xABCD...
- `AgentExecutor`: https://basescan.org/address/0xEFGH...

Click on "Contract" → "Read Contract" and verify:
- `feeWallet()` → should return your address
- `feeBps()` → should return `30`
- `operator()` → should return your address (in PolicyModule)

---

## How fee works after deployment

Before deployment (now):
```
Agent → Uniswap → receives USDC
Fee: registered in the database but not transferred on-chain
```

After deployment:
```
Agent → AgentExecutor → Uniswap → receives USDC
                      ↓
              0.30% goes to 0xD73d0c... in the same tx
```

The backend will automatically detect the deployed addresses via `.env`
and route all transactions through `AgentExecutor`.

---

## Deployed Contracts (Base Mainnet — Chain 8453)

| Contract | Address |
|----------|---------|
| AgentPolicyModule | [`0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d`](https://basescan.org/address/0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d) |
| AgentExecutor | [`0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3`](https://basescan.org/address/0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3) |

**Deployer:** `0x2530c24Be25100C3f313D3F6BF36557a7b02A41b`
**Fee Wallet:** `0xD73d0cBF9C3fa2932eA54b6dfe70fa7e45bF8646`
**Fee BPS:** 30 (0.30%)

---

## Deployment on other networks

```powershell
# Ethereum Mainnet
forge script script/Deploy.s.sol --rpc-url mainnet --broadcast --verify

# Arbitrum One
forge script script/Deploy.s.sol --rpc-url arbitrum --broadcast --verify

# Polygon
forge script script/Deploy.s.sol --rpc-url polygon --broadcast --verify
```

After each deployment, update `.env` with the new addresses and add them to Railway.
