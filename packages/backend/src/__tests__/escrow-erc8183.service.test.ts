/**
 * Unit tests — ERC-8183 escrow orchestrator (`services/job/escrow-erc8183.service.ts`).
 *
 * Runs the pure orchestrator against an in-memory Prisma stand-in, a fake
 * transaction queue, a fake settlement queue, a fake public client (receipts
 * built from the generated ABI) and a fake evaluator signer — no Redis, no RPC.
 *
 *  - startEscrow persists the escrow columns and enqueues createJob from the requester
 *  - create confirmed → JobCreated parsed with the generated ABI → setBudget → approve → fund → FUNDED
 *  - any step failing before FUNDED → FAILED + DB reservation released, chain stops
 *  - cancellation stops the chain; a late `fund` schedules an evaluator reject
 *  - submit failure returns the job to ACCEPTED (reservation kept)
 *  - settlement: complete → finalizer CONFIRMED with fee/feedback parsed from logs
 *  - contested → reject; already-terminal on-chain → reconcile without sending
 *  - revert on the last attempt → PAYMENT_PENDING kept, SUBMITTED restored, no DB refund
 *  - expiry sweep enqueues claimRefund; claimRefund finalizes as FAILED
 *  - payment recovery branch never refunds
 *  - feedback file bytes are stable across key reordering (jsonb round-trip)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  parseUnits,
  stringToHex,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import type { EvaluatorWriteParams } from '../services/escrow/evaluator-signer.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';
import {
  CHAIN_JOB_STATUS,
  SETTLEMENT_REASONS,
  __resetEscrowTokenCacheForTests,
  deliverableHashOf,
  enqueueSubmit,
  escrowIntentId,
  feedbackHashOf,
  feedbackUriFor,
  getEscrowToken,
  handleFailedSettlementJob,
  isErc8183EnabledWith,
  isEscrowTokenReward,
  onEscrowTxOutcome,
  processSettlementJob,
  pumpFunding,
  recoverErc8183Job,
  requestCancellationReject,
  serializeFeedbackFile,
  startEscrow,
  sweepExpiredEscrows,
  toJobResponse,
  type Erc8183Config,
  type Erc8183Deps,
  type FeedbackFile,
} from '../services/job/escrow-erc8183.service.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const CHAIN_ID = 84532;
const ESCROW = getAddress('0x00000000000000000000000000000000000e5c20');
const HOOK = getAddress('0x000000000000000000000000000000000000400c');
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const EVALUATOR = getAddress('0x000000000000000000000000000000000000ea1d');
const REQUESTER = { id: 'agent-req', walletId: 'wallet-req', safeAddress: '0x1111111111111111111111111111111111111111' };
const PROVIDER = { id: 'agent-prov', walletId: 'wallet-prov', safeAddress: '0x2222222222222222222222222222222222222222' };
const NOW = new Date('2026-10-06T12:00:00.000Z');
const TTL = 604_800;
const TX_HASH = '0xabc0000000000000000000000000000000000000000000000000000000000001' as Hex;
const SETTLE_HASH = '0xabc0000000000000000000000000000000000000000000000000000000000002' as Hex;
const BUDGET = parseUnits('12.5', 6); // 12_500_000n

const config: Erc8183Config = {
  evaluatorAddress: EVALUATOR,
  jobTtlSeconds: TTL,
  evaluationDelaySeconds: 0,
  backendPublicUrl: 'https://api.example.test',
  chain: (chainId) => (chainId === CHAIN_ID ? { chainId, escrow: ESCROW, hook: HOOK } : null),
};

type JobRow = Record<string, unknown> & { id: string; status: string };
type TxRow = Record<string, unknown> & { id: string; intentId: string | null; status: string };

function escrowJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    requesterId: REQUESTER.id,
    providerId: PROVIDER.id,
    status: 'PENDING',
    reward: { amount: '12.5', token: 'USDC', chainId: CHAIN_ID },
    result: null,
    reservationStatus: 'PENDING',
    escrowKind: 'erc8183',
    escrowChainId: CHAIN_ID,
    escrowContract: ESCROW,
    onChainJobId: null,
    onChainStatus: 'CREATING',
    evaluator: EVALUATOR,
    budgetToken: USDC,
    budgetAmount: BUDGET.toString(),
    expiresAt: new Date(NOW.getTime() + TTL * 1000),
    deliverableHash: null,
    settleTxHash: null,
    platformFeeAmount: null,
    feedbackStatus: null,
    feedbackFile: null,
    contestedAt: null,
    contestReason: null,
    escrowError: null,
    requester: REQUESTER,
    provider: PROVIDER,
    ...overrides,
  };
}

/** Encodes an event the way a node would log it (topics for indexed inputs, ABI-encoded data for the rest). */
function makeLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address): Log {
  const item = getAbiItem({ abi, name: eventName }) as unknown as { inputs: Array<{ name: string; type: string; indexed?: boolean }> };
  const topics = encodeEventTopics({ abi, eventName, args } as never);
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed.map((i) => ({ name: i.name, type: i.type })),
        nonIndexed.map((i) => args[i.name]),
      )
    : '0x';
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: 1n,
    blockHash: '0x00' as Hex,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

/**
 * Prisma `where` matcher for the stand-in: equality, `in`, `notIn`, `not`,
 * `lt`, `lte`, `startsWith`, `OR`, `AND` — the shapes the orchestrator issues.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Record<string, unknown>[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Record<string, unknown>[]).every((w) => matchesWhere(row, w))) return false;
      continue;
    }
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; lt?: Date; lte?: Date; startsWith?: string };
      if ('in' in c && !c.in!.includes(value)) return false;
      if ('notIn' in c && c.notIn!.includes(value)) return false;
      if ('not' in c && value === (c.not ?? null)) return false;
      if ('lt' in c && !(value instanceof Date && value < c.lt!)) return false;
      if ('lte' in c && !(value instanceof Date && value <= c.lte!)) return false;
      if ('startsWith' in c && !(typeof value === 'string' && value.startsWith(c.startsWith!))) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

/** Applies `orderBy: { createdAt }` to rows kept in insertion order (rows carry no timestamps). */
function ordered<T>(rows: T[], orderBy?: { createdAt?: 'asc' | 'desc' }): T[] {
  return orderBy?.createdAt === 'desc' ? [...rows].reverse() : rows;
}

/** In-memory Prisma stand-in covering the queries the orchestrator issues. */
function makeDb(jobs: JobRow[], txs: TxRow[] = []) {
  const jobTable = new Map(jobs.map((j) => [j.id, j]));
  const txTable = new Map(txs.map((t) => [t.id, t]));
  let txSeq = txTable.size;

  type Args = { where?: Record<string, unknown>; data?: Record<string, unknown>; take?: number; orderBy?: { createdAt?: 'asc' | 'desc' } };

  const db = {
    job: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => jobTable.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where, orderBy }: Args) => ordered([...jobTable.values()], orderBy).find((row) => matchesWhere(row, where)) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = jobTable.get(where.id);
        if (!row) throw new Error(`job ${where.id} not found`);
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: Args) => {
        let count = 0;
        for (const row of jobTable.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where, take }: Args) => {
        const rows = [...jobTable.values()].filter((row) => matchesWhere(row, where));
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      }),
    },
    transaction: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; intentId?: string } }) => {
        if (where.id) return txTable.get(where.id) ?? null;
        return [...txTable.values()].find((t) => t.intentId === where.intentId) ?? null;
      }),
      // Default order: newest first (the orchestrator always asks for the latest attempt).
      findFirst: vi.fn(async ({ where, orderBy }: Args) =>
        ordered([...txTable.values()], orderBy ?? { createdAt: 'desc' }).find((t) => matchesWhere(t, where)) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `tx-${++txSeq}`, txHash: null, ...data } as unknown as TxRow;
        txTable.set(row.id, row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = txTable.get(where.id);
        if (!row) throw new Error(`transaction ${where.id} not found`);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { db: db as unknown as PrismaClient, dbMock: db, jobs: jobTable, txs: txTable };
}

function makeDeps(
  jobs: JobRow[],
  opts: {
    txs?: TxRow[];
    chainStatus?: number;
    chainBudget?: bigint;
    allowance?: bigint;
    receiptLogs?: Log[];
    settleLogs?: Log[];
    settleStatus?: 'success' | 'reverted';
  } = {},
) {
  const store = makeDb(jobs, opts.txs);
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const settlement = { add: vi.fn().mockResolvedValue(undefined) };
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'token') return USDC;
    if (functionName === 'getJob') return { status: opts.chainStatus ?? CHAIN_JOB_STATUS.Submitted, budget: opts.chainBudget ?? BUDGET };
    if (functionName === 'allowance') return opts.allowance ?? 0n;
    throw new Error(`unexpected read ${functionName}`);
  });
  const getTransactionReceipt = vi.fn(async () => ({ status: 'success', logs: opts.receiptLogs ?? [] }));
  const signer = {
    address: EVALUATOR,
    chainId: CHAIN_ID,
    writeContract: vi.fn(async (_params: EvaluatorWriteParams) => SETTLE_HASH),
    waitForTransactionReceipt: vi.fn(async () => ({ status: opts.settleStatus ?? 'success', logs: opts.settleLogs ?? [] })),
  };
  const releaseJobEscrow = vi.fn().mockResolvedValue(undefined);
  const finalize = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const getBalance = vi.fn(async () => 10n ** 18n);
  const alert = vi.fn();
  const deps: Erc8183Deps = {
    db: store.db,
    queue: queue as never,
    settlement,
    publicClient: () => ({ readContract, getTransactionReceipt, getBalance }) as never,
    evaluatorSigner: () => signer as never,
    config,
    releaseJobEscrow,
    finalize,
    logger,
    now: () => NOW,
    alert,
  };
  return { ...store, deps, queue, settlement, readContract, getTransactionReceipt, getBalance, signer, releaseJobEscrow, finalize, logger, alert };
}

/** Transaction row for a step, as `enqueueStep` would have created it. */
function stepTx(step: string, jobId: string, overrides: Partial<TxRow> = {}): TxRow {
  return {
    id: `tx-${step}`,
    intentId: escrowIntentId(step as never, jobId),
    status: 'CONFIRMED',
    txHash: TX_HASH,
    chainId: CHAIN_ID,
    metadata: { jobId, erc8183: true, escrowStep: step },
    ...overrides,
  };
}

function lastQueued(queue: { add: ReturnType<typeof vi.fn> }) {
  const call = queue.add.mock.calls[queue.add.mock.calls.length - 1];
  return { name: call?.[0] as string, data: call?.[1] as Record<string, unknown> };
}

beforeEach(() => {
  __resetEscrowTokenCacheForTests();
});

// ── Enablement + token ─────────────────────────────────────────────────────

describe('enablement and token rules', () => {
  it('is enabled only with an escrow address AND an evaluator key', () => {
    expect(isErc8183EnabledWith(config, CHAIN_ID)).toBe(true);
    expect(isErc8183EnabledWith(config, 8453)).toBe(false);
    expect(isErc8183EnabledWith({ ...config, evaluatorAddress: null }, CHAIN_ID)).toBe(false);
  });

  it('accepts USDC by symbol or escrow token address, case-insensitively (D8)', () => {
    expect(isEscrowTokenReward('USDC', USDC)).toBe(true);
    expect(isEscrowTokenReward('usdc', USDC)).toBe(true);
    expect(isEscrowTokenReward(USDC.toLowerCase(), USDC)).toBe(true);
    expect(isEscrowTokenReward('ETH', USDC)).toBe(false);
    expect(isEscrowTokenReward('0x4200000000000000000000000000000000000006', USDC)).toBe(false);
  });

  it('reads token() once per chain and caches it; falls back to the registry when the RPC fails', async () => {
    const { deps, readContract } = makeDeps([]);
    expect(await getEscrowToken(deps, CHAIN_ID)).toBe(USDC);
    expect(await getEscrowToken(deps, CHAIN_ID)).toBe(USDC);
    expect(readContract).toHaveBeenCalledTimes(1);

    __resetEscrowTokenCacheForTests();
    readContract.mockRejectedValueOnce(new Error('rpc down'));
    expect(await getEscrowToken(deps, CHAIN_ID)).toBe(USDC);
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

// ── startEscrow ────────────────────────────────────────────────────────────

describe('startEscrow', () => {
  it('persists the escrow columns and enqueues createJob from the requester wallet', async () => {
    const { deps, jobs, txs, queue } = makeDeps([escrowJob({ escrowKind: null, onChainStatus: null, budgetAmount: null })]);

    await startEscrow(deps, { job: { id: 'job-1' }, requester: REQUESTER, provider: PROVIDER, amount: '12.5', chainId: CHAIN_ID });

    const job = jobs.get('job-1')!;
    expect(job).toMatchObject({
      escrowKind: 'erc8183',
      escrowChainId: CHAIN_ID,
      escrowContract: ESCROW,
      evaluator: EVALUATOR,
      budgetToken: USDC,
      budgetAmount: '12500000',
      onChainStatus: 'CREATING',
    });
    expect((job['expiresAt'] as Date).getTime()).toBe(NOW.getTime() + TTL * 1000);

    const tx = [...txs.values()][0]!;
    expect(tx).toMatchObject({
      agentId: REQUESTER.id,
      type: 'ESCROW_LOCK',
      status: 'QUEUED',
      intentId: 'erc8183:create:job-1',
      metadata: expect.objectContaining({ jobId: 'job-1', erc8183: true, escrowStep: 'create' }),
    });

    const { name, data } = lastQueued(queue);
    expect(name).toBe('erc8183-create');
    expect(data).toMatchObject({ transactionId: tx.id, from: REQUESTER.safeAddress, to: ESCROW, walletId: REQUESTER.walletId, agentId: REQUESTER.id, value: '0' });
    const decoded = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: data['data'] as Hex });
    expect(decoded.functionName).toBe('createJob');
    expect(decoded.args).toEqual([
      PROVIDER.safeAddress,
      EVALUATOR,
      BigInt(Math.floor((NOW.getTime() + TTL * 1000) / 1000)),
      'https://api.example.test/v1/jobs/job-1',
      HOOK,
    ]);
  });

  it('refuses a chain without escrow config before writing anything', async () => {
    const { deps, queue, dbMock } = makeDeps([escrowJob()]);
    await expect(
      startEscrow(deps, { job: { id: 'job-1' }, requester: REQUESTER, provider: PROVIDER, amount: '1', chainId: 8453 }),
    ).rejects.toThrow(/not enabled/);
    expect(queue.add).not.toHaveBeenCalled();
    expect(dbMock.job.update).not.toHaveBeenCalled();
  });

  it('re-enqueue of a step already in flight is idempotent (same intentId, no second row)', async () => {
    const { deps, queue, txs } = makeDeps([escrowJob()], { txs: [stepTx('create', 'job-1', { status: 'QUEUED', txHash: null })] });
    await startEscrow(deps, { job: { id: 'job-1' }, requester: REQUESTER, provider: PROVIDER, amount: '12.5', chainId: CHAIN_ID });
    expect(queue.add).not.toHaveBeenCalled();
    expect(txs.size).toBe(1);
  });
});

// ── Step chain ─────────────────────────────────────────────────────────────

describe('onEscrowTxOutcome — funding chain happy path', () => {
  it('create confirmed → JobCreated parsed with the generated ABI → OPEN + setBudget enqueued', async () => {
    const jobCreated = makeLog(
      AGENT_JOB_ESCROW_ABI,
      'JobCreated',
      { jobId: 7n, client: REQUESTER.safeAddress, provider: PROVIDER.safeAddress, evaluator: EVALUATOR, expiredAt: 1n, hook: HOOK },
      ESCROW,
    );
    const foreign = makeLog(AGENT_JOB_ESCROW_ABI, 'JobCreated', { jobId: 99n, client: EVALUATOR, provider: EVALUATOR, evaluator: EVALUATOR, expiredAt: 1n, hook: HOOK }, HOOK);
    const { deps, jobs, queue, getTransactionReceipt } = makeDeps([escrowJob()], {
      txs: [stepTx('create', 'job-1')],
      receiptLogs: [foreign, jobCreated],
    });

    await onEscrowTxOutcome(deps, { transactionId: 'tx-create', status: 'CONFIRMED' });

    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH });
    expect(jobs.get('job-1')).toMatchObject({ onChainJobId: '7', onChainStatus: 'OPEN' });
    const { name, data } = lastQueued(queue);
    expect(name).toBe('erc8183-setBudget');
    expect(data).toMatchObject({ from: REQUESTER.safeAddress, to: ESCROW });
    const decoded = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: data['data'] as Hex });
    expect(decoded.functionName).toBe('setBudget');
    expect(decoded.args).toEqual([7n, BUDGET, '0x']);
  });

  it('setBudget → BUDGET_SET + USDC approve(escrow, budget); approve → APPROVED + fund; fund → FUNDED, chain ends', async () => {
    const { deps, jobs, queue, txs } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'OPEN' })], {
      // approve/fund rows stand in for the worker's later confirmations; their
      // intentIds are null so the orchestrator's idempotency check sees no live step.
      txs: [stepTx('setBudget', 'job-1'), stepTx('approve', 'job-1', { intentId: null }), stepTx('fund', 'job-1', { intentId: null })],
    });

    await onEscrowTxOutcome(deps, { transactionId: 'tx-setBudget', status: 'CONFIRMED' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('BUDGET_SET');
    let step = lastQueued(queue);
    expect(step.name).toBe('erc8183-approve');
    expect(step.data['to']).toBe(USDC);
    const approve = decodeFunctionData({
      abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const,
      data: step.data['data'] as Hex,
    });
    expect(approve.args).toEqual([ESCROW, BUDGET]);

    await onEscrowTxOutcome(deps, { transactionId: 'tx-approve', status: 'CONFIRMED' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('APPROVED');
    step = lastQueued(queue);
    expect(step.name).toBe('erc8183-fund');
    const fund = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: step.data['data'] as Hex });
    expect(fund.functionName).toBe('fund');
    expect(fund.args).toEqual([7n, BUDGET, '0x']);

    const addsBefore = queue.add.mock.calls.length;
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'CONFIRMED' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('FUNDED');
    expect(queue.add.mock.calls.length).toBe(addsBefore);
    // Every requester step carries the deterministic intentId.
    const intents = [...txs.values()].map((t) => t.intentId).filter(Boolean).sort();
    expect(intents).toEqual(['erc8183:approve:job-1', 'erc8183:fund:job-1', 'erc8183:setBudget:job-1'].sort());
  });

  it('ignores transactions that are not escrow steps', async () => {
    const { deps, queue, dbMock } = makeDeps([escrowJob()], { txs: [{ id: 'tx-x', intentId: null, status: 'CONFIRMED', metadata: { a2aPayment: true, jobId: 'job-1' } }] });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-x', status: 'CONFIRMED' });
    expect(queue.add).not.toHaveBeenCalled();
    expect(dbMock.job.update).not.toHaveBeenCalled();
  });
});

describe('onEscrowTxOutcome — failures and cancellation', () => {
  it('a step REVERTED before FUNDED (chain still Open, no allowance) → onChainStatus FAILED, Job FAILED, reservation released, no next step', async () => {
    const { deps, jobs, queue, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'BUDGET_SET', status: 'PENDING' })], {
      txs: [stepTx('approve', 'job-1', { status: 'REVERTED' })],
      chainStatus: CHAIN_JOB_STATUS.Open,
    });

    await onEscrowTxOutcome(deps, { transactionId: 'tx-approve', status: 'REVERTED', error: 'execution reverted' });

    expect(jobs.get('job-1')).toMatchObject({ status: 'FAILED', onChainStatus: 'FAILED', escrowError: 'approve REVERTED: execution reverted' });
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('create confirmed without a JobCreated log is a failure (nothing locked)', async () => {
    const { deps, jobs, releaseJobEscrow, queue } = makeDeps([escrowJob()], { txs: [stepTx('create', 'job-1')], receiptLogs: [] });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-create', status: 'CONFIRMED' });
    expect(jobs.get('job-1')).toMatchObject({ status: 'FAILED', onChainStatus: 'FAILED' });
    expect(jobs.get('job-1')!['escrowError']).toMatch(/JobCreated event not found/);
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a cancelled job stops the chain: the confirmed step is recorded, the next one is never enqueued', async () => {
    const { deps, jobs, queue, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'OPEN', status: 'CANCELLED' })], {
      txs: [stepTx('setBudget', 'job-1')],
    });

    await onEscrowTxOutcome(deps, { transactionId: 'tx-setBudget', status: 'CONFIRMED' });

    expect(jobs.get('job-1')!['onChainStatus']).toBe('BUDGET_SET');
    expect(queue.add).not.toHaveBeenCalled();
    expect(releaseJobEscrow).not.toHaveBeenCalled(); // the route already released it
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', nextStep: 'approve' }), expect.stringContaining('chain stopped'));
  });

  it('fund confirming after a cancellation schedules an evaluator reject (budget is locked now)', async () => {
    const { deps, jobs, settlement } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'APPROVED', status: 'CANCELLED' })], {
      txs: [stepTx('fund', 'job-1')],
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'CONFIRMED' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('FUNDED');
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'reject', reason: 'cancelled' });
  });

  it('submit FAILED (chain still Funded) → job back to ACCEPTED with escrowError, onChainStatus stays FUNDED, reservation kept', async () => {
    const { deps, jobs, releaseJobEscrow, finalize } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { status: 'FAILED', txHash: null })],
      chainStatus: CHAIN_JOB_STATUS.Funded,
    });

    await onEscrowTxOutcome(deps, { transactionId: 'tx-submit', status: 'FAILED', error: 'Agent paused before submission' });

    expect(jobs.get('job-1')).toMatchObject({ status: 'ACCEPTED', onChainStatus: 'FUNDED', reservationStatus: 'PENDING', escrowError: 'submit FAILED: Agent paused before submission' });
    expect(releaseJobEscrow).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
});

// ── Submit ─────────────────────────────────────────────────────────────────

describe('enqueueSubmit + submit confirmation', () => {
  it('enqueues submit(onChainJobId, keccak256(result)) from the PROVIDER wallet as ESCROW_SUBMIT', async () => {
    const { deps, jobs, txs, queue } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })]);
    const result = { answer: 42, notes: ['a', 'b'] };

    await enqueueSubmit(deps, { jobId: 'job-1', result });

    const expectedHash = keccak256(toBytes(JSON.stringify(result)));
    expect(deliverableHashOf(result)).toBe(expectedHash);
    expect(deliverableHashOf(undefined)).toBe(keccak256(toBytes('{}')));
    expect(jobs.get('job-1')!['deliverableHash']).toBe(expectedHash);
    const tx = [...txs.values()][0]!;
    expect(tx).toMatchObject({ agentId: PROVIDER.id, type: 'ESCROW_SUBMIT', intentId: 'erc8183:submit:job-1', metadata: expect.objectContaining({ escrowStep: 'submit', deliverable: expectedHash }) });
    const { name, data } = lastQueued(queue);
    expect(name).toBe('erc8183-submit');
    expect(data).toMatchObject({ from: PROVIDER.safeAddress, walletId: PROVIDER.walletId, to: ESCROW });
    const decoded = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: data['data'] as Hex });
    expect(decoded.functionName).toBe('submit');
    expect(decoded.args).toEqual([7n, expectedHash, '0x']);
  });

  it('a retry after a failed submit gets a fresh intentId instead of colliding', async () => {
    const { deps, txs } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { status: 'FAILED', txHash: null })],
    });
    await enqueueSubmit(deps, { jobId: 'job-1', result: {} });
    const intents = [...txs.values()].map((t) => t.intentId);
    expect(intents).toEqual(['erc8183:submit:job-1', `erc8183:submit:job-1#${NOW.getTime()}`]);
  });

  it('a synchronous enqueue failure puts the job back to ACCEPTED and rethrows', async () => {
    const { deps, jobs, queue } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })]);
    queue.add.mockRejectedValueOnce(new Error('redis gone'));
    await expect(enqueueSubmit(deps, { jobId: 'job-1', result: {} })).rejects.toThrow('redis gone');
    expect(jobs.get('job-1')).toMatchObject({ status: 'ACCEPTED' });
    expect(jobs.get('job-1')!['escrowError']).toMatch(/redis gone/);
  });

  it('submit confirmed → SUBMITTED + deliverableHash + settlement scheduled with the evaluation delay', async () => {
    const delayed = { ...config, evaluationDelaySeconds: 90 };
    const { deps, jobs, settlement } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { metadata: { jobId: 'job-1', erc8183: true, escrowStep: 'submit', deliverable: '0x' + 'ab'.repeat(32) } })],
    });
    await onEscrowTxOutcome({ ...deps, config: delayed }, { transactionId: 'tx-submit', status: 'CONFIRMED' });
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SUBMITTED', deliverableHash: '0x' + 'ab'.repeat(32) });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'settle' }, { delayMs: 90_000 });
  });
});

// ── Cancellation request ───────────────────────────────────────────────────

describe('requestCancellationReject', () => {
  it('schedules an evaluator reject for every job that exists on-chain and is not final (the reject reads the chain)', async () => {
    const { deps, settlement } = makeDeps([
      escrowJob({ id: 'funded', onChainJobId: '7', onChainStatus: 'FUNDED' }),
      // C3c: the DB may lag the chain (a fund whose monitor was lost) — the reject action decides from getJob.
      escrowJob({ id: 'approved', onChainJobId: '8', onChainStatus: 'APPROVED' }),
      escrowJob({ id: 'creating', onChainJobId: null, onChainStatus: 'CREATING' }),
      escrowJob({ id: 'rejected', onChainJobId: '9', onChainStatus: 'REJECTED' }),
      escrowJob({ id: 'legacy', escrowKind: null }),
    ]);
    expect(await requestCancellationReject(deps, { jobId: 'funded', reason: 'provider-failed' })).toBe(true);
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'funded', action: 'reject', reason: 'provider-failed' });
    expect(await requestCancellationReject(deps, { jobId: 'approved', reason: 'cancelled' })).toBe(true);
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'approved', action: 'reject', reason: 'cancelled' });
    expect(await requestCancellationReject(deps, { jobId: 'creating', reason: 'cancelled' })).toBe(false);
    expect(await requestCancellationReject(deps, { jobId: 'rejected', reason: 'cancelled' })).toBe(false);
    expect(await requestCancellationReject(deps, { jobId: 'legacy', reason: 'cancelled' })).toBe(false);
    expect(settlement.add).toHaveBeenCalledTimes(2);
  });
});

// ── Settlement ─────────────────────────────────────────────────────────────

const SUBMITTED_JOB = () => escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', deliverableHash: '0x' + 'cd'.repeat(32) });
const FUND_TX = () => stepTx('fund', 'job-1', { txHash: '0xf00d000000000000000000000000000000000000000000000000000000000001' });

function completeLogs(feedback: 'written' | 'skipped' | 'failed' | 'none' = 'written'): Log[] {
  const logs = [
    makeLog(AGENT_JOB_ESCROW_ABI, 'JobCompleted', { jobId: 7n, evaluator: EVALUATOR, reason: SETTLEMENT_REASONS.completed }, ESCROW),
    makeLog(AGENT_JOB_ESCROW_ABI, 'PaymentReleased', { jobId: 7n, provider: PROVIDER.safeAddress, amount: 12_462_500n }, ESCROW),
    makeLog(AGENT_JOB_ESCROW_ABI, 'PlatformFeeAccrued', { jobId: 7n, amount: 37_500n }, ESCROW),
  ];
  if (feedback === 'written') logs.push(makeLog(REPUTATION_HOOK_ABI, 'FeedbackWritten', { jobId: 7n, agentId: 3n, value: 100n }, HOOK));
  if (feedback === 'skipped') logs.push(makeLog(REPUTATION_HOOK_ABI, 'FeedbackSkipped', { jobId: 7n, reason: stringToHex('no-agent-id', { size: 32 }) }, HOOK));
  if (feedback === 'failed') logs.push(makeLog(REPUTATION_HOOK_ABI, 'FeedbackFailed', { jobId: 7n, reason: '0x1234' }, HOOK));
  return logs;
}

function rejectLogs(): Log[] {
  return [
    makeLog(AGENT_JOB_ESCROW_ABI, 'JobRejected', { jobId: 7n, rejector: EVALUATOR, reason: SETTLEMENT_REASONS.contested }, ESCROW),
    makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
    makeLog(REPUTATION_HOOK_ABI, 'FeedbackSkipped', { jobId: 7n, reason: stringToHex('budget-too-small', { size: 32 }) }, HOOK),
  ];
}

const settleJob = (attemptsMade = 1) => ({ data: { jobId: 'job-1', action: 'settle' as const }, attemptsMade, opts: { attempts: 3 } });

describe('processSettlementJob — settle', () => {
  it('complete: feedback file generated once, optParams encoded, receipt parsed, finalizer CONFIRMED', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });

    const result = await processSettlementJob(deps, settleJob());

    expect(result).toMatchObject({ outcome: 'settled', action: 'settle', onChainStatus: 'COMPLETED', txHash: SETTLE_HASH, feedbackStatus: 'written' });
    const job = jobs.get('job-1')!;
    expect(job).toMatchObject({ onChainStatus: 'COMPLETED', settleTxHash: SETTLE_HASH, platformFeeAmount: '37500', feedbackStatus: 'written', escrowError: null });

    // Feedback file: generated once, stored, with the fund tx as proof of payment.
    const file = job['feedbackFile'] as FeedbackFile;
    expect(file).toMatchObject({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
      jobId: 'job-1',
      escrow: { chainId: CHAIN_ID, contract: ESCROW, onChainJobId: 7 },
      proofOfPayment: { chainId: CHAIN_ID, txHash: FUND_TX().txHash, fromAddress: REQUESTER.safeAddress, toAddress: ESCROW },
      outcome: 'completed',
      deliverableHash: '0x' + 'cd'.repeat(32),
      evaluator: EVALUATOR,
      issuedAt: NOW.toISOString(),
    });

    // The evaluator signed complete(7, keccak("agentfi.completed"), abi.encode(uri, hash)).
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.address).toBe(ESCROW);
    expect(call.functionName).toBe('complete');
    expect(call.args[0]).toBe(7n);
    expect(call.args[1]).toBe(SETTLEMENT_REASONS.completed);
    const [uri, hash] = decodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], call.args[2] as Hex);
    expect(uri).toBe('https://api.example.test/v1/jobs/job-1/feedback.json');
    expect(uri).toBe(feedbackUriFor(config, 'job-1'));
    expect(hash).toBe(feedbackHashOf(file));
    expect(hash).toBe(keccak256(toBytes(serializeFeedbackFile(file))));

    expect(finalize).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'CONFIRMED', transactionId: null });
  });

  it('parses FeedbackSkipped(bytes32 reason) into "skipped:<reason>" and FeedbackFailed into "failed"', async () => {
    const skipped = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('skipped') });
    await processSettlementJob(skipped.deps, settleJob());
    expect(skipped.jobs.get('job-1')!['feedbackStatus']).toBe('skipped:no-agent-id');

    const failed = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('failed') });
    await processSettlementJob(failed.deps, settleJob());
    expect(failed.jobs.get('job-1')!['feedbackStatus']).toBe('failed');

    const none = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('none') });
    await processSettlementJob(none.deps, settleJob());
    expect(none.jobs.get('job-1')!['feedbackStatus']).toBeNull();
  });

  it('contested → reject with keccak("agentfi.contested"), outcome rejected, finalizer FAILED', async () => {
    const { deps, jobs, signer, finalize, releaseJobEscrow } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: rejectLogs() });
    jobs.get('job-1')!['contestedAt'] = NOW;

    const result = await processSettlementJob(deps, settleJob());

    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'REJECTED', feedbackStatus: 'skipped:budget-too-small' });
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('reject');
    expect(call.args[1]).toBe(SETTLEMENT_REASONS.contested);
    expect((jobs.get('job-1')!['feedbackFile'] as FeedbackFile).outcome).toBe('rejected');
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'REJECTED', settleTxHash: SETTLE_HASH });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', outcome: 'FAILED', transactionId: null, reason: expect.stringContaining('contested') }));
    // The DB reservation is released by the finalizer's FAILED branch, not here.
    expect(releaseJobEscrow).not.toHaveBeenCalled();
  });

  it('reuses a stored feedback file (never regenerated once present with the same outcome)', async () => {
    const stored: FeedbackFile = {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
      jobId: 'job-1',
      escrow: { chainId: CHAIN_ID, contract: ESCROW, onChainJobId: 7 },
      proofOfPayment: { chainId: CHAIN_ID, txHash: TX_HASH, fromAddress: REQUESTER.safeAddress as Address, toAddress: ESCROW },
      outcome: 'completed',
      deliverableHash: null,
      evaluator: EVALUATOR,
      issuedAt: '2026-10-01T00:00:00.000Z',
    };
    const { deps, jobs, signer } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs() });
    jobs.get('job-1')!['feedbackFile'] = stored;
    await processSettlementJob(deps, settleJob());
    expect(jobs.get('job-1')!['feedbackFile']).toBe(stored);
    const call = signer.writeContract.mock.calls[0]![0];
    const [, hash] = decodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], call.args[2] as Hex);
    expect(hash).toBe(feedbackHashOf(stored));
  });

  it('already Completed on-chain → reconciled without sending; finalizer CONFIRMED', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SETTLING', status: 'PAYMENT_PENDING' })], { chainStatus: CHAIN_JOB_STATUS.Completed });
    const result = await processSettlementJob(deps, settleJob(2));
    expect(result).toEqual({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')!['onChainStatus']).toBe('COMPLETED');
    expect(finalize).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'CONFIRMED', transactionId: null });
  });

  it('already Expired on-chain for a PAYMENT_PENDING job → reconciled as EXPIRED, finalizer FAILED, nothing sent', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Expired });
    await processSettlementJob(deps, settleJob());
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')!['onChainStatus']).toBe('EXPIRED');
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', outcome: 'FAILED' }));
  });

  it('reverted settlement throws (BullMQ retries); last attempt leaves PAYMENT_PENDING + SUBMITTED, no DB refund', async () => {
    const { deps, jobs, finalize, releaseJobEscrow } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleStatus: 'reverted' });

    const job = settleJob(3);
    await expect(processSettlementJob(deps, job)).rejects.toThrow(/reverted on-chain/);
    expect(jobs.get('job-1')!['onChainStatus']).toBe('SETTLING');
    expect(jobs.get('job-1')!['settleTxHash']).toBe(SETTLE_HASH);

    await handleFailedSettlementJob(deps, job, new Error('ERC-8183 settle reverted on-chain'));

    expect(jobs.get('job-1')).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', reservationStatus: 'PENDING' });
    expect(jobs.get('job-1')!['escrowError']).toMatch(/settle failed after 3 attempts/);
    expect(finalize).not.toHaveBeenCalled();
    expect(releaseJobEscrow).not.toHaveBeenCalled();
  });

  it('reverted complete → contest → the retry sends reject with a feedback file whose outcome is "rejected"', async () => {
    const { deps, jobs, signer } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: rejectLogs() });
    // Attempt 1: complete is sent but reverts. settleTxHash is now set, the
    // feedback file says "completed", nothing was mined.
    signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] } as never);
    const first = settleJob(3);
    await expect(processSettlementJob(deps, first)).rejects.toThrow(/reverted on-chain/);
    await handleFailedSettlementJob(deps, first, new Error('reverted'));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SUBMITTED', settleTxHash: SETTLE_HASH });
    expect((jobs.get('job-1')!['feedbackFile'] as FeedbackFile).outcome).toBe('completed');
    expect((signer.writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('complete');

    // Requester contests while the job is back to SUBMITTED.
    jobs.get('job-1')!['contestedAt'] = NOW;

    // Attempt 2 (recovery re-enqueue): must reject with a REBUILT file.
    const result = await processSettlementJob(deps, settleJob(1));

    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'REJECTED' });
    const second = signer.writeContract.mock.calls[1]![0] as { functionName: string; args: readonly unknown[] };
    expect(second.functionName).toBe('reject');
    expect(second.args[1]).toBe(SETTLEMENT_REASONS.contested);
    const file = jobs.get('job-1')!['feedbackFile'] as FeedbackFile;
    expect(file.outcome).toBe('rejected');
    const [, hash] = decodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], second.args[2] as Hex);
    expect(hash).toBe(feedbackHashOf(file));
  });

  it('the failure handler is a no-op before the last attempt', async () => {
    const { deps, jobs } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SETTLING', status: 'PAYMENT_PENDING' })]);
    await handleFailedSettlementJob(deps, settleJob(1), new Error('rpc down'));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING', escrowError: null });
  });

  it('refuses to settle when the chain is not Submitted (submit not mined yet) so BullMQ retries', async () => {
    const { deps, signer } = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Funded });
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/expected Submitted/);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('is a no-op for a job that is no longer PAYMENT_PENDING', async () => {
    const { deps, signer } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'COMPLETED' })]);
    const result = await processSettlementJob(deps, settleJob());
    expect(result).toMatchObject({ outcome: 'noop' });
    expect(signer.writeContract).not.toHaveBeenCalled();
  });
});

describe('processSettlementJob — reject (cancellation) and claimRefund (expiry)', () => {
  it('reject for a cancelled FUNDED job → evaluator reject(cancelled), REJECTED, reservation released', async () => {
    const logs = [
      makeLog(AGENT_JOB_ESCROW_ABI, 'JobRejected', { jobId: 7n, rejector: EVALUATOR, reason: SETTLEMENT_REASONS.cancelled }, ESCROW),
      makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
    ];
    const { deps, jobs, signer, releaseJobEscrow, finalize } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'CANCELLED' })], {
      chainStatus: CHAIN_JOB_STATUS.Funded,
      settleLogs: logs,
    });

    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' }, attemptsMade: 1, opts: { attempts: 3 } });

    expect(result).toMatchObject({ outcome: 'settled', action: 'reject', onChainStatus: 'REJECTED' });
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('reject');
    expect(call.args).toEqual([7n, SETTLEMENT_REASONS.cancelled, '0x']);
    expect(jobs.get('job-1')).toMatchObject({ status: 'CANCELLED', onChainStatus: 'REJECTED', settleTxHash: SETTLE_HASH });
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-1');
    expect(finalize).not.toHaveBeenCalled();
  });

  it('reject while the chain is still Open is a no-op (nothing locked)', async () => {
    const { deps, signer } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'OPEN', status: 'CANCELLED' })], { chainStatus: CHAIN_JOB_STATUS.Open });
    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } });
    expect(result).toMatchObject({ outcome: 'noop' });
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('claimRefund on an ACCEPTED job → EXPIRED, Job FAILED, reservation released', async () => {
    const logs = [
      makeLog(AGENT_JOB_ESCROW_ABI, 'JobExpired', { jobId: 7n }, ESCROW),
      makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
    ];
    const { deps, jobs, signer, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'ACCEPTED' })], {
      chainStatus: CHAIN_JOB_STATUS.Funded,
      settleLogs: logs,
    });
    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } });
    expect(result).toMatchObject({ outcome: 'settled', action: 'claimRefund', onChainStatus: 'EXPIRED' });
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('claimRefund');
    expect(call.args).toEqual([7n]);
    expect(jobs.get('job-1')).toMatchObject({ status: 'FAILED', onChainStatus: 'EXPIRED' });
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-1');
  });

  it('claimRefund on a PAYMENT_PENDING (submitted) job → finalizer FAILED', async () => {
    const { deps, finalize } = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Submitted, settleLogs: [makeLog(AGENT_JOB_ESCROW_ABI, 'JobExpired', { jobId: 7n }, ESCROW)] });
    await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', outcome: 'FAILED', reason: expect.stringContaining('Expired') }));
  });
});

// ── Expiry sweep + recovery ────────────────────────────────────────────────

describe('sweepExpiredEscrows', () => {
  it('C3c: enqueues claimRefund for every on-chain escrow job past expiresAt that is not final, whatever the DB step', async () => {
    const past = new Date(NOW.getTime() - 1000);
    const future = new Date(NOW.getTime() + 1000);
    const { deps, settlement } = makeDeps([
      escrowJob({ id: 'expired-funded', onChainJobId: '1', onChainStatus: 'FUNDED', expiresAt: past }),
      escrowJob({ id: 'expired-submitted', onChainJobId: '2', onChainStatus: 'SUBMITTED', expiresAt: past }),
      // The fund monitor was lost: the DB still says APPROVED while the chain may be Funded.
      escrowJob({ id: 'expired-approved', onChainJobId: '3', onChainStatus: 'APPROVED', expiresAt: past }),
      // Unwound as FAILED but the fund may have mined afterwards.
      escrowJob({ id: 'expired-failed', status: 'FAILED', onChainJobId: '4', onChainStatus: 'FAILED', expiresAt: past }),
      escrowJob({ id: 'expired-settling', onChainJobId: '5', onChainStatus: 'SETTLING', expiresAt: past }),
      escrowJob({ id: 'expired-final', onChainJobId: '6', onChainStatus: 'EXPIRED', expiresAt: past }),
      escrowJob({ id: 'expired-closed', onChainJobId: '10', onChainStatus: 'EXPIRED_UNFUNDED', expiresAt: past }),
      escrowJob({ id: 'expired-no-chain-job', onChainJobId: null, onChainStatus: 'CREATING', expiresAt: past }),
      escrowJob({ id: 'live', onChainJobId: '7', onChainStatus: 'FUNDED', expiresAt: future }),
      escrowJob({ id: 'legacy', escrowKind: null, onChainJobId: '8', onChainStatus: 'FUNDED', expiresAt: past }),
    ]);

    const result = await processSettlementJob(deps, { data: { jobId: '*', action: 'sweep' } });

    expect(result).toEqual({ outcome: 'swept', enqueued: 4 });
    expect(settlement.add.mock.calls.map((call) => (call[0] as { jobId: string }).jobId).sort()).toEqual(
      ['expired-approved', 'expired-failed', 'expired-funded', 'expired-submitted'].sort(),
    );
    expect(await sweepExpiredEscrows({ ...deps, now: () => new Date(0) })).toBe(0);
  });
});

describe('recoverErc8183Job (payment-recovery branch)', () => {
  it('re-enqueues the idempotent settlement for SUBMITTED / SETTLING / terminal-but-unfinalized jobs', async () => {
    const { deps, settlement, finalize, releaseJobEscrow } = makeDeps([escrowJob({ onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING' })]);
    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'SUBMITTED' })).toBe('resettled');
    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'SETTLING' })).toBe('resettled');
    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'COMPLETED' })).toBe('resettled');
    expect(settlement.add).toHaveBeenCalledTimes(3);
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'settle' });
    expect(finalize).not.toHaveBeenCalled();
    expect(releaseJobEscrow).not.toHaveBeenCalled();
  });

  it('FUNDED with a dead submit (chain still Funded) → back to ACCEPTED; with an in-flight submit → left alone', async () => {
    const dead = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { status: 'FAILED', error: 'rpc down' })],
      chainStatus: CHAIN_JOB_STATUS.Funded,
    });
    expect(await recoverErc8183Job(dead.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('returnedToAccepted');
    expect(dead.jobs.get('job-1')).toMatchObject({ status: 'ACCEPTED', escrowError: 'Recovery: submit FAILED (rpc down)' });

    const orphan = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], { chainStatus: CHAIN_JOB_STATUS.Funded });
    expect(await recoverErc8183Job(orphan.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('returnedToAccepted');

    const inFlight = makeDeps([escrowJob({ onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], { txs: [stepTx('submit', 'job-1', { status: 'SUBMITTED' })] });
    expect(await recoverErc8183Job(inFlight.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('inFlight');
    expect(inFlight.jobs.get('job-1')!['status']).toBe('PAYMENT_PENDING');
  });
});

// ── C3c: chain as the source of truth ──────────────────────────────────────

describe('C3c — the chain decides before anything is unwound', () => {
  it('a fund REVERTED while getJob says Funded → FUNDED, job stays PENDING, reservation kept', async () => {
    const { deps, jobs, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'APPROVED', status: 'PENDING' })], {
      txs: [stepTx('fund', 'job-1', { status: 'REVERTED' })],
      chainStatus: CHAIN_JOB_STATUS.Funded,
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'REVERTED', error: 'InvalidStatus' });
    expect(jobs.get('job-1')).toMatchObject({ status: 'PENDING', onChainStatus: 'FUNDED', escrowError: null });
    expect(releaseJobEscrow).not.toHaveBeenCalled();
  });

  it('an unreadable chain unwinds nothing: escrowError records it for the reconciliation', async () => {
    const { deps, jobs, readContract, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'APPROVED', status: 'PENDING' })], {
      txs: [stepTx('fund', 'job-1', { status: 'FAILED' })],
    });
    readContract.mockRejectedValue(new Error('rpc down'));
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'FAILED', error: 'Dropped' });
    expect(jobs.get('job-1')).toMatchObject({ status: 'PENDING', onChainStatus: 'APPROVED' });
    expect(jobs.get('job-1')!['escrowError']).toMatch(/left for reconciliation/);
    expect(releaseJobEscrow).not.toHaveBeenCalled();
  });

  it('setBudget reported failed but the budget is set on-chain → BUDGET_SET and the approve goes out', async () => {
    const { deps, jobs, queue } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'OPEN', status: 'PENDING' })], {
      txs: [stepTx('setBudget', 'job-1', { status: 'FAILED' })],
      chainStatus: CHAIN_JOB_STATUS.Open,
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-setBudget', status: 'FAILED', error: 'Dropped' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('BUDGET_SET');
    expect(lastQueued(queue).name).toBe('erc8183-approve');
  });

  it('approve reported failed but the allowance is granted → APPROVED and the fund goes out', async () => {
    const { deps, jobs, queue } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'BUDGET_SET', status: 'PENDING' })], {
      txs: [stepTx('approve', 'job-1', { status: 'FAILED' })],
      chainStatus: CHAIN_JOB_STATUS.Open,
      allowance: BUDGET,
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-approve', status: 'FAILED', error: 'Dropped' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('APPROVED');
    expect(lastQueued(queue).name).toBe('erc8183-fund');
  });

  it('a submit reported failed while the chain says Submitted → SUBMITTED + settlement, never back to ACCEPTED', async () => {
    const { deps, jobs, settlement } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { status: 'REVERTED' })],
      chainStatus: CHAIN_JOB_STATUS.Submitted,
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-submit', status: 'REVERTED', error: 'InvalidStatus' });
    expect(jobs.get('job-1')).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED' });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'settle' }, undefined);
  });

  it('a duplicate fund confirmation runs its effects once (conditional advance)', async () => {
    const { deps, settlement } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'APPROVED', status: 'CANCELLED' })], {
      txs: [stepTx('fund', 'job-1')],
    });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'CONFIRMED' });
    await onEscrowTxOutcome(deps, { transactionId: 'tx-fund', status: 'CONFIRMED' });
    expect(settlement.add).toHaveBeenCalledTimes(1);
  });

  it('enqueueSubmit failing while another submit of the job is live keeps PAYMENT_PENDING (no hand-back)', async () => {
    const { deps, jobs, queue } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { status: 'FAILED' }), { ...stepTx('submit', 'job-1', { status: 'SUBMITTED' }), id: 'tx-live', intentId: 'erc8183:submit:job-1#1' }],
    });
    queue.add.mockRejectedValueOnce(new Error('redis gone'));
    expect(await enqueueSubmit(deps, { jobId: 'job-1', result: {} })).toEqual({ deferred: false });
    expect(jobs.get('job-1')!['status']).toBe('PAYMENT_PENDING');
  });
});

describe('C3c — funding lane (pumpFunding)', () => {
  it('admits one job at a time between approve and the end of its fund, oldest first', async () => {
    const jobA = escrowJob({ id: 'job-a', onChainJobId: '1', onChainStatus: 'APPROVED', status: 'PENDING' });
    const jobB = escrowJob({ id: 'job-b', onChainJobId: '2', onChainStatus: 'BUDGET_SET', status: 'PENDING' });
    const jobC = escrowJob({ id: 'job-c', onChainJobId: '3', onChainStatus: 'BUDGET_SET', status: 'PENDING' });
    const { deps, jobs, queue } = makeDeps([jobA, jobB, jobC]);

    expect(await pumpFunding(deps, REQUESTER.id, CHAIN_ID)).toBeNull(); // A holds the lane
    expect(queue.add).not.toHaveBeenCalled();

    jobs.get('job-a')!['onChainStatus'] = 'FUNDED';
    expect(await pumpFunding(deps, REQUESTER.id, CHAIN_ID)).toBe('job-b');
    expect(lastQueued(queue).name).toBe('erc8183-approve');
    // B's approve is pending now: the lane is busy until B's fund is terminal.
    expect(await pumpFunding(deps, REQUESTER.id, CHAIN_ID)).toBeNull();
  });

  it('a cancelled holder that never sent its fund does not keep the lane', async () => {
    const { deps } = makeDeps([
      escrowJob({ id: 'job-a', onChainJobId: '1', onChainStatus: 'APPROVED', status: 'CANCELLED' }),
      escrowJob({ id: 'job-b', onChainJobId: '2', onChainStatus: 'BUDGET_SET', status: 'PENDING' }),
    ]);
    expect(await pumpFunding(deps, REQUESTER.id, CHAIN_ID)).toBe('job-b');
  });
});

describe('C3c — expiry, refusal and evaluator gas', () => {
  it('claimRefund on a job still Open past expiresAt closes it EXPIRED_UNFUNDED, fails a live job, releases the reservation', async () => {
    const { deps, jobs, signer, releaseJobEscrow } = makeDeps(
      [escrowJob({ onChainJobId: '7', onChainStatus: 'BUDGET_SET', status: 'PENDING', expiresAt: new Date(NOW.getTime() - 1000) })],
      { chainStatus: CHAIN_JOB_STATUS.Open },
    );
    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } });
    expect(result).toEqual({ outcome: 'reconciled', onChainStatus: 'EXPIRED_UNFUNDED' });
    expect(jobs.get('job-1')).toMatchObject({ status: 'FAILED', onChainStatus: 'EXPIRED_UNFUNDED' });
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-1');
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('a reject for a cancellation refuses a job Submitted on-chain: alert, mirror SUBMITTED, nothing sent', async () => {
    const { deps, jobs, signer, alert } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'CANCELLED' })], {
      chainStatus: CHAIN_JOB_STATUS.Submitted,
    });
    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } });
    expect(result).toMatchObject({ outcome: 'noop' });
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SUBMITTED', escrowError: expect.stringMatching(/Cancellation refused/) });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancellation-refused', jobId: 'job-1' }));
  });

  it('a stale reject for a live job is dropped', async () => {
    const { deps, signer } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'ACCEPTED' })], { chainStatus: CHAIN_JOB_STATUS.Funded });
    expect(await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } })).toMatchObject({ outcome: 'noop' });
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('alerts once per interval when the evaluator gas is below the threshold, and still sends', async () => {
    const low = { ...config, evaluatorMinBalanceWei: 10n ** 15n };
    const { deps, signer, alert, getBalance } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'CANCELLED' })], {
      chainStatus: CHAIN_JOB_STATUS.Funded,
    });
    getBalance.mockResolvedValue(10n ** 12n);
    const d = { ...deps, config: low };
    await processSettlementJob(d, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } });
    await processSettlementJob(d, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } });
    expect(signer.writeContract).toHaveBeenCalled();
    expect(alert.mock.calls.filter(([a]) => (a as { kind: string }).kind === 'evaluator-balance-low')).toHaveLength(1);
  });
});

// ── Feedback file + API view ───────────────────────────────────────────────

describe('feedback file serialization', () => {
  it('is byte-stable across key reordering (jsonb round-trip) so keccak256(served) == committed hash', () => {
    const file: FeedbackFile = {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
      jobId: 'job-1',
      escrow: { chainId: CHAIN_ID, contract: ESCROW, onChainJobId: 7 },
      proofOfPayment: { chainId: CHAIN_ID, txHash: TX_HASH, fromAddress: REQUESTER.safeAddress as Address, toAddress: ESCROW },
      outcome: 'completed',
      deliverableHash: null,
      evaluator: EVALUATOR,
      issuedAt: NOW.toISOString(),
    };
    // jsonb stores keys ordered by length then bytes — simulate an arbitrary reorder.
    const reordered = {
      issuedAt: file.issuedAt,
      proofOfPayment: { toAddress: file.proofOfPayment.toAddress, chainId: file.proofOfPayment.chainId, txHash: file.proofOfPayment.txHash, fromAddress: file.proofOfPayment.fromAddress },
      evaluator: file.evaluator,
      type: file.type,
      deliverableHash: file.deliverableHash,
      outcome: file.outcome,
      escrow: { onChainJobId: 7, contract: ESCROW, chainId: CHAIN_ID },
      jobId: file.jobId,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(file));
    expect(serializeFeedbackFile(reordered)).toBe(serializeFeedbackFile(file));
    expect(feedbackHashOf(reordered)).toBe(feedbackHashOf(file));
    expect(feedbackHashOf(file)).toBe(keccak256(toBytes(serializeFeedbackFile(file))));
  });
});

describe('toJobResponse', () => {
  it('folds the escrow columns into one `escrow` object and never inlines the feedback file', () => {
    const job = escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', feedbackFile: { secret: true } });
    const view = toJobResponse(job);
    expect(view.escrow).toMatchObject({ kind: 'erc8183', chainId: CHAIN_ID, contract: ESCROW, onChainJobId: '7', onChainStatus: 'FUNDED', evaluator: EVALUATOR, budgetAmount: BUDGET.toString(), budgetToken: USDC });
    expect(view).not.toHaveProperty('feedbackFile');
    expect(view).not.toHaveProperty('onChainStatus');
    expect(view).toHaveProperty('id', 'job-1');
    expect(view).toHaveProperty('reward');
  });

  it('exposes contestedAt and contestReason', () => {
    const contestedAt = new Date('2026-10-06T13:00:00.000Z');
    const view = toJobResponse(escrowJob({ contestedAt, contestReason: 'wrong answer' }));
    expect(view.escrow).toMatchObject({ contestedAt, contestReason: 'wrong answer' });
    expect(view).not.toHaveProperty('contestReason');
    expect(toJobResponse(escrowJob()).escrow).toMatchObject({ contestedAt: null, contestReason: null });
  });

  it('is `escrow: null` for legacy jobs', () => {
    const view = toJobResponse({ id: 'legacy', status: 'PENDING', escrowKind: null, onChainStatus: null });
    expect(view.escrow).toBeNull();
    expect(view).not.toHaveProperty('escrowKind');
  });
});
