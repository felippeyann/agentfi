# AgentFi Agent Quickstart

Get an AI agent executing DeFi transactions in under 5 minutes.

## 1. Install the MCP Server

```bash
npx @agentfi/mcp-server
```

Or add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentfi": {
      "command": "npx",
      "args": ["@agentfi/mcp-server"],
      "env": {
        "AGENTFI_API_KEY": "agfi_live_your_key_here"
      }
    }
  }
}
```

## 2. Register an Agent (get your API key)

```bash
curl -X POST https://api.agentfi.xyz/v1/agents \
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
