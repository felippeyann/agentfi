import { z } from 'zod';
import { api } from '../api-client.js';

export const gmxTools = [
  {
    name: 'list_gmx_markets',
    description:
      'Lists available GMX V2 perpetual markets on Arbitrum. Returns market labels ' +
      'and token addresses. Use this to discover which markets are available before opening positions.',
    inputSchema: z.object({}),
    handler: async () => {
      return {
        markets: [
          { label: 'ETH/USD', marketToken: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336' },
          { label: 'BTC/USD', marketToken: '0x47c031236e19d024b42f8AE6DA7A02043640408D' },
          { label: 'ARB/USD', marketToken: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407' },
          { label: 'SOL/USD', marketToken: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9' },
          { label: 'LINK/USD', marketToken: '0x7f1fa204bb700853D36994DA19F830b6Ad18455C' },
        ],
        chain: 'Arbitrum One (42161)',
        note: 'GMX V2 uses an order-based system. After opening, a keeper executes your order within ~1-2 blocks.',
      };
    },
  },

  {
    name: 'open_gmx_position',
    description:
      'Opens a leveraged perpetual position on GMX V2 (Arbitrum). Creates a MarketIncrease order ' +
      'that is executed by a GMX keeper after oracle price update. Specify the market (e.g. "ETH/USD"), ' +
      'collateral amount, position size in USD, and direction (long/short). ' +
      'Returns a transaction ID to track with get_transaction_status.',
    inputSchema: z.object({
      market: z
        .string()
        .describe('Market label (e.g. "ETH/USD", "BTC/USD") or market token address.'),
      collateral_token: z
        .string()
        .describe('Collateral token address. Use WETH for ETH-collateralized positions.'),
      collateral_amount: z
        .string()
        .describe('Collateral amount in human-readable units. Example: "0.5" for 0.5 WETH.'),
      size_delta_usd: z
        .string()
        .describe(
          'Position size in USD with 30 decimals (GMX precision). ' +
          'Example: "1000000000000000000000000000000000" for $1000. ' +
          'Tip: multiply desired USD amount by 10^30.',
        ),
      acceptable_price: z
        .string()
        .describe(
          'Max acceptable execution price with 30 decimals. For longs, set above current price. ' +
          'For shorts, set below. Example: use a 1% buffer above/below market price.',
        ),
      is_long: z.boolean().describe('true to go long (price goes up = profit), false to go short.'),
      chain_id: z.number().default(42161).describe('Chain ID. Default: 42161 (Arbitrum One).'),
    }),
    handler: async (input: {
      market: string;
      collateral_token: string;
      collateral_amount: string;
      size_delta_usd: string;
      acceptable_price: string;
      is_long: boolean;
      chain_id: number;
    }) => {
      const result = await api.post<{
        transactionId: string;
        status: string;
        simulationId: string;
        market: string;
        fee: { bps: number; amountWei: string; feeWallet: string };
      }>('/v1/transactions/gmx-open', {
        market: input.market,
        collateralToken: input.collateral_token,
        collateralAmount: input.collateral_amount,
        sizeDeltaUsd: input.size_delta_usd,
        acceptablePrice: input.acceptable_price,
        isLong: input.is_long,
        chainId: input.chain_id,
      });

      return {
        transactionId: result.transactionId,
        status: result.status,
        market: result.market,
        direction: input.is_long ? 'LONG' : 'SHORT',
        fee: {
          basisPoints: result.fee.bps,
          description: `${result.fee.bps / 100}% protocol fee`,
        },
        note: 'Order submitted. GMX keeper will execute within ~1-2 blocks after oracle price update.',
        next: 'Call get_transaction_status with the transactionId to track confirmation.',
      };
    },
  },

  {
    name: 'close_gmx_position',
    description:
      'Closes (fully or partially) a perpetual position on GMX V2 (Arbitrum). Creates a MarketDecrease ' +
      'order. Specify the market, collateral token, size to close, and direction. ' +
      'Use the full position size in size_delta_usd for a complete close.',
    inputSchema: z.object({
      market: z
        .string()
        .describe('Market label (e.g. "ETH/USD") or market token address.'),
      collateral_token: z
        .string()
        .describe('Collateral token of the existing position.'),
      size_delta_usd: z
        .string()
        .describe('Size to close in USD with 30 decimals. Use full position size for complete close.'),
      acceptable_price: z
        .string()
        .describe(
          'Min acceptable price for longs, max for shorts (30 decimals). ' +
          'Set with a buffer to avoid keeper rejection.',
        ),
      is_long: z.boolean().describe('true if closing a long position, false for short.'),
      chain_id: z.number().default(42161).describe('Chain ID. Default: 42161 (Arbitrum One).'),
    }),
    handler: async (input: {
      market: string;
      collateral_token: string;
      size_delta_usd: string;
      acceptable_price: string;
      is_long: boolean;
      chain_id: number;
    }) => {
      const result = await api.post<{
        transactionId: string;
        status: string;
        simulationId: string;
        market: string;
        fee: { bps: number; amountWei: string; feeWallet: string };
      }>('/v1/transactions/gmx-close', {
        market: input.market,
        collateralToken: input.collateral_token,
        sizeDeltaUsd: input.size_delta_usd,
        acceptablePrice: input.acceptable_price,
        isLong: input.is_long,
        chainId: input.chain_id,
      });

      return {
        transactionId: result.transactionId,
        status: result.status,
        market: result.market,
        direction: input.is_long ? 'LONG' : 'SHORT',
        fee: {
          basisPoints: result.fee.bps,
          description: `${result.fee.bps / 100}% protocol fee`,
        },
        note: 'Close order submitted. GMX keeper will execute within ~1-2 blocks.',
        next: 'Call get_transaction_status with the transactionId to track confirmation.',
      };
    },
  },
];
