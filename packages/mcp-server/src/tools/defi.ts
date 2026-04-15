import { z } from 'zod';
import { api } from '../api-client.js';
import { resolveAssetToken, resolveTransferToken } from './token-map.js';

export const defiTools = [
  {
    name: 'transfer_token',
    description:
      'Transfers ETH or an ERC-20 token to any Ethereum address. ' +
      'Use "ETH" as the token identifier to send native ETH, or provide a contract address for ERC-20.',
    inputSchema: z.object({
      token: z
        .string()
        .describe(
          'Token to transfer. Use "ETH" for native ETH, or the ERC-20 contract address.',
        ),
      to: z.string().describe('Destination Ethereum address (checksummed).'),
      amount: z
        .string()
        .describe('Amount in human-readable units. Example: "100" for 100 USDC.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: { token: string; to: string; amount: string; chain_id: number }) => {
      const token = resolveTransferToken(input.token, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/transfer',
        {
          token,
          to: input.to,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to track confirmation.',
      };
    },
  },

  {
    name: 'deposit_aave',
    description:
      'Supplies an asset to Aave V3 lending protocol to earn yield. ' +
      'The supplied amount earns the current supply APY and can be withdrawn at any time. ' +
      'Call get_defi_rates first to check current rates.',
    inputSchema: z.object({
      asset: z
        .string()
        .describe('ERC-20 token address to supply. Common: USDC, DAI, WETH contract addresses.'),
      amount: z.string().describe('Amount to supply in human-readable units.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: { asset: string; amount: string; chain_id: number }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/deposit',
        {
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to confirm. After confirmation, you will hold aTokens representing your position.',
      };
    },
  },

  {
    name: 'withdraw_aave',
    description:
      'Withdraws a previously supplied asset from Aave V3. ' +
      'Pass "max" as the amount to withdraw your entire position.',
    inputSchema: z.object({
      asset: z.string().describe('ERC-20 token address to withdraw.'),
      amount: z
        .string()
        .describe('Amount to withdraw. Use "max" to withdraw entire position.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: { asset: string; amount: string; chain_id: number }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/withdraw',
        {
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to track confirmation.',
      };
    },
  },

  {
    name: 'supply_compound',
    description:
      'Supplies an asset to Compound V3 (Comet USDC market) to earn yield. ' +
      'Each Compound V3 market is single-asset; the USDC market accepts USDC as the base asset ' +
      'plus whitelisted collateral (e.g. WETH, WBTC). Available on Mainnet, Base, Arbitrum, Polygon.',
    inputSchema: z.object({
      asset: z
        .string()
        .describe('ERC-20 token address to supply. Use USDC for the base asset, or a supported collateral.'),
      amount: z.string().describe('Amount to supply in human-readable units.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: { asset: string; amount: string; chain_id: number }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/supply-compound',
        {
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to confirm. Your supplied balance accrues interest in the Comet market.',
      };
    },
  },

  {
    name: 'withdraw_compound',
    description:
      'Withdraws a previously supplied asset from Compound V3 (Comet USDC market). ' +
      'Pass "max" as the amount to withdraw your entire balance.',
    inputSchema: z.object({
      asset: z.string().describe('ERC-20 token address to withdraw.'),
      amount: z.string().describe('Amount to withdraw. Use "max" to withdraw entire balance.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: { asset: string; amount: string; chain_id: number }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/withdraw-compound',
        {
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to track confirmation.',
      };
    },
  },

  {
    name: 'deposit_erc4626',
    description:
      'Deposits an asset into any ERC-4626 compliant vault (Yearn, Morpho, Beefy, etc.). ' +
      'The vault address is supplied by the caller — no pre-registration needed. ' +
      'Useful for any yield strategy that follows the tokenized-vault standard.',
    inputSchema: z.object({
      vault: z.string().describe('ERC-4626 vault contract address to deposit into.'),
      asset: z.string().describe('Underlying ERC-20 token address (for decimals + USD pricing).'),
      amount: z.string().describe('Amount of underlying asset to deposit, in human-readable units.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: {
      vault: string;
      asset: string;
      amount: string;
      chain_id: number;
    }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/deposit-erc4626',
        {
          vault: input.vault,
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to confirm. You will receive vault shares proportional to your deposit.',
      };
    },
  },

  {
    name: 'withdraw_erc4626',
    description:
      'Withdraws assets from any ERC-4626 compliant vault. ' +
      'Use "max" to attempt a full withdrawal (vault may still limit to available liquidity).',
    inputSchema: z.object({
      vault: z.string().describe('ERC-4626 vault contract address to withdraw from.'),
      asset: z.string().describe('Underlying ERC-20 token address.'),
      amount: z.string().describe('Amount to withdraw. Use "max" for the full balance.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: {
      vault: string;
      asset: string;
      amount: string;
      chain_id: number;
    }) => {
      const asset = resolveAssetToken(input.asset, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/withdraw-erc4626',
        {
          vault: input.vault,
          asset,
          amount: input.amount,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to track confirmation.',
      };
    },
  },

  {
    name: 'swap_curve',
    description:
      'Swaps between two assets on a Curve StableSwap pool. Ideal for stablecoin-to-stablecoin ' +
      'conversions (USDC↔USDT↔DAI) with minimal slippage. The caller must supply the pool address ' +
      'and the indices of the input/output tokens within that pool. Assumes fromToken has already ' +
      'been approved to the pool; simulation will fail clearly if approval is missing.',
    inputSchema: z.object({
      pool: z.string().describe('Curve pool contract address.'),
      from_token_index: z
        .number()
        .int()
        .describe('Index (0, 1, 2, ...) of the input token within the pool.'),
      to_token_index: z
        .number()
        .int()
        .describe('Index of the output token within the pool.'),
      from_token_address: z.string().describe('ERC-20 address of the input token.'),
      to_token_address: z.string().describe('ERC-20 address of the output token.'),
      amount_in: z.string().describe('Amount of input token in human-readable units.'),
      min_amount_out: z
        .string()
        .describe('Minimum acceptable amount of output token (slippage protection).'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
    }),
    handler: async (input: {
      pool: string;
      from_token_index: number;
      to_token_index: number;
      from_token_address: string;
      to_token_address: string;
      amount_in: string;
      min_amount_out: string;
      chain_id: number;
    }) => {
      const fromToken = resolveAssetToken(input.from_token_address, input.chain_id);
      const toToken = resolveAssetToken(input.to_token_address, input.chain_id);

      const result = await api.post<{ transactionId: string; status: string }>(
        '/v1/transactions/swap-curve',
        {
          pool: input.pool,
          fromTokenIndex: input.from_token_index,
          toTokenIndex: input.to_token_index,
          fromTokenAddress: fromToken,
          toTokenAddress: toToken,
          amountIn: input.amount_in,
          minAmountOut: input.min_amount_out,
          chainId: input.chain_id,
        },
      );

      return {
        transactionId: result.transactionId,
        status: result.status,
        next: 'Call get_transaction_status to track confirmation.',
      };
    },
  },

  {
    name: 'get_defi_rates',
    description:
      'Returns current supply and borrow APY rates for major assets on Aave V3. ' +
      'Use this to decide where to deploy capital for yield.',
    inputSchema: z.object({
      chain_id: z.number().default(1).describe('Chain ID to fetch rates for.'),
    }),
    handler: async (input: { chain_id: number }) => {
      // Fetch from Aave subgraph (public, no auth required)
      const subgraphUrls: Record<number, string> = {
        1: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3',
        137: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
        42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
        8453: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-base',
      };

      const url = subgraphUrls[input.chain_id];
      if (!url) {
        return { error: `Aave rates not available for chain ${input.chain_id}` };
      }

      const query = `{
        reserves(first: 10, orderBy: totalLiquidity, orderDirection: desc) {
          name
          symbol
          liquidityRate
          variableBorrowRate
          stableBorrowRate
          totalLiquidity
          availableLiquidity
        }
      }`;

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const data = (await res.json()) as {
          data: {
            reserves: Array<{
              name: string;
              symbol: string;
              liquidityRate: string;
              variableBorrowRate: string;
            }>;
          };
        };

        const RAY = 1e27;
        return {
          chainId: input.chain_id,
          rates: data.data.reserves.map((r) => ({
            asset: r.symbol,
            supplyApy: ((parseFloat(r.liquidityRate) / RAY) * 100).toFixed(2) + '%',
            borrowApy: ((parseFloat(r.variableBorrowRate) / RAY) * 100).toFixed(2) + '%',
          })),
          timestamp: new Date().toISOString(),
        };
      } catch {
        return {
          error: 'Failed to fetch Aave rates. Try again or check chain availability.',
        };
      }
    },
  },
];
