/**
 * Transaction Monitor — tracks on-chain confirmation with exponential backoff.
 */

import { createPublicClient, http, type Hex } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getChain, withFallbackRpc } from '../../config/chains.js';
import { logger } from '../../api/middleware/logger.js';

export class MonitorService {
  constructor(private db: PrismaClient) {}

  /**
   * Waits for a transaction to be confirmed on-chain.
   * Polls with exponential backoff up to maxAttempts.
   */
  async waitForConfirmation(params: {
    txHash: Hex;
    chainId: number;
    transactionId: string;
    maxAttempts?: number;
  }): Promise<void> {
    const { txHash, chainId, transactionId, maxAttempts = 20 } = params;
    const chain = getChain(chainId);

    let attempt = 0;
    let delay = 2000; // start at 2s

    while (attempt < maxAttempts) {
      attempt++;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 30_000); // cap at 30s

      try {
        const receipt = await withFallbackRpc(chainId, (url) => {
          const client = createPublicClient({ chain, transport: http(url) });
          return client.getTransactionReceipt({ hash: txHash });
        });

        if (receipt) {
          const confirmed = receipt.status === 'success';
          await this.db.transaction.update({
            where: { id: transactionId },
            data: {
              status: confirmed ? 'CONFIRMED' : 'REVERTED',
              gasUsed: receipt.gasUsed.toString(),
              confirmedAt: new Date(),
            },
          });

          logger.info(
            { txHash, status: receipt.status, gasUsed: receipt.gasUsed },
            'Transaction confirmed',
          );
          return;
        }
      } catch (err) {
        logger.warn({ txHash, attempt, err }, 'Error polling for receipt');
      }
    }

    // Max attempts reached — mark as failed
    await this.db.transaction.update({
      where: { id: transactionId },
      data: { status: 'FAILED', error: 'Confirmation timeout after max polling attempts' },
    });

    logger.error({ txHash, transactionId }, 'Transaction confirmation timed out');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
