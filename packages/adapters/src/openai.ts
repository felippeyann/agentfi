/**
 * AgentFi OpenAI Function Calling Adapter
 *
 * For agents using OpenAI's function calling API directly (GPT-4, etc.)
 * or any tool-use compatible API (Anthropic, Mistral, Gemini).
 *
 * Usage:
 *   import { getAgentFiTools, handleAgentFiToolCall } from '@agentfi/adapters/openai';
 *
 *   const tools = getAgentFiTools();
 *   // pass tools to openai.chat.completions.create({ tools })
 *
 *   // when a tool_call comes back:
 *   const result = await handleAgentFiToolCall(toolCall.function.name, toolCall.function.arguments, { apiKey });
 */

import { AgentFiClient, type AgentFiConfig } from './client.js';

// OpenAI tool definition format
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; default?: unknown }>;
      required: string[];
    };
  };
}

export function getAgentFiTools(): OpenAITool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'agentfi_get_wallet_info',
        description:
          "Returns the agent's wallet address and current token balances. Call before any transaction to verify available funds.",
        parameters: {
          type: 'object',
          properties: {
            chain_id: {
              type: 'number',
              description: 'Chain ID: 1=Ethereum, 8453=Base, 42161=Arbitrum, 137=Polygon',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_simulate_swap',
        description:
          'Simulates a token swap and returns expected output and gas estimate. MUST be called before agentfi_execute_swap.',
        parameters: {
          type: 'object',
          properties: {
            from_token: { type: 'string', description: 'Token to sell (address or symbol)' },
            to_token: { type: 'string', description: 'Token to buy (address or symbol)' },
            amount_in: { type: 'string', description: 'Amount in human-readable units e.g. "1.5"' },
            chain_id: { type: 'number', description: 'Chain ID', default: 1 },
            slippage_tolerance: {
              type: 'number',
              description: 'Max slippage % e.g. 0.5',
              default: 0.5,
            },
          },
          required: ['from_token', 'to_token', 'amount_in'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_execute_swap',
        description:
          'Executes a token swap. Requires agentfi_simulate_swap to have been called first.',
        parameters: {
          type: 'object',
          properties: {
            from_token: { type: 'string', description: 'Token to sell' },
            to_token: { type: 'string', description: 'Token to buy' },
            amount_in: { type: 'string', description: 'Amount to sell' },
            chain_id: { type: 'number', description: 'Chain ID', default: 1 },
            slippage_tolerance: { type: 'number', description: 'Max slippage % e.g. 0.5', default: 0.5 },
            simulation_id: {
              type: 'string',
              description: 'simulation_id from agentfi_simulate_swap',
            },
          },
          required: ['from_token', 'to_token', 'amount_in', 'simulation_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_transfer_token',
        description: 'Transfers ETH or an ERC-20 token to an address.',
        parameters: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: '"ETH" for native ETH, or ERC-20 contract address',
            },
            to: { type: 'string', description: 'Destination address' },
            amount: { type: 'string', description: 'Amount in human-readable units' },
            chain_id: { type: 'number', description: 'Chain ID. Default: 1 (Ethereum mainnet).', default: 1 },
          },
          required: ['token', 'to', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_deposit_aave',
        description: 'Supplies an asset to Aave V3 to earn yield.',
        parameters: {
          type: 'object',
          properties: {
            asset: { type: 'string', description: 'ERC-20 token address to supply' },
            amount: { type: 'string', description: 'Amount to supply' },
            chain_id: { type: 'number', description: 'Chain ID. Default: 1 (Ethereum mainnet).', default: 1 },
          },
          required: ['asset', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_get_transaction_status',
        description:
          'Returns current status of a submitted transaction. Poll after submitting any transaction.',
        parameters: {
          type: 'object',
          properties: {
            transaction_id: {
              type: 'string',
              description: 'transaction_id returned by swap/transfer/deposit tools',
            },
          },
          required: ['transaction_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'agentfi_get_defi_rates',
        description: 'Returns current Aave V3 supply and borrow APY rates.',
        parameters: {
          type: 'object',
          properties: {
            chain_id: { type: 'number', description: 'Chain ID. Default: 1 (Ethereum mainnet).', default: 1 },
          },
          required: [],
        },
      },
    },
  ];
}

/**
 * Handles a tool call returned by the LLM and routes it to the AgentFi API.
 */
export async function handleAgentFiToolCall(
  toolName: string,
  argumentsJson: string,
  config: AgentFiConfig,
): Promise<string> {
  const client = new AgentFiClient(config);
  const args = JSON.parse(argumentsJson) as Record<string, unknown>;

  const handlers: Record<string, () => Promise<unknown>> = {
    agentfi_get_wallet_info: () => {
      const cid = args['chain_id'];
      return client.get(`/v1/wallet/balance${cid ? `?chainId=${cid}` : ''}`);
    },
    agentfi_simulate_swap: () =>
      client.post('/v1/transactions/simulate', {
        fromToken: args['from_token'],
        toToken: args['to_token'],
        amountIn: args['amount_in'],
        chainId: args['chain_id'] ?? 1,
        slippageTolerance: args['slippage_tolerance'] ?? 0.5,
      }),
    agentfi_execute_swap: () =>
      client.post('/v1/transactions/swap', {
        fromToken: args['from_token'],
        toToken: args['to_token'],
        amountIn: args['amount_in'],
        chainId: args['chain_id'] ?? 1,
        slippageTolerance: args['slippage_tolerance'] ?? 0.5,
      }),
    agentfi_transfer_token: () =>
      client.post('/v1/transactions/transfer', {
        token: args['token'],
        to: args['to'],
        amount: args['amount'],
        chainId: args['chain_id'] ?? 1,
      }),
    agentfi_deposit_aave: () =>
      client.post('/v1/transactions/deposit', {
        asset: args['asset'],
        amount: args['amount'],
        chainId: args['chain_id'] ?? 1,
      }),
    agentfi_get_transaction_status: () =>
      client.get(`/v1/transactions/${args['transaction_id']}`),
    agentfi_get_defi_rates: () =>
      client.get(`/v1/wallet/balance?chainId=${args['chain_id'] ?? 1}`),
  };

  const handler = handlers[toolName];
  if (!handler) {
    return JSON.stringify({ error: `Unknown AgentFi tool: ${toolName}` });
  }

  try {
    const result = await handler();
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}
