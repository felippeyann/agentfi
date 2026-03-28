/**
 * AgentFi LangChain Toolkit
 *
 * Usage:
 *   import { AgentFiToolkit } from '@agentfi/adapters/langchain';
 *   const tools = new AgentFiToolkit({ apiKey: 'agfi_live_...' }).getTools();
 */

import { AgentFiClient, type AgentFiConfig } from './client.js';

// LangChain Tool interface (duck-typed to avoid hard dependency)
interface LangChainTool {
  name: string;
  description: string;
  call(input: string): Promise<string>;
}

function makeTool(
  name: string,
  description: string,
  handler: (input: Record<string, unknown>) => Promise<unknown>,
): LangChainTool {
  return {
    name,
    description,
    async call(input: string): Promise<string> {
      try {
        const parsed = JSON.parse(input) as Record<string, unknown>;
        const result = await handler(parsed);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
  };
}

export class AgentFiToolkit {
  private client: AgentFiClient;

  constructor(config: AgentFiConfig) {
    this.client = new AgentFiClient(config);
  }

  getTools(): LangChainTool[] {
    const c = this.client;

    return [
      makeTool(
        'agentfi_get_wallet_info',
        'Get wallet address and token balances. Input: {"chain_id": 1}',
        async (input) => {
          const chainId = (input['chain_id'] as number | undefined)?.toString();
          const path = chainId
            ? `/v1/wallet/balance?chainId=${chainId}`
            : '/v1/wallet/balance';
          return c.get(path);
        },
      ),

      makeTool(
        'agentfi_simulate_swap',
        'Simulate a token swap. ALWAYS call before agentfi_execute_swap. ' +
        'Input: {"from_token":"0x...", "to_token":"0x...", "amount_in":"1.0", "chain_id":1, "slippage_tolerance":0.5}',
        async (input) =>
          c.post('/v1/transactions/simulate', {
            fromToken: input['from_token'],
            toToken: input['to_token'],
            amountIn: input['amount_in'],
            chainId: input['chain_id'] ?? 1,
            slippageTolerance: input['slippage_tolerance'] ?? 0.5,
          }),
      ),

      makeTool(
        'agentfi_execute_swap',
        'Execute a token swap after simulation. ' +
        'Input: {"from_token":"0x...", "to_token":"0x...", "amount_in":"1.0", "chain_id":1, "slippage_tolerance":0.5, "simulation_id":"..."}',
        async (input) =>
          c.post('/v1/transactions/swap', {
            fromToken: input['from_token'],
            toToken: input['to_token'],
            amountIn: input['amount_in'],
            chainId: input['chain_id'] ?? 1,
            slippageTolerance: input['slippage_tolerance'] ?? 0.5,
          }),
      ),

      makeTool(
        'agentfi_transfer',
        'Transfer ETH or ERC-20 token. Input: {"token":"ETH","to":"0x...","amount":"0.1","chain_id":1}',
        async (input) =>
          c.post('/v1/transactions/transfer', {
            token: input['token'],
            to: input['to'],
            amount: input['amount'],
            chainId: input['chain_id'] ?? 1,
          }),
      ),

      makeTool(
        'agentfi_deposit_aave',
        'Supply asset to Aave V3 to earn yield. Input: {"asset":"0x...","amount":"100","chain_id":1}',
        async (input) =>
          c.post('/v1/transactions/deposit', {
            asset: input['asset'],
            amount: input['amount'],
            chainId: input['chain_id'] ?? 1,
          }),
      ),

      makeTool(
        'agentfi_transaction_status',
        'Get transaction status. Input: {"transaction_id":"..."}',
        async (input) => c.get(`/v1/transactions/${input['transaction_id']}`),
      ),

      makeTool(
        'agentfi_defi_rates',
        'Get current Aave supply/borrow APY rates. Input: {"chain_id":1}',
        async (input) => c.get(`/v1/wallet/balance?chainId=${input['chain_id'] ?? 1}`),
      ),
    ];
  }
}
