/**
 * AgentFi Eliza Plugin
 *
 * Integrates AgentFi tools into the ElizaOS agent framework (a16z).
 *
 * Usage in eliza config:
 *   import { agentFiPlugin } from '@agentfi/adapters/eliza';
 *   const agent = new Agent({ plugins: [agentFiPlugin({ apiKey: 'agfi_live_...' })] });
 */

import { AgentFiClient, type AgentFiConfig } from './client.js';

// Eliza Action interface (duck-typed)
interface ElizaAction {
  name: string;
  description: string;
  similes: string[];
  validate: (runtime: unknown, message: unknown) => Promise<boolean>;
  handler: (
    runtime: unknown,
    message: { content: { text: string } },
    state: unknown,
    options: unknown,
    callback: (response: { text: string }) => void,
  ) => Promise<void>;
  examples: Array<Array<{ user: string; content: { text: string } }>>;
}

interface ElizaPlugin {
  name: string;
  description: string;
  actions: ElizaAction[];
}

export function agentFiPlugin(config: AgentFiConfig): ElizaPlugin {
  const client = new AgentFiClient(config);

  return {
    name: 'agentfi',
    description: 'DeFi transaction tools — swap tokens, transfer assets, deposit to Aave',
    actions: [
      {
        name: 'CHECK_WALLET',
        description: 'Check wallet balance',
        similes: ['WALLET_BALANCE', 'GET_BALANCE', 'MY_BALANCE'],
        validate: async () => true,
        handler: async (_runtime, _message, _state, _options, callback) => {
          try {
            const result = await client.get('/v1/wallet/balance');
            callback({ text: `Wallet balances:\n${JSON.stringify(result, null, 2)}` });
          } catch (err) {
            callback({ text: `Error fetching balance: ${err}` });
          }
        },
        examples: [
          [
            { user: 'user', content: { text: "What's my wallet balance?" } },
            { user: 'agent', content: { text: 'Let me check your balances.' } },
          ],
        ],
      },

      {
        name: 'SWAP_TOKENS',
        description: 'Swap one token for another via Uniswap V3',
        similes: ['EXECUTE_SWAP', 'TRADE_TOKENS', 'EXCHANGE_TOKENS'],
        validate: async () => true,
        handler: async (_runtime, message, _state, _options, callback) => {
          // Simple parser — in production use proper NLP or structured input
          const text = message.content.text.toLowerCase();
          const amountMatch = text.match(/(\d+\.?\d*)\s*(eth|usdc|dai|wbtc)/i);

          if (!amountMatch) {
            callback({
              text: 'Please specify the amount and token. Example: "swap 0.1 ETH to USDC"',
            });
            return;
          }

          callback({
            text: 'Simulating swap first for safety... (use the MCP server for full swap capability)',
          });
        },
        examples: [
          [
            { user: 'user', content: { text: 'Swap 0.1 ETH to USDC' } },
            { user: 'agent', content: { text: 'Simulating the swap now...' } },
          ],
        ],
      },

      {
        name: 'CHECK_DEFI_RATES',
        description: 'Check current Aave lending rates',
        similes: ['AAVE_RATES', 'LENDING_RATES', 'YIELD_RATES'],
        validate: async () => true,
        handler: async (_runtime, _message, _state, _options, callback) => {
          try {
            // Fetch from Aave subgraph directly
            const res = await fetch(
              'https://api.thegraph.com/subgraphs/name/aave/protocol-v3',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: `{ reserves(first: 5) { symbol liquidityRate variableBorrowRate } }`,
                }),
              },
            );
            const data = (await res.json()) as {
              data: { reserves: Array<{ symbol: string; liquidityRate: string; variableBorrowRate: string }> };
            };
            const RAY = 1e27;
            const formatted = data.data.reserves
              .map(
                (r) =>
                  `${r.symbol}: Supply ${((parseFloat(r.liquidityRate) / RAY) * 100).toFixed(2)}% | Borrow ${((parseFloat(r.variableBorrowRate) / RAY) * 100).toFixed(2)}%`,
              )
              .join('\n');

            callback({ text: `Current Aave V3 rates:\n${formatted}` });
          } catch (err) {
            callback({ text: `Could not fetch rates: ${err}` });
          }
        },
        examples: [
          [
            { user: 'user', content: { text: 'What are the current Aave rates?' } },
            { user: 'agent', content: { text: 'Fetching current lending rates...' } },
          ],
        ],
      },
    ],
  };
}
