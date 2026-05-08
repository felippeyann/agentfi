# AgentFi Agent Quickstart

Get an AI agent executing DeFi transactions in under 5 minutes.

## 1. Connect to the MCP Server

For Claude Desktop, the lowest-friction path is the local stdio MCP server:

```json
{
  "mcpServers": {
    "agentfi": {
      "command": "npx",
      "args": ["-y", "@agent_fi/mcp-server@0.3.0"],
      "env": {
        "AGENTFI_API_URL": "https://agentfi-develop.up.railway.app",
        "AGENTFI_API_KEY": "agfi_live_your_key_here"
      }
    }
  }
}
```

On native Windows, use `cmd /c npx` as shown by
[`npm run demo:claude-mcp`](../demos/claude-desktop-mcp.md).

For MCP-compatible clients that support remote SSE directly, a hosted AgentFi
MCP deployment can expose `/mcp/sse`.

To run from a local checkout instead of npm:

```bash
git clone https://github.com/felippeyann/agentfi
cd agentfi && npm install
cd packages/mcp-server && npm run dev
```

## 2. Register an Agent (get your API key)

```bash
curl -X POST https://agentfi-develop.up.railway.app/v1/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "chainIds": [1, 8453]}'
```

Response includes your `apiKey` — shown **once**, store it securely.

## 3. Your Agent Can Now Execute Transactions

The agent receives a Safe smart wallet automatically. Example Claude prompt:

> "Check my ETH balance and swap 0.1 ETH to USDC on Ethereum."

The agent will:
1. Call `get_wallet_info` to see current balance
2. Call `simulate_swap` to verify the trade
3. Call `execute_swap` with the simulation ID
4. Call `get_transaction_status` to confirm

For an end-to-end local Claude Desktop walkthrough that avoids real funds, use
the [Claude Desktop MCP Demo](../demos/claude-desktop-mcp.md).

## Fee Structure

| Tier | Monthly | Protocol Fee | Tx Limit |
|------|---------|-------------|----------|
| FREE | $0 | 0.30% | 100/month |
| PRO | $99 | 0.15% | 10,000/month |
| ENTERPRISE | Custom | 0.05% | Unlimited |

## Security Guarantees

- Private keys never leave Turnkey MPC infrastructure
- All transactions simulated before submission
- Operator kill switch available per agent
- Policy whitelists for contracts, tokens, and max values
