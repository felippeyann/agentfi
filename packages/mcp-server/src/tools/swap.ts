import { z } from 'zod';
import { api } from '../api-client.js';

export const swapTools = [
  {
    name: 'simulate_swap',
    description:
      'Simulates a token swap via Uniswap V3 and returns the expected output, price impact, ' +
      'and gas estimate. ALWAYS call this before execute_swap to verify the trade is viable. ' +
      'Returns a simulation_id that must be passed to execute_swap.',
    inputSchema: z.object({
      from_token: z
        .string()
        .describe('Token to sell. Use symbol (ETH, USDC, WBTC) or contract address.'),
      to_token: z.string().describe('Token to buy. Use symbol or contract address.'),
      amount_in: z
        .string()
        .describe('Amount to sell in human-readable units. Example: "1.5" for 1.5 ETH.'),
      chain_id: z.number().default(1).describe('Chain ID. Default: 1 (Ethereum mainnet).'),
      slippage_tolerance: z
        .number()
        .min(0.01)
        .max(50)
        .default(0.5)
        .describe('Max slippage tolerance in percentage. Example: 0.5 = 0.5%.'),
    }),
    handler: async (input: {
      from_token: string;
      to_token: string;
      amount_in: string;
      chain_id: number;
      slippage_tolerance: number;
    }) => {
      const result = await api.post<{
        success: boolean;
        gasEstimate: string;
        gasPrice: string;
        error?: string;
        simulationId: string;
      }>('/v1/transactions/simulate', {
        fromToken: input.from_token,
        toToken: input.to_token,
        amountIn: input.amount_in,
        chainId: input.chain_id,
        slippageTolerance: input.slippage_tolerance,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          recommendation:
            'The swap would fail on-chain. Common causes: insufficient liquidity, insufficient balance, or slippage too tight.',
        };
      }

      return {
        success: true,
        simulationId: result.simulationId,
        gasEstimate: result.gasEstimate,
        gasPrice: result.gasPrice,
        recommendation: 'Simulation passed. Safe to call execute_swap with this simulation_id.',
      };
    },
  },

  {
    name: 'execute_swap',
    description:
      'Executes a token swap via Uniswap V3. You MUST call simulate_swap first and pass the returned ' +
      'simulation_id here. Returns a transaction_id to track the status with get_transaction_status.',
    inputSchema: z.object({
      from_token: z.string().describe('Token to sell. Must match simulate_swap call.'),
      to_token: z.string().describe('Token to buy. Must match simulate_swap call.'),
      amount_in: z.string().describe('Amount to sell. Must match simulate_swap call.'),
      chain_id: z.number().default(1),
      slippage_tolerance: z.number().min(0.01).max(50).default(0.5),
      simulation_id: z
        .string()
        .describe('The simulation_id returned by simulate_swap. Required for safety.'),
    }),
    handler: async (input: {
      from_token: string;
      to_token: string;
      amount_in: string;
      chain_id: number;
      slippage_tolerance: number;
      simulation_id: string;
    }) => {
      const result = await api.post<{
        transactionId: string;
        status: string;
        simulationId: string;
        fee: { bps: number; amountWei: string; feeWallet: string };
      }>('/v1/transactions/swap', {
        fromToken: input.from_token,
        toToken: input.to_token,
        amountIn: input.amount_in,
        chainId: input.chain_id,
        slippageTolerance: input.slippage_tolerance,
      });

      return {
        transactionId: result.transactionId,
        status: result.status,
        fee: {
          basisPoints: result.fee.bps,
          description: `${result.fee.bps / 100}% protocol fee charged by AgentFi`,
        },
        next: 'Call get_transaction_status with the transactionId to track confirmation.',
      };
    },
  },
];
