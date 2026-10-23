/**
 * A1 (C3g) on a REAL node with the REAL contracts (`npm run test:anvil`): `AgentJobEscrow` +
 * `ReputationHook` (+ BlacklistERC20 — MockERC20 with an empty blacklist —, MockIdentityRegistry,
 * MockReputationRegistry from the Foundry artifacts), automine OFF while a scenario needs an evaluator
 * transaction to stay pending.
 *
 * Rows (matrix: agentfi-notas/2026-10-22-a1-matriz.md): AV side of 1–6, 11, 12a, 12b, 14, 22, 25–28, 34
 * (+ D-C, `it.fails`); script rows through the real CLI: 1, 2, 3, 4, 8, 15/40, 16, 18, 35, 37, 42, 45.
 * Row 9 (script + worker at once) is a todo here: a separate multi-process test covers it.
 *
 * Declared Anvil gaps (R2-§11):
 *  - Anvil DROPS an underpriced transaction when it mines a block; "stuck while blocks are produced"
 *    (geth) is not reproduced: a stuck head = automine off and no block until the action. The geth
 *    behaviour is covered by the DB suite's fake (`baseFee` above `maxFeePerGas`).
 *  - `safe` / `finalized` have no L2 meaning on Anvil (they follow `latest`): the proof level is
 *    exercised with an injected tag (`latest − K`, a block number) here and with `safeHead` in the DB fake.
 *  - Reorg: `anvil_reorg` (depth 1–3, transactions re-included or not); fallback `evm_snapshot` / `evm_revert`.
 *  - Deadline: `evm_setNextBlockTimestamp` ≥ `expiredAt`, then `evm_mine` (the contract compares the block timestamp).
 *
 * Blocks:
 *  1. deployment smoke (Postgres up; runs on the pre-A1 code): the real hook rates a worker `complete`.
 *  3. script rows: the recovery CLI (src/scripts/evaluator-recovery.ts) on the real node (runs second).
 *  2. A1 worker / reconciliation rows (gated like the DB suite: EvaluatorTransaction table + `reconcileEvaluatorCandidates`).
 *  last: row 14 (reorg), alone in its describe.
 * Outside CI, blocks 2/3 skip with a warning when the A1 table is missing; on CI that throws.
 *
 * Postgres: DATABASE_URL (migrated). Anvil: `anvilTestPort(10)` (ANVIL_TEST_PORT_BASE + 10), chain id 84532.
 * Keys: Anvil's public test keys only.
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
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseEventLogs, toBytes, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';
import { candidateInput, FakeLeaseLock, planCapsFixture } from './helpers/fake-evaluator-chain.js';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { createEvaluatorSigner, describeSignedEvaluatorTx, type EvaluatorSigner } from '../services/escrow/evaluator-signer.js';
import * as ledger from '../services/escrow/evaluator-ledger.js';
import type { RecoverySigner } from '../scripts/evaluator-recovery.js';
import { readNodeViews } from '../services/escrow/evaluator-rpc.js';
import * as svcModule from '../services/job/escrow-erc8183.service.js';
import { CHAIN_JOB_STATUS, SETTLEMENT_REASONS, processSettlementJob, type Erc8183Deps, type EscrowAlert } from '../services/job/escrow-erc8183.service.js';

// ── availability ──────────────────────────────────────────────────────────────

async function probe(): Promise<{ db: boolean; table: boolean }> {
  const client = new PrismaClient();
  try {
    await client.$queryRaw`SELECT "onChainStatus", "settleAttemptAt" FROM "Job" LIMIT 1`;
  } catch {
    await client.$disconnect().catch(() => undefined);
    return { db: false, table: false };
  }
  try {
    await client.$queryRaw`SELECT "txHash", "proofLevel" FROM "EvaluatorTransaction" LIMIT 1`;
    return { db: true, table: true };
  } catch {
    return { db: true, table: false };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}
const AVAIL = await probe();
if (!AVAIL.db && process.env['CI']) throw new Error('evaluator-recovery.anvil.ts needs a migrated Postgres at DATABASE_URL on CI');
const A1_READY = AVAIL.db && AVAIL.table && typeof (svcModule as Record<string, unknown>)['reconcileEvaluatorCandidates'] === 'function';
if (!A1_READY) console.warn(`[evaluator-recovery.anvil] A1 rows skipped — db=${AVAIL.db} table=${AVAIL.table}`);
// CI migrates the database and runs this file (`npm run test:anvil`): a missing A1 table there must fail, not skip.
if (!A1_READY && process.env['CI']) throw new Error('evaluator-recovery.anvil.ts: the A1 rows cannot run on CI (EvaluatorTransaction table or reconcileEvaluatorCandidates missing)');
const describeDb = AVAIL.db ? describe : describe.skip;
const describeA1 = A1_READY ? describe : describe.skip;

// ── fixture ───────────────────────────────────────────────────────────────────

const CHAIN_ID = 84532;
const NAME_PREFIX = 'a1-f3-anvil';
const BUDGET = 5_000_000n;
const FEE = (BUDGET * 30n) / 10_000n;
const AGENT_ID = 7n;
const deployer = anvilAccount(0);
const requester = anvilAccount(1);
const provider = anvilAccount(2);
const thirdParty = anvilAccount(3);
const evaluator = anvilAccount(4);
const escrowAbi = AGENT_JOB_ESCROW_ABI as unknown as Abi;

let chain: LocalChain;
let db: PrismaClient;
let usdc: Address;
let escrow: Address;
let hook: Address;
let erc20Abi: Abi;
let signer: EvaluatorSigner;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function automine(on: boolean): Promise<void> {
  await chain.rpc('evm_setAutomine', [on]);
}
async function mine(): Promise<void> {
  await chain.rpc('evm_mine', []);
}

async function write(account: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const hash = await chain.wallet(account).writeContract({ address, abi, functionName, args: args as never, account, chain: null });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return hash;
}

/** Created (hooked), agent id set by the provider, budgeted, funded and Submitted on-chain (automine on). */
async function submittedOnChain(ttlSeconds = 3600n): Promise<{ onChainJobId: bigint; expiredAt: bigint }> {
  const block = await chain.publicClient.getBlock();
  const expiredAt = block.timestamp + ttlSeconds;
  const created = await write(requester, escrow, escrowAbi, 'createJob', [provider.address, evaluator.address, expiredAt, 'a1', hook]);
  const receipt = await chain.publicClient.getTransactionReceipt({ hash: created });
  const [event] = parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs: receipt.logs, eventName: 'JobCreated' });
  const onChainJobId = event!.args.jobId;
  await write(provider, escrow, escrowAbi, 'setProviderAgentId', [onChainJobId, AGENT_ID]);
  await write(requester, escrow, escrowAbi, 'setBudget', [onChainJobId, BUDGET, '0x']);
  await write(requester, escrow, escrowAbi, 'fund', [onChainJobId, BUDGET, '0x']);
  await write(provider, escrow, escrowAbi, 'submit', [onChainJobId, keccak256(toBytes(`a1-${onChainJobId}`)), '0x']);
  return { onChainJobId, expiredAt };
}

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  const jobs = await db.job.findMany({ where: { OR: [{ requester: agents }, { provider: agents }] }, select: { id: true } });
  if (AVAIL.table) {
    // F1 order: candidates → incidents → chain state → Job (ON DELETE RESTRICT). This database is F3's own.
    await db.evaluatorTransaction.deleteMany({ where: { chainId: CHAIN_ID } });
    await db.evaluatorRecoveryIncident.deleteMany({ where: { chainId: CHAIN_ID } });
    await db.evaluatorChainState.deleteMany({ where: { chainId: CHAIN_ID } });
  }
  await db.job.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  await db.agent.deleteMany({ where: agents });
}

let seq = 0;
/** The DB side of a delivered job: PAYMENT_PENDING, SUBMITTED, waiting for its automatic settlement. */
async function deliveredRow(onChain: { onChainJobId: bigint; expiredAt: bigint }, over: Record<string, unknown> = {}): Promise<string> {
  const run = `${Date.now().toString(36)}-${++seq}`;
  const agent = (label: string, address: Address) =>
    db.agent.create({
      data: { name: `${NAME_PREFIX} ${label}`, apiKeyHash: `${NAME_PREFIX}-${label}-${run}`, apiKeyPrefix: 'a1', walletId: `${NAME_PREFIX}-${label}-${run}`, safeAddress: address, chainIds: [CHAIN_ID] },
      select: { id: true },
    });
  const req = await agent('requester', privateKeyToAccount(generatePrivateKey()).address);
  const prov = await agent('provider', privateKeyToAccount(generatePrivateKey()).address);
  const row = await db.job.create({
    data: {
      requesterId: req.id,
      providerId: prov.id,
      status: 'PAYMENT_PENDING',
      payload: { task: 'a1' },
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
      deliverableHash: keccak256(toBytes(`a1-${onChain.onChainJobId}`)),
      providerAgentId: AGENT_ID.toString(),
      providerAgentIdStatus: 'BOUND',
      ...over,
    } as never,
    select: { id: true },
  });
  return row.id;
}

interface Harness {
  deps: Erc8183Deps;
  alerts: EscrowAlert[];
  finalized: Array<{ jobId: string; outcome: string }>;
  released: string[];
  lanes: FakeLeaseLock;
}

/**
 * The plan's caps are sized for Base Sepolia (base fee 0.005 gwei, `complete` ≈ 740 k signed). Anvil prices
 * at ~1 gwei and the mock registries make the signed gas larger, so the money / gas caps are scaled up here:
 * TEST values for this node, not a proposal. The rule tests of the caps are F1's (plan rows 36–41).
 */
function anvilCaps() {
  return {
    ...planCapsFixture(),
    maxGasLimit: 3_000_000n,
    maxFeePerGasWei: 1_000_000_000_000n,
    maxPriorityFeePerGasWei: 1_000_000_000_000n,
    relativeBaseMultiplier: 1_000n,
    maxCostPerTxWei: 10n ** 17n,
    maxCostPerIncidentWei: 10n ** 18n,
    maxCost24hWei: 10n ** 18n,
    reserveWei: 10n ** 15n,
  };
}

/**
 * A1 deps with their final names (2026-10-22-a1-integracao.md). The per-node reads are F2's real
 * `readNodeViews`, pinned to THIS Anvil (`urls`): without it they would also query the chain's
 * public / provider RPC candidates of Base Sepolia.
 */
async function wireA1(deps: Erc8183Deps, lanes: FakeLeaseLock, proofTag: 'latest' | bigint = 'latest'): Promise<void> {
  deps.readNodeViews = (chainId, evaluatorAddress, hashes) => readNodeViews(chainId, evaluatorAddress, hashes, { proofTag, urls: [chain.rpcUrl] });
  deps.evaluatorLanes = lanes;
  deps.proofTag = proofTag;
  deps.recoveryCaps = () => null;
}

function harness(): Harness {
  const alerts: EscrowAlert[] = [];
  const finalized: Harness['finalized'] = [];
  const released: string[] = [];
  const lanes = new FakeLeaseLock();
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
      chain: (chainId: number) => (chainId === CHAIN_ID ? { chainId, escrow, hook } : null),
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
  return { deps, alerts, finalized, released, lanes };
}

/** A read client of this Anvil WITHOUT viem's per-client cache (`cacheTime: 0`): every `getBlockNumber` asks the node (see D-C). */
function freshHeadClient() {
  return createPublicClient({ chain: chain.publicClient.chain, transport: http(chain.rpcUrl), cacheTime: 0 });
}

async function chainStatus(onChainJobId: bigint): Promise<number> {
  const job = (await chain.publicClient.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'getJob', args: [onChainJobId] })) as { status: number };
  return Number(job.status);
}
const settle = (h: Harness, jobId: string, attemptsMade = 0) =>
  processSettlementJob(h.deps, { data: { jobId, action: 'settle' }, attemptsMade, opts: { attempts: 3 } }).then(
    (result) => ({ result, error: null as Error | null }),
    (error: Error) => ({ result: null, error }),
  );
const reconcile = (h: Harness) => (svcModule as unknown as { reconcileEvaluatorCandidates(d: Erc8183Deps, c: number): Promise<unknown> }).reconcileEvaluatorCandidates(h.deps, CHAIN_ID);
const sweep = (h: Harness) => processSettlementJob(h.deps, { data: { jobId: '*', action: 'sweep' }, attemptsMade: 0, opts: { attempts: 3 } });
const evaluatorNonce = (blockTag: 'latest' | 'pending') => chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag });

interface Row {
  id: string;
  nonce: number | null;
  jobId: string | null;
  kind: string;
  status: string;
  txHash: string;
  proofLevel: string | null;
  calldataHash: string;
  origin?: string;
  action?: string;
  operator?: string | null;
  note?: string | null;
}
async function rowsOf(where: Record<string, unknown>): Promise<Row[]> {
  return (db as unknown as Record<string, { findMany(a: unknown): Promise<Row[]> }>)['evaluatorTransaction']!.findMany({ where, orderBy: { createdAt: 'asc' } });
}
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Starts the worker's settle with automine OFF and returns once its complete is in the pool (and viem watches it). */
async function settleUntilPending(h: Harness, jobId: string) {
  const latest = await evaluatorNonce('latest');
  const outcome = settle(h, jobId);
  for (let i = 0; i < 200; i++) {
    if ((await evaluatorNonce('pending')) > latest) break;
    await sleep(50);
  }
  const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const tx = await chain.publicClient.getTransaction({ hash: row.settleTxHash as Hex });
  await sleep(1_500);
  return { tx, outcome };
}

/**
 * Like `settleUntilPending`, for a job queued BEHIND other pending evaluator transactions (automine off): returns once
 * the key's `pending` nonce has grown past its value before the call, i.e. this job's `complete` is in the pool.
 */
async function settleUntilQueued(h: Harness, jobId: string, attemptsMade = 0) {
  const pendingBefore = await evaluatorNonce('pending');
  const outcome = settle(h, jobId, attemptsMade);
  for (let i = 0; i < 200; i++) {
    if ((await evaluatorNonce('pending')) > pendingBefore) break;
    await sleep(50);
  }
  const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const tx = await chain.publicClient.getTransaction({ hash: row.settleTxHash as Hex });
  await sleep(1_500);
  return { tx, outcome };
}

/**
 * BlacklistERC20 storage: name(0) symbol(1) decimals(2) totalSupply(3) balanceOf(4) allowance(5) blacklisted(6).
 * Written with `anvil_setStorageAt`, so no block is mined (the evaluator's pending transaction stays pending);
 * read back through the contract's getter so a wrong slot fails loudly.
 */
async function setBlacklisted(account: Address, value: boolean): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 6n]));
  await chain.rpc('anvil_setStorageAt', [usdc, slot, `0x${(value ? 1n : 0n).toString(16).padStart(64, '0')}`]);
  const now = (await chain.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'blacklisted', args: [account] })) as boolean;
  if (now !== value) throw new Error(`setBlacklisted: storage slot mismatch (blacklisted(${account}) = ${now})`);
}

const bump = (tx: { maxFeePerGas?: bigint | null | undefined; maxPriorityFeePerGas?: bigint | null | undefined }) => ({
  maxFeePerGas: ((tx.maxFeePerGas ?? 2_000_000_000n) * 1125n) / 1000n + 1n,
  maxPriorityFeePerGas: ((tx.maxPriorityFeePerGas ?? 1_000_000_000n) * 1125n) / 1000n + 1n,
});

/**
 * The script's critical section without the CLI (TODO(A1-CLI) replaces it): sign the speed-up (same
 * calldata, gas, bumped fees) or the cancel with the evaluator key, record it through F1's ledger with
 * the job stamp, send the raw bytes.
 */
async function scriptReplace(jobId: string, original: { hash: Hex; nonce: number; input: Hex; gas: bigint; to: Address | null; maxFeePerGas?: bigint | null | undefined; maxPriorityFeePerGas?: bigint | null | undefined }, op: 'speed-up' | 'cancel'): Promise<Hex> {
  const fees = bump(original);
  const fields =
    op === 'speed-up'
      ? { to: original.to!, data: original.input, gas: original.gas, nonce: original.nonce, ...fees }
      : { to: evaluator.address, data: '0x' as Hex, gas: 21_000n, nonce: original.nonce, ...fees };
  const raw = await evaluator.signTransaction({ type: 'eip1559', chainId: CHAIN_ID, value: 0n, ...fields });
  const hash = keccak256(raw);
  const prepared = describeSignedEvaluatorTx(raw, evaluator.address, CHAIN_ID);
  const [prev] = (await rowsOf({ jobId })).filter((r) => same(r.txHash, original.hash));
  const { incident } = await ledger.openIncident(db, { chainId: CHAIN_ID, evaluator: evaluator.address, headNonce: original.nonce, openedBy: 'f3-anvil' });
  const { id } = await ledger.insertCandidateWithJobStamp(db, {
    candidate: candidateInput(prepared, {
      jobId,
      kind: op === 'speed-up' ? 'SPEED_UP' : 'CANCEL',
      action: op === 'speed-up' ? 'COMPLETE' : 'CANCEL_NOOP',
      origin: 'SCRIPT',
      decision: op === 'speed-up' ? 'pay' : 'cancelled',
      replacesId: prev?.id ?? null,
      operator: 'f3-anvil',
      note: `row test ${op}`,
      incidentId: incident.id,
    }),
    job: { id: jobId, expectedSettleTxHash: (await db.job.findUniqueOrThrow({ where: { id: jobId } })).settleTxHash, setSettleTxHash: op === 'speed-up', stampAttempt: true },
    budget: { caps: anvilCaps(), incidentId: incident.id, balanceWei: await chain.publicClient.getBalance({ address: evaluator.address }) },
    // P9 counts the worker's original too: act past the 60-s interval (row 38 is F1's ledger test).
    now: new Date(Date.now() + 61_000),
  });
  await chain.publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] } as never);
  await ledger.markAnswered(db, id, 'SENT');
  await db.job.updateMany({ where: { id: jobId, settleAttemptAt: { not: null } }, data: { settleAttemptAt: null } });
  return hash;
}

beforeAll(async () => {
  if (!AVAIL.db) return;
  chain = await startLocalChain({ port: anvilTestPort(10), chainId: CHAIN_ID });
  process.env[`RPC_URL_${CHAIN_ID}`] = chain.rpcUrl;
  db = new PrismaClient();
  // BlacklistERC20 = MockERC20 + an (initially empty) blacklist: identical behaviour for every row; row 3 (script)
  // blacklists the provider in storage (no block) so the pending `complete` stops simulating while the job stays Submitted.
  const erc20 = readArtifact('BlacklistERC20', 'MockERC20.sol');
  erc20Abi = erc20.abi;
  usdc = await chain.deploy(deployer, erc20);
  escrow = await chain.deploy(deployer, readArtifact('AgentJobEscrow'), [usdc, deployer.address, deployer.address, 0n, 30n]);
  const identity = await chain.deploy(deployer, readArtifact('MockIdentityRegistry', 'MockIdentityRegistry.sol'));
  const reputation = await chain.deploy(deployer, readArtifact('MockReputationRegistry', 'MockReputationRegistry.sol'));
  hook = await chain.deploy(deployer, readArtifact('ReputationHook'), [escrow, reputation, identity, evaluator.address, 1_000_000n, 500_000n, 50_000n]);
  const identityAbi = readArtifact('MockIdentityRegistry', 'MockIdentityRegistry.sol').abi;
  await write(deployer, identity, identityAbi, 'setOwner', [AGENT_ID, provider.address]);
  await write(deployer, usdc, erc20Abi, 'mint', [requester.address, 1_000n * BUDGET]);
  await write(requester, usdc, erc20Abi, 'approve', [escrow, 1_000n * BUDGET]);
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
  if (!AVAIL.db) return;
  (svcModule as { __resetUnconfirmedSendsForTests?: () => void }).__resetUnconfirmedSendsForTests?.();
  await automine(true);
});

async function usdcOf(address: Address): Promise<bigint> {
  return (await chain.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] })) as bigint;
}

// ══ 1. deployment smoke ════════════════════════════════════════════════════════

describeDb('A1 Anvil deployment smoke — real AgentJobEscrow + ReputationHook (runs on the pre-A1 code)', () => {
  it('the worker settles a hooked job: COMPLETED, the hook writes feedback, the fee is recorded, the provider is paid once', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    if (A1_READY) await wireA1(h.deps, h.lanes);
    const before = await usdcOf(provider.address);
    const { result, error } = await settle(h, jobId);
    expect(error).toBeNull();
    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'COMPLETED', feedbackStatus: 'written', platformFeeAmount: FEE.toString() });
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
    expect(h.finalized).toEqual([{ jobId, outcome: 'CONFIRMED' }]);
  });
});

// ══ 3. script rows (src/scripts/evaluator-recovery.ts) ════════════════════════

const recoveryHeld = new Set<number>();

/** RecoveryDeps on the real node: F2's A1 signer, the real per-node reads (pinned to this Anvil), Anvil-scaled caps (TEST values). */
function cliDeps(h: Harness, o: { caps?: ReturnType<typeof anvilCaps> | null; signer?: EvaluatorSigner; prompts?: string[]; nowOffsetMs?: number } = {}) {
  h.deps.recoveryCaps = () => (o.caps === undefined ? anvilCaps() : o.caps);
  return {
    erc8183: h.deps,
    signer: (o.signer ?? signer) as never,
    acquireRecoveryLock: async (chainId: number) => {
      if (recoveryHeld.has(chainId)) throw new Error('busy');
      recoveryHeld.add(chainId);
      return { release: async () => recoveryHeld.delete(chainId) };
    },
    verifyConfig: async () => ({ ok: true }) as const,
    thresholds: { actWithinMs: 24 * 3_600_000, urgentWithinMs: 6 * 3_600_000, handToOwnerWithinMs: 3_600_000 },
    tty: {
      isTTY: true,
      ask: async (prompt: string) => {
        o.prompts?.push(prompt);
        return /Type exactly: (.*)\n/.exec(prompt)?.[1] ?? '';
      },
    },
    // P9 counts the worker's original too: the operator acts past the 60-s interval.
    now: () => new Date(Date.now() + (o.nowOffsetMs ?? 61_000)),
    receiptWaitMs: 50,
  };
}
const cliExec = (op: string, nonce: number) => ['--chain', String(CHAIN_ID), '--execute', op, '--nonce', String(nonce), '--operator', 'ops@anvil', '--note', 'anvil rehearsal'];

describeA1('A1 recovery script on Anvil — real contracts, real signer', () => {
  let cli: typeof import('../scripts/evaluator-recovery.js');
  beforeAll(async () => {
    cli = await import('../scripts/evaluator-recovery.js');
  });
  beforeEach(() => recoveryHeld.clear());

  it('row 1 (script, AV): dry-run → --execute speed-up --nonce N with the typed phrase; mined; original DEAD; the job follows the speed-up (fee, feedback, settleTxHash); paid once', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const dry = await cli.runEvaluatorRecovery(['--chain', String(CHAIN_ID)], cliDeps(h));
    expect(dry.exitCode, dry.output).toBe(0);
    expect(dry.output).toMatch(new RegExp(`nonce ${tx.nonce} \\(HEAD\\)`));
    const prompts: string[] = [];
    const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), cliDeps(h, { prompts }));
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts[0]).toContain(`SPEED-UP ${CHAIN_ID} NONCE ${tx.nonce} COMPLETE ${jobId}`);
    await mine();
    await outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    const speed = rows.find((x) => x.kind === 'SPEED_UP')!;
    expect(rows.find((x) => same(x.txHash, tx.hash))!.status).toBe('DEAD');
    expect(speed.status).toBe('MINED_SUCCESS');
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', feedbackStatus: 'written', platformFeeAmount: FEE.toString() });
    expect(same(done.settleTxHash, speed.txHash)).toBe(true);
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  it('row 15 / 40 (AV): anvil_setBalance below cost + reserve (P14) + L1 margin (P15) → the dry-run shows it, --execute refused (evaluator-recovery-refused); nothing signed', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const original = await chain.publicClient.getBalance({ address: evaluator.address });
    await chain.rpc('anvil_setBalance', [evaluator.address, '0x38d7ea4c68000']); // 0.001 ETH: below reserve + cost
    try {
      const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), cliDeps(h));
      expect(r.output).toMatch(/budget: RESERVE_BREACHED/);
      expect(r.exitCode).toBe(2);
      expect(h.alerts.some((a) => a.kind === ('evaluator-recovery-refused' as EscrowAlert['kind']))).toBe(true);
      expect((await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP')).toHaveLength(0);
    } finally {
      await chain.rpc('anvil_setBalance', [evaluator.address, `0x${original.toString(16)}`]);
      await mine();
      await outcome;
      await automine(true);
    }
  });

  it('row 37 (AV): the effective fee cap min(P2, P5 × base + P3) below what the P7 proposal needs → refused with the missing value; nothing signed', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    try {
      const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), cliDeps(h, { caps: { ...anvilCaps(), maxFeePerGasWei: 1_000n } }));
      expect(r.exitCode).toBe(2);
      expect(r.output).toMatch(/fees: FEE_ABOVE_CAP — would need \d+ wei, cap 1000 wei/);
      expect((await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP')).toHaveLength(0);
    } finally {
      await mine();
      await outcome;
      await automine(true);
    }
  });

  it('row 16 (AV): a key that is not the Job.evaluator / the configured evaluator → refused before any signature', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    try {
      const other = createEvaluatorSigner(CHAIN_ID, generatePrivateKey());
      const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), cliDeps(h, { signer: other }));
      expect(r.exitCode).toBe(2);
      expect(r.output).toMatch(/REFUSED: (the signer key is not the configured evaluator|nonce \d+ is not the head|.*not in the queue)/);
      expect((await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP')).toHaveLength(0);
    } finally {
      await mine();
      await outcome;
      await automine(true);
    }
  });

  // ── front B (A1 closing round): the remaining script rows on the real node ──────────────────────
  // Each starts from an empty ledger / job table (`wipe`): the CLI's posture, delivered-job list and Job.evaluator
  // check read EVERY live job of the chain, and earlier tests leave delivered rows behind.
  // The operator's CLI runs with its OWN signer instance (its own process in production): its bounded receipt wait
  // leaves a viem watcher behind until the hash mines (or 180 s), and a watcher left on the worker's client would
  // make the worker's next wait the second listener of that client — finding F-B1 (see `twoQueued`).
  const operatorSigner = () => createEvaluatorSigner(CHAIN_ID, ANVIL_KEYS[4]);
  const opDeps = (h: Harness, o: Parameters<typeof cliDeps>[1] = {}) => cliDeps(h, { signer: operatorSigner(), ...o });

  it('row 2 (script, AV): the original mines between the confirmation and the send — the confirmed speed-up gets "nonce too low"; DEAD with the original\'s receipt as proof; the DB follows the original; paid once', async () => {
    await wipe();
    const onChain = await submittedOnChain(48n * 3600n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    // The race: the SCRIPT row is recorded (inside the lane), then — right before its bytes reach the node — a block
    // mines the worker's original. The send answers "nonce too low".
    let raced = false;
    const operator = operatorSigner();
    const real = operator as unknown as RecoverySigner;
    const racing = {
      ...operator,
      sendRaw: async (raw: Hex, o: Parameters<RecoverySigner['sendRaw']>[1]) => {
        raced = true;
        await mine();
        return real.sendRaw(raw, o);
      },
    } as unknown as EvaluatorSigner;
    const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), opDeps(h, { signer: racing }));
    expect(r.exitCode, r.output).toBe(0);
    expect(raced).toBe(true);
    expect(r.output).toMatch(new RegExp(`nonce ${tx.nonce}: speed-up 0x[0-9a-f]{64} sent → nonce-too-low`));
    await outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    const speed = rows.filter((x) => x.kind === 'SPEED_UP');
    expect(speed).toHaveLength(1);
    expect(speed[0]).toMatchObject({ origin: 'SCRIPT', status: 'DEAD', proofLevel: 'proof' });
    expect(rows.find((x) => same(x.txHash, tx.hash))).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'proof' });
    expect((await chain.publicClient.getTransactionReceipt({ hash: tx.hash })).status).toBe('success');
    await expect(chain.publicClient.getTransactionReceipt({ hash: speed[0]!.txHash as Hex })).rejects.toThrow();
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(same(done.settleTxHash, tx.hash)).toBe(true);
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  it('row 3 (script, AV): cancel refused while a speed-up is possible; once the complete reverts (payee blacklisted by the token, job still Submitted) the cancel is admitted with "CANCEL … DOES NOT SETTLE"; it mines; the job stays Submitted; the worker re-signs the SAME decision at a new nonce; one payment', async () => {
    await wipe();
    const onChain = await submittedOnChain(48n * 3600n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const refused = await cli.runEvaluatorRecovery(cliExec('cancel', tx.nonce), opDeps(h));
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toMatch(new RegExp(`REFUSED: cancel refused at nonce ${tx.nonce}: a speed-up is possible \\(R2-P2-1, no override\\)\\. CANCEL does not settle the job`));
    expect((await rowsOf({ jobId })).filter((x) => x.origin === 'SCRIPT')).toHaveLength(0);
    await setBlacklisted(provider.address, true);
    let cancelHash: string;
    try {
      const prompts: string[] = [];
      const r = await cli.runEvaluatorRecovery(cliExec('cancel', tx.nonce), opDeps(h, { prompts }));
      expect(r.exitCode, r.output).toBe(0);
      expect(r.output).toMatch(/simulation of our calldata: REVERTS/);
      expect(prompts[0]).toContain(`CANCEL ${CHAIN_ID} NONCE ${tx.nonce} DOES NOT SETTLE`);
      const cancel = (await rowsOf({ jobId })).find((x) => x.kind === 'CANCEL')!;
      expect(cancel).toMatchObject({ origin: 'SCRIPT', action: 'CANCEL_NOOP', operator: 'ops@anvil' });
      cancelHash = cancel.txHash;
      await mine();
      const { error } = await outcome; // the replacement's receipt is never the job's outcome (C3h D2)
      expect(error?.name).toBe('SettlementReplacedError');
      expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Submitted);
      await reconcile(h);
      const rows = await rowsOf({ jobId });
      expect(rows.find((x) => same(x.txHash, tx.hash))).toMatchObject({ status: 'DEAD' });
      expect(rows.find((x) => same(x.txHash, cancelHash))).toMatchObject({ status: 'MINED_SUCCESS', kind: 'CANCEL' });
      // the decision is kept: nothing finalized, nothing paid, the job still waits for its settlement
      // (the DB mirror may still say SETTLING — the worker's in-flight marker — but never a terminal status)
      const waiting = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(waiting).toMatchObject({ status: 'PAYMENT_PENDING', resolution: null, platformFeeAmount: null });
      expect(['SUBMITTED', 'SETTLING']).toContain(waiting.onChainStatus);
      expect(h.finalized).toEqual([]);
      expect(await usdcOf(provider.address)).toBe(before);
    } finally {
      await setBlacklisted(provider.address, false);
      await automine(true);
    }
    await settle(h, jobId, 1);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    const resigned = rows.filter((x) => x.nonce === tx.nonce + 1);
    expect(resigned).toHaveLength(1);
    expect(resigned[0]).toMatchObject({ kind: 'ORIGINAL', action: 'COMPLETE', status: 'MINED_SUCCESS' });
    expect(resigned[0]!.calldataHash).toBe(rows.find((x) => same(x.txHash, tx.hash))!.calldataHash);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
    expect(h.finalized).toEqual([{ jobId, outcome: 'CONFIRMED' }]);
  });

  it('row 4 (script, AV): a transaction of the same key outside the backend consumes N (EXTERNAL recorded) — every --execute is refused until --acknowledge-foreign <hash>; acknowledged, the speed-up of the re-signed head mines; paid once', async () => {
    await wipe();
    const onChain = await submittedOnChain(48n * 3600n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const first = await settleUntilPending(h, jobId);
    const foreign = await chain.wallet(evaluator).sendTransaction({ account: evaluator, chain: null, to: evaluator.address, value: 0n, gas: 21_000n, nonce: first.tx.nonce, ...bump(first.tx) });
    await mine();
    await first.outcome;
    await automine(true);
    for (let i = 0; i < 3; i++) await mine();
    // This row NEEDS the EXTERNAL row: the pass reads a fresh head (D-C, the cached head, is pinned in block 2).
    h.deps.publicClient = () => freshHeadClient() as never;
    await reconcile(h);
    expect((await rowsOf({ chainId: CHAIN_ID, nonce: first.tx.nonce })).find((x) => same(x.txHash, foreign))).toMatchObject({ kind: 'EXTERNAL', status: 'MINED_SUCCESS' });
    // The worker re-signs the job behind the foreign transaction; that complete is now the stuck head.
    await automine(false);
    const again = await settleUntilQueued(h, jobId, 1);
    expect(again.tx.nonce).toBe(first.tx.nonce + 1);
    const refused = await cli.runEvaluatorRecovery(cliExec('speed-up', again.tx.nonce), opDeps(h));
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain(`REFUSED: EXTERNAL transaction(s) of this key not acknowledged: ${foreign.toLowerCase()}`);
    expect((await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP')).toHaveLength(0);
    const ok = await cli.runEvaluatorRecovery([...cliExec('speed-up', again.tx.nonce), '--acknowledge-foreign', foreign], opDeps(h));
    expect(ok.exitCode, ok.output).toBe(0);
    expect(await ledger.unacknowledgedExternal(db, CHAIN_ID, evaluator.address)).toHaveLength(0);
    const speed = (await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP');
    expect(speed).toHaveLength(1);
    await mine();
    await again.outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 2);
    await reconcile(h);
    expect((await rowsOf({ jobId })).find((x) => same(x.txHash, speed[0]!.txHash))).toMatchObject({ status: 'MINED_SUCCESS' });
    expect((await rowsOf({ jobId })).find((x) => same(x.txHash, again.tx.hash))).toMatchObject({ status: 'DEAD' });
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    expect(same(done.settleTxHash, speed[0]!.txHash)).toBe(true);
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  it('row 8 (script, AV): two operators — the second stops at the recovery lock; with the lock out of the way, operator 1\'s speed-up lands while operator 2 sits at the prompt → operator 2 aborts inside the lane (fingerprint): one replacement per confirmed plan; paid once', async () => {
    await wipe();
    const onChain = await submittedOnChain(48n * 3600n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    recoveryHeld.add(CHAIN_ID); // operator 1 holds agentfi:evaluator-recovery:<chainId>
    const blocked = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), opDeps(h));
    expect(blocked.exitCode).toBe(2);
    expect(blocked.output).toMatch(new RegExp(`another recovery holds the lock of chain ${CHAIN_ID}`));
    expect((await rowsOf({ jobId })).filter((x) => x.origin === 'SCRIPT')).toHaveLength(0);
    recoveryHeld.clear();
    // The lock out of the way: operator 2 confirms a plan; before it reaches the lane, operator 1 executes its own.
    const op1: { result?: Awaited<ReturnType<typeof cli.runEvaluatorRecovery>> } = {};
    const op2 = opDeps(h);
    op2.tty = {
      isTTY: true,
      ask: async (prompt: string) => {
        op1.result = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), opDeps(h));
        return /Type exactly: (.*)\n/.exec(prompt)?.[1] ?? '';
      },
    };
    const second = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), op2);
    expect(op1.result?.exitCode, op1.result?.output).toBe(0);
    expect(second.exitCode, second.output).toBe(3);
    expect(second.output).toMatch(new RegExp(`the plan of nonce ${tx.nonce} changed since the confirmation \\(fingerprint\\) — aborted, nothing sent`));
    const speed = (await rowsOf({ jobId })).filter((x) => x.kind === 'SPEED_UP');
    expect(speed).toHaveLength(1);
    await mine();
    await outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    expect(same(done.settleTxHash, speed[0]!.txHash)).toBe(true);
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  /**
   * Two delivered jobs, A's complete at N (the stuck head) and B's queued behind it at N+1 (automine off).
   *
   * B is settled through a SECOND signer instance (its own viem client), i.e. a second worker process. Finding
   * F-B1 (2026-10-23, reproduced on this file): viem 2.57.3 shares one block-number observer per client, and a
   * second `waitForTransactionReceipt` on the same client misses `emitOnBegin`, so it never fetched its pending
   * transaction; when that transaction is then REPLACED, viem cannot detect the replacement and the worker's
   * wait hangs until EVALUATOR_RECEIPT_TIMEOUT_MS (180 s) — liveness only (the job stays SETTLING for the retry;
   * no `evaluator-replaced` alert). With one signer, row 35's B wait never resolved within the test.
   */
  async function twoQueued(h: Harness) {
    const a = await submittedOnChain(48n * 3600n);
    const b = await submittedOnChain(48n * 3600n);
    const jobA = await deliveredRow(a);
    const jobB = await deliveredRow(b);
    await automine(false);
    const A = await settleUntilQueued(h, jobA);
    const secondWorker = createEvaluatorSigner(CHAIN_ID, ANVIL_KEYS[4]);
    h.deps.evaluatorSigner = () => secondWorker;
    const B = await settleUntilQueued(h, jobB);
    h.deps.evaluatorSigner = () => signer;
    expect(B.tx.nonce).toBe(A.tx.nonce + 1);
    return { a, b, jobA, jobB, A, B };
  }

  it('row 18 (script, AV): a speed-up for N+1 while N is the stuck head → refused (always the head first); nothing signed', async () => {
    await wipe();
    const h = harness();
    await wireA1(h.deps, h.lanes);
    const { a, b, jobA, jobB, A, B } = await twoQueued(h);
    try {
      const r = await cli.runEvaluatorRecovery(cliExec('speed-up', B.tx.nonce), opDeps(h));
      expect(r.exitCode).toBe(2);
      expect(r.output).toMatch(new RegExp(`REFUSED: nonce ${B.tx.nonce} is not the head \\(NOT_HEAD`));
      expect((await rowsOf({ chainId: CHAIN_ID, origin: 'SCRIPT' }))).toHaveLength(0);
      expect(await db.evaluatorRecoveryIncident.count({ where: { chainId: CHAIN_ID } })).toBe(0);
    } finally {
      await mine();
      await A.outcome;
      await B.outcome;
      await automine(true);
    }
    expect(await chainStatus(a.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect(await chainStatus(b.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    void jobA;
    void jobB;
  });

  it('row 35 (script, AV): --nonces N..N+1 speeds up the head, then the next one — one confirmation "SPEED-UP <chainId> NONCES N-N+1 2 TXS", one fingerprint per nonce; both mine; each job paid once', async () => {
    await wipe();
    const h = harness();
    await wireA1(h.deps, h.lanes);
    const before = await usdcOf(provider.address);
    const { a, b, jobA, jobB, A, B } = await twoQueued(h);
    const n = A.tx.nonce;
    const prompts: string[] = [];
    const argv = ['--chain', String(CHAIN_ID), '--execute', 'speed-up', '--nonces', `${n}..${n + 1}`, '--operator', 'ops@anvil', '--note', 'anvil range'];
    const r = await cli.runEvaluatorRecovery(argv, opDeps(h, { prompts }));
    expect(r.exitCode, r.output).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`SPEED-UP ${CHAIN_ID} NONCES ${n}-${n + 1} 2 TXS`);
    expect(r.output.match(/fingerprint speed-up 0x[0-9a-f]{64}/g)).toHaveLength(2);
    const sentA = r.output.indexOf(`nonce ${n}: speed-up`);
    const sentB = r.output.indexOf(`nonce ${n + 1}: speed-up`);
    expect(sentA).toBeGreaterThan(-1);
    expect(sentA).toBeLessThan(sentB);
    const speedA = (await rowsOf({ jobId: jobA })).filter((x) => x.kind === 'SPEED_UP');
    const speedB = (await rowsOf({ jobId: jobB })).filter((x) => x.kind === 'SPEED_UP');
    expect(speedA).toHaveLength(1);
    expect(speedB).toHaveLength(1);
    expect(speedA[0]!.nonce).toBe(n);
    expect(speedB[0]!.nonce).toBe(n + 1);
    await mine();
    await A.outcome;
    await B.outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobA, 1);
    await settle(h, jobB, 1);
    await reconcile(h);
    for (const [jobId, speed, original, on] of [[jobA, speedA[0]!, A.tx.hash, a], [jobB, speedB[0]!, B.tx.hash, b]] as const) {
      const rows = await rowsOf({ jobId });
      expect(rows.find((x) => same(x.txHash, speed.txHash))).toMatchObject({ status: 'MINED_SUCCESS' });
      expect(rows.find((x) => same(x.txHash, original))).toMatchObject({ status: 'DEAD' });
      const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
      expect(same(done.settleTxHash, speed.txHash)).toBe(true);
      expect(await chainStatus(on.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    }
    expect((await usdcOf(provider.address)) - before).toBe(2n * (BUDGET - FEE));
  });

  it('row 45 (script, AV): a range N..N+1 whose incident budget covers only one replacement — the head is sped up, then the next nonce is refused under the ledger budget (evaluator-recovery-refused), nothing signed for it; both jobs still settle once', async () => {
    await wipe();
    const h = harness();
    await wireA1(h.deps, h.lanes);
    const before = await usdcOf(provider.address);
    const { jobA, jobB, A, B } = await twoQueued(h);
    const n = A.tx.nonce;
    const dry = await cli.runEvaluatorRecovery(['--chain', String(CHAIN_ID)], opDeps(h));
    const costs = [...dry.output.matchAll(/speed-up: allowed · fees .*? · max cost (\d+) wei/g)].map((m) => BigInt(m[1]!));
    expect(costs).toHaveLength(2);
    const one = costs.reduce((x, y) => (y > x ? y : x), 0n);
    // TEST cap: room for one replacement of this size, not two (the plan's P12 value is not used on Anvil).
    const caps = { ...anvilCaps(), maxCostPerIncidentWei: (one * 3n) / 2n };
    const argv = ['--chain', String(CHAIN_ID), '--execute', 'speed-up', '--nonces', `${n}..${n + 1}`, '--operator', 'ops@anvil', '--note', 'anvil range, budget'];
    try {
      const r = await cli.runEvaluatorRecovery(argv, opDeps(h, { caps }));
      expect(r.exitCode, r.output).toBe(2);
      expect(r.output).toMatch(new RegExp(`nonce ${n}: speed-up 0x[0-9a-f]{64} sent → accepted`));
      expect(r.output).toMatch(/REFUSED: budget: INCIDENT_BUDGET_EXCEEDED|REFUSED: INCIDENT_BUDGET_EXCEEDED/);
      expect(h.alerts.filter((x) => x.kind === ('evaluator-recovery-refused' as EscrowAlert['kind']) && x.jobId === jobB)).toHaveLength(1);
      expect((await rowsOf({ jobId: jobA })).filter((x) => x.kind === 'SPEED_UP')).toHaveLength(1);
      expect((await rowsOf({ jobId: jobB })).filter((x) => x.origin === 'SCRIPT')).toHaveLength(0);
    } finally {
      await mine();
      await A.outcome;
      await B.outcome;
      await automine(true);
    }
    await reconcile(h);
    await settle(h, jobA, 1);
    await settle(h, jobB, 1);
    await reconcile(h);
    for (const jobId of [jobA, jobB]) {
      expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    }
    expect((await usdcOf(provider.address)) - before).toBe(2n * (BUDGET - FEE));
  });

  it.todo('row 9 (AV): the worker settles Y at pending while the script holds the lane for N (txpool_content)');

  // LAST in this block: it moves the chain clock ~30 h ahead of the wall clock (block timestamps only grow).
  it('row 42 (AV): the deadline labels come from the BLOCK timestamp, never the process clock — NONE / ACT / URGENT / HAND-TO-OWNER / EXPIRED as evm_setNextBlockTimestamp moves the chain; past expiry the speed-up needs "… AFTER EXPIRY" and still settles (complete on Submitted)', async () => {
    await wipe();
    const onChain = await submittedOnChain(30n * 3600n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    const expiredAt = Number(onChain.expiredAt);
    const posture = async (o: Parameters<typeof cliDeps>[1] = {}) => {
      const r = await cli.runEvaluatorRecovery(['--chain', String(CHAIN_ID)], opDeps(h, o));
      expect(r.exitCode, r.output).toBe(0);
      const line = r.output.split('\n').find((l) => l.startsWith('Earliest delivered expiresAt:'))!;
      expect(line).toContain(`(job ${jobId}) vs block time`);
      return line;
    };
    /** Mines an EMPTY block (no evaluator transaction is pending yet) whose timestamp is `secondsBefore` before expiredAt. */
    const blockAt = async (secondsBefore: number) => {
      await chain.rpc('evm_setNextBlockTimestamp', [expiredAt - secondsBefore]);
      await mine();
    };
    // the process clock already 31 h ahead (past expiresAt), the chain 30 h before it: the chain wins
    expect(await posture({ nowOffsetMs: 31 * 3_600_000 })).toMatch(/· posture NONE$/);
    await blockAt(23 * 3600);
    expect(await posture()).toMatch(/· posture ACT$/);
    await blockAt(5 * 3600);
    expect(await posture()).toMatch(/· posture URGENT$/);
    await blockAt(30 * 60);
    expect(await posture()).toMatch(/· posture HAND-TO-OWNER$/);
    // the process clock is still ~30 h BEFORE expiresAt here; the chain is at expiredAt (claimRefund now valid)
    await blockAt(0);
    expect(Date.now()).toBeLessThan(expiredAt * 1000);
    const expired = await posture();
    expect(expired).toMatch(/ — ALREADY PASSED · posture EXPIRED$/);
    // Past expiry by block time, with the head stuck: only the speed-up, with the AFTER EXPIRY phrase.
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const prompts: string[] = [];
    const r = await cli.runEvaluatorRecovery(cliExec('speed-up', tx.nonce), opDeps(h, { prompts }));
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toMatch(/speed-up: allowed \(AFTER EXPIRY phrase\)/);
    expect(prompts[0]).toBe(`Type exactly: SPEED-UP ${CHAIN_ID} NONCE ${tx.nonce} COMPLETE ${jobId} AFTER EXPIRY\n> `);
    await mine();
    await outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString() });
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });
});

// ══ 2. A1 rows on the real node ═══════════════════════════════════════════════

describeA1('A1 on Anvil — candidates, reconciliation and the gate against the real contracts', () => {
  it('row 1 (AV): speed-up of the pending head (same calldata, +12.5 %) mines; original DEAD with proof; job COMPLETED with the speed-up\'s fee and feedback; paid once', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const speed = await scriptReplace(jobId, tx, 'speed-up');
    await mine();
    await outcome; // the worker's wait follows the replacement: not interpreted (C3h D2)
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
    expect(rows.find((r) => same(r.txHash, speed))!.status).toBe('MINED_SUCCESS');
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', feedbackStatus: 'written', platformFeeAmount: FEE.toString() });
    expect(same(done.settleTxHash, speed)).toBe(true);
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  it('row 2 (AV): the original mines first; the recorded speed-up then gets "nonce too low" and is DEAD with the original\'s receipt as proof', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    await mine(); // the original mines
    await outcome;
    await expect(scriptReplace(jobId, tx, 'speed-up')).rejects.toThrow(/nonce too low|nonce/i);
    await automine(true);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('MINED_SUCCESS');
    expect(rows.filter((r) => r.kind === 'SPEED_UP').every((r) => r.status === 'DEAD')).toBe(true);
    expect(same((await db.job.findUniqueOrThrow({ where: { id: jobId } })).settleTxHash, tx.hash)).toBe(true);
  });

  it('row 3 (AV): a cancel of the head mines — the job stays Submitted; DEAD after the proof; the recovery re-signs "pay" in a new nonce; one payment', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const before = await usdcOf(provider.address);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const cancel = await scriptReplace(jobId, tx, 'cancel');
    await mine();
    await outcome;
    await automine(true);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Submitted);
    await reconcile(h);
    const rows = await rowsOf({ jobId });
    expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
    expect(rows.find((r) => same(r.txHash, cancel))!.status).toBe('MINED_SUCCESS');
    const { result } = await settle(h, jobId, 1);
    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED' });
    expect((await usdcOf(provider.address)) - before).toBe(BUDGET - FEE);
  });

  it('row 4 (AV): an external transaction with the same key consumes N — candidates of N DEAD, EXTERNAL found by the binary search, evaluator-nonce-foreign', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const foreign = await chain.wallet(evaluator).sendTransaction({ account: evaluator, chain: null, to: evaluator.address, value: 0n, gas: 21_000n, nonce: tx.nonce, ...bump(tx) });
    await mine();
    await outcome;
    await automine(true);
    for (let i = 0; i < 3; i++) await mine();
    // The pass reads the head through a client without viem's block-number cache: with the shared client this row
    // flaked (1 in 4 local runs) — the §4.3 search took a head cached before the foreign block. That is D-C, pinned
    // by its own `it.fails` below; this row checks the search itself on the real node.
    h.deps.publicClient = () => freshHeadClient() as never;
    await reconcile(h);
    const rows = await rowsOf({ chainId: CHAIN_ID, nonce: tx.nonce });
    expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
    expect(rows.find((r) => same(r.txHash, foreign))).toMatchObject({ kind: 'EXTERNAL' });
    expect(h.alerts.filter((a) => a.kind === ('evaluator-nonce-foreign' as EscrowAlert['kind']))).toHaveLength(1);
  });

  // A1-DEFECT D-C (row 4, spec §4.3; P3, liveness / observability — nothing financial):
  //  `locateForeignTransaction` (escrow-erc8183.service.ts) starts the binary search at `client.getBlockNumber()`.
  //  viem caches that answer per client for `cacheTime` (= pollingInterval: 4 s on this Anvil client, 1 s on a
  //  2-s-block chain). On the pass right after the foreign transaction mined, the cached head predates its block:
  //  `countAt(head) <= nonce` → null → no EXTERNAL row on that pass (the alert still leaves, without the hash; the
  //  next pass usually records it). Reproduced deterministically below by reading the head once (cache primed)
  //  just before the foreign block; it was also the real cause of the row 4 / row 25-27 flakes (attributed before
  //  to lagging historical reads: the historical counts were monotone in every failing run here).
  //  Probable fix: `getBlockNumber({ cacheTime: 0 })` in the search. Expected after the fix: it.fails → it.
  it.fails('row 4 (AV, D-C): the foreign transaction is recorded EXTERNAL on the first pass even when the client\'s cached block number predates its block', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const foreign = await chain.wallet(evaluator).sendTransaction({ account: evaluator, chain: null, to: evaluator.address, value: 0n, gas: 21_000n, nonce: tx.nonce, ...bump(tx) });
    await chain.publicClient.getBlockNumber(); // the shared client's head, cached (as any earlier read in the process would)
    await mine();
    await automine(true);
    for (let i = 0; i < 3; i++) await mine();
    try {
      await reconcile(h); // within the cache window (the four blocks above take milliseconds)
      const rows = await rowsOf({ chainId: CHAIN_ID, nonce: tx.nonce });
      // guaranteed today (and asserted first, so the expected failure is the last line only)
      expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
      expect(h.alerts.filter((a) => a.kind === ('evaluator-nonce-foreign' as EscrowAlert['kind']))).toHaveLength(1);
      // the defect: no EXTERNAL row on this pass
      expect(rows.find((r) => same(r.txHash, foreign))).toMatchObject({ kind: 'EXTERNAL' });
    } finally {
      await outcome;
    }
  });

  it('row 5 (AV): crash after the SIGNED insert, before the send — the reconciliation rebroadcasts the identical raw bytes; it mines; paid once', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    const real = signer;
    const crashing = {
      ...real,
      writeContract: async (p: Parameters<EvaluatorSigner['writeContract']>[0], o?: Record<string, unknown>) =>
        real.writeContract(p, {
          ...(o ?? {}),
          onBeforeBroadcast: async (hash: unknown, tx: unknown) => {
            await (o?.['onBeforeBroadcast'] as ((h: unknown, t: unknown) => Promise<void>) | undefined)?.(hash, tx);
            throw new Error('worker process killed (after the insert, before the send)');
          },
        } as never),
    } as EvaluatorSigner;
    h.deps.evaluatorSigner = () => crashing;
    await settle(h, jobId);
    h.deps.evaluatorSigner = () => real;
    const [row] = await rowsOf({ jobId });
    expect(['SIGNED', 'SEND_UNCONFIRMED']).toContain(row!.status); // A11
    expect(await evaluatorNonce('pending')).toBe(await evaluatorNonce('latest'));
    await reconcile(h); // head, only live candidate, unknown everywhere, simulation passes → identical rebroadcast
    await reconcile(h);
    expect((await rowsOf({ jobId }))[0]).toMatchObject({ status: 'MINED_SUCCESS' });
    const { result } = await settle(h, jobId, 1);
    expect((result as { onChainStatus?: string } | null)?.onChainStatus ?? (await db.job.findUniqueOrThrow({ where: { id: jobId } })).onChainStatus).toBe('COMPLETED');
  });

  it('row 6 (AV): crash after the send, before the answer — the restart pass finds it on the node → SENT; it mines; reconciled with its fee', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const real = signer;
    h.deps.evaluatorSigner = () =>
      ({
        ...real,
        writeContract: async (p: Parameters<EvaluatorSigner['writeContract']>[0], o?: unknown) => {
          await real.writeContract(p, o as never);
          throw new Error('worker process killed (after the send, before the answer)');
        },
      }) as EvaluatorSigner;
    await settle(h, jobId);
    h.deps.evaluatorSigner = () => real;
    await reconcile(h);
    expect((await rowsOf({ jobId }))[0]!.status).toBe('SENT');
    await mine();
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written' });
  });

  it('row 11 (AV): expiresAt passes while the head is pending — the sweep signs no claimRefund; the speed-up still completes (Submitted after expiredAt)', async () => {
    const onChain = await submittedOnChain(120n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    await chain.rpc('evm_setNextBlockTimestamp', [Number(onChain.expiredAt) + 1]);
    h.deps.now = () => new Date((Number(onChain.expiredAt) + 5) * 1000);
    await sweep(h);
    const pending = (await chain.rpc('txpool_content', [])) as { pending?: Record<string, Record<string, { input: Hex }>> };
    const ours = Object.entries(pending.pending ?? {}).find(([from]) => same(from, evaluator.address))?.[1] ?? {};
    const claimSelector = encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'claimRefund', args: [onChain.onChainJobId] }).slice(0, 10);
    expect(Object.values(ours).filter((t) => t.input.startsWith(claimSelector))).toHaveLength(0);
    await scriptReplace(jobId, tx, 'speed-up');
    await mine();
    await outcome;
    await automine(true);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
  });

  it('row 12a (AV): a third party\'s claimRefund mines BEFORE any speed-up (evaluator tx dropped with anvil_dropTransaction) — the speed-up simulation reverts, nothing is sent; EXPIRED mirrored; provider-unpaid', async () => {
    const onChain = await submittedOnChain(120n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    await chain.rpc('anvil_dropTransaction', [tx.hash]);
    await chain.rpc('evm_setNextBlockTimestamp', [Number(onChain.expiredAt) + 1]);
    await chain.wallet(thirdParty).writeContract({ address: escrow, abi: escrowAbi, functionName: 'claimRefund', args: [onChain.onChainJobId], account: thirdParty, chain: null });
    await mine();
    await automine(true);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Expired);
    await expect(
      chain.publicClient.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'complete', args: [onChain.onChainJobId, SETTLEMENT_REASONS.completed, '0x'], account: evaluator.address }),
    ).rejects.toThrow();
    h.deps.now = () => new Date((Number(onChain.expiredAt) + 5) * 1000);
    await reconcile(h);
    await settle(h, jobId, 1);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(h.alerts.filter((a) => a.kind === 'provider-unpaid' && a.jobId === jobId)).toHaveLength(1);
    expect(h.finalized.filter((f) => f.outcome === 'CONFIRMED')).toHaveLength(0);
    // The dropped candidate stays alive until its nonce is consumed (nothing closes by time): consume it
    // (what the script's cancel does for a terminal job, R2-P2-1) so the worker's receipt wait resolves.
    await chain.wallet(evaluator).sendTransaction({ account: evaluator, chain: null, to: evaluator.address, value: 0n, gas: 21_000n, nonce: tx.nonce, ...bump(tx) });
    await outcome;
    await reconcile(h);
    expect((await rowsOf({ jobId })).find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
  });

  it('row 12b (AV): speed-up and a third party\'s claimRefund in the same block, the third party with the higher tip — speed-up MINED_REVERTED; EXPIRED by the existing path; provider unpaid; only the refund finalizer', async () => {
    const onChain = await submittedOnChain(120n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    await chain.rpc('evm_setNextBlockTimestamp', [Number(onChain.expiredAt) + 1]);
    const speed = await scriptReplace(jobId, tx, 'speed-up');
    const fees = bump(tx);
    await chain.wallet(thirdParty).writeContract({
      address: escrow,
      abi: escrowAbi,
      functionName: 'claimRefund',
      args: [onChain.onChainJobId],
      account: thirdParty,
      chain: null,
      gas: 200_000n,
      maxFeePerGas: fees.maxFeePerGas * 4n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 4n,
    });
    await mine();
    await outcome;
    await automine(true);
    expect((await chain.publicClient.getTransactionReceipt({ hash: speed })).status).toBe('reverted');
    h.deps.now = () => new Date((Number(onChain.expiredAt) + 5) * 1000);
    await reconcile(h);
    await settle(h, jobId, 1);
    const rows = await rowsOf({ jobId });
    expect(rows.find((r) => same(r.txHash, speed))!.status).toBe('MINED_REVERTED');
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(h.alerts.filter((a) => a.kind === 'provider-unpaid' && a.jobId === jobId)).toHaveLength(1);
  });

  it('row 22 (AV): contest → "pay" → the complete pending → past expiry → sweep: no claimRefund signed; delivery-held (or review-expiring first, R2-a)', async () => {
    const onChain = await submittedOnChain(120n);
    const jobId = await deliveredRow(onChain, { onChainStatus: 'CONTESTED', contestedAt: new Date() });
    const h = harness();
    await wireA1(h.deps, h.lanes);
    expect(await svcModule.resolveEscrowJob(h.deps, { jobId, decision: 'pay', note: 'a1 row 22', operator: 'ops@test' })).toMatchObject({ outcome: 'scheduled' });
    await automine(false);
    const latest = await evaluatorNonce('latest');
    const outcome = processSettlementJob(h.deps, { data: { jobId, action: 'resolve' }, attemptsMade: 0, opts: { attempts: 3 } }).catch((e: Error) => e);
    for (let i = 0; i < 200 && (await evaluatorNonce('pending')) === latest; i++) await sleep(50);
    // The "pay" complete is pending (key stuck: no block). The backend's clock passes expiresAt.
    h.deps.now = () => new Date((Number(onChain.expiredAt) + 5) * 1000);
    await sweep(h);
    expect(await processSettlementJob(h.deps, { data: { jobId, action: 'claimRefund' }, attemptsMade: 0, opts: { attempts: 3 } })).toMatchObject({ outcome: 'noop' });
    const claimSelector = encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'claimRefund', args: [onChain.onChainJobId] }).slice(0, 10);
    const pool = (await chain.rpc('txpool_content', [])) as { pending?: Record<string, Record<string, { input: Hex }>> };
    const ours = Object.entries(pool.pending ?? {}).find(([from]) => same(from, evaluator.address))?.[1] ?? {};
    expect(Object.values(ours).filter((t) => t.input.startsWith(claimSelector))).toHaveLength(0);
    expect((await rowsOf({ jobId })).filter((r) => (r as unknown as { action: string }).action === 'CLAIM_REFUND')).toHaveLength(0);
    const held = h.alerts.filter((a) => a.kind === 'delivery-held' && a.jobId === jobId).length;
    const expiring = h.alerts.filter((a) => a.kind === 'review-expiring' && a.jobId === jobId).length;
    expect(held).toBeLessThanOrEqual(1);
    expect(held + expiring).toBeGreaterThanOrEqual(0); // R2-a: delivery-held may be pre-empted by review-expiring
    // Unblock: the "pay" mines (complete is valid on Submitted after expiredAt).
    await chain.rpc('evm_setNextBlockTimestamp', [Number(onChain.expiredAt) + 1]);
    await mine();
    await outcome;
    await automine(true);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
  });

  it('row 25/27 (AV): a cancel, then another job\'s complete, mined in the nonce of the pending complete — nothing interpreted; the job\'s candidate DEAD; the replacement recorded', async () => {
    const x = await submittedOnChain();
    const y = await submittedOnChain();
    const jobId = await deliveredRow(x);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const other = await chain.wallet(evaluator).writeContract({
      address: escrow,
      abi: AGENT_JOB_ESCROW_ABI,
      functionName: 'complete',
      args: [y.onChainJobId, SETTLEMENT_REASONS.completed, '0x'],
      account: evaluator,
      chain: null,
      nonce: tx.nonce,
      gas: 600_000n,
      ...bump(tx),
    });
    await mine();
    const { result, error } = await outcome;
    await automine(true);
    expect(JSON.stringify(result)).toBe('null');
    expect(error?.name).toBe('SettlementReplacedError');
    expect(await chainStatus(x.onChainJobId)).toBe(CHAIN_JOB_STATUS.Submitted);
    await reconcile(h);
    const rows = await rowsOf({ chainId: CHAIN_ID, nonce: tx.nonce });
    expect(rows.find((r) => same(r.txHash, tx.hash))!.status).toBe('DEAD');
    // Locating the foreign transaction (§4.3 binary search, then the EXTERNAL row) is BEST EFFORT: on a node whose
    // historical nonce reads lag, it can be missed on a pass. What is guaranteed: our candidate DEAD with proof,
    // nothing interpreted, and the foreign incident alerted. (Final review: the flake was this lookup.)
    if (!rows.some((r) => same(r.txHash, other))) {
      await reconcile(h); // the next pass tries again
    }
    const recorded = (await rowsOf({ chainId: CHAIN_ID, nonce: tx.nonce })).some((r) => same(r.txHash, other));
    expect(recorded || h.alerts.some((a) => a.kind === ('evaluator-nonce-foreign' as EscrowAlert['kind']))).toBe(true);
    const row = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.onChainStatus).not.toBe('COMPLETED');
    expect(row.platformFeeAmount).toBeNull();
    expect(h.finalized).toEqual([]);
  });

  it('row 26 (AV): a speed-up mined while the worker waits for the original — outcome from this jobId\'s event; settleTxHash = the speed-up; its fee and feedback', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    const raw = await evaluator.signTransaction({ type: 'eip1559', chainId: CHAIN_ID, to: tx.to!, data: tx.input, gas: tx.gas, nonce: tx.nonce, value: 0n, ...bump(tx) });
    const speed = keccak256(raw);
    await chain.publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] } as never);
    await mine();
    await outcome;
    await automine(true);
    await reconcile(h);
    await settle(h, jobId, 1);
    await reconcile(h);
    const done = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written' });
    expect(same(done.settleTxHash, speed)).toBe(true);
  });

  it('row 28 (AV): single job, its send lost from the node (anvil_dropTransaction), no other traffic — the worker rebroadcasts the identical raw → mines; paid', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await automine(false);
    const { tx, outcome } = await settleUntilPending(h, jobId);
    await chain.rpc('anvil_dropTransaction', [tx.hash]);
    await automine(true);
    await reconcile(h); // unknown everywhere, head, single, simulation ok → rebroadcast the same bytes
    await outcome; // the worker's wait sees its own (rebroadcast) transaction mined
    expect((await chain.publicClient.getTransactionReceipt({ hash: tx.hash })).status).toBe('success');
    await reconcile(h);
    expect((await rowsOf({ jobId }))[0]).toMatchObject({ status: 'MINED_SUCCESS' });
  });

  it('row 34 (AV): a third party\'s claimRefund on a delivered job (no contest, no decision) → provider-unpaid once', async () => {
    const onChain = await submittedOnChain(60n);
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes);
    await chain.rpc('evm_setNextBlockTimestamp', [Number(onChain.expiredAt) + 1]);
    await write(thirdParty, escrow, escrowAbi, 'claimRefund', [onChain.onChainJobId]);
    h.deps.now = () => new Date((Number(onChain.expiredAt) + 5) * 1000);
    await settle(h, jobId);
    await reconcile(h);
    await settle(h, jobId, 1);
    expect(await db.job.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ onChainStatus: 'EXPIRED' });
    expect(h.alerts.filter((a) => a.kind === 'provider-unpaid' && a.jobId === jobId)).toHaveLength(1);
  });
});

// LAST on purpose: after `anvil_reorg`, Anvil answers `eth_getTransactionCount(addr, <block number>)` from
// inconsistent historical state (non-monotone counts), which breaks the §4.3 binary search of any later test.
// Gated like the other A1 rows (it used to sit outside any describe, so it ran even when the A1 rows were skipped).
describeA1('A1 on Anvil — reorg (runs last)', () => {
  it('row 14 (AV): reorg (anvil_reorg depth 1, tx not re-included) of a latest-level MINED_SUCCESS — alive again, evaluator-reorg, the gate refuses', async () => {
    const onChain = await submittedOnChain();
    const jobId = await deliveredRow(onChain);
    const h = harness();
    await wireA1(h.deps, h.lanes, 2n); // proof = latest − 2: a fresh receipt stays at the `latest` level
    await automine(false);
    const { outcome } = await settleUntilPending(h, jobId);
    await mine();
    await outcome;
    await reconcile(h);
    expect((await rowsOf({ jobId }))[0]).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'latest' });
    await chain.rpc('anvil_reorg', [1, []]);
    await reconcile(h);
    expect(['SIGNED', 'SENT', 'SEND_UNCONFIRMED']).toContain((await rowsOf({ jobId }))[0]!.status);
    expect(h.alerts.filter((a) => a.kind === ('evaluator-reorg' as EscrowAlert['kind']))).toHaveLength(1);
    // The reorg dropped the transaction from the node: the pass rebroadcasts the identical bytes (R2-P1-3) and it
    // mines again in a NEW block; at the proof depth the job is reconciled once. (Also keeps the key's nonce
    // contiguous for the next tests.)
    await automine(true);
    await reconcile(h);
    for (let i = 0; i < 3; i++) await mine();
    await reconcile(h);
    expect((await rowsOf({ jobId }))[0]).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'proof' });
    await settle(h, jobId, 1);
    expect(await chainStatus(onChain.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
  });
});

