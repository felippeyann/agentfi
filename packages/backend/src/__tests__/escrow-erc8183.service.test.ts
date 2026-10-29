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
 *  - C3d: a contest holds the job (CONTESTED) — never settled automatically;
 *    operator decisions pay / refund / quality-rejected / payout-blocked send
 *    the right call, reason and optParams; receipts surface the rated agent
 *    id and penalties; expiry alerts; delay clamped to the TTL
 *  - C3f review P3-1: the evaluator-stuck alert states the refund deadline
 *    (or that there is none) — never a made-up date
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  HttpRequestError,
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
import { InMemoryLaneLock } from '../services/transaction/wallet-lane.js';
import type { EvaluatorWriteOptions, EvaluatorWriteParams, PreparedEvaluatorTx } from '../services/escrow/evaluator-signer.js';
import { inMemoryEvaluatorLedger, type InMemoryLedger } from './helpers/in-memory-evaluator-ledger.js';
import type { LedgerCandidate } from '../services/job/escrow-evaluator-a1.js';
import { TransactionLookupUnavailableError } from '../services/transaction/tx-known.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';
import {
  ALERT_TEXT_MAX_CHARS,
  CHAIN_JOB_STATUS,
  SETTLEMENT_REASONS,
  EVALUATOR_STUCK_ALERT_AFTER_MS,
  __resetEscrowTokenCacheForTests,
  __resetEvaluatorBacklogForTests,
  alertExpiringReviews,
  checkEvaluatorBacklog,
  contestEscrowJob,
  deliverableHashOf,
  EscrowConfigUnverifiedError,
  SettlementStillPendingError,
  enqueueSubmit,
  expiryMarginMs,
  escrowIntentId,
  feedbackHashOf,
  feedbackUriFor,
  getEscrowToken,
  handleFailedSettlementJob,
  isErc8183EnabledWith,
  isEscrowTokenReward,
  isFeedbackFileCommitted,
  onEscrowTxOutcome,
  parseHookIdentityEvents,
  parseSettlementReceipt,
  processSettlementJob,
  pumpFunding,
  reconcileHeldReview,
  recoverErc8183Job,
  requestCancellationReject,
  resolveEscrowJob,
  serializeFeedbackFile,
  settlementDelay,
  startEscrow,
  sweepExpiredEscrows,
  toJobResponse,
  type Erc8183Config,
  type Erc8183Deps,
  type EscrowAlert,
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
    providerAgentId: null,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    reviewLog: null,
    reviewAlertedAt: null,
    ratedAgentId: null,
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

/** Prisma's JSON null sentinels are stored as SQL NULL. */
function stored(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull || v === Prisma.JsonNull ? null : v]));
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
        Object.assign(row, stored(data));
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: Args) => {
        let count = 0;
        for (const row of jobTable.values()) {
          if (matchesWhere(row, where)) {
            Object.assign(row, stored(data ?? {}));
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
    // A1: records through the broadcast hook (hash + signed transaction) before "sending", like the real signer.
    writeContract: vi.fn(async (params: EvaluatorWriteParams, writeOpts?: EvaluatorWriteOptions) => {
      await writeOpts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      return SETTLE_HASH;
    }),
    // C3h D2: the receipt of the transaction the signer sent (its own hash).
    waitForTransactionReceipt: vi.fn(async (hash: Hex) => ({ status: opts.settleStatus ?? 'success', logs: opts.settleLogs ?? [], transactionHash: hash })),
  };
  const releaseJobEscrow = vi.fn().mockResolvedValue(undefined);
  const finalize = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const getBalance = vi.fn(async () => 10n ** 18n);
  const alert = vi.fn();
  const nodes: { mined: number | null } = { mined: 1_000_000 };
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
    // A1: the candidate ledger (in memory: this suite's Prisma is a mock).
    evaluatorLedger: inMemoryEvaluatorLedger((args) => store.dbMock.job.updateMany(args as never)),
    // A1 review P3-4: no evaluator send without the evaluator lane (fail closed) — the in-memory lane lock.
    lanes: new InMemoryLaneLock(),
    // A1: one RPC node. `nodes.mined` = the key's `latest` (= proof) transaction count — by default every
    // nonce this suite signs is consumed; null = the node cannot be read. Receipts come from the read
    // client's `getTransactionReceipt` mock, "known" from `isKnownTransaction` (else: has a receipt).
    readNodeViews: async (_chainId, _evaluator, hashes) => {
      if (nodes.mined === null) return [{ node: '#0 test', index: 0, ok: false, error: 'node down' }];
      const known: Record<Hex, boolean> = {};
      const receipts: Record<Hex, { txHash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: Log[] } | null> = {};
      for (const hash of hashes) {
        let receipt: (typeof receipts)[Hex] = null;
        try {
          const r = (await (getTransactionReceipt as unknown as (a: unknown) => Promise<unknown>)({ hash })) as { status: 'success' | 'reverted'; logs?: Log[] };
          receipt = { txHash: hash, status: r.status, blockNumber: 1n, blockHash: keccak256(hash), logs: r.logs ?? [] };
        } catch (err) {
          if ((err as { name?: string }).name !== 'TransactionReceiptNotFoundError') return [{ node: '#0 test', index: 0, ok: false, error: 'receipt unreadable' }];
        }
        receipts[hash] = receipt;
        known[hash] = receipt !== null || (deps.isKnownTransaction ? await deps.isKnownTransaction(CHAIN_ID, hash).catch(() => false) : false);
      }
      return [{ node: '#0 test', index: 0, ok: true, nonceLatest: nodes.mined, noncePending: nodes.mined, nonceAtTag: nodes.mined, known, receipts }];
    },
  };
  return { ...store, deps, nodes, queue, settlement, readContract, getTransactionReceipt, getBalance, signer, releaseJobEscrow, finalize, logger, alert };
}

let signedNonce = 0;
/** A1: the signed transaction the evaluator signer hands to `onBeforeBroadcast` (second argument). */
function signedTx(hash: Hex, params: EvaluatorWriteParams): PreparedEvaluatorTx {
  return {
    hash,
    raw: `0xfa${hash.slice(2)}` as Hex,
    nonce: signedNonce++,
    gas: 500_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    to: params.address,
    data: encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args as never }),
    value: 0n,
    chainId: CHAIN_ID,
    from: EVALUATOR,
  };
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
  // A1: the C3f item 3 memory is the (per-deps) candidate ledger now — nothing process-wide to reset.
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

const SUBMITTED_JOB = (overrides: Partial<JobRow> = {}) =>
  escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', deliverableHash: '0x' + 'cd'.repeat(32), ...overrides });
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

/** C3h D2: the escrow events of a `reject` of on-chain job 7 (the outcome is read from them, never inferred). */
function rejectedLogs(reason: Hex): Log[] {
  return [
    makeLog(AGENT_JOB_ESCROW_ABI, 'JobRejected', { jobId: 7n, rejector: EVALUATOR, reason }, ESCROW),
    makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
  ];
}

/** C3h D2: the escrow events of a `claimRefund` of on-chain job 7. */
function expiredLogs(): Log[] {
  return [
    makeLog(AGENT_JOB_ESCROW_ABI, 'JobExpired', { jobId: 7n }, ESCROW),
    makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
  ];
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

  it('C3d (D9): a CONTESTED job is never settled automatically — no complete, no reject', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'CONTESTED', status: 'PAYMENT_PENDING', contestedAt: NOW })], {
      txs: [FUND_TX()],
    });
    const result = await processSettlementJob(deps, settleJob());
    expect(result).toMatchObject({ outcome: 'noop', reason: expect.stringContaining('held for operator review') });
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', status: 'PAYMENT_PENDING' });
  });

  it('C3d: a contest recorded without the hold (pre-C3d row; migration 0019 moves those to CONTESTED) is never claimed by the automatic settlement', async () => {
    for (const onChainStatus of ['SUBMITTED', 'SETTLING']) {
      const { deps, jobs, signer } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()] });
      Object.assign(jobs.get('job-1')!, { contestedAt: NOW, onChainStatus });
      const result = await processSettlementJob(deps, settleJob());
      expect(result).toMatchObject({ outcome: 'noop', reason: expect.stringContaining('cannot be settled') });
      expect(signer.writeContract).not.toHaveBeenCalled();
      expect(jobs.get('job-1')).toMatchObject({ onChainStatus, status: 'PAYMENT_PENDING' });
    }
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

  it('reverted complete → contest (allowed: the receipt is a revert) → hold → operator verdict rebuilds the file as "rejected"', async () => {
    const { deps, jobs, signer, getTransactionReceipt, settlement } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: rejectLogs() });
    // Attempt 1: complete is sent but reverts. settleTxHash is now set, the
    // feedback file says "completed", nothing was mined.
    signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [], transactionHash: SETTLE_HASH } as never);
    const first = settleJob(3);
    await expect(processSettlementJob(deps, first)).rejects.toThrow(/reverted on-chain/);
    await handleFailedSettlementJob(deps, first, new Error('reverted'));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SUBMITTED', settleTxHash: SETTLE_HASH });
    expect((jobs.get('job-1')!['feedbackFile'] as FeedbackFile).outcome).toBe('completed');
    expect((signer.writeContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('complete');

    // The requester contests: the last settlement's receipt is a revert, so nothing can still mine.
    // (A1: persistent, not once — the gates read the candidate's receipt on every check, per node.)
    getTransactionReceipt.mockResolvedValue({ status: 'reverted', logs: [] } as never);
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: 'not what I asked' })).toMatchObject({ outcome: 'held' });
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', contestReason: 'not what I asked' });

    // Recovery re-enqueues the settle: held, nothing sent.
    expect(await processSettlementJob(deps, settleJob(1))).toMatchObject({ outcome: 'noop' });
    expect(signer.writeContract).toHaveBeenCalledTimes(1);

    // The operator's verdict: reject with REASON_QUALITY_REJECTED and a REBUILT file.
    getTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] } as never);
    expect(await resolveEscrowJob(deps, { jobId: 'job-1', decision: 'quality-rejected', note: 'off-brief', operator: 'ops@test' })).toMatchObject({ outcome: 'scheduled' });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'resolve' });
    const result = await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'resolve' }, attemptsMade: 0, opts: { attempts: 3 } });

    expect(result).toMatchObject({ outcome: 'settled', action: 'resolve', onChainStatus: 'REJECTED' });
    const second = signer.writeContract.mock.calls[1]![0] as { functionName: string; args: readonly unknown[] };
    expect(second.functionName).toBe('reject');
    expect(second.args[1]).toBe(SETTLEMENT_REASONS.qualityRejected);
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

  it('claimRefund on a PAYMENT_PENDING job held for review (contested, C3d) → finalizer FAILED', async () => {
    const { deps, finalize } = makeDeps([SUBMITTED_JOB({ onChainStatus: 'CONTESTED', contestedAt: NOW })], {
      chainStatus: CHAIN_JOB_STATUS.Submitted,
      settleLogs: [makeLog(AGENT_JOB_ESCROW_ABI, 'JobExpired', { jobId: 7n }, ESCROW)],
    });
    await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', outcome: 'FAILED', reason: expect.stringContaining('Expired') }));
  });

  it('G1 review P2-1: claimRefund on an uncontested delivery accepted in time (Submitted, or its submit in flight) is dropped — nothing signed, nothing finalized', async () => {
    const submitted = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Submitted });
    expect(await processSettlementJob(submitted.deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({
      outcome: 'noop',
      reason: expect.stringContaining('held'),
    });
    expect(submitted.signer.writeContract).not.toHaveBeenCalled();
    expect(submitted.finalize).not.toHaveBeenCalled();

    // FUNDED with the submit QUEUED (e.g. deferred by the Q7 gate): held; once it failed for good: refunded.
    const queued = makeDeps([SUBMITTED_JOB({ onChainStatus: 'FUNDED' })], {
      chainStatus: CHAIN_JOB_STATUS.Funded,
      txs: [stepTx('submit', 'job-1', { status: 'QUEUED', txHash: null })],
    });
    expect(await processSettlementJob(queued.deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({ outcome: 'noop' });
    expect(queued.signer.writeContract).not.toHaveBeenCalled();
    const failed = makeDeps([SUBMITTED_JOB({ onChainStatus: 'FUNDED' })], {
      chainStatus: CHAIN_JOB_STATUS.Funded,
      txs: [stepTx('submit', 'job-1', { status: 'FAILED', txHash: null })],
      settleLogs: expiredLogs(),
    });
    expect(await processSettlementJob(failed.deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({ outcome: 'settled', action: 'claimRefund' });
  });
});

// ── C3e item 1: no second evaluator broadcast while the previous one may mine ──

describe('processSettlementJob — C3e item 1: a retry never signs over a pending settlement', () => {
  const PREV = '0xabab000000000000000000000000000000000000000000000000000000000001' as Hex;
  const notFound = (name: string) => Object.assign(new Error(name), { name });

  function withPrevious(getTransaction: () => Promise<unknown>) {
    const ctx = makeDeps([SUBMITTED_JOB({ settleTxHash: PREV, onChainStatus: 'SETTLING' })], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.getTransactionReceipt.mockImplementation((async ({ hash }: { hash: Hex }) => {
      if (hash === PREV) throw notFound('TransactionReceiptNotFoundError');
      return { status: 'success', logs: [] };
    }) as never);
    const base = ctx.deps.publicClient;
    ctx.deps.publicClient = (chainId: number) => ({ ...base(chainId), getTransaction: getTransaction as never });
    return ctx;
  }

  it('previous complete still pending (node knows it, no receipt) → SettlementStillPendingError, nothing signed, hash kept', async () => {
    const { deps, signer, jobs } = withPrevious(async () => ({ hash: PREV, blockNumber: null }));
    const err = await processSettlementJob(deps, settleJob(2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementStillPendingError);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')!['settleTxHash']).toBe(PREV);
  });

  it('previous complete dropped (unknown to the node) → a new one is signed and replaces the hash', async () => {
    const { deps, signer, jobs } = withPrevious(async () => {
      throw notFound('TransactionNotFoundError');
    });
    expect(await processSettlementJob(deps, settleJob(2))).toMatchObject({ outcome: 'settled', txHash: SETTLE_HASH });
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
    expect(jobs.get('job-1')!['settleTxHash']).toBe(SETTLE_HASH);
  });

  it('the node cannot be asked (RPC error) → refused too (retried later), nothing signed', async () => {
    const { deps, signer } = withPrevious(async () => {
      throw new Error('HTTP request failed');
    });
    await expect(processSettlementJob(deps, settleJob(2))).rejects.toBeInstanceOf(SettlementStillPendingError);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('G1 review P3-1 (strict lookup): the multi-node check is uncertain (no node knows it, one errored) → refused, nothing signed — even if the read client says "not found"', async () => {
    const { deps, signer, jobs } = withPrevious(async () => {
      throw notFound('TransactionNotFoundError');
    });
    deps.isKnownTransaction = vi.fn(async () => Promise.reject(new TransactionLookupUnavailableError(PREV, 3, 1)));
    const err = await processSettlementJob(deps, settleJob(2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementStillPendingError);
    expect((err as Error).message).toMatch(/cannot tell whether it is known/);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')!['settleTxHash']).toBe(PREV);
  });
});

describe('sendEvaluatorTx — G1 review P3-2: a send that throws after the signed hash was recorded', () => {
  const SIGNED = '0x5157000000000000000000000000000000000000000000000000000000000001' as Hex;

  /** A signer that records the signed hash through the hook, then fails at send. */
  function failingSend(known: () => Promise<boolean>) {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      await opts?.onBeforeBroadcast?.(SIGNED, signedTx(SIGNED, params));
      throw new Error('insufficient funds for gas * price + value');
    }) as never);
    ctx.deps.isKnownTransaction = vi.fn(known);
    // The signed nonce is NOT consumed (the send failed): the key's latest count stays below it.
    ctx.nodes.mined = 0;
    ctx.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('no receipt'), { name: 'TransactionReceiptNotFoundError' }));
    return ctx;
  }

  // C3g-A1 (§2.4-3, §6.3): changed meaning. P3-2 gave the hash slot back when every node said "not found";
  // A1 never closes on "not found": the candidate is SEND_UNCONFIRMED and LIVE until its nonce is consumed.
  it('no node knows it (every node answered) → SEND_UNCONFIRMED, still live: the hash stays, the stamp is cleared (the ledger is the gate); contest refused until the nonce is consumed, accepted after the proof', async () => {
    const { deps, jobs, nodes } = failingSend(async () => false);
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/insufficient funds/);
    expect(jobs.get('job-1')).toMatchObject({ settleTxHash: SIGNED, settleAttemptAt: null });
    const [row] = await deps.evaluatorLedger!.candidatesForJob('job-1');
    expect(row).toMatchObject({ status: 'SEND_UNCONFIRMED', txHash: SIGNED });
    jobs.get('job-1')!['onChainStatus'] = 'SUBMITTED'; // the failed handler's hand-back
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/may still mine/) });
    nodes.mined = row!.nonce! + 1; // another transaction of the key consumed that nonce (no receipt for ours)
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'held' });
  });

  it('a node knows it → SENT: hash kept, stamp cleared', async () => {
    const { deps, jobs } = failingSend(async () => true);
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/insufficient funds/);
    expect(jobs.get('job-1')).toMatchObject({ settleTxHash: SIGNED, settleAttemptAt: null });
    expect((await deps.evaluatorLedger!.candidatesForJob('job-1'))[0]).toMatchObject({ status: 'SENT' });
  });

  // A1: the stamp is cleared here too (it was kept under P3-2) — the live SIGNED candidate is the gate now.
  it('strict lookup uncertain (no node knows it, one errored) → candidate stays SIGNED with the error (may still mine): contest refused', async () => {
    const { deps, jobs } = failingSend(async () => Promise.reject(new TransactionLookupUnavailableError(SIGNED, 2, 1)));
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/insufficient funds/);
    expect(jobs.get('job-1')).toMatchObject({ settleTxHash: SIGNED, settleAttemptAt: null });
    expect((await deps.evaluatorLedger!.candidatesForJob('job-1'))[0]).toMatchObject({ status: 'SIGNED', sendError: expect.stringMatching(/insufficient funds/) });
    jobs.get('job-1')!['onChainStatus'] = 'SUBMITTED'; // the failed handler's hand-back
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/may still mine/) });
  });

  it('A1: a node that cannot be read → contest unverifiable (503 CONTEST_UNVERIFIABLE), resolve unverifiable', async () => {
    const { deps, jobs, nodes } = failingSend(async () => false);
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/insufficient funds/);
    jobs.get('job-1')!['onChainStatus'] = 'SUBMITTED';
    nodes.mined = null;
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'unverifiable' });
    expect(await resolveEscrowJob(deps, { jobId: 'job-1', decision: 'refund', note: 'n', operator: 'ops' })).toMatchObject({ outcome: 'unverifiable' });
  });

  it('A1: the retry of the same job signs nothing while its candidate may still mine (no second complete)', async () => {
    const { deps, signer } = failingSend(async () => false);
    await expect(processSettlementJob(deps, settleJob())).rejects.toThrow(/insufficient funds/);
    const err = await processSettlementJob(deps, settleJob(2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementStillPendingError);
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
  });

  it('A1: a candidate is recorded BEFORE the send, atomically with the job stamp; a lost conditional write records nothing and sends nothing', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    const order: string[] = [];
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      ctx.jobs.get('job-1')!['settleTxHash'] = '0x' + 'cd'.repeat(32); // another attempt recorded its own hash meanwhile
      await opts?.onBeforeBroadcast?.(SIGNED, signedTx(SIGNED, params));
      order.push('sent');
      return SIGNED;
    }) as never);
    const err = await processSettlementJob(ctx.deps, settleJob()).catch((e: unknown) => e);
    expect((err as Error).name).toBe('SettlementSupersededError');
    expect(order).toEqual([]);
    expect(await ctx.deps.evaluatorLedger!.candidatesForJob('job-1')).toEqual([]);
  });
});

// ── Q7: evaluator settlement deferred while the configuration is unverified ──

describe('processSettlementJob — Q7: no evaluator signature on an unverified chain', () => {
  const refuse = (chainId: number) => ({
    allowed: false as const,
    chainId,
    block: 'unverified' as const,
    reason: `the ERC-8183 configuration of chain ${chainId} is unverified: the chain could not be read`,
    retryAfterSeconds: 120,
  });
  const allow = (chainId: number) => ({ allowed: true as const, chainId, verifiedAt: NOW, validUntil: new Date(NOW.getTime() + 600_000) });

  it('settle: EscrowConfigUnverifiedError (retry in 120 s) BEFORE the claim — job stays SUBMITTED (contestable), nothing signed, nothing alerted', async () => {
    const { deps, jobs, signer, finalize, alert } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    deps.configGate = refuse;
    const err = await processSettlementJob(deps, settleJob()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EscrowConfigUnverifiedError);
    expect(err).toMatchObject({ chainId: CHAIN_ID, retryAfterMs: 120_000 });
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', settleTxHash: null, escrowError: null });
    expect(finalize).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();

    // Verified again: the same job settles normally.
    deps.configGate = allow;
    expect(await processSettlementJob(deps, settleJob())).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
  });

  it('#182 review: the gate closes AFTER the pre-checks, while the evaluator simulates / signs → refused in the broadcast hook: nothing stamped or sent, the claim handed back (SUBMITTED, contestable); settles once re-verified', async () => {
    const { deps, jobs, signer, finalize, alert } = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    let closed = false;
    deps.configGate = (chainId) => (closed ? refuse(chainId) : allow(chainId));
    const sent: Hex[] = [];
    // Like the real signer: simulation, gas estimate and signature, then the hook, then the send.
    signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      closed = true; // a failed re-check revokes the verification in this window (deterministic)
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      sent.push(SETTLE_HASH);
      return SETTLE_HASH;
    }) as never);

    const err = await processSettlementJob(deps, settleJob()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EscrowConfigUnverifiedError);
    expect(err).toMatchObject({ chainId: CHAIN_ID, retryAfterMs: 120_000 });
    expect(signer.writeContract).toHaveBeenCalledTimes(1); // the pre-checks passed
    expect(sent).toEqual([]);
    expect(jobs.get('job-1')).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', settleTxHash: null, escrowError: null });
    expect(jobs.get('job-1')!['settleAttemptAt'] ?? null).toBeNull(); // never stamped
    expect(finalize).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();

    // Verified again: the same job settles, through the same hook.
    closed = false;
    signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      sent.push(SETTLE_HASH);
      return SETTLE_HASH;
    }) as never);
    expect(await processSettlementJob(deps, settleJob())).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(sent).toEqual([SETTLE_HASH]);
  });

  it('an operator decision on a contested job: deferred, the job stays CONTESTED with its decision (still resolvable)', async () => {
    const { deps, jobs, signer } = makeDeps([CONTESTED_JOB({ resolution: 'refund' })], { settleLogs: rejectLogs() });
    deps.configGate = refuse;
    await expect(processSettlementJob(deps, { data: { jobId: 'job-1', action: 'resolve' }, attemptsMade: 0, opts: { attempts: 3 } })).rejects.toBeInstanceOf(
      EscrowConfigUnverifiedError,
    );
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', resolution: 'refund' });
  });

  it.each([
    ['reject (cancellation)', { status: 'CANCELLED' }, CHAIN_JOB_STATUS.Funded, { action: 'reject' as const, reason: 'cancelled' as const }],
    ['claimRefund (expiry)', { status: 'ACCEPTED' }, CHAIN_JOB_STATUS.Funded, { action: 'claimRefund' as const }],
  ])('%s: deferred before signing; the job and the reservation are untouched', async (_label, overrides, chainStatus, data) => {
    const { deps, jobs, signer, releaseJobEscrow } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', ...overrides })], { chainStatus });
    deps.configGate = refuse;
    await expect(processSettlementJob(deps, { data: { jobId: 'job-1', ...data } })).rejects.toBeInstanceOf(EscrowConfigUnverifiedError);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(releaseJobEscrow).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'FUNDED', settleTxHash: null });
  });

  it('a job already terminal on-chain is still mirrored (a read + DB write, no signature) while unverified', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Completed });
    deps.configGate = refuse;
    expect(await processSettlementJob(deps, settleJob())).toMatchObject({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'COMPLETED' });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'CONFIRMED' }));
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

  it('G1 review P2-1: a delivery accepted in time whose submit / settlement is still on its way is held (no claimRefund) and alerted once; the other expiry cases are unchanged', async () => {
    const past = new Date(NOW.getTime() - 1000);
    const delivered = { status: 'PAYMENT_PENDING', expiresAt: past, deliverableHash: `0x${'cd'.repeat(32)}` };
    const { deps, settlement, alert, jobs } = makeDeps(
      [
        escrowJob({ id: 'held-queued', onChainJobId: '1', onChainStatus: 'FUNDED', ...delivered }),
        escrowJob({ id: 'held-broadcast', onChainJobId: '2', onChainStatus: 'FUNDED', ...delivered }),
        escrowJob({ id: 'held-binding', onChainJobId: '3', onChainStatus: 'FUNDED', deferredSubmitAt: past, ...delivered }),
        escrowJob({ id: 'held-submitted', onChainJobId: '4', onChainStatus: 'SUBMITTED', ...delivered }),
        // An operator "pay" on a held delivery is not overtaken by a refund.
        escrowJob({ id: 'held-pay', onChainJobId: '9', onChainStatus: 'SUBMITTED', resolution: 'pay', ...delivered }),
        // C3h D1: a recorded "pay" is held whatever the contest or the job status (it used to be refunded here).
        escrowJob({ id: 'contested-pay', onChainJobId: '6', onChainStatus: 'CONTESTED', contestedAt: past, resolution: 'pay', ...delivered }),
        escrowJob({ id: 'cancelled-pay', onChainJobId: '10', onChainStatus: 'SUBMITTED', resolution: 'pay', ...delivered, status: 'CANCELLED' }),
        // Unchanged: the submit failed for good (no attempt in flight), an undecided contest, a refund decision, no delivery.
        escrowJob({ id: 'failed-submit', onChainJobId: '5', onChainStatus: 'FUNDED', ...delivered }),
        escrowJob({ id: 'contested', onChainJobId: '11', onChainStatus: 'CONTESTED', contestedAt: past, ...delivered }),
        escrowJob({ id: 'decided', onChainJobId: '7', onChainStatus: 'SUBMITTED', resolution: 'refund', ...delivered }),
        escrowJob({ id: 'undelivered', onChainJobId: '8', onChainStatus: 'FUNDED', status: 'ACCEPTED', expiresAt: past }),
      ],
      {
        txs: [
          stepTx('submit', 'held-queued', { id: 'tx-q', status: 'QUEUED', txHash: null }),
          stepTx('submit', 'held-broadcast', { id: 'tx-b', status: 'SUBMITTED' }),
          stepTx('submit', 'failed-submit', { id: 'tx-f', status: 'FAILED', txHash: null }),
        ],
      },
    );

    expect(await sweepExpiredEscrows(deps)).toBe(4);
    expect(settlement.add.mock.calls.map((call) => (call[0] as { jobId: string }).jobId).sort()).toEqual(
      ['contested', 'decided', 'failed-submit', 'undelivered'].sort(),
    );
    // C3h D1: the claim action re-checks the hold of a recorded "pay" (a claim queued before the fix, an older process).
    for (const id of ['contested-pay', 'cancelled-pay']) {
      expect(await processSettlementJob(deps, { data: { jobId: id, action: 'claimRefund' } })).toMatchObject({ outcome: 'noop', reason: expect.stringContaining('"pay"') });
    }
    const held = alert.mock.calls.map((call) => call[0] as EscrowAlert).filter((a) => a.kind === 'delivery-held');
    expect(held.map((a) => a.jobId).sort()).toEqual(['cancelled-pay', 'contested-pay', 'held-binding', 'held-broadcast', 'held-pay', 'held-queued', 'held-submitted']);
    for (const id of ['held-pay', 'contested-pay', 'cancelled-pay']) {
      const payHeld = held.find((a) => a.jobId === id)!;
      expect(payHeld.message).toMatch(/operator decision "pay" recorded and not executed.*does NOT sign claimRefund.*permissionless/s);
      expect(payHeld.details).toMatchObject({ resolution: 'pay', expiresAt: past.toISOString() });
    }
    expect(held.find((a) => a.jobId === 'held-queued')!.message).toMatch(/QUEUED.*claimRefund is permissionless/s);
    expect(jobs.get('held-queued')!['reviewAlertedAt']).toEqual(NOW);

    // A second tick: still held, not alerted again.
    settlement.add.mockClear();
    alert.mockClear();
    await sweepExpiredEscrows(deps);
    expect(settlement.add.mock.calls.map((call) => (call[0] as { jobId: string }).jobId)).not.toContain('held-queued');
    expect(alert).not.toHaveBeenCalled();
  });

  it('P2-1: an undelivered alert releases its once-per-job claim for the next tick', async () => {
    const past = new Date(NOW.getTime() - 1000);
    const { deps, alert, jobs } = makeDeps([escrowJob({ id: 'held', onChainJobId: '1', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', expiresAt: past })]);
    alert.mockRejectedValueOnce(new Error('webhook down'));
    await sweepExpiredEscrows(deps);
    expect(jobs.get('held')!['reviewAlertedAt']).toBeNull();
    await sweepExpiredEscrows(deps);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(jobs.get('held')!['reviewAlertedAt']).toEqual(NOW);
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

  it('a job that cannot be funded is unwound after the lane is released (no self-deadlock on a real lock)', async () => {
    const { deps, jobs, releaseJobEscrow } = makeDeps(
      [escrowJob({ id: 'job-a', onChainJobId: '1', onChainStatus: 'BUDGET_SET', status: 'PENDING', budgetToken: null })],
      { chainStatus: CHAIN_JOB_STATUS.Open },
    );
    const locked = { ...deps, lanes: new InMemoryLaneLock() };
    expect(await pumpFunding(locked, REQUESTER.id, CHAIN_ID)).toBeNull();
    expect(jobs.get('job-a')).toMatchObject({ status: 'FAILED', onChainStatus: 'FAILED' });
    expect(releaseJobEscrow).toHaveBeenCalledWith('job-a');
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
      settleLogs: rejectedLogs(SETTLEMENT_REASONS.cancelled),
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

// ── C3d: contest → operator review (decision D9) ───────────────────────────

const CONTESTED_JOB = (overrides: Partial<JobRow> = {}) =>
  escrowJob({
    onChainJobId: '7',
    onChainStatus: 'CONTESTED',
    status: 'PAYMENT_PENDING',
    contestedAt: NOW,
    contestReason: 'wrong',
    deliverableHash: '0x' + 'cd'.repeat(32),
    ...overrides,
  });

const resolveJob = (attemptsMade = 0) => ({ data: { jobId: 'job-1', action: 'resolve' as const }, attemptsMade, opts: { attempts: 3 } });

function hookLog(eventName: string, args: Record<string, unknown>): Log {
  return makeLog(REPUTATION_HOOK_ABI, eventName, args, HOOK);
}

describe('C3d — contestEscrowJob (race rule)', () => {
  it('holds a PAYMENT_PENDING + SUBMITTED job: CONTESTED, contestedAt/reason recorded, operator alerted with the resolve path and expiresAt', async () => {
    const { deps, jobs, alert, signer } = makeDeps([SUBMITTED_JOB()]);
    const outcome = await contestEscrowJob(deps, { jobId: 'job-1', reason: 'off-brief' });
    expect(outcome).toEqual({ outcome: 'held', contestedAt: NOW });
    expect(jobs.get('job-1')).toMatchObject({ status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED', contestedAt: NOW, contestReason: 'off-brief' });
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'contested', jobId: 'job-1', message: expect.stringContaining('POST /admin/jobs/job-1/resolve') }),
    );
    expect((alert.mock.calls[0]![0] as { message: string }).message).toMatch(/claimRefund/);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it('is refused once settlement is claimed (SETTLING) or already contested', async () => {
    for (const row of [SUBMITTED_JOB(), CONTESTED_JOB()]) {
      if (row['onChainStatus'] === 'SUBMITTED') row['onChainStatus'] = 'SETTLING';
      const { deps, alert } = makeDeps([row]);
      expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused' });
      expect(alert).not.toHaveBeenCalled();
    }
  });

  it('is refused while an evaluator settlement can still mine (receipt missing) or has mined', async () => {
    const pending = makeDeps([SUBMITTED_JOB({ settleTxHash: SETTLE_HASH })]);
    pending.getTransactionReceipt.mockRejectedValueOnce(new Error('TransactionReceiptNotFoundError'));
    expect(await contestEscrowJob(pending.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('pending') });
    expect(pending.jobs.get('job-1')!['onChainStatus']).toBe('SUBMITTED');

    const mined = makeDeps([SUBMITTED_JOB({ settleTxHash: SETTLE_HASH })]);
    mined.getTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [] } as never);
    expect(await contestEscrowJob(mined.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('mined') });
  });

  it('is refused when the chain no longer says Submitted (the P3 race: a complete mined behind the DB) and unverifiable when unreadable', async () => {
    const completed = makeDeps([SUBMITTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Completed });
    expect(await contestEscrowJob(completed.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused' });
    expect(completed.jobs.get('job-1')!['contestedAt']).toBeNull();

    const down = makeDeps([SUBMITTED_JOB()]);
    down.readContract.mockRejectedValueOnce(new Error('rpc down'));
    expect(await contestEscrowJob(down.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'unverifiable' });
    expect(down.jobs.get('job-1')!['onChainStatus']).toBe('SUBMITTED');
  });

  it('the claim is conditional on the row it checked (incl. settleTxHash and, C3e, no settle-attempt stamp): a settlement claimed in between wins', async () => {
    const { deps, jobs, dbMock } = makeDeps([SUBMITTED_JOB()]);
    // The settlement claims SUBMITTED → SETTLING right after the contest read the row.
    dbMock.job.updateMany.mockImplementationOnce(async () => {
      jobs.get('job-1')!['onChainStatus'] = 'SETTLING';
      return { count: 0 };
    });
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused' });
    expect(dbMock.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', contestedAt: null, settleTxHash: null, settleAttemptAt: null },
      data: { onChainStatus: 'CONTESTED', contestedAt: NOW, contestReason: null, escrowError: null },
    });
  });

  it('C3e item 2: a settle-attempt stamp (a send in progress, or crashed mid-send) refuses the contest — it may still mine', async () => {
    const { deps, dbMock } = makeDeps([SUBMITTED_JOB({ settleAttemptAt: new Date(NOW.getTime() - 60_000) })]);
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason: null })).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/settlement was being sent at .* it may still mine/),
    });
    expect(dbMock.job.updateMany).not.toHaveBeenCalled();
  });

  it('G1 review P2-1: the contest window closes at expiresAt − margin (where the settlement is due): refused after it, nothing written', async () => {
    const margin = expiryMarginMs(config);
    const late = makeDeps([SUBMITTED_JOB({ expiresAt: new Date(NOW.getTime() + margin - 1) })]);
    expect(await contestEscrowJob(late.deps, { jobId: 'job-1', reason: null })).toMatchObject({
      outcome: 'refused',
      reason: expect.stringContaining('contest window has closed'),
    });
    expect(late.dbMock.job.updateMany).not.toHaveBeenCalled();
    expect(late.readContract).not.toHaveBeenCalled();
    const expired = makeDeps([SUBMITTED_JOB({ expiresAt: new Date(NOW.getTime() - 1) })]);
    expect(await contestEscrowJob(expired.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'refused' });
    // Just before the margin: still contestable.
    const inTime = makeDeps([SUBMITTED_JOB({ expiresAt: new Date(NOW.getTime() + margin + 1_000) })]);
    expect(await contestEscrowJob(inTime.deps, { jobId: 'job-1', reason: null })).toMatchObject({ outcome: 'held' });
  });
});

describe('C3d — resolveEscrowJob + the resolve settlement', () => {
  it('records the decision (who, when, note), appends the review log, claims SETTLING and enqueues `resolve`', async () => {
    const { deps, jobs, settlement } = makeDeps([CONTESTED_JOB()]);
    const outcome = await resolveEscrowJob(deps, { jobId: 'job-1', decision: 'pay', note: 'deliverable matches the brief', operator: 'alice' });
    expect(outcome).toEqual({ outcome: 'scheduled', resolution: 'pay', previousStatus: 'PAYMENT_PENDING', previousOnChainStatus: 'CONTESTED', queued: true });
    expect(jobs.get('job-1')).toMatchObject({
      onChainStatus: 'SETTLING',
      resolution: 'pay',
      resolvedBy: 'alice',
      resolvedAt: NOW,
      resolutionNote: 'deliverable matches the brief',
      reviewLog: [{ at: NOW.toISOString(), by: 'alice', decision: 'pay', note: 'deliverable matches the brief', status: 'PAYMENT_PENDING', onChainStatus: 'CONTESTED' }],
    });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'resolve' });
  });

  it('pay → complete(agentfi.completed, feedback "completed") → COMPLETED, finalizer CONFIRMED, rated agent id stored', async () => {
    const { deps, jobs, signer, finalize } = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'pay' })], {
      txs: [FUND_TX()],
      settleLogs: completeLogs('written'),
    });
    const result = await processSettlementJob(deps, resolveJob());
    expect(result).toMatchObject({ outcome: 'settled', action: 'resolve', onChainStatus: 'COMPLETED', feedbackStatus: 'written' });
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('complete');
    expect(call.args[1]).toBe(SETTLEMENT_REASONS.completed);
    const [uri, hash] = decodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], call.args[2] as Hex);
    expect(uri).toBe(feedbackUriFor(config, 'job-1'));
    const file = jobs.get('job-1')!['feedbackFile'] as FeedbackFile;
    expect(file.outcome).toBe('completed');
    expect(hash).toBe(feedbackHashOf(file));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'COMPLETED', ratedAgentId: '3', feedbackStatus: 'written' });
    expect(finalize).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'CONFIRMED', transactionId: null });
  });

  it('refund + quality-rejected verdict → reject(REASON_QUALITY_REJECTED, feedback "rejected"); the hook writes 0', async () => {
    const logs = [
      makeLog(AGENT_JOB_ESCROW_ABI, 'JobRejected', { jobId: 7n, rejector: EVALUATOR, reason: SETTLEMENT_REASONS.qualityRejected }, ESCROW),
      makeLog(AGENT_JOB_ESCROW_ABI, 'Refunded', { jobId: 7n, client: REQUESTER.safeAddress, amount: BUDGET }, ESCROW),
      hookLog('FeedbackWritten', { jobId: 7n, agentId: 3n, value: 0n }),
    ];
    const { deps, jobs, signer, finalize } = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'quality-rejected' })], { txs: [FUND_TX()], settleLogs: logs });
    expect(await processSettlementJob(deps, resolveJob())).toMatchObject({ outcome: 'settled', onChainStatus: 'REJECTED', feedbackStatus: 'written' });
    const call = signer.writeContract.mock.calls[0]![0];
    expect(call.functionName).toBe('reject');
    expect(call.args[1]).toBe(SETTLEMENT_REASONS.qualityRejected);
    expect(SETTLEMENT_REASONS.qualityRejected).toBe(keccak256(toBytes('agentfi.quality-rejected')));
    const [, hash] = decodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], call.args[2] as Hex);
    expect(hash).toBe(feedbackHashOf(jobs.get('job-1')!['feedbackFile'] as FeedbackFile));
    expect((jobs.get('job-1')!['feedbackFile'] as FeedbackFile).outcome).toBe('rejected');
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED', reason: expect.stringContaining('quality-rejected') }));
  });

  it('refund without verdict → reject(agentfi.contested, "0x"): nothing rated, an earlier unmined file is dropped', async () => {
    const { deps, jobs, signer } = makeDeps(
      [CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'refund', feedbackFile: { outcome: 'completed', stale: true } })],
      { settleLogs: [...rejectedLogs(SETTLEMENT_REASONS.contested), hookLog('FeedbackSkipped', { jobId: 7n, reason: stringToHex('no-params', { size: 32 }) })] },
    );
    expect(await processSettlementJob(deps, resolveJob())).toMatchObject({ outcome: 'settled', onChainStatus: 'REJECTED', feedbackStatus: 'skipped:no-params' });
    expect(signer.writeContract.mock.calls[0]![0].args).toEqual([7n, SETTLEMENT_REASONS.contested, '0x']);
    expect(jobs.get('job-1')!['feedbackFile']).toBeNull();
  });

  it('payout-blocked → reject(REASON_PAYOUT_BLOCKED, "0x") for a PAYMENT_PENDING job whose complete keeps reverting', async () => {
    const { deps, jobs, signer, getTransactionReceipt, settlement, finalize } = makeDeps([SUBMITTED_JOB({ settleTxHash: SETTLE_HASH, escrowError: 'settle failed after 3 attempts' })], {
      settleLogs: rejectedLogs(SETTLEMENT_REASONS.payoutBlocked),
    });
    getTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] } as never); // the last complete reverted
    expect(await resolveEscrowJob(deps, { jobId: 'job-1', decision: 'payout-blocked', note: 'provider blacklisted by USDC', operator: 'ops' })).toMatchObject({ outcome: 'scheduled' });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'resolve' });
    await processSettlementJob(deps, resolveJob());
    expect(signer.writeContract.mock.calls[0]![0].args).toEqual([7n, SETTLEMENT_REASONS.payoutBlocked, '0x']);
    expect(SETTLEMENT_REASONS.payoutBlocked).toBe(keccak256(toBytes('agentfi.payout-blocked')));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'REJECTED', resolution: 'payout-blocked' });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED' }));
  });

  it('resolves a CANCELLED job Submitted on-chain (C3c conflict): pay → COMPLETED; refund → reject(cancelled), reservation released', async () => {
    const paid = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'CANCELLED' })], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    expect(await resolveEscrowJob(paid.deps, { jobId: 'job-1', decision: 'pay', note: 'delivered before the cancel', operator: 'ops' })).toMatchObject({
      outcome: 'scheduled',
      previousStatus: 'CANCELLED',
    });
    await processSettlementJob(paid.deps, resolveJob());
    expect(paid.signer.writeContract.mock.calls[0]![0].functionName).toBe('complete');
    expect(paid.jobs.get('job-1')).toMatchObject({ status: 'COMPLETED', onChainStatus: 'COMPLETED' });
    expect(paid.finalize).not.toHaveBeenCalled();

    const refunded = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'CANCELLED' })], { settleLogs: rejectedLogs(SETTLEMENT_REASONS.cancelled) });
    await resolveEscrowJob(refunded.deps, { jobId: 'job-1', decision: 'refund', note: 'requester right', operator: 'ops' });
    await processSettlementJob(refunded.deps, resolveJob());
    expect(refunded.signer.writeContract.mock.calls[0]![0].args).toEqual([7n, SETTLEMENT_REASONS.cancelled, '0x']);
    expect(refunded.jobs.get('job-1')).toMatchObject({ status: 'CANCELLED', onChainStatus: 'REJECTED' });
    expect(refunded.releaseJobEscrow).toHaveBeenCalledWith('job-1');
  });

  it('refuses what it must not decide: SETTLING (in progress), not held, legacy, chain not Submitted, a settlement still in flight; 503 when unreadable', async () => {
    const settling = makeDeps([SUBMITTED_JOB({ onChainStatus: 'SETTLING' })]);
    expect(await resolveEscrowJob(settling.deps, { jobId: 'job-1', decision: 'pay', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'SETTLEMENT_IN_PROGRESS' });

    const funded = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'ACCEPTED' })]);
    expect(await resolveEscrowJob(funded.deps, { jobId: 'job-1', decision: 'refund', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'NOT_RESOLVABLE' });

    const legacy = makeDeps([escrowJob({ escrowKind: null, onChainStatus: null })]);
    expect(await resolveEscrowJob(legacy.deps, { jobId: 'job-1', decision: 'refund', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'NOT_ESCROW_JOB' });

    const missing = makeDeps([]);
    expect(await resolveEscrowJob(missing.deps, { jobId: 'job-1', decision: 'refund', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'NOT_FOUND' });

    const expired = makeDeps([CONTESTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Expired });
    expect(await resolveEscrowJob(expired.deps, { jobId: 'job-1', decision: 'pay', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'CHAIN_NOT_SUBMITTED' });

    const inFlight = makeDeps([CONTESTED_JOB({ settleTxHash: SETTLE_HASH })]);
    inFlight.getTransactionReceipt.mockRejectedValueOnce(new Error('not found'));
    expect(await resolveEscrowJob(inFlight.deps, { jobId: 'job-1', decision: 'pay', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'refused', code: 'SETTLEMENT_IN_PROGRESS' });

    const down = makeDeps([CONTESTED_JOB()]);
    down.readContract.mockRejectedValueOnce(new Error('rpc down'));
    expect(await resolveEscrowJob(down.deps, { jobId: 'job-1', decision: 'pay', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'unverifiable' });
    expect(down.jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', resolution: null });
  });

  it('a decision recorded while the queue is down stays recorded (queued: false) and the recovery retries it', async () => {
    const { deps, jobs, settlement } = makeDeps([CONTESTED_JOB()]);
    settlement.add.mockRejectedValueOnce(new Error('redis down'));
    expect(await resolveEscrowJob(deps, { jobId: 'job-1', decision: 'refund', note: 'x y z', operator: 'o' })).toMatchObject({ outcome: 'scheduled', queued: false });
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING', resolution: 'refund' });
    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'SETTLING' })).toBe('resettled');
    expect(settlement.add).toHaveBeenLastCalledWith({ jobId: 'job-1', action: 'settle' });
  });

  it('a decision whose settlement fails for good goes back to the hold (CONTESTED), is alerted (once an hour) and retried by recovery', async () => {
    const { deps, jobs, alert, settlement } = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'pay' })], { settleStatus: 'reverted', txs: [FUND_TX()] });
    const last = resolveJob(3);
    await expect(processSettlementJob(deps, last)).rejects.toThrow(/reverted on-chain/);
    await handleFailedSettlementJob(deps, last, new Error('ERC-8183 resolve reverted on-chain'));
    await handleFailedSettlementJob(deps, last, new Error('ERC-8183 resolve reverted on-chain'));
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', resolution: 'pay', escrowError: expect.stringMatching(/resolve failed after 3 attempts/) });
    const failures = alert.mock.calls.filter(([a]) => (a as { kind: string }).kind === 'settlement-failed');
    expect(failures).toHaveLength(1);
    expect((failures[0]![0] as { message: string }).message).toMatch(/payout-blocked/);

    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'CONTESTED' })).toBe('resettled');
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'resolve' });
  });

  it('recovery leaves an undecided contested job on hold', async () => {
    const { deps, settlement } = makeDeps([CONTESTED_JOB()]);
    expect(await recoverErc8183Job(deps, { id: 'job-1', onChainStatus: 'CONTESTED' })).toBe('heldForReview');
    expect(settlement.add).not.toHaveBeenCalled();
  });

  it('a stale cancellation reject never overwrites a recorded decision (no refusal alert, nothing sent)', async () => {
    const { deps, jobs, alert, signer } = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SETTLING', status: 'CANCELLED', resolution: 'pay' })]);
    expect(await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'reject', reason: 'cancelled' } })).toMatchObject({ outcome: 'noop' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('SETTLING');
    expect(alert).not.toHaveBeenCalled();
    expect(signer.writeContract).not.toHaveBeenCalled();
  });
});

describe('C3d — expiry and contradictions', () => {
  it('claimRefund of an undecided contested job alerts "review-expired" and drops the uncommitted feedback file', async () => {
    const { deps, jobs, alert } = makeDeps([CONTESTED_JOB({ feedbackFile: { outcome: 'completed' } })], {
      settleLogs: [makeLog(AGENT_JOB_ESCROW_ABI, 'JobExpired', { jobId: 7n }, ESCROW)],
    });
    expect(await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'EXPIRED', feedbackFile: null });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-expired', jobId: 'job-1' }));
  });

  it('a contested job found Completed on-chain follows the chain and alerts "review-overridden" — never silently', async () => {
    const { deps, jobs, alert, finalize } = makeDeps([CONTESTED_JOB()], { chainStatus: CHAIN_JOB_STATUS.Completed });
    expect(await processSettlementJob(deps, settleJob())).toEqual({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });
    expect(jobs.get('job-1')!['onChainStatus']).toBe('COMPLETED');
    expect(finalize).toHaveBeenCalledWith({ jobId: 'job-1', outcome: 'CONFIRMED', transactionId: null });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-overridden', jobId: 'job-1' }));
  });

  it('a recorded "pay" found Completed is consistent (no alert); a recorded "refund" found Completed is alerted', async () => {
    const consistent = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'pay' })], { chainStatus: CHAIN_JOB_STATUS.Completed });
    await processSettlementJob(consistent.deps, resolveJob());
    expect(consistent.alert).not.toHaveBeenCalled();

    const contradicted = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'refund' })], { chainStatus: CHAIN_JOB_STATUS.Completed });
    await processSettlementJob(contradicted.deps, resolveJob());
    expect(contradicted.alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-overridden' }));
  });

  it('alertExpiringReviews alerts once per held job within the lead time (contested or CANCELLED/FAILED + SUBMITTED)', async () => {
    const soon = new Date(NOW.getTime() + 3_600_000);
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    const { deps, jobs, alert } = makeDeps([
      CONTESTED_JOB({ id: 'contested-soon', expiresAt: soon }),
      escrowJob({ id: 'conflict-soon', onChainJobId: '8', onChainStatus: 'SUBMITTED', status: 'CANCELLED', expiresAt: soon }),
      CONTESTED_JOB({ id: 'contested-later', expiresAt: later }),
      SUBMITTED_JOB({ id: 'normal-soon', expiresAt: soon }),
    ]);
    expect(await alertExpiringReviews(deps)).toBe(2);
    expect(await alertExpiringReviews(deps)).toBe(0);
    const ids = alert.mock.calls.map(([a]) => (a as { jobId: string; kind: string }).jobId).sort();
    expect(ids).toEqual(['conflict-soon', 'contested-soon']);
    expect(alert.mock.calls.every(([a]) => (a as { kind: string }).kind === 'review-expiring')).toBe(true);
    expect((alert.mock.calls[0]![0] as { message: string }).message).toMatch(/full refund to the requester without feedback/);
    expect(jobs.get('contested-soon')!['reviewAlertedAt']).toEqual(NOW);
    expect(await alertExpiringReviews({ ...deps, config: { ...config, reviewAlertBeforeExpirySeconds: 0 } })).toBe(0);
  });

  it('review P3-6: an expiring-review alert the channel fails to deliver releases its claim and is retried next tick', async () => {
    const soon = new Date(NOW.getTime() + 3_600_000);
    const { deps, jobs, alert } = makeDeps([CONTESTED_JOB({ expiresAt: soon })]);
    alert.mockRejectedValueOnce(new Error('webhook down'));
    expect(await alertExpiringReviews(deps)).toBe(0);
    expect(jobs.get('job-1')!['reviewAlertedAt']).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'review-expiring' }), 'Escrow alert could not be delivered');
    expect(await alertExpiringReviews(deps)).toBe(1);
    expect(jobs.get('job-1')!['reviewAlertedAt']).toEqual(NOW);
    expect(await alertExpiringReviews(deps)).toBe(0);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('review P3-2: a job that expires with a recorded decision (its settlement kept failing) is alerted "review-overridden", not "review-expired"', async () => {
    const { deps, jobs, alert } = makeDeps([CONTESTED_JOB({ resolution: 'quality-rejected', escrowError: 'resolve failed after 3 attempts' })], { settleLogs: expiredLogs() });
    expect(await processSettlementJob(deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(jobs.get('job-1')).toMatchObject({ onChainStatus: 'EXPIRED', resolution: 'quality-rejected' });
    expect(alert.mock.calls.map(([a]) => (a as { kind: string }).kind)).toEqual(['review-overridden']);
    const message = (alert.mock.calls[0]![0] as { message: string }).message;
    expect(message).toMatch(/expired on-chain before the operator decision "quality-rejected" was executed/);
    expect(message.includes('NOT paid')).toBe(false);

    // C3h D1: a recorded "pay" is never refunded by the backend — the claim is dropped, nothing is signed.
    const pay = makeDeps([CONTESTED_JOB({ resolution: 'pay', escrowError: 'resolve failed after 3 attempts' })], { settleLogs: expiredLogs() });
    expect(await processSettlementJob(pay.deps, { data: { jobId: 'job-1', action: 'claimRefund' } })).toMatchObject({ outcome: 'noop' });
    expect(pay.signer.writeContract).not.toHaveBeenCalled();
    expect(pay.jobs.get('job-1')).toMatchObject({ onChainStatus: 'CONTESTED', resolution: 'pay' });

    // A third party's claimRefund (chain already Expired) is found by a reconciliation: mirrored and alerted.
    const found = makeDeps([CONTESTED_JOB({ resolution: 'pay' })], { chainStatus: CHAIN_JOB_STATUS.Expired });
    expect(await reconcileHeldReview(found.deps, 'job-1')).toBe('skipped'); // decided → not the read-only pass's job
    await processSettlementJob(found.deps, resolveJob());
    expect(found.alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-overridden', message: expect.stringContaining('NOT paid') }));
    expect(found.alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provider-unpaid', jobId: 'job-1' }));
    expect(found.alert).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-expired' }));
  });

  it('review P3-1: reconcileHeldReview is read-only — still Submitted → held (nothing written or queued); settled by another hand → mirrored + "review-overridden"', async () => {
    const held = makeDeps([CONTESTED_JOB()]);
    expect(await reconcileHeldReview(held.deps, 'job-1')).toBe('heldForReview');
    expect(held.dbMock.job.update).not.toHaveBeenCalled();
    expect(held.dbMock.job.updateMany).not.toHaveBeenCalled();
    expect(held.settlement.add).not.toHaveBeenCalled();
    expect(held.signer.writeContract).not.toHaveBeenCalled();

    for (const [row, chainStatus, onChainStatus] of [
      [CONTESTED_JOB(), CHAIN_JOB_STATUS.Rejected, 'REJECTED'],
      [escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'CANCELLED' }), CHAIN_JOB_STATUS.Completed, 'COMPLETED'],
    ] as const) {
      const moved = makeDeps([row], { chainStatus });
      expect(await reconcileHeldReview(moved.deps, 'job-1')).toBe('reconciled');
      expect(moved.jobs.get('job-1')!['onChainStatus']).toBe(onChainStatus);
      expect(moved.alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review-overridden', jobId: 'job-1' }));
      expect(moved.settlement.add).not.toHaveBeenCalled();
      expect(moved.signer.writeContract).not.toHaveBeenCalled();
    }

    const down = makeDeps([CONTESTED_JOB()]);
    down.readContract.mockRejectedValueOnce(new Error('rpc down'));
    expect(await reconcileHeldReview(down.deps, 'job-1')).toBe('chainUnreadable');
    expect(await reconcileHeldReview(makeDeps([SUBMITTED_JOB()]).deps, 'job-1')).toBe('skipped'); // not held
  });
});

describe('C3d review P2-2 — alerts are sanitized', () => {
  const KEY = 'AbCdEf0123456789ghIJklMNop';
  const KEYED_URL = `https://base-sepolia.g.alchemy.com/v2/${KEY}`;

  it('the settlement-failed alert carries the sanitized error (no keyed RPC URL), sanitized BEFORE it is clipped', async () => {
    const { deps, alert, logger } = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'pay' })]);
    // A long prefix pushes the URL across the old 200-char cut: clipping first would leave a key fragment.
    const err = new Error(`${'x'.repeat(170)} request to ${KEYED_URL} failed: 503`);
    await handleFailedSettlementJob(deps, resolveJob(3), err);
    const delivered = alert.mock.calls.map(([a]) => a as { kind: string; message: string; details?: Record<string, unknown> });
    expect(delivered.map((a) => a.kind)).toEqual(['settlement-failed']);
    const serialized = JSON.stringify(delivered);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(KEY.slice(0, 8));
    // The log line of the alert is sanitized the same way.
    const alertLog = logger.error.mock.calls.find(([, m]) => String(m).startsWith('ESCROW ALERT'));
    expect(JSON.stringify(alertLog)).not.toContain(KEY);
  });

  it('a viem HttpRequestError (URL with the key in its message) never reaches the alert', async () => {
    const { deps, alert } = makeDeps([CONTESTED_JOB({ onChainStatus: 'SETTLING', resolution: 'pay' })]);
    await handleFailedSettlementJob(deps, resolveJob(3), new HttpRequestError({ url: KEYED_URL, status: 503 }));
    const message = (alert.mock.calls[0]![0] as { message: string }).message;
    expect(message).toMatch(/HTTP request failed/);
    expect(message).not.toContain(KEY);
  });

  it('the requester\'s contest reason is sanitized and clipped in the "contested" alert (the row keeps the reason as given)', async () => {
    const { deps, jobs, alert } = makeDeps([SUBMITTED_JOB()]);
    const reason = `the deliverable called ${KEYED_URL} and api_key=supersecretvalue123 ${'y'.repeat(600)}`;
    expect(await contestEscrowJob(deps, { jobId: 'job-1', reason })).toMatchObject({ outcome: 'held' });
    const details = (alert.mock.calls[0]![0] as { details: { reason: string } }).details;
    expect(details.reason).not.toContain(KEY);
    expect(details.reason).not.toContain('supersecretvalue123');
    expect(details.reason.length).toBeLessThanOrEqual(ALERT_TEXT_MAX_CHARS + 1);
    expect(details.reason).toMatch(/^the deliverable called https:\/\/base-sepolia\.g\.alchemy\.com\/\[redacted\]/);
    expect(jobs.get('job-1')!['contestReason']).toBe(reason);
  });
});

describe('P3-6 — a replacement of the worker\'s evaluator transaction: the recovery script\'s own operation vs an unknown one', () => {
  const RECOVERY = '0xbeef000000000000000000000000000000000000000000000000000000000001' as Hex;
  const UNKNOWN = '0xdead000000000000000000000000000000000000000000000000000000000002' as Hex;
  type Ctx = ReturnType<typeof makeDeps>;
  const ledgerOf = (ctx: Ctx) => ctx.deps.evaluatorLedger as InMemoryLedger;

  /** While the worker waits for its own `complete`, a candidate `replacement(own)` is in the ledger and mines in its place. */
  function replacedBy(
    ctx: Ctx,
    minedHash: Hex,
    replacement: ((own: LedgerCandidate) => Partial<LedgerCandidate>) | null,
    /** Review P3-3: what happens to the job's OWN candidate row before the lookup (removed, or changed in place). */
    ownChange?: 'remove' | ((own: LedgerCandidate) => void),
  ) {
    ctx.signer.waitForTransactionReceipt.mockImplementationOnce(async (hash: Hex) => {
      const own = ledgerOf(ctx).rows.find((r) => r.txHash.toLowerCase() === hash.toLowerCase())!;
      expect(own).toBeDefined();
      const snapshot = { ...own };
      if (ownChange === 'remove') ledgerOf(ctx).rows.splice(ledgerOf(ctx).rows.indexOf(own), 1);
      else ownChange?.(own);
      if (replacement) {
        ledgerOf(ctx).rows.push({
          ...snapshot,
          id: 'etx_replacement',
          txHash: minedHash.toLowerCase(),
          kind: 'SPEED_UP',
          origin: 'SCRIPT',
          incidentId: 'inc_p3_6',
          operator: 'ops@test',
          note: 'stuck head',
          replacesId: own.id,
          status: 'SENT',
          ...replacement(own),
        });
      }
      return { status: 'success', logs: [], transactionHash: minedHash, replacedReason: 'repriced' } as never;
    });
  }
  const alertsOf = (ctx: Ctx) => ctx.alert.mock.calls.map((c) => c[0] as EscrowAlert);

  it('the recovery script\'s speed-up recorded in the ledger (SCRIPT row, its incident) → an informational notice naming the incident and the operator; no incident alert; nothing recorded from the receipt', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    replacedBy(ctx, RECOVERY, () => ({}));
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    expect(ctx.jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING', platformFeeAmount: null });
    expect(ctx.finalize).not.toHaveBeenCalled();
    const alerts = alertsOf(ctx);
    expect(alerts.filter((a) => a.kind === 'evaluator-replaced')).toEqual([]);
    const notices = alerts.filter((a) => (a.kind as string) === 'evaluator-replaced-by-recovery');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      jobId: 'job-1',
      severity: 'info',
      details: expect.objectContaining({ txHash: SETTLE_HASH, replacedBy: RECOVERY, recovery: expect.objectContaining({ incidentId: 'inc_p3_6', operator: 'ops@test', kind: 'SPEED_UP' }) }),
    });
    expect(notices[0]!.message).toMatch(/recovery script/);
    expect(notices[0]!.message).toContain('inc_p3_6');
    expect(notices[0]!.message).not.toMatch(/manual send|second settlement worker|Do not replace/);
  });

  it('an unknown replacement (no ledger row for the mined hash) stays the evaluator-replaced INCIDENT alert, with its text', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    replacedBy(ctx, UNKNOWN, null);
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    const alerts = alertsOf(ctx);
    expect(alerts.filter((a) => (a.kind as string) === 'evaluator-replaced-by-recovery')).toEqual([]);
    const replaced = alerts.filter((a) => a.kind === 'evaluator-replaced');
    expect(replaced).toHaveLength(1);
    expect((replaced[0] as { severity?: string }).severity ?? 'incident').toBe('incident');
    expect(replaced[0]!.message).toMatch(/a manual send with the evaluator key or a second settlement worker/);
    expect(replaced[0]!.details).toMatchObject({ txHash: SETTLE_HASH, replacedBy: UNKNOWN });
  });

  it.each([
    ['a WORKER row (not a recovery operation)', () => ({ origin: 'WORKER' as const, incidentId: null })],
    ['a SCRIPT row without an incident', () => ({ incidentId: null })],
    ['a SCRIPT row at ANOTHER nonce', (own: LedgerCandidate) => ({ nonce: (own.nonce ?? 0) + 1 })],
    ['a SCRIPT row of ANOTHER evaluator key', () => ({ evaluator: '0x1111111111111111111111111111111111111111' })],
    // Review P3-3: each check of `recoveryReplacementOf` on its own (every other field a valid recovery row).
    ['a WORKER row that carries an incident (origin alone decides)', () => ({ origin: 'WORKER' as const })],
    ['a RECONCILE row with an incident', () => ({ origin: 'RECONCILE' as const })],
    ['a SCRIPT row of kind ORIGINAL (not a replacement kind)', () => ({ kind: 'ORIGINAL' as const })],
    ['a SCRIPT row of kind EXTERNAL', () => ({ kind: 'EXTERNAL' as const })],
    ['a SCRIPT row of ANOTHER chain', () => ({ chainId: 8453 })],
  ])('a ledger row for the mined hash that is not this nonce\'s recovery operation — %s — is treated as unknown: incident alert', async (_label, over) => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    replacedBy(ctx, RECOVERY, over);
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    const alerts = alertsOf(ctx);
    expect(alerts.filter((a) => (a.kind as string) === 'evaluator-replaced-by-recovery')).toEqual([]);
    expect(alerts.filter((a) => a.kind === 'evaluator-replaced')).toHaveLength(1);
  });

  it.each([
    ['the job\'s own candidate has no ledger row', 'remove' as const, () => ({})],
    ['the job\'s own candidate has no nonce (and the SCRIPT row neither)', (own: LedgerCandidate) => void (own.nonce = null), () => ({ nonce: null })],
  ])('review P3-3: a valid SCRIPT row of an incident, but %s → no nonce to compare: incident alert', async (_label, ownChange, over) => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    replacedBy(ctx, RECOVERY, over, ownChange);
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    const alerts = alertsOf(ctx);
    expect(alerts.filter((a) => (a.kind as string) === 'evaluator-replaced-by-recovery')).toEqual([]);
    expect(alerts.filter((a) => a.kind === 'evaluator-replaced')).toHaveLength(1);
  });

  it('the ledger cannot be read when the replacement is seen → treated as unknown: incident alert (fail toward the incident)', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    const ledger = ledgerOf(ctx);
    const real = ledger.candidatesForJob.bind(ledger);
    let failed = 0;
    // The recovery row IS in the ledger, but the first ledger read after the receipt wait fails.
    ctx.signer.waitForTransactionReceipt.mockImplementationOnce(async (hash: Hex) => {
      const own = ledger.rows.find((r) => r.txHash.toLowerCase() === hash.toLowerCase())!;
      ledger.rows.push({ ...own, id: 'etx_replacement', txHash: RECOVERY.toLowerCase(), kind: 'SPEED_UP', origin: 'SCRIPT', incidentId: 'inc_p3_6', operator: 'ops@test', replacesId: own.id, status: 'SENT' });
      ledger.candidatesForJob = async () => {
        failed++;
        ledger.candidatesForJob = real;
        throw new Error('database unreachable');
      };
      return { status: 'success', logs: [], transactionHash: RECOVERY, replacedReason: 'repriced' } as never;
    });
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    ledger.candidatesForJob = real;
    const alerts = alertsOf(ctx);
    expect(alerts.filter((a) => (a.kind as string) === 'evaluator-replaced-by-recovery')).toEqual([]);
    expect(alerts.filter((a) => a.kind === 'evaluator-replaced')).toHaveLength(1);
    expect(failed).toBe(1); // the lookup was tried and failed
  });
});

describe('C3d — receipt surfacing', () => {
  it('FeedbackFailed + AgentPenalized → "failed:penalized" with the penalized agent id and count', () => {
    const parsed = parseSettlementReceipt(
      [
        hookLog('FeedbackFailed', { jobId: 7n, reason: '0x' }),
        hookLog('AgentPenalized', { agentId: 9n, jobId: 7n, penalties: 2n }),
      ],
      ESCROW,
      HOOK,
      7n,
    );
    expect(parsed).toMatchObject({ feedbackStatus: 'failed:penalized', ratedAgentId: '9', penalties: '2' });
  });

  it('C3h D2: only the events of THIS job count — another job\'s JobCompleted, fee and hook outcome in the receipt are ignored', () => {
    const otherJob = [
      makeLog(AGENT_JOB_ESCROW_ABI, 'JobCompleted', { jobId: 8n, evaluator: EVALUATOR, reason: SETTLEMENT_REASONS.completed }, ESCROW),
      makeLog(AGENT_JOB_ESCROW_ABI, 'PlatformFeeAccrued', { jobId: 8n, amount: 37_500n }, ESCROW),
      makeLog(REPUTATION_HOOK_ABI, 'FeedbackWritten', { jobId: 8n, agentId: 3n, value: 100n }, HOOK),
    ];
    expect(parseSettlementReceipt(otherJob, ESCROW, HOOK, 7n)).toMatchObject({ completed: false, rejected: false, expired: false, platformFee: null, feedbackStatus: null, ratedAgentId: null });
    expect(parseSettlementReceipt([...otherJob, ...completeLogs('written')], ESCROW, HOOK, 7n)).toMatchObject({ completed: true, platformFee: 37_500n, feedbackStatus: 'written', ratedAgentId: '3' });
  });

  it('C3h D2: a replacement\'s receipt is never read as the outcome; the job\'s own receipt without its terminal event is never "REJECTED"', async () => {
    const OTHER = '0xdead000000000000000000000000000000000000000000000000000000000001' as Hex;
    const replaced = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    replaced.signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [], transactionHash: OTHER, replacedReason: 'cancelled' } as never);
    await expect(processSettlementJob(replaced.deps, settleJob())).rejects.toThrow(/replaced in its nonce/);
    expect(replaced.jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING', settleTxHash: SETTLE_HASH, platformFeeAmount: null });
    expect(replaced.finalize).not.toHaveBeenCalled();
    expect(replaced.alert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'evaluator-replaced', jobId: 'job-1', details: expect.objectContaining({ txHash: SETTLE_HASH, replacedBy: OTHER, replacedReason: 'cancelled' }) }),
    );

    // The chain already terminal when the replacement is seen (a speed-up of this complete): mirrored from the chain.
    const spedUp = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    spedUp.signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: completeLogs('written'), transactionHash: OTHER, replacedReason: 'repriced' } as never);
    let getJobReads = 0;
    spedUp.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'getJob' ? { status: getJobReads++ === 0 ? CHAIN_JOB_STATUS.Submitted : CHAIN_JOB_STATUS.Completed, budget: BUDGET } : USDC,
    );
    await expect(processSettlementJob(spedUp.deps, settleJob())).resolves.toEqual({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });

    const silent = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: [] });
    await expect(processSettlementJob(silent.deps, settleJob())).rejects.toThrow(/without a terminal event for this job/);
    expect(silent.jobs.get('job-1')!['onChainStatus']).toBe('SETTLING');
    expect(silent.finalize).not.toHaveBeenCalled();
    expect(silent.alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'settlement-unproven', jobId: 'job-1' }));
  });

  it('FeedbackSkipped reasons from C2b are surfaced verbatim (not-verdict, payout-blocked, penalized)', () => {
    for (const reason of ['not-verdict', 'payout-blocked', 'penalized', 'agent-not-provider']) {
      const parsed = parseSettlementReceipt([hookLog('FeedbackSkipped', { jobId: 7n, reason: stringToHex(reason, { size: 32 }) })], ESCROW, HOOK, 7n);
      expect(parsed.feedbackStatus).toBe(`skipped:${reason}`);
      expect(parsed.ratedAgentId).toBeNull();
    }
  });

  it('a complete skipped as "penalized" stores the canonical id the hook used (canonicalAgentId(provider))', async () => {
    const { deps, jobs, readContract } = makeDeps([SUBMITTED_JOB()], {
      txs: [FUND_TX()],
      settleLogs: [...completeLogs('none'), hookLog('FeedbackSkipped', { jobId: 7n, reason: stringToHex('penalized', { size: 32 }) })],
    });
    const base = readContract.getMockImplementation()!;
    readContract.mockImplementation(async (params: { functionName: string }) => (params.functionName === 'canonicalAgentId' ? 12n : base(params as never)));
    await processSettlementJob(deps, settleJob());
    expect(jobs.get('job-1')).toMatchObject({ feedbackStatus: 'skipped:penalized', ratedAgentId: '12' });
  });

  it('submit receipt: CanonicalAgentIdSet → ratedAgentId; AgentIdNotVerified → providerAgentIdError (feedback will be skipped)', async () => {
    const events = parseHookIdentityEvents(
      [hookLog('CanonicalAgentIdSet', { provider: PROVIDER.safeAddress, agentId: 5n, jobId: 7n })],
      HOOK,
    );
    expect(events).toEqual({ canonicalAgentId: '5', notVerifiedAgentId: null });

    const meta = { jobId: 'job-1', erc8183: true, escrowStep: 'submit', deliverable: '0x' + 'ab'.repeat(32) };
    const set = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING', providerAgentId: '4' })], {
      txs: [stepTx('submit', 'job-1', { metadata: meta })],
      receiptLogs: [hookLog('CanonicalAgentIdSet', { provider: PROVIDER.safeAddress, agentId: 5n, jobId: 7n })],
    });
    await onEscrowTxOutcome(set.deps, { transactionId: 'tx-submit', status: 'CONFIRMED' });
    expect(set.jobs.get('job-1')).toMatchObject({ onChainStatus: 'SUBMITTED', ratedAgentId: '5' });
    expect(set.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ providerAgentId: '4', canonicalAgentId: '5' }), expect.any(String));

    const unverified = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING' })], {
      txs: [stepTx('submit', 'job-1', { metadata: meta })],
      receiptLogs: [hookLog('AgentIdNotVerified', { jobId: 7n, provider: PROVIDER.safeAddress, agentId: 6n })],
    });
    await onEscrowTxOutcome(unverified.deps, { transactionId: 'tx-submit', status: 'CONFIRMED' });
    expect(unverified.jobs.get('job-1')!['providerAgentIdError']).toMatch(/did not verify ERC-8004 agent id 6/);
    expect(unverified.jobs.get('job-1')!['onChainStatus']).toBe('SUBMITTED');
  });

  it('exposes resolution, resolvedAt and ratedAgentId in `escrow`; the operator fields stay out of agent responses', () => {
    const view = toJobResponse(CONTESTED_JOB({ resolution: 'pay', resolvedAt: NOW, resolvedBy: 'alice', resolutionNote: 'secret', reviewLog: [{}], ratedAgentId: '3' }));
    expect(view.escrow).toMatchObject({ onChainStatus: 'CONTESTED', resolution: 'pay', resolvedAt: NOW, ratedAgentId: '3' });
    expect(JSON.stringify(view)).not.toContain('alice');
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view).not.toHaveProperty('reviewLog');
  });
});

describe('C3d — evaluation delay vs expiresAt, committed feedback files', () => {
  it('clamps the evaluation delay so the settlement runs at least the margin before expiresAt', () => {
    const cfg = { evaluationDelaySeconds: 3600, jobTtlSeconds: TTL };
    expect(settlementDelay(cfg, new Date(NOW.getTime() + 86_400_000), NOW)).toEqual({ delayMs: 3_600_000, clamped: false });
    expect(settlementDelay(cfg, new Date(NOW.getTime() + 600_000), NOW)).toEqual({ delayMs: 480_000, clamped: true });
    expect(settlementDelay(cfg, new Date(NOW.getTime() + 60_000), NOW)).toEqual({ delayMs: 0, clamped: true });
    expect(settlementDelay(cfg, null, NOW)).toEqual({ delayMs: 3_600_000, clamped: false });
    // Short TTLs (tests): 10 % of the TTL instead of 2 minutes.
    expect(settlementDelay({ evaluationDelaySeconds: 20, jobTtlSeconds: 60 }, new Date(NOW.getTime() + 20_000), NOW)).toEqual({ delayMs: 14_000, clamped: true });
  });

  it('Q6: the 3600 s validation window against the default 7-day TTL — never clamped until the last hour + margin', () => {
    const cfg = { evaluationDelaySeconds: 3600, jobTtlSeconds: 604_800 };
    expect(expiryMarginMs(cfg)).toBe(120_000);
    // Submitted right after funding, a day before expiry, and exactly at the edge: the full hour.
    for (const leftMs of [604_800_000, 86_400_000, 3_600_000 + 120_000]) {
      expect(settlementDelay(cfg, new Date(NOW.getTime() + leftMs), NOW)).toEqual({ delayMs: 3_600_000, clamped: false });
    }
    // Inside the last hour + margin: clamped to expiresAt − now − margin (never past expiresAt).
    expect(settlementDelay(cfg, new Date(NOW.getTime() + 3_600_000), NOW)).toEqual({ delayMs: 3_480_000, clamped: true });
    expect(settlementDelay(cfg, new Date(NOW.getTime() + 1_800_000), NOW)).toEqual({ delayMs: 1_680_000, clamped: true });
    // A one-hour TTL with a one-hour window: margin = min(2 min, 10 % of the TTL) = 2 min.
    expect(settlementDelay({ evaluationDelaySeconds: 3600, jobTtlSeconds: 3600 }, new Date(NOW.getTime() + 3_000_000), NOW)).toEqual({
      delayMs: 2_880_000,
      clamped: true,
    });
  });

  it('submit confirmed close to expiry schedules the settlement with the clamped delay', async () => {
    const { deps, settlement } = makeDeps(
      [escrowJob({ onChainJobId: '7', onChainStatus: 'FUNDED', status: 'PAYMENT_PENDING', expiresAt: new Date(NOW.getTime() + 300_000) })],
      { txs: [stepTx('submit', 'job-1', { metadata: { jobId: 'job-1', erc8183: true, escrowStep: 'submit' } })] },
    );
    await onEscrowTxOutcome({ ...deps, config: { ...config, evaluationDelaySeconds: 3600 } }, { transactionId: 'tx-submit', status: 'CONFIRMED' });
    expect(settlement.add).toHaveBeenCalledWith({ jobId: 'job-1', action: 'settle' }, { delayMs: 180_000 });
  });

  it('a feedback file counts as committed only on COMPLETED / REJECTED', () => {
    expect(isFeedbackFileCommitted({ onChainStatus: 'COMPLETED', feedbackFile: {} })).toBe(true);
    expect(isFeedbackFileCommitted({ onChainStatus: 'REJECTED', feedbackFile: {} })).toBe(true);
    for (const onChainStatus of ['SUBMITTED', 'SETTLING', 'CONTESTED', 'EXPIRED', null]) {
      expect(isFeedbackFileCommitted({ onChainStatus, feedbackFile: {} })).toBe(false);
    }
    expect(isFeedbackFileCommitted({ onChainStatus: 'COMPLETED', feedbackFile: null })).toBe(false);
  });
});

describe('C3f review P3-1 — the evaluator-stuck alert states the refund deadline', () => {
  beforeEach(() => __resetEvaluatorBacklogForTests());

  /** The key's lowest pending nonce (5) has not moved past the threshold: the second check alerts. */
  async function stuckAlert(ctx: ReturnType<typeof makeDeps>): Promise<EscrowAlert> {
    let now = NOW.getTime();
    const getTransactionCount = vi.fn(async ({ blockTag }: { blockTag: 'latest' | 'pending' }) => (blockTag === 'pending' ? 6 : 5));
    // A1 R2-P2-5: the early (first-sight) alert is off here — this block checks the C3f text after the 10-minute rule.
    const deps: Erc8183Deps = {
      ...ctx.deps,
      now: () => new Date(now),
      publicClient: () => ({ getTransactionCount }) as never,
      evaluatorA1: { leaseMinRemainingMs: 30_000, criticalSectionMaxMs: 60_000, earlyAlertBeforeExpirySeconds: 0 },
    };
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toBeNull(); // first sight
    now += EVALUATOR_STUCK_ALERT_AFTER_MS + 1_000;
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toMatchObject({ stuckNonce: 5, queued: 1 });
    expect(ctx.alert).toHaveBeenCalledTimes(1);
    return ctx.alert.mock.calls[0]![0] as EscrowAlert;
  }

  it('no live job with an expiresAt: the alert says so — no date is made up (a final job is no deadline)', async () => {
    const done = escrowJob({ id: 'job-done', onChainJobId: '8', onChainStatus: 'COMPLETED', status: 'COMPLETED' });
    const ctx = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', expiresAt: null }), done]);
    const alert = await stuckAlert(ctx);
    expect(alert.message).toContain("Funds stay in the escrow only until each job's expiresAt (no live escrow job on this chain has an expiresAt recorded)");
    expect(alert.message).toMatch(/after it anyone can call claimRefund .*also for work already delivered/);
    expect(alert.message).not.toContain((done['expiresAt'] as Date).toISOString());
    expect(alert.message).not.toContain('Invalid Date');
    expect(alert.details).toMatchObject({ earliestExpiresAt: null, earliestExpiringJobId: null });
  });

  it('an earliest expiresAt already past is flagged; an unreadable one is said, and the alert is still raised', async () => {
    const past = new Date(NOW.getTime() - 60_000);
    const late = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', expiresAt: past })]);
    const lateAlert = await stuckAlert(late);
    expect(lateAlert.message).toContain(`the earliest among the live escrow jobs on this chain is ${past.toISOString()} (job job-1, already passed)`);
    expect(lateAlert.details).toMatchObject({ earliestExpiresAt: past.toISOString(), earliestExpiringJobId: 'job-1' });

    __resetEvaluatorBacklogForTests();
    const unreadable = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING' })]);
    unreadable.dbMock.job.findMany.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const alert = await stuckAlert(unreadable);
    expect(alert.message).toContain("(the live jobs' expiresAt could not be read): after it anyone can call claimRefund");
    expect(alert.details).toMatchObject({ earliestExpiresAt: null, earliestExpiringJobId: null });
  });

  it('A1 R2-P2-5: a delivered job waiting on the key within T of expiresAt → alerted at FIRST sight (no 10 minutes), with the claimRefund sentence', async () => {
    const soon = new Date(NOW.getTime() + 3_600_000);
    const ctx = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', expiresAt: soon })]);
    const getTransactionCount = vi.fn(async ({ blockTag }: { blockTag: 'latest' | 'pending' }) => (blockTag === 'pending' ? 6 : 5));
    const deps: Erc8183Deps = { ...ctx.deps, publicClient: () => ({ getTransactionCount }) as never, evaluatorA1: { leaseMinRemainingMs: 30_000, criticalSectionMaxMs: 60_000, earlyAlertBeforeExpirySeconds: 86_400 } };
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toMatchObject({ stuckNonce: 5, early: true, earliestDeliveredExpiry: { jobId: 'job-1', expiresAt: soon } });
    const alert = ctx.alert.mock.calls[0]![0] as EscrowAlert;
    expect(alert.kind).toBe('evaluator-stuck');
    expect(alert.message).toMatch(/Alerted at first sight: delivered job job-1/);
    expect(alert.message).toMatch(/after it anyone can call claimRefund .*also for work already delivered/);
    // Not again within the hour (persisted "delivered" mark).
    expect(await checkEvaluatorBacklog(deps, CHAIN_ID)).toBeNull();
    expect(ctx.alert).toHaveBeenCalledTimes(1);
  });

  it('A1 R2-P1-3c: the stuck clock survives a restart (persisted), and the "alerted" mark is written only after the delivery', async () => {
    let now = NOW.getTime();
    const ctx = makeDeps([escrowJob({ onChainJobId: '7', onChainStatus: 'SUBMITTED', status: 'PAYMENT_PENDING', expiresAt: null })]);
    const getTransactionCount = vi.fn(async ({ blockTag }: { blockTag: 'latest' | 'pending' }) => (blockTag === 'pending' ? 6 : 5));
    const make = (): Erc8183Deps => ({ ...ctx.deps, now: () => new Date(now), publicClient: () => ({ getTransactionCount }) as never });
    expect(await checkEvaluatorBacklog(make(), CHAIN_ID)).toBeNull(); // first sight, in "process 1"
    now += EVALUATOR_STUCK_ALERT_AFTER_MS + 1_000;
    // "Process 2" (new deps, same tables): the channel fails once — nothing recorded as delivered.
    ctx.alert.mockImplementationOnce(() => {
      throw new Error('channel down');
    });
    expect(await checkEvaluatorBacklog(make(), CHAIN_ID)).toMatchObject({ stuckNonce: 5 });
    expect((await ctx.deps.evaluatorLedger!.readChainState(CHAIN_ID, EVALUATOR))!.lastAlertAt['evaluator-stuck']).toBeUndefined();
    // Next tick: alerted again (delivered this time) and recorded.
    expect(await checkEvaluatorBacklog(make(), CHAIN_ID)).toMatchObject({ stuckNonce: 5 });
    expect((await ctx.deps.evaluatorLedger!.readChainState(CHAIN_ID, EVALUATOR))!.lastAlertAt['evaluator-stuck']).toEqual(new Date(now));
    expect(await checkEvaluatorBacklog(make(), CHAIN_ID)).toBeNull();
  });
});

// ── C3g-A1: the evaluator lane, nonce choice, critical section, proof-depth finalization ──

describe('C3g-A1 — sendEvaluatorTx in the evaluator lane', () => {
  it('acquires the evaluator lane before signing, passes lease + margin + nonce choice, and releases it BEFORE the receipt wait', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    const lanes = new InMemoryLaneLock();
    const events: string[] = [];
    const acquire = lanes.acquire.bind(lanes);
    lanes.acquire = (async (key: string, o?: { waitMs?: number }) => {
      events.push(`acquire:${key}`);
      const lease = await acquire(key, o);
      const release = lease.release.bind(lease);
      return Object.assign(lease, { release: async () => { events.push('release'); await release(); } });
    }) as never;
    ctx.deps.lanes = lanes;
    let seen: EvaluatorWriteOptions | undefined;
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      seen = opts;
      events.push(`nonce:${await opts!.chooseNonce!(3)}`);
      await opts!.lease!.assertHeld(opts!.minLeaseMs!);
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      events.push('sent');
      return SETTLE_HASH;
    }) as never);
    ctx.signer.waitForTransactionReceipt.mockImplementation((async (hash: Hex) => {
      events.push('wait');
      return { status: 'success', logs: completeLogs('written'), transactionHash: hash };
    }) as never);
    expect(await processSettlementJob(ctx.deps, settleJob())).toMatchObject({ outcome: 'settled' });
    expect(seen?.minLeaseMs).toBe(30_000);
    expect(events).toEqual([`acquire:${CHAIN_ID}:${EVALUATOR.toLowerCase()}`, 'nonce:3', 'sent', 'release', 'wait']);
    expect((await ctx.deps.evaluatorLedger!.candidatesForJob('job-1'))[0]).toMatchObject({ status: 'SENT', origin: 'WORKER', kind: 'ORIGINAL', action: 'COMPLETE', decision: 'pay', rawTx: expect.stringMatching(/^0xfa/) });
  });

  it('R2-P2-3: the nonce is max(pending, highest live candidate + 1) — never on top of a live candidate of another job', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    // A live candidate of another job at nonce 7 (a lagging `pending` of 5).
    await ctx.deps.evaluatorLedger!.insertCandidateWithJobStamp({
      candidate: { chainId: CHAIN_ID, evaluator: EVALUATOR, nonce: 7, jobId: null, kind: 'ORIGINAL', action: 'COMPLETE', toAddress: ESCROW, calldata: '0x1234', gasLimit: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, txHash: '0x' + '77'.repeat(32), origin: 'WORKER' },
    });
    let chosen = -1;
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      chosen = await opts!.chooseNonce!(5);
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, { ...signedTx(SETTLE_HASH, params), nonce: chosen });
      return SETTLE_HASH;
    }) as never);
    await processSettlementJob(ctx.deps, settleJob());
    expect(chosen).toBe(8);
  });

  it('P17: a critical section older than the configured maximum records nothing and sends nothing', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.deps.lanes = new InMemoryLaneLock();
    ctx.deps.evaluatorA1 = { leaseMinRemainingMs: 1, criticalSectionMaxMs: 5 };
    const sent: Hex[] = [];
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      await new Promise((r) => setTimeout(r, 20)); // simulation + signature took too long
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      sent.push(SETTLE_HASH);
      return SETTLE_HASH;
    }) as never);
    const err = await processSettlementJob(ctx.deps, settleJob()).catch((e: unknown) => e);
    expect((err as Error).name).toBe('EvaluatorCriticalSectionError');
    expect(sent).toEqual([]);
    expect(await ctx.deps.evaluatorLedger!.candidatesForJob('job-1')).toEqual([]);
    expect(ctx.jobs.get('job-1')).toMatchObject({ settleTxHash: null });
  });

  it('a LeaseLostError after the record = NOT broadcast: the candidate stays SIGNED and live (no "lost answer" verdict, no node asked)', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.deps.isKnownTransaction = vi.fn(async () => true);
    ctx.signer.writeContract.mockImplementation((async (params: EvaluatorWriteParams, opts?: EvaluatorWriteOptions) => {
      await opts?.onBeforeBroadcast?.(SETTLE_HASH, signedTx(SETTLE_HASH, params));
      throw Object.assign(new Error('Lane lease is not held'), { name: 'LeaseLostError' });
    }) as never);
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/not held/);
    expect(ctx.deps.isKnownTransaction).not.toHaveBeenCalled();
    expect((await ctx.deps.evaluatorLedger!.candidatesForJob('job-1'))[0]).toMatchObject({ status: 'SIGNED', sendError: expect.stringMatching(/not broadcast/) });
    expect(ctx.jobs.get('job-1')).toMatchObject({ settleTxHash: SETTLE_HASH, settleAttemptAt: null });
  });
});

describe('C3g-A1 (decision A3) — the DB finalizes only at the proof tag', () => {
  it('own complete mined at latest but the job still Submitted at `safe` → nothing finalized, candidate MINED at latest; finalized once proven', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.deps.proofTag = 'safe';
    let safeStatus: number = CHAIN_JOB_STATUS.Submitted;
    let latestStatus: number = CHAIN_JOB_STATUS.Submitted;
    ctx.readContract.mockImplementation((async (p: { functionName: string; blockTag?: string }) => {
      if (p.functionName === 'getJob') return { status: p.blockTag === 'safe' ? safeStatus : latestStatus, budget: BUDGET };
      if (p.functionName === 'token') return USDC;
      throw new Error(`unexpected read ${p.functionName}`);
    }) as never);
    ctx.signer.waitForTransactionReceipt.mockImplementation((async (hash: Hex) => {
      latestStatus = CHAIN_JOB_STATUS.Completed; // mined: terminal at latest, not yet at safe
      return { status: 'success', logs: completeLogs('written'), transactionHash: hash, blockNumber: 9n, blockHash: keccak256(hash) };
    }) as never);
    expect(await processSettlementJob(ctx.deps, settleJob())).toMatchObject({ outcome: 'noop' });
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING' });
    expect((await ctx.deps.evaluatorLedger!.candidatesForJob('job-1'))[0]).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'latest' });
    // A retry while `safe` lags: still nothing.
    expect(await processSettlementJob(ctx.deps, settleJob(2))).toMatchObject({ outcome: 'noop' });
    expect(ctx.finalize).not.toHaveBeenCalled();
    // `safe` catches up: the existing path reconciles and finalizes once.
    safeStatus = CHAIN_JOB_STATUS.Completed;
    expect(await processSettlementJob(ctx.deps, settleJob(3))).toMatchObject({ outcome: 'reconciled', onChainStatus: 'COMPLETED' });
    expect(ctx.finalize).toHaveBeenCalledTimes(1);
  });
});

describe('A1 core review fixes', () => {
  it('P2-3: a speed-up mined during the receipt wait while the proof tag lags → no-op (no throw, no retry storm), nothing finalized, the job is not handed back', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    ctx.deps.proofTag = 'safe';
    let latestStatus: number = CHAIN_JOB_STATUS.Submitted;
    ctx.readContract.mockImplementation((async (p: { functionName: string; blockTag?: string }) => {
      if (p.functionName === 'getJob') return { status: p.blockTag === 'safe' ? CHAIN_JOB_STATUS.Submitted : latestStatus, budget: BUDGET };
      if (p.functionName === 'token') return USDC;
      throw new Error(`unexpected read ${p.functionName}`);
    }) as never);
    const SPEED_UP = ('0x' + '5e'.repeat(32)) as Hex;
    ctx.signer.waitForTransactionReceipt.mockImplementation((async () => {
      latestStatus = CHAIN_JOB_STATUS.Completed; // the operator's speed-up of the same decision mined instead
      return { status: 'success', logs: completeLogs('written'), transactionHash: SPEED_UP, replacedReason: 'repriced' };
    }) as never);
    const job = settleJob(3); // the LAST attempt: a throw would hand the job back and alert settlement-failed
    const result = await processSettlementJob(ctx.deps, job);
    expect(result).toMatchObject({ outcome: 'noop' });
    expect(ctx.finalize).not.toHaveBeenCalled();
    expect(ctx.jobs.get('job-1')).toMatchObject({ onChainStatus: 'SETTLING' });
    expect(ctx.alert.mock.calls.map(([a]) => (a as EscrowAlert).kind)).not.toContain('settlement-failed');
  });

  it('P3-4: no evaluator lane wired → nothing is signed or sent (fail closed)', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    delete (ctx.deps as { lanes?: unknown }).lanes;
    await expect(processSettlementJob(ctx.deps, settleJob())).rejects.toThrow(/no evaluator lane/);
    expect(ctx.signer.writeContract).not.toHaveBeenCalled();
    expect(await ctx.deps.evaluatorLedger!.candidatesForJob('job-1')).toEqual([]);
  });

  it('P3-2: P17 counts from the moment the lane was OBTAINED — a long wait for a busy lane does not refuse the send', async () => {
    const ctx = makeDeps([SUBMITTED_JOB()], { txs: [FUND_TX()], settleLogs: completeLogs('written') });
    const lanes = new InMemoryLaneLock();
    ctx.deps.lanes = lanes;
    ctx.deps.evaluatorA1 = { leaseMinRemainingMs: 1, criticalSectionMaxMs: 40 };
    const busy = await lanes.acquire(`${CHAIN_ID}:${EVALUATOR.toLowerCase()}`); // the recovery script holds the lane
    setTimeout(() => void busy.release(), 80); // longer than the critical-section maximum
    expect(await processSettlementJob(ctx.deps, settleJob())).toMatchObject({ outcome: 'settled' });
  });
});
