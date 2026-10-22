/**
 * C3h D2 on a REAL node with the REAL contracts (`npm run test:anvil`): a
 * same-nonce replacement of the evaluator's settlement mined while the worker
 * waits for its receipt.
 *
 * The evaluator signer (`createEvaluatorSigner`, viem 2.57.3) waits with
 * `waitForTransactionReceipt`, whose `checkReplacement` is on by default:
 * when the transaction it waits for is replaced in its nonce, viem resolves
 * with the REPLACEMENT's receipt. Before C3h the settlement read that receipt
 * as the job's outcome: a 0-value cancel (no JobCompleted) became `REJECTED`
 * and the job was finalized as refunded while it stayed Submitted on-chain;
 * another job's `complete` in the same nonce marked THIS job paid. Here the
 * worker (real `processSettlementJob`, real Postgres rows, real signer) sends
 * its `complete`, and with automine off the test mines a replacement signed
 * with the evaluator key in the same nonce (what `cast send --nonce …` or a
 * second worker does).
 *
 * Contracts: `AgentJobEscrow` + `MockERC20` from the Foundry artifacts.
 * Postgres: DATABASE_URL (migrated; skipped with a warning when unreachable
 * outside CI). Anvil: `anvilTestPort(7)` (default 8752), chain id 84532.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, parseEventLogs, toBytes, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { createEvaluatorSigner, type EvaluatorSigner } from '../services/escrow/evaluator-signer.js';
import {
  CHAIN_JOB_STATUS,
  SETTLEMENT_REASONS,
  processSettlementJob,
  type Erc8183Deps,
  type EscrowAlert,
} from '../services/job/escrow-erc8183.service.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "onChainStatus", "settleAttemptAt" FROM "Job" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('escrow-settlement-replacement.anvil.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[escrow-settlement-replacement.anvil] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const CHAIN_ID = 84532;
const NAME_PREFIX = 'c3h-anvil';
const BUDGET = 5_000_000n;
const deployer = anvilAccount(0);
const requester = anvilAccount(1);
const provider = anvilAccount(2);
const evaluator = anvilAccount(4);
const escrowAbi = AGENT_JOB_ESCROW_ABI as unknown as Abi;

let chain: LocalChain;
let db: PrismaClient;
let usdc: Address;
let escrow: Address;
let signer: EvaluatorSigner;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function write(account: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await chain.wallet(account).writeContract({ address, abi, functionName, args: args as never, account, chain: null });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return hash;
}

/** A job created, funded and Submitted on-chain (automine on). */
async function submittedOnChain(): Promise<{ onChainJobId: bigint; expiredAt: bigint }> {
  const block = await chain.publicClient.getBlock();
  const expiredAt = block.timestamp + 3600n;
  const created = await write(requester, escrow, escrowAbi, 'createJob', [provider.address, evaluator.address, expiredAt, 'c3h', zeroAddress]);
  const receipt = await chain.publicClient.getTransactionReceipt({ hash: created });
  const [event] = parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs: receipt.logs, eventName: 'JobCreated' });
  const onChainJobId = event!.args.jobId;
  await write(requester, escrow, escrowAbi, 'setBudget', [onChainJobId, BUDGET, '0x']);
  await write(requester, escrow, escrowAbi, 'fund', [onChainJobId, BUDGET, '0x']);
  await write(provider, escrow, escrowAbi, 'submit', [onChainJobId, keccak256(toBytes(`c3h-${onChainJobId}`)), '0x']);
  return { onChainJobId, expiredAt };
}

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  // A1 (R2-P3-8): candidate rows reference Job with ON DELETE RESTRICT — deleted first.
  await db.evaluatorTransaction.deleteMany({ where: { job: { OR: [{ requester: agents }, { provider: agents }] } } });
  await db.job.deleteMany({ where: { OR: [{ requester: agents }, { provider: agents }] } });
  await db.agent.deleteMany({ where: agents });
}

let seq = 0;
/** The DB side of a delivered escrow job: PAYMENT_PENDING, SUBMITTED, waiting for its automatic settlement. */
async function deliveredRow(onChain: { onChainJobId: bigint; expiredAt: bigint }): Promise<string> {
  const run = `${Date.now().toString(36)}-${++seq}`;
  const agent = (label: string, address: Address) =>
    db.agent.create({
      data: { name: `${NAME_PREFIX} ${label}`, apiKeyHash: `${NAME_PREFIX}-${label}-${run}`, apiKeyPrefix: 'c3h', walletId: `${NAME_PREFIX}-${label}-${run}`, safeAddress: address, chainIds: [CHAIN_ID] },
      select: { id: true },
    });
  // Unique wallet addresses per row (Agent.safeAddress is unique); the chain side uses the Anvil accounts.
  const req = await agent('requester', privateKeyToAccount(generatePrivateKey()).address);
  const prov = await agent('provider', privateKeyToAccount(generatePrivateKey()).address);
  const row = await db.job.create({
    data: {
      requesterId: req.id,
      providerId: prov.id,
      status: 'PAYMENT_PENDING',
      payload: { task: 'c3h' },
      result: { ok: true },
      escrowKind: 'erc8183',
      escrowChainId: CHAIN_ID,
      escrowContract: getAddress(escrow),
      onChainJobId: onChain.onChainJobId.toString(),
      onChainStatus: 'SUBMITTED',
      evaluator: evaluator.address,
      budgetToken: usdc,
      budgetAmount: BUDGET.toString(),
      expiresAt: new Date(Number(onChain.expiredAt) * 1000),
      reservationStatus: 'PENDING',
    },
    select: { id: true },
  });
  return row.id;
}

interface Harness {
  deps: Erc8183Deps;
  alerts: EscrowAlert[];
  finalized: Array<{ jobId: string; outcome: string }>;
  released: string[];
}

function harness(): Harness {
  const alerts: EscrowAlert[] = [];
  const finalized: Harness['finalized'] = [];
  const released: string[] = [];
  const deps: Erc8183Deps = {
    db,
    queue: { add: async () => undefined } as never,
    settlement: { add: async () => undefined },
    publicClient: () => chain.publicClient as never,
    evaluatorSigner: () => signer,
    config: {
      evaluatorAddress: evaluator.address,
      jobTtlSeconds: 3600,
      evaluationDelaySeconds: 0,
      backendPublicUrl: 'http://localhost:3000',
      chain: (chainId: number) => (chainId === CHAIN_ID ? { chainId, escrow, hook: null } : null),
    },
    releaseJobEscrow: async (jobId) => {
      released.push(jobId);
    },
    finalize: async (params) => {
      finalized.push({ jobId: params.jobId, outcome: params.outcome });
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    alert: (a) => {
      alerts.push(a);
    },
  };
  return { deps, alerts, finalized, released };
}

async function chainStatus(onChainJobId: bigint): Promise<number> {
  const job = (await chain.publicClient.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'getJob', args: [onChainJobId] })) as { status: number };
  return Number(job.status);
}

/**
 * Starts the worker's settlement of `jobId` (it signs and sends `complete`, then waits), waits
 * until that transaction is in the node's mempool and viem has started watching it, and returns
 * the pending transaction and the settlement's outcome promise.
 */
async function settleUntilPending(h: Harness, jobId: string) {
  const latest = await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'latest' });
  const outcome = processSettlementJob(h.deps, { data: { jobId, action: 'settle' }, attemptsMade: 0, opts: { attempts: 3 } }).then(
    (result) => ({ result, error: null as Error | null }),
    (error: Error) => ({ result: null, error }),
  );
  for (let i = 0; i < 200; i++) {
    const pending = await chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag: 'pending' });
    if (pending > latest) break;
    await sleep(50);
  }
  const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  expect(row.settleTxHash).not.toBeNull();
  const tx = await chain.publicClient.getTransaction({ hash: row.settleTxHash as Hex });
  expect(tx.nonce).toBe(latest);
  // viem's receipt wait reads the transaction on its first poll (needed to recognise a replacement).
  await sleep(1_500);
  return { tx, outcome };
}

const replacementFees = (tx: { maxFeePerGas?: bigint | null | undefined; maxPriorityFeePerGas?: bigint | null | undefined }) => ({
  maxFeePerGas: (tx.maxFeePerGas ?? 2_000_000_000n) * 3n,
  maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 1_000_000_000n) * 3n,
});

beforeAll(async () => {
  if (!DB_READY) return;
  chain = await startLocalChain({ port: anvilTestPort(7), chainId: CHAIN_ID });
  // The evaluator signer sends through RPC_URL_<chainId> (read on every call).
  process.env[`RPC_URL_${CHAIN_ID}`] = chain.rpcUrl;
  db = new PrismaClient();
  usdc = await chain.deploy(deployer, readArtifact('MockERC20', 'MockERC20.sol'));
  escrow = await chain.deploy(deployer, readArtifact('AgentJobEscrow'), [usdc, deployer.address, deployer.address, 0n, 30n]);
  const erc20 = readArtifact('MockERC20', 'MockERC20.sol').abi;
  await write(deployer, usdc, erc20, 'mint', [requester.address, 1_000n * BUDGET]);
  await write(requester, usdc, erc20, 'approve', [escrow, 1_000n * BUDGET]);
  signer = createEvaluatorSigner(CHAIN_ID, ANVIL_KEYS[4]);
  await wipe();
});

afterAll(async () => {
  if (db) {
    await wipe();
    await db.$disconnect();
  }
  chain?.stop();
});

beforeEach(async () => {
  if (!DB_READY) return;
  // A1: the memory of unconfirmed sends is the candidate ledger now (cleaned with the DB rows).
  await chain.rpc('evm_setAutomine', [true]);
});

describeDb('C3h D2 — a same-nonce replacement of the evaluator settlement while the worker waits (real node, real contracts)', () => {
  it('a 0-value cancel in the nonce of the pending complete: the job is not recorded REJECTED nor finalized; alerted; the retry pays with its own complete', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await chain.rpc('evm_setAutomine', [false]);

    const { tx, outcome } = await settleUntilPending(h, jobId);
    const cancel = await chain.wallet(evaluator).sendTransaction({
      account: evaluator,
      chain: null,
      to: evaluator.address,
      value: 0n,
      gas: 21_000n,
      nonce: tx.nonce,
      ...replacementFees(tx),
    });
    await chain.rpc('evm_mine', []);
    const { result, error } = await outcome;

    // viem resolved with the cancel's receipt; the settlement did not read it as this job's outcome.
    expect(JSON.stringify(result)).toBe('null'); // before C3h: {"outcome":"settled",…} from the replacement's receipt
    expect(error?.name).toBe('SettlementReplacedError');
    expect((await chain.publicClient.getTransactionReceipt({ hash: cancel })).status).toBe('success');
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Submitted);
    const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.onChainStatus).not.toBe('REJECTED');
    expect(row.status).toBe('PAYMENT_PENDING');
    expect(h.finalized).toEqual([]);
    expect(h.released).toEqual([]);
    expect(h.alerts.filter((a) => a.kind === ('evaluator-replaced' as EscrowAlert['kind']))).toEqual([
      expect.objectContaining({ jobId, details: expect.objectContaining({ txHash: tx.hash, replacedBy: cancel, onChainJobId: onChain.onChainJobId.toString() }) }),
    ]);

    // The retry (BullMQ) reads the chain — still Submitted — and pays with its own transaction.
    await chain.rpc('evm_setAutomine', [true]);
    const retry = await processSettlementJob(h.deps, { data: { jobId, action: 'settle' }, attemptsMade: 1, opts: { attempts: 3 } });
    expect(retry).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.onChainStatus).toBe('COMPLETED');
    expect(done.settleTxHash).not.toBe(tx.hash);
    expect(done.settleTxHash).not.toBe(cancel);
    expect(h.finalized).toEqual([{ jobId, outcome: 'CONFIRMED' }]);
  });

  it("another job's complete mined in this job's nonce: this job is not marked paid by that receipt; the retry pays it", async () => {
    const x = await submittedOnChain();
    const y = await submittedOnChain();
    const jobId = await deliveredRow(x);
    const h = harness();
    await chain.rpc('evm_setAutomine', [false]);

    const { tx, outcome } = await settleUntilPending(h, jobId);
    // Y's complete, signed with the evaluator key in X's nonce (a second worker, a manual send).
    const other = await chain.wallet(evaluator).writeContract({
      address: escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: 'complete',
      args: [y.onChainJobId, SETTLEMENT_REASONS.completed, '0x'],
      account: evaluator,
      chain: null,
      nonce: tx.nonce,
      gas: 500_000n,
      ...replacementFees(tx),
    });
    await chain.rpc('evm_mine', []);
    const { result, error } = await outcome;

    expect(JSON.stringify(result)).toBe('null'); // before C3h: {"outcome":"settled",…} from the replacement's receipt
    expect(error?.name).toBe('SettlementReplacedError');
    expect(await chainStatus(y.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect(await chainStatus(x.onChainJobId)).toBe(CHAIN_JOB_STATUS.Submitted);
    const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.onChainStatus).not.toBe('COMPLETED');
    expect(row.platformFeeAmount).toBeNull();
    expect(h.finalized).toEqual([]);
    expect(h.alerts.filter((a) => a.kind === ('evaluator-replaced' as EscrowAlert['kind']))).toEqual([
      expect.objectContaining({ jobId, details: expect.objectContaining({ replacedBy: other }) }),
    ]);

    await chain.rpc('evm_setAutomine', [true]);
    const retry = await processSettlementJob(h.deps, { data: { jobId, action: 'settle' }, attemptsMade: 1, opts: { attempts: 3 } });
    expect(retry).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(await chainStatus(x.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).settleTxHash).not.toBe(other);
    expect(h.finalized).toEqual([{ jobId, outcome: 'CONFIRMED' }]);
  });
});
