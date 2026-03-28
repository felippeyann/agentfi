import { z } from 'zod';
import { api } from '../api-client.js';

export const statusTools = [
  {
    name: 'get_transaction_status',
    description:
      'Returns the current status of a submitted transaction. ' +
      'Poll this after execute_swap, transfer_token, deposit_aave, or withdraw_aave. ' +
      'Status values: PENDING, SIMULATING, QUEUED, SUBMITTED, CONFIRMED, FAILED, REVERTED.',
    inputSchema: z.object({
      transaction_id: z
        .string()
        .describe('The transaction_id returned by execute_swap or other transaction tools.'),
    }),
    handler: async (input: { transaction_id: string }) => {
      const tx = await api.get<{
        id: string;
        status: string;
        txHash?: string;
        type: string;
        chainId: number;
        fromToken?: string;
        toToken?: string;
        amountIn?: string;
        amountOut?: string;
        gasUsed?: string;
        error?: string;
        createdAt: string;
        confirmedAt?: string;
      }>(`/v1/transactions/${input.transaction_id}`);

      const isTerminal = ['CONFIRMED', 'FAILED', 'REVERTED'].includes(tx.status);

      return {
        transactionId: tx.id,
        status: tx.status,
        txHash: tx.txHash,
        type: tx.type,
        chainId: tx.chainId,
        from: tx.fromToken,
        to: tx.toToken,
        amountIn: tx.amountIn,
        amountOut: tx.amountOut,
        gasUsed: tx.gasUsed,
        error: tx.error,
        createdAt: tx.createdAt,
        confirmedAt: tx.confirmedAt,
        isTerminal,
        recommendation: isTerminal
          ? tx.status === 'CONFIRMED'
            ? 'Transaction confirmed successfully.'
            : `Transaction ${tx.status.toLowerCase()}. ${tx.error ?? 'Check the error field for details.'}`
          : 'Transaction still processing. Poll again in a few seconds.',
      };
    },
  },

  {
    name: 'get_policy',
    description:
      'Returns the current operational limits and restrictions for this agent. ' +
      'Check this to understand what transactions are allowed before attempting them.',
    inputSchema: z.object({}),
    handler: async (_input: Record<string, never>) => {
      const agentInfo = await api.get<{
        policy: {
          maxValuePerTxEth: string;
          maxDailyVolumeUsd: string;
          allowedContracts: string[];
          allowedTokens: string[];
          cooldownSeconds: number;
          active: boolean;
        } | null;
        tier: string;
        billing: {
          txCountThisPeriod: number;
          subscriptionActive: boolean;
        } | null;
      }>(`/v1/agents/me`);

      return {
        tier: agentInfo.tier,
        policy: agentInfo.policy ?? {
          maxValuePerTxEth: 'unlimited (no policy set)',
          allowedContracts: [],
          allowedTokens: [],
          cooldownSeconds: 0,
          active: true,
        },
        usage: agentInfo.billing,
      };
    },
  },
];
