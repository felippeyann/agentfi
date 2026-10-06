# AgentFi Smart Contracts

Solidity contracts for on-chain policy enforcement and fee collection. Built with [Foundry](https://getfoundry.sh).

## Contracts

| Contract | Description |
|----------|-------------|
| **AgentPolicyModule** | Safe module that enforces per-agent transaction policies (value limits, contract whitelists, daily volume caps). Operator-managed. |
| **AgentExecutor** | Proxy that executes batched transactions on behalf of agents, collecting protocol fees atomically. |
| **EscrowModule** | Legacy escrow (ETH + ERC-20, operator-settled). Kept for ETH jobs until retired. |
| **AgentJobEscrow** | ERC-8183 (Agentic Commerce) job escrow, USDC only. Client funds → provider submits → evaluator completes/rejects; `platformFeeBP` taken on completion; permissionless `claimRefund` after expiry; per-job `IACPHook`. Operator can only pause creation/funding. |
| **ReputationHook** | ERC-8183 `IACPHook` that writes ERC-8004 reputation feedback (`giveFeedback`) for the provider in the same tx as `complete`/`reject`. Never blocks settlement. |
| **IACPHook** / **IReputationRegistry** | Interfaces: the ERC-8183 hook surface (with ERC-165 expectation) and the ERC-8004 Reputation Registry call used by the hook. |

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
# Deploy to Base (example)
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify

# Deploy the ERC-8183 escrow + ERC-8004 hook (Base Sepolia first; USDC and registry default per chain)
forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --broadcast --verify
```

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
