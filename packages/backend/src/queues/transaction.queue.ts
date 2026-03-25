/**
 * Transaction Queue — BullMQ workers for async tx processing.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { MonitorService } from '../services/transaction/monitor.service.js';
import { FeeService } from '../services/policy/fee.service.js';
import { weiToUsd } from '../services/transaction/price.service.js';
import { logger } from '../api/middleware/logger.js';
import type { Address, Hex } from 'viem';

export interface TransactionJobData {
  transactionId: string;
  chainId: number;
  walletId: string;
  from: Address;
  to: Address;
  data: Hex;
  value: string; // bigint as string
  agentId: string;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  feeAmountWei: string; // bigint as string
  feeUsd: string;
  feeBps: number;
}

const connection = { url: env.REDIS_URL };
const db = new PrismaClient();
const submitter = new SubmitterService();
const monitor = new MonitorService(db);
const feeService = new FeeService(db);

export const transactionQueue = new Queue<TransactionJobData>('transactions', {
  connection,
  defaultJobOptions: {
    // Retry up to 3 times with exponential backoff (2s, 4s, 8s)
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

/**
 * Atomically adds incoming USD volume to today's DailyVolume row.
 * Uses INSERT ... ON CONFLICT ... DO UPDATE to avoid read-then-write
 * race conditions under concurrent worker execution.
 */
async function addDailyVolumeAtomic(agentId: string, date: string, valueUsd: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt")
    VALUES (gen_random_uuid()::text, ${agentId}, ${date}, ${valueUsd}, NOW())
    ON CONFLICT ("agentId", "date")
    DO UPDATE SET
      "volumeUsd" = (("DailyVolume"."volumeUsd"::numeric) + (${valueUsd}::numeric))::text,
      "updatedAt" = NOW()
  `;
}

export function startTransactionWorker(): Worker<TransactionJobData> {
  return new Worker<TransactionJobData>(
    'transactions',
    async (job: Job<TransactionJobData>) => {
      const { data } = job;

      logger.info({ transactionId: data.transactionId }, 'Processing transaction job');

      await db.transaction.update({
        where: { id: data.transactionId },
        data: { status: 'SUBMITTED' },
      });

      const { txHash } = await submitter.submit({
        chainId: data.chainId,
        walletId: data.walletId,
        from: data.from,
        to: data.to,
        data: data.data,
        value: BigInt(data.value),
      });

      await db.transaction.update({
        where: { id: data.transactionId },
        data: { txHash },
      });

      logger.info({ transactionId: data.transactionId, txHash }, 'Transaction submitted');

      // Monitor confirmation async — resolves feeUsd via price oracle once confirmed
      monitor.waitForConfirmation({
        txHash,
        chainId: data.chainId,
        transactionId: data.transactionId,
      }).then(async () => {
        const tx = await db.transaction.findUnique({
          where: { id: data.transactionId },
          select: { status: true, amountIn: true },
        });
        if (tx?.status === 'CONFIRMED') {
          // Resolve USD value at time of confirmation
          const feeUsd = BigInt(data.feeAmountWei) > 0n
            ? await weiToUsd(BigInt(data.feeAmountWei), data.chainId)
            : '0';

          if (BigInt(data.feeAmountWei) > 0n) {
            await feeService.recordFeeEvent({
              agentId: data.agentId,
              transactionId: data.transactionId,
              feeAmountWei: BigInt(data.feeAmountWei),
              feeUsd,
              feeBps: data.feeBps,
            });
          }

          // Update daily volume — atomic upsert avoids race condition under concurrency: 5
          const valueUsd = await weiToUsd(BigInt(data.value), data.chainId);
          if (parseFloat(valueUsd) > 0) {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            await addDailyVolumeAtomic(data.agentId, today, valueUsd);
          }
        }
      }).catch((err) => {
        logger.error({ err, transactionId: data.transactionId }, 'Post-confirmation accounting failed');
      });

      return { txHash };
    },
    {
      connection,
      concurrency: 5,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 500 },
    },
  );
}
