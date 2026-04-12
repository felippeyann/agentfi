# AgentFi Smart Contracts

Solidity contracts for on-chain policy enforcement and fee collection. Built with [Foundry](https://getfoundry.sh).

## Contracts

| Contract | Description |
|----------|-------------|
| **AgentPolicyModule** | Safe module that enforces per-agent transaction policies (value limits, contract whitelists, daily volume caps). Operator-managed. |
| **AgentExecutor** | Proxy that executes batched transactions on behalf of agents, collecting protocol fees atomically. |

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
