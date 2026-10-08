/**
 * Transaction Monitor — tracks on-chain confirmation with exponential backoff.
 *
 * C3c: the receipt is the only thing that moves a row out of SUBMITTED.
 *  - The write is conditional (`status = SUBMITTED`), so when two observers
 *    see the same receipt — this monitor and the payment-recovery re-poll
 *    (`repollSubmittedTransactions`), or two processes re-polling at boot —
 *    exactly one of them records it and runs the post-confirmation outcome.
 *  - Polling out of attempts no longer marks the row FAILED: a transaction
 *    without a receipt after ~7.5 minutes is unknown, not failed (it may still
 *    be in the mempool and mine later, which is how a `fund` used to end up
 *    "FAILED" while the budget was locked on-chain). The row stays SUBMITTED
 *    and the reconciliation re-polls it; only a transaction that no node
 *    knows any more is ever declared dropped, and only after a grace period.
 */

import { createPublicClient, http, type Hex, type TransactionReceipt } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { getChain, withFallbackRpc } from '../../config/chains.js';
import { logger } from '../../api/middleware/logger.js';

export type ConfirmationOutcome =
  /** `recorded` is true only for the caller whose write moved the row out of SUBMITTED. */
  | { status: 'CONFIRMED' | 'REVERTED'; recorded: boolean }
  /** No receipt within the polling window: the row is left SUBMITTED for the reconciliation. */
  | { status: 'TIMEOUT'; recorded: false };

export interface MonitorOptions {
  /** Reads a receipt; throws (viem TransactionReceiptNotFoundError) while not mined. */
  getReceipt?: (chainId: number, txHash: Hex) => Promise<TransactionReceipt>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Records a receipt on its Transaction row exactly once. Returns whether this
 * call made the SUBMITTED → CONFIRMED/REVERTED transition (the caller then
 * owns the post-confirmation outcome).
 */
export async function recordReceiptOnce(
  db: PrismaClient,
  transactionId: string,
  receipt: Pick<TransactionReceipt, 'status' | 'gasUsed' | 'effectiveGasPrice'>,
): Promise<{ status: 'CONFIRMED' | 'REVERTED'; recorded: boolean }> {
  const status = receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED';
  const written = await db.transaction.updateMany({
    where: { id: transactionId, status: 'SUBMITTED' },
    data: {
      status,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: receipt.effectiveGasPrice?.toString() ?? null,
      confirmedAt: new Date(),
    },
  });
  return { status, recorded: written.count > 0 };
}

async function defaultGetReceipt(chainId: number, txHash: Hex): Promise<TransactionReceipt> {
  const chain = getChain(chainId);
  return withFallbackRpc(chainId, (url) => {
    const client = createPublicClient({ chain, transport: http(url) });
    return client.getTransactionReceipt({ hash: txHash });
  });
}

export class MonitorService {
  constructor(
    private db: PrismaClient,
    private readonly opts: MonitorOptions = {},
  ) {}

  /**
   * Waits for a transaction to be confirmed on-chain.
   * Polls with exponential backoff up to maxAttempts.
   */
  async waitForConfirmation(params: {
    txHash: Hex;
    chainId: number;
    transactionId: string;
    maxAttempts?: number;
  }): Promise<ConfirmationOutcome> {
    const { txHash, chainId, transactionId, maxAttempts = 20 } = params;
    const getReceipt = this.opts.getReceipt ?? defaultGetReceipt;
    const sleep = this.opts.sleep ?? defaultSleep;

    let attempt = 0;
    let delay = 2000; // start at 2s

    while (attempt < maxAttempts) {
      attempt++;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 30_000); // cap at 30s

      let receipt: TransactionReceipt | null = null;
      try {
        receipt = await getReceipt(chainId, txHash);
      } catch (err) {
        logger.warn({ txHash, attempt, err }, 'Error polling for receipt');
      }

      if (receipt) {
        const outcome = await recordReceiptOnce(this.db, transactionId, receipt);
        logger.info(
          {
            txHash,
            status: receipt.status,
            gasUsed: receipt.gasUsed,
            effectiveGasPriceWei: receipt.effectiveGasPrice?.toString() ?? null,
            recorded: outcome.recorded,
          },
          'Transaction confirmed',
        );
        return outcome;
      }
    }

    // Out of attempts: unknown, not failed. The payment-recovery reconciliation
    // re-polls stale SUBMITTED rows and decides from the chain.
    logger.warn(
      { txHash, transactionId, attempts: maxAttempts },
      'No receipt within the monitor window — transaction left SUBMITTED for reconciliation',
    );
    return { status: 'TIMEOUT', recorded: false };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
