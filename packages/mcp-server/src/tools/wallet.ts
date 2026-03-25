import { z } from 'zod';
import { api } from '../api-client.js';

export const walletTools = [
  {
    name: 'get_wallet_info',
    description:
      'Returns the agent\'s wallet address and current token balances across chains. ' +
      'Call this to know how much ETH, USDC, USDT, DAI, WETH the agent holds before executing transactions.',
    inputSchema: z.object({
      chain_id: z
        .number()
        .optional()
        .describe('Chain ID (1=Ethereum, 8453=Base, 42161=Arbitrum, 137=Polygon). Omit for all chains.'),
    }),
    handler: async (input: { chain_id?: number }) => {
      const query = input.chain_id ? { chainId: input.chain_id.toString() } : undefined;
      const [address, balance] = await Promise.all([
        api.get<{ safeAddress: string; networks: number[] }>('/v1/wallet/address'),
        api.get<{ address: string; balances: unknown[] }>('/v1/wallet/balance', query),
      ]);

      return {
        walletAddress: address.safeAddress,
        networks: address.networks,
        balances: balance.balances,
      };
    },
  },

  {
    name: 'get_token_price',
    description:
      'Returns the current USD price of a token. Use this before swaps to understand value.',
    inputSchema: z.object({
      token_symbol: z
        .string()
        .describe('Token symbol (e.g. "ETH", "USDC", "WBTC") or contract address.'),
      chain_id: z.number().default(1).describe('Chain ID where the token exists.'),
    }),
    handler: async (input: { token_symbol: string; chain_id: number }) => {
      // Fetch price from CoinGecko (no key required for basic use)
      const symbolMap: Record<string, string> = {
        ETH: 'ethereum',
        WETH: 'weth',
        USDC: 'usd-coin',
        USDT: 'tether',
        DAI: 'dai',
        WBTC: 'wrapped-bitcoin',
        MATIC: 'matic-network',
      };

      const coinId = symbolMap[input.token_symbol.toUpperCase()] ?? input.token_symbol.toLowerCase();

      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      );
      const data = (await res.json()) as Record<string, { usd?: number }>;
      const price = data[coinId]?.usd;

      if (!price) {
        return { error: `Price not found for ${input.token_symbol}` };
      }

      return {
        token: input.token_symbol.toUpperCase(),
        priceUsd: price.toString(),
        chainId: input.chain_id,
        timestamp: new Date().toISOString(),
      };
    },
  },
];
