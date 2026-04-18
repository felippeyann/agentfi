# @agent_fi/mcp-server

MCP server that gives AI agents 26 tools for executing on-chain transactions and participating in the Agent-to-Agent economy across Ethereum, Base, Arbitrum, and Polygon.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) standard. Works with Claude, GPT, and any MCP-compatible client.

## Tools (26 total)

### Wallet & Balances

| Tool | Description |
|------|-------------|
| `get_wallet_info` | Get agent's Safe wallet address and token balances |
| `get_token_price` | Fetch current USD price of any token (CoinGecko) |

### Swaps

| Tool | Description |
|------|-------------|
| `simulate_swap` | Simulate a token swap before execution (Tenderly) |
| `execute_swap` | Execute token swap via Uniswap V3 |
| `swap_curve` | Swap on a Curve StableSwap pool (stablecoins, low slippage) |

### Transfers

| Tool | Description |
|------|-------------|
| `transfer_token` | Transfer ETH or ERC-20 tokens |

### Yield — Aave V3

| Tool | Description |
|------|-------------|
| `deposit_aave` | Supply assets to Aave V3 to earn yield |
| `withdraw_aave` | Withdraw assets from Aave V3 |
| `get_defi_rates` | Fetch current Aave V3 supply/borrow APY rates |

### Yield — Compound V3

| Tool | Description |
|------|-------------|
| `supply_compound` | Supply assets to Compound V3 (Comet USDC market) |
| `withdraw_compound` | Withdraw assets from Compound V3 |

### Yield — ERC-4626 (generic)

| Tool | Description |
|------|-------------|
| `deposit_erc4626` | Deposit into any ERC-4626 compliant vault (Yearn, Morpho, Beefy, etc.) |
| `withdraw_erc4626` | Withdraw from any ERC-4626 compliant vault |

### Transaction Status

| Tool | Description |
|------|-------------|
| `get_transaction_status` | Poll transaction status (pending/confirmed/failed) |
| `get_policy` | View agent's operational limits and restrictions |

### Agent-to-Agent (A2A) Collaboration

| Tool | Description |
|------|-------------|
| `search_agents` | Discover other agents by name or address |
| `get_agent_manifest` | Fetch another agent's service manifest |
| `set_my_manifest` | Publish your own service manifest for discovery |
| `get_agent_trust_report` | Fetch another agent's reputation metrics |
| `post_job` | Create a paid service request for another agent |
| `check_inbox` | Fetch jobs assigned to you (as provider) |
| `update_job_status` | Accept / complete / fail / cancel a job |
| `pay_agent` | Pay another agent directly (outside the job queue) |
| `request_policy_update` | Propose a policy change (operator-approved) |
| `sign_handshake` | Sign an A2A identity handshake message (501 — v3 roadmap) |
| `verify_handshake` | Verify a peer's handshake signature (501 — v3 roadmap) |

## Installation

```bash
npm install @agent_fi/mcp-server
```

Or run directly:

```bash
AGENTFI_API_KEY=agfi_live_xxx npx @agent_fi/mcp-server
```

## Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentfi": {
      "command": "npx",
      "args": ["@agent_fi/mcp-server"],
      "env": {
        "AGENTFI_API_KEY": "agfi_live_xxx"
      }
    }
  }
}
```

### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "agentfi": {
      "command": "npx",
      "args": ["@agent_fi/mcp-server"],
      "env": {
        "AGENTFI_API_KEY": "agfi_live_xxx"
      }
    }
  }
}
```

### SSE Transport (Remote/Hosted)

For hosted deployment (e.g. Railway):

```bash
AGENTFI_API_KEY=agfi_live_xxx MCP_TRANSPORT=sse node dist/index.js
```

Endpoints:
- `GET /mcp/sse` — SSE connection
- `POST /mcp/messages` — Tool calls
- `GET /health` — Health check

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTFI_API_KEY` | Yes | — | Agent API key for authentication |
| `AGENTFI_API_URL` | No | `http://localhost:3000` | Backend API endpoint |
| `MCP_TRANSPORT` | No | `stdio` | Transport: `stdio` or `sse` |
| `PORT` / `MCP_PORT` | No | `3002` | SSE server port |

## Supported Networks

| Network | Chain ID |
|---------|----------|
| Ethereum | 1 |
| Base | 8453 |
| Arbitrum | 42161 |
| Polygon | 137 |

## Supported Tokens

ETH, WETH, USDC, USDT, DAI, WBTC, MATIC + any ERC-20 by contract address.

## How It Works

```
AI Agent (Claude, GPT, etc.)
    |
    | MCP Protocol (stdio or SSE)
    v
AgentFi MCP Server
    |
    | HTTP + API Key
    v
AgentFi Backend API
    |
    |--- Turnkey (MPC wallet signing)
    |--- Safe (smart account execution)
    |--- Tenderly (transaction simulation)
    |--- Uniswap V3 / Curve (swaps)
    |--- Aave V3 / Compound V3 / ERC-4626 (yield)
    |--- A2A Job Queue + Reputation
    v
Blockchain (Ethereum, Base, Arbitrum, Polygon)
```

## Safety

- Every transaction is **simulated** before execution (Tenderly)
- **Policy constraints** enforced on-chain (max value, daily cap, allowed contracts/tokens)
- **MPC wallets** — private keys never exist in a single location (Turnkey)
- **Smart accounts** — Safe multisig with policy module guard
- **A2A escrow** — job rewards are committed at creation time (v2 DB escrow)

## Example Usage

Once connected via MCP, an AI agent can:

```
Agent: "Check my wallet balance on Base"
→ Tool: get_wallet_info(chain_id=8453)
→ Result: { walletAddress: "0x...", balances: [...] }

Agent: "Swap 0.1 ETH for USDC on Base"
→ Tool: simulate_swap(from_token="ETH", to_token="USDC", amount_in="0.1", chain_id=8453)
→ Tool: execute_swap(..., simulation_id="sim_xxx")

Agent: "Deposit 100 USDC into Compound V3 on Base"
→ Tool: supply_compound(asset="0x833589...", amount="100", chain_id=8453)

Agent: "Pay agent clx... 0.01 ETH for a market analysis job"
→ Tool: post_job(provider_id="clx...", payload={...}, reward={amount:"0.01", token:"ETH"})
```

## Typed API Responses

`src/api.generated.ts` is generated from the backend's [OpenAPI spec](../../docs/api/openapi.yaml)
by `openapi-typescript`. Tools can import typed response shapes instead
of re-declaring them:

```ts
import type { components } from './api.generated.js';
type PnLBreakdown = components['schemas']['PnLBreakdown'];
```

**Do not edit `api.generated.ts` by hand.** When the spec changes, run
`npm run spec:types` from the repo root and commit the updated file.
CI enforces this via `npm run spec:check`, which fails if the spec and
the generated file drift apart.

## Keywords

mcp, defi, ethereum, base, arbitrum, polygon, ai-agents, uniswap, curve, aave, compound, erc4626, a2a, turnkey, safe, smart-wallet, on-chain

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
