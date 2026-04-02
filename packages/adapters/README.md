# @agentfi/adapters

Framework adapters for the AgentFi DeFi toolset. Provides ready-made tool definitions for the most common LLM orchestration frameworks so your agent can execute DeFi transactions with minimal boilerplate.

## Supported frameworks

| Adapter | Import |
|---------|--------|
| OpenAI function calling / Anthropic tool use | `@agentfi/adapters/openai` |
| LangChain | `@agentfi/adapters/langchain` |
| ElizaOS | `@agentfi/adapters/eliza` |
| Native MCP (stdio/SSE) | `packages/mcp-server` (run directly) |

---

## Installation

```bash
npm install @agentfi/adapters
```

Set your API key:

```bash
AGENTFI_API_KEY=agfi_live_your_key_here
```

---

## OpenAI / Anthropic

```typescript
import { getAgentFiTools, handleAgentFiToolCall } from '@agentfi/adapters/openai';
import OpenAI from 'openai';

const client = new OpenAI();
const tools = getAgentFiTools();

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Swap 0.1 ETH for USDC on Base' }],
  tools,
});

// Handle tool calls
for (const toolCall of response.choices[0]?.message?.tool_calls ?? []) {
  const result = await handleAgentFiToolCall(
    toolCall.function.name,
    toolCall.function.arguments,
    { apiKey: process.env.AGENTFI_API_KEY! },
  );
  console.log(result);
}
```

The same adapter works for Anthropic, Mistral, Gemini, and any other OpenAI-compatible tool-use API.

---

## LangChain

```typescript
import { getAgentFiLangChainTools } from '@agentfi/adapters/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents';

const tools = getAgentFiLangChainTools({
  apiKey: process.env.AGENTFI_API_KEY!,
});

const llm = new ChatOpenAI({ model: 'gpt-4o' });
const agent = await createOpenAIToolsAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const result = await executor.invoke({ input: 'What is my ETH balance on Base?' });
```

---

## ElizaOS

```typescript
import { agentFiPlugin } from '@agentfi/adapters/eliza';

// In your ElizaOS agent config:
export default {
  plugins: [
    agentFiPlugin({
      apiKey: process.env.AGENTFI_API_KEY!,
    }),
  ],
};
```

---

## Available tools

All adapters expose the same 10 tools:

| Tool | What it does |
|------|-------------|
| `agentfi_get_wallet_info` | Wallet address + token balances |
| `agentfi_get_token_price` | USD price for any token via CoinGecko |
| `agentfi_simulate_swap` | Dry-run a token swap before executing |
| `agentfi_execute_swap` | Swap tokens via Uniswap V3 |
| `agentfi_transfer_token` | Send ETH or any ERC-20 token |
| `agentfi_deposit_aave` | Supply assets to Aave V3 for yield |
| `agentfi_withdraw_aave` | Withdraw assets from Aave V3 |
| `agentfi_get_defi_rates` | Current APY for Aave lending markets |
| `agentfi_get_transaction_status` | Poll status of a submitted transaction |
| `agentfi_get_policy` | Inspect the agent's operational limits |

---

## Supported chains

| Chain | ID |
|-------|----|
| Ethereum Mainnet | 1 |
| Base | 8453 |
| Arbitrum One | 42161 |
| Polygon | 137 |

---

## Self-hosted backend

By default the adapters call the hosted AgentFi API. To point them at your own deployment:

```typescript
const tools = getAgentFiTools({
  baseUrl: 'https://your-agentfi-instance.example.com',
  apiKey: 'agfi_live_your_key',
});
```

---

## License

[Apache 2.0](../../LICENSE)
