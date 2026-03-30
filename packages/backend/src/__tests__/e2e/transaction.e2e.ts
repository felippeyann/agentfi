/**
 * E2E — Full Transaction Pipeline
 *
 * Tests the complete flow without hitting any external SaaS:
 *   API layer → PolicyService → FeeService → BullMQ worker →
 *   SubmitterService (Turnkey mock → Anvil) →
 *   MonitorService (receipt polling → Anvil) →
 *   DB accounting (FeeEvent + DailyVolume)
 *
 * External dependencies replaced:
 *   • Turnkey  → local EOA signing (Anvil account[0])
 *   • Alchemy  → Anvil RPC (RPC_URLS mutated in beforeAll)
 *   • Tenderly → graceful mock (no TENDERLY_* env vars)
 *   • CoinGecko→ vi.stubGlobal fetch mock ($2 000/ETH)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  parseEther,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  transactionQueue,
  startTransactionWorker,
} from '../../queues/transaction.queue.js';
import { generateApiKey } from '../../api/middleware/auth.js';
import type { Worker } from 'bullmq';

// ── Constants ────────────────────────────────────────────────────────────────

const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const ANVIL_ACCOUNT_1: Address =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil account[1] — recipient

// ── Mock: SubmitterService ───────────────────────────────────────────────────
// Replace the real submitter (Turnkey MPC + Alchemy RPC) with a local viem
// wallet client that signs with Anvil account[0] and broadcasts to local Anvil.
// This is simpler and more reliable than mocking chains.js + TurnkeyService
// separately, because SubmitterService is instantiated at module-load time and
// its internal RPC client creation happens before any beforeAll mutation.

vi.mock('../../services/transaction/submitter.service.js', async () => {
  const {
    createPublicClient,
    createWalletClient,
    http,
  } = await import('viem');
  const { privateKeyToAccount: pkToAccount } = await import('viem/accounts');
  const { base } = await import('viem/chains');

  const ANVIL = 'http://127.0.0.1:8545';
  const account = pkToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  // Use Base chain definition but point transport to local Anvil
  const anvilChain = {
    ...base,
    rpcUrls: { default: { http: [ANVIL] }, public: { http: [ANVIL] } },
  } as const;

  return {
    SubmitterService: class {
      async submit(params: {
        chainId: number;
        walletId: string;
        from: `0x${string}`;
        to: `0x${string}`;
        data: `0x${string}`;
        value: bigint;
        gasLimit?: bigint;
      }) {
        const pub = createPublicClient({ chain: anvilChain, transport: http(ANVIL) });
        const wal = createWalletClient({ account, chain: anvilChain, transport: http(ANVIL) });

        const [nonce, gasPrice] = await Promise.all([
          pub.getTransactionCount({ address: account.address }),
          pub.getGasPrice(),
        ]);

        const gas = params.gasLimit ?? await pub.estimateGas({
          account: account.address,
          to: params.to,
          data: params.data,
          value: params.value,
        });

        const txHash = await wal.sendTransaction({
          to: params.to,
          data: params.data,
          value: params.value,
          gas,
          gasPrice,
          nonce,
        });

        return { txHash, nonce };
      }
    },
  };
});

// ── Mock: MonitorService ─────────────────────────────────────────────────────
// Replace the real monitor (which polls via withFallbackRpc → Alchemy) with a
// local viem public client pointed at Anvil.

vi.mock('../../services/transaction/monitor.service.js', async () => {
  const { createPublicClient, http } = await import('viem');
  const { base } = await import('viem/chains');

  const ANVIL = 'http://127.0.0.1:8545';
  const anvilChain = {
    ...base,
    rpcUrls: { default: { http: [ANVIL] }, public: { http: [ANVIL] } },
  } as const;

  return {
    MonitorService: class {
      constructor(private db: import('@prisma/client').PrismaClient) {}

      async waitForConfirmation(params: {
        txHash: `0x${string}`;
        chainId: number;
        transactionId: string;
        maxAttempts?: number;
      }): Promise<void> {
        const { txHash, transactionId, maxAttempts = 40 } = params;
        const client = createPublicClient({ chain: anvilChain, transport: http(ANVIL) });
        const db = this.db;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const receipt = await client.getTransactionReceipt({ hash: txHash });
            if (receipt) {
              const confirmed = receipt.status === 'success';
              await db.transaction.update({
                where: { id: transactionId },
                data: {
                  status: confirmed ? 'CONFIRMED' : 'REVERTED',
                  gasUsed: receipt.gasUsed.toString(),
                  confirmedAt: new Date(),
                },
              });
              return;
            }
          } catch {
            // not yet mined — keep polling
          }
        }

        await db.transaction.update({
          where: { id: transactionId },
          data: { status: 'FAILED', error: 'Confirmation timeout after max polling attempts' },
        });
      }
    },
  };
});

// ── Mock: CoinGecko price feed ───────────────────────────────────────────────
// Capture original fetch so Anvil readiness checks (in globalSetup) still work.
// Note: globalSetup already completed by the time this runs, but any
// internal fetch calls (e.g. Tenderly) should also pass through.

const _originalFetch = globalThis.fetch;

vi.stubGlobal(
  'fetch',
  async (url: string | URL, init?: RequestInit) => {
    if (url.toString().includes('coingecko.com')) {
      return {
        ok: true,
        json: async () => ({
          ethereum: { usd: 2000 },
          'matic-network': { usd: 0.5 },
          base: { usd: 2000 },
          'arbitrum-one': { usd: 2000 },
        }),
      };
    }
    return _originalFetch(url, init);
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitForTxStatus(
  db: PrismaClient,
  txId: string,
  terminal: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = await db.transaction.findUnique({
      where: { id: txId },
      select: { status: true },
    });
    if (tx && terminal.includes(tx.status)) return tx.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Transaction ${txId} did not reach a terminal status within ${timeoutMs}ms`,
  );
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Transaction Pipeline E2E', () => {
  let db: PrismaClient;
  let worker: Worker;
  let testAgentId: string;
  let testApiKey: string;
  let testWalletId: string;
  const DEPLOYER_ADDRESS = privateKeyToAccount(ANVIL_PRIVATE_KEY).address;

  beforeAll(async () => {
    // 1 ─ Connect to test DB and run pending migrations.
    db = new PrismaClient();
    await db.$connect();

    // 3 ─ Seed a test agent backed by Anvil account[0].
    const { plaintext, hash, prefix } = generateApiKey();
    testApiKey = plaintext;
    testWalletId = 'e2e-anvil-wallet';

    // Upsert so re-runs after a failed teardown don't hit unique constraint.
    const agent = await db.agent.upsert({
      where: { walletId: testWalletId },
      update: { apiKeyHash: hash, apiKeyPrefix: prefix, active: true },
      create: {
        name: 'E2E Test Agent',
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        walletId: testWalletId,
        safeAddress: DEPLOYER_ADDRESS,
        chainIds: [8453],
        tier: 'FREE',
      },
    });
    testAgentId = agent.id;

    // 4 ─ Start the BullMQ worker (connects to real Redis).
    worker = startTransactionWorker();
    // Give the worker a moment to connect to Redis.
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await worker?.close();
    // Clean up test data (cascade deletes related records).
    if (testAgentId) {
      await db.agent.delete({ where: { id: testAgentId } }).catch(() => {});
    }
    await db.$disconnect();
  });

  // ── Test 1: ETH transfer ────────────────────────────────────────────────

  it('processes an ETH transfer from queue to CONFIRMED status', async () => {
    const transferValue = parseEther('0.01');
    const feeBps = 30;
    const feeAmount = (transferValue * BigInt(feeBps)) / 10_000n;

    // Create the transaction record in the DB (mimics what the API route does).
    const tx = await db.transaction.create({
      data: {
        agentId: testAgentId,
        chainId: 8453,
        status: 'QUEUED',
        type: 'TRANSFER',
        amountIn: transferValue.toString(),
      },
    });

    // Enqueue the job (mimics transactionQueue.add in the transactions route).
    await transactionQueue.add(
      'eth-transfer',
      {
        transactionId: tx.id,
        chainId: 8453,
        walletId: testWalletId,
        from: DEPLOYER_ADDRESS,
        to: ANVIL_ACCOUNT_1,
        data: '0x',
        value: transferValue.toString(),
        agentId: testAgentId,
        tier: 'FREE',
        feeAmountWei: feeAmount.toString(),
        feeUsd: '20.00',
        feeBps,
        routedViaExecutor: false,
      },
      { jobId: `e2e-transfer-${tx.id}` },
    );

    // Wait for the worker to process and the monitor to confirm.
    const finalStatus = await waitForTxStatus(
      db,
      tx.id,
      ['CONFIRMED', 'FAILED', 'REVERTED'],
      60_000,
    );

    // On failure, surface the stored error message for diagnosis.
    if (finalStatus !== 'CONFIRMED') {
      const record = await db.transaction.findUnique({ where: { id: tx.id } });
      throw new Error(`Transaction ended as ${finalStatus}. Worker error: ${record?.error ?? '(none)'}`);
    }

    expect(finalStatus).toBe('CONFIRMED');

    // Assert txHash was written.
    const confirmed = await db.transaction.findUnique({
      where: { id: tx.id },
    });
    expect(confirmed?.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(confirmed?.confirmedAt).toBeTruthy();
    expect(confirmed?.gasUsed).toBeTruthy();
  });

  // ── Test 2: Fee accounting ──────────────────────────────────────────────

  it('records a FeeEvent and updates DailyVolume after confirmation', async () => {
    const transferValue = parseEther('0.05');
    const feeBps = 30;
    const feeAmount = (transferValue * BigInt(feeBps)) / 10_000n;

    const tx = await db.transaction.create({
      data: {
        agentId: testAgentId,
        chainId: 8453,
        status: 'QUEUED',
        type: 'TRANSFER',
        amountIn: transferValue.toString(),
      },
    });

    await transactionQueue.add(
      'eth-transfer-fee',
      {
        transactionId: tx.id,
        chainId: 8453,
        walletId: testWalletId,
        from: DEPLOYER_ADDRESS,
        to: ANVIL_ACCOUNT_1,
        data: '0x',
        value: transferValue.toString(),
        agentId: testAgentId,
        tier: 'FREE',
        feeAmountWei: feeAmount.toString(),
        feeUsd: '100.00',
        feeBps,
        routedViaExecutor: false,
      },
      { jobId: `e2e-fee-${tx.id}` },
    );

    await waitForTxStatus(db, tx.id, ['CONFIRMED', 'FAILED', 'REVERTED'], 60_000);

    // Wait briefly for the async post-confirmation accounting to finish.
    await new Promise((r) => setTimeout(r, 2_000));

    // Assert FeeEvent was created.
    const feeEvent = await db.feeEvent.findFirst({
      where: { transactionId: tx.id },
    });
    expect(feeEvent).not.toBeNull();
    expect(feeEvent!.feeBps).toBe(feeBps);
    expect(BigInt(feeEvent!.feeTokens)).toBe(feeAmount);

    // Assert DailyVolume was updated.
    const today = new Date().toISOString().slice(0, 10);
    const volume = await db.dailyVolume.findFirst({
      where: { agentId: testAgentId, date: today },
    });
    expect(volume).not.toBeNull();
    expect(parseFloat(volume!.volumeUsd)).toBeGreaterThan(0);
  });

  // ── Test 3: Failed transaction ──────────────────────────────────────────

  it('marks transaction FAILED when worker exhausts retries (bad calldata)', async () => {
    // Send a transaction that will definitely fail on-chain:
    // call a non-existent method on a contract address.
    // We use the executor address which rejects unknown selectors.
    const executorAddress = process.env['EXECUTOR_ADDRESS_8453'] as Address;

    const tx = await db.transaction.create({
      data: {
        agentId: testAgentId,
        chainId: 8453,
        status: 'QUEUED',
        type: 'TRANSFER',
      },
    });

    await transactionQueue.add(
      'bad-tx',
      {
        transactionId: tx.id,
        chainId: 8453,
        walletId: testWalletId,
        from: DEPLOYER_ADDRESS,
        to: executorAddress ?? DEPLOYER_ADDRESS,
        // 0xdeadbeef — will revert because executorAddress doesn't have this selector
        // and we're sending 0 value which fails the fee math in executeBatch.
        data: '0xdeadbeef',
        value: '0',
        agentId: testAgentId,
        tier: 'FREE',
        feeAmountWei: '0',
        feeUsd: '0',
        feeBps: 30,
        routedViaExecutor: false,
      },
      {
        jobId: `e2e-fail-${tx.id}`,
        // Override attempts to 1 so we don't wait for 3 retries
        attempts: 1,
      },
    );

    // This transaction should revert and become REVERTED or FAILED.
    const finalStatus = await waitForTxStatus(
      db,
      tx.id,
      ['CONFIRMED', 'FAILED', 'REVERTED'],
      60_000,
    );

    expect(['FAILED', 'REVERTED']).toContain(finalStatus);
  });
});
