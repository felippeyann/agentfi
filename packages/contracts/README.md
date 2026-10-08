# AgentFi Smart Contracts

Solidity contracts for on-chain policy enforcement and fee collection. Built with [Foundry](https://getfoundry.sh).

## Contracts

| Contract | Description |
|----------|-------------|
| **AgentPolicyModule** | Safe module that enforces per-agent transaction policies (value limits, contract whitelists, daily volume caps). Operator-managed. |
| **AgentExecutor** | Proxy that executes batched transactions on behalf of agents, collecting protocol fees atomically. |
| **EscrowModule** | Legacy escrow (ETH + ERC-20, operator-settled). Kept for ETH jobs until retired. |
| **AgentJobEscrow** | ERC-8183 (Agentic Commerce) job escrow, USDC only. Client funds → provider submits → evaluator completes/rejects; `platformFeeBP` accrued on completion and pulled with `withdrawPlatformFees()` (fee wallet rotatable by the operator); permissionless `claimRefund` after expiry; per-job `IACPHook` with strict ERC-165 detection. Operator can only pause creation/funding, rotate the fee wallet and sweep fees. |
| **ReputationHook** | ERC-8183 `IACPHook` that writes ERC-8004 reputation feedback (`giveFeedback`) for the provider in the same tx as `complete` (value 100) or a `reject` carrying the evaluator's quality verdict `REASON_QUALITY_REJECTED` (value 0; contests, cancellations and every other reason write nothing, D9), only for jobs settled by the trusted evaluator, above a minimum budget. Rates one canonical agent id per provider address, verified against the Identity Registry on the provider's first `submit`; a verdict the registry does not record penalizes the id (no further positive entries). Never blocks settlement; `revokeFeedback` / `clearPenalties` for corrections. |
| **IACPHook** / **IReputationRegistry** / **IIdentityRegistry** | Interfaces: the ERC-8183 hook surface (`is IERC165`), and the ERC-8004 Reputation (`giveFeedback`, `revokeFeedback`) and Identity (`ownerOf`, `getAgentWallet`) Registry calls used by the hook. |

## Development

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Build
forge build

# Test
forge test -vvv

# Coverage
forge coverage --report summary
```

## Deployment

See [Contract Deployment Guide](../../docs/operations/contract-deployment.md) for step-by-step instructions.

```bash
# Keystore signer (do not export PRIVATE_KEY; a key in packages/contracts/.env is refused when it
# differs from --account), Etherscan API V2 key for --verify, mandatory chain guard.
cast wallet import agentfi-deployer --interactive
export ETHERSCAN_API_KEY=...

# Policy module + executor (legacy EscrowModule only with DEPLOY_LEGACY_ESCROW_MODULE=true)
EXPECTED_CHAIN_ID=84532 OPERATOR_ADDRESS=0x... FEE_WALLET=0x... EXECUTOR_FEE_BPS=30   forge script script/Deploy.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify

# ERC-8183 escrow + ERC-8004 hook (Base Sepolia first; USDC and registries default per chain)
EXPECTED_CHAIN_ID=84532 OPERATOR_ADDRESS=0x... FEE_WALLET=0x... TRUSTED_EVALUATOR=0x...   forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account agentfi-deployer --broadcast --verify
```

Both scripts refuse to broadcast when `EXPECTED_CHAIN_ID` differs from the RPC's chain id.

## Security

- Solidity 0.8.24 (built-in overflow protection)
- Check-effects-interactions pattern
- No delegatecall vulnerabilities
- Operator access control on policy changes
- SPDX-License-Identifier: MIT

## Chain Support

| Chain | ID | Status |
|-------|----|--------|
| Ethereum | 1 | Supported |
| Base | 8453 | Primary |
| Arbitrum | 42161 | Supported |
| Polygon | 137 | Supported |
