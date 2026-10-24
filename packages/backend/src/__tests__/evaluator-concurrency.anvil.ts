/**
 * A1 matrix ROW 9 (spec C3g-A1 §7.1–7.3, §8.4, R2-P2-3, R2-P3-2): the settlement worker and the
 * recovery script acting CONCURRENTLY, as separate OS processes, on a real node with the real
 * contracts (`npm run test:anvil`).
 *
 * Processes:
 *  - W  — the real settlement worker (`helpers/a1c-settlement-worker.entry.ts`: `runEscrowBootCheck` +
 *         `startEscrowSettlementWorker(erc8183Deps)`), BullMQ on the shared Redis, the Prisma ledger, the
 *         Redis evaluator lane, the evaluator signer. Jobs reach it through `addSettlementJob`.
 *  - S  — the real recovery CLI (`src/scripts/evaluator-recovery.ts`, its `main()` unchanged), with test
 *         caps in env; stdin is a pipe (the typed phrase), `isTTY` set by the child preload (no pty here).
 *  - P0 — this test process: creates the stuck head X with the same `processSettlementJob` (in-process
 *         deps, the same Redis lane lock), mines, and reconciles. It is the "worker that signed X".
 * Each process talks to Anvil through its own JSON-RPC proxy (`helpers/rpc-barrier-proxy.ts`).
 *
 * Synchronisation is deterministic — barriers the test controls, no sleep as proof:
 *  - a proxy HOLDS one request: W's first `eth_fillTransaction` (viem's gas / nonce fill on Anvil: W inside the lane, nothing signed yet); S's
 *    `eth_feeHistory` after the typed phrase (S inside its critical section: the re-read);
 *  - the lane owner is read from Redis (`agentfi:lane:<chainId>:<evaluator>` = the lease token); every
 *    SET / release / assertHeld on the lane key is seen through Redis MONITOR, in one ordered timeline
 *    with the proxies' requests;
 *  - S's confirmation prompt ("Type exactly: …") is a barrier: state is changed before the phrase;
 *  - conditions are polled with a timeout (never a fixed sleep).
 * Every `eth_sendRawTransaction` of every process is probed by its proxy BEFORE it is forwarded: the
 * ledger row of that hash must already exist ("no unauthorised send").
 *
 * Resources: Postgres DATABASE_URL (migrated; `agentfi_a1c_row9_anvil`), Redis A1C_REDIS_URL (default
 * redis://127.0.0.1:6391/1 — never 6379; required explicitly on CI), Anvil `anvilTestPort(40)`, chain id 84532,
 * Anvil keys only.
 *
 * The suite WIPES its database (the A1 ledger of every chain, TRUNCATE "Job", "Agent" CASCADE) and its Redis db
 * (`agentfi:*`, `bull:escrow-settlement:*`). Before anything connects, it refuses (file error, nothing touched):
 *  - a database whose name is not dedicated — only `test` or a name ending in `_anvil` / `_test` (so never
 *    `agentfi`, the docker-compose dev database);
 *  - a Redis URL on port 6379 (the dev stack) or without an explicit db index ≥ 1.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  if (process.env['CI'] && !process.env['A1C_REDIS_URL']) {
    throw new Error('evaluator-concurrency.anvil.ts needs A1C_REDIS_URL on CI (a dedicated Redis, e.g. redis://localhost:6391/1)');
  }
  const redisUrl = process.env['A1C_REDIS_URL'] ?? 'redis://127.0.0.1:6391/1';
  // Review P3-7: an implicit port is 6379 too (redis://localhost/1), so read the parsed port, not the text.
  if ((new URL(redisUrl).port || '6379') === '6379') throw new Error('evaluator-concurrency.anvil.ts must not use Redis 6379 (the dev stack)');
  // P2-2: the suite deletes `agentfi:*` and the settlement queue in this Redis db — never db 0 / an implicit db.
  const redisDb = /^\/(\d+)$/.exec(new URL(redisUrl).pathname)?.[1];
  if (redisDb === undefined || Number(redisDb) < 1) {
    throw new Error(`evaluator-concurrency.anvil.ts refuses Redis ${redisUrl}: name an explicit, dedicated db index ≥ 1 (e.g. redis://127.0.0.1:6391/1)`);
  }
  // P2-2: the suite truncates Job / Agent and the A1 ledger — only in a dedicated database.
  if (process.env['DATABASE_URL']) {
    const dbName = new URL(process.env['DATABASE_URL']).pathname.replace(/^\//, '');
    if (!(dbName === 'test' || /_(anvil|test)$/.test(dbName))) {
      throw new Error(
        `evaluator-concurrency.anvil.ts refuses to wipe database "${dbName || '(none)'}": point DATABASE_URL at a dedicated database whose name ends in _anvil or _test (e.g. agentfi_a1c_row9_anvil)`,
      );
    }
  }
  process.env['A1C_REDIS_URL'] = redisUrl;
  process.env['REDIS_URL'] = redisUrl;
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, parseEventLogs, toBytes, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ANVIL_KEYS, anvilAccount, anvilTestPort, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';
import { RpcBarrierProxy, Timeline, type TimelineEvent } from './helpers/rpc-barrier-proxy.js';
import { childEnv, startChild, type Child } from './helpers/a1c-processes.js';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { createEvaluatorSigner, type EvaluatorSigner } from '../services/escrow/evaluator-signer.js';
import { readNodeViews } from '../services/escrow/evaluator-rpc.js';
import { ASSERT_HELD_SCRIPT, RedisLaneLock, evaluatorLaneKey, recoveryLockKey } from '../services/transaction/wallet-lane.js';
import { getKnownTokenBySymbol } from '../services/transaction/token-registry.js';
import * as svc from '../services/job/escrow-erc8183.service.js';
import { CHAIN_JOB_STATUS, processSettlementJob, type Erc8183Deps, type EscrowAlert } from '../services/job/escrow-erc8183.service.js';

// ── availability ──────────────────────────────────────────────────────────────

async function probe(): Promise<boolean> {
  const client = new PrismaClient();
  try {
    await client.$queryRaw`SELECT "txHash", "proofLevel" FROM "EvaluatorTransaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}
async function redisUp(): Promise<boolean> {
  const r = new Redis(process.env['A1C_REDIS_URL']!, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const AVAIL = (await probe()) && (await redisUp());
if (!AVAIL && process.env['CI']) throw new Error('evaluator-concurrency.anvil.ts needs a migrated Postgres (DATABASE_URL) and Redis (A1C_REDIS_URL) on CI');
if (!AVAIL) console.warn('[evaluator-concurrency.anvil] skipped — Postgres (A1 tables) or Redis not reachable');
const describeA1 = AVAIL ? describe : describe.skip;

// ── fixture ───────────────────────────────────────────────────────────────────

const CHAIN_ID = 84532;
const NAME_PREFIX = 'a1c-row9';
const BUDGET = 5_000_000n;
const FEE = (BUDGET * 30n) / 10_000n;
const AGENT_ID = 7n;
const deployer = anvilAccount(0);
const requester = anvilAccount(1);
const provider = anvilAccount(2);
const thirdParty = anvilAccount(3);
const evaluator = anvilAccount(4);
const escrowAbi = AGENT_JOB_ESCROW_ABI as unknown as Abi;
const USDC = getAddress(getKnownTokenBySymbol('USDC', CHAIN_ID)!.address);
const LANE_KEY = `agentfi:lane:${evaluatorLaneKey(CHAIN_ID, evaluator.address)}`;
const RECOVERY_KEY = recoveryLockKey(CHAIN_ID);
const OPERATOR = 'ops@a1c-row9';

/** TEST caps for this node (Anvil prices ~1 gwei): the CLI refuses --execute without them. P9 = 0 s (the
 * worker's original is seconds old; the interval rule itself is F1's row 38). Not a proposal. */
const TEST_CAPS: Record<string, string> = {
  [`EVALUATOR_RECOVERY_MAX_GAS_LIMIT_${CHAIN_ID}`]: '3000000',
  [`EVALUATOR_RECOVERY_MAX_FEE_PER_GAS_WEI_${CHAIN_ID}`]: '1000000000000',
  [`EVALUATOR_RECOVERY_MAX_PRIORITY_FEE_PER_GAS_WEI_${CHAIN_ID}`]: '1000000000000',
  [`EVALUATOR_RECOVERY_MIN_PRIORITY_FEE_PER_GAS_WEI_${CHAIN_ID}`]: '1000000',
  [`EVALUATOR_RECOVERY_MAX_COST_WEI_${CHAIN_ID}`]: '100000000000000000',
  [`EVALUATOR_RECOVERY_MAX_INCIDENT_COST_WEI_${CHAIN_ID}`]: '1000000000000000000',
  [`EVALUATOR_RECOVERY_MAX_DAILY_COST_WEI_${CHAIN_ID}`]: '1000000000000000000',
  [`EVALUATOR_RECOVERY_RESERVE_WEI_${CHAIN_ID}`]: '1000000000000000',
  [`EVALUATOR_RECOVERY_L1_MARGIN_WEI_${CHAIN_ID}`]: '10000000000000',
  EVALUATOR_RECOVERY_BASE_FEE_MULTIPLIERS: '3,6,12',
  EVALUATOR_RECOVERY_MAX_BASE_FEE_MULTIPLE: '1000',
  EVALUATOR_RECOVERY_REPLACEMENT_BUMP_BPS: '1250',
  EVALUATOR_RECOVERY_MAX_REPLACEMENTS_PER_NONCE: '3',
  EVALUATOR_RECOVERY_MIN_INTERVAL_SECONDS: '0',
  EVALUATOR_RECOVERY_MAX_RANGE_NONCES: '3',
  EVALUATOR_RECOVERY_RECEIPT_WAIT_SECONDS: '1',
};

let chain: LocalChain;
let db: PrismaClient;
let redis: Redis;
let monitorConn: Redis | null = null;
let monitor: { disconnect(): void } | null = null;
let escrow: Address;
let hook: Address;
let identity: Address;
let reputation: Address;
let erc20Abi: Abi;
let signer: EvaluatorSigner;
let startBlock = 0n;
const timeline = new Timeline();
let pW: RpcBarrierProxy;
let pS: RpcBarrierProxy;
let p0: RpcBarrierProxy;
let W: Child | null = null;
const children: Child[] = [];
let addSettlementJob: (data: { jobId: string; action: 'settle' }) => Promise<void>;
let settlementQueue: {
  getJob(id: string): Promise<{ promote(): Promise<void>; getState(): Promise<string> } | undefined>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
};

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => lower(a) === lower(b);

/** Setup progress on stderr (a hang in the shared fixtures is then located at a glance). */
function step(label: string): void {
  timeline.push('test', 'step', { label });
  process.stderr.write(`[a1c-row9 ${new Date().toISOString()}] ${label}\n`);
}

async function until<T>(what: string, read: () => Promise<T> | T, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs} ms) waiting for: ${what}; last = ${JSON.stringify(last, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** A Redis MONITOR event is delivered asynchronously (another socket): wait for it (with a timeout). */
async function seen(what: string, pred: (e: TimelineEvent) => boolean, from: number): Promise<TimelineEvent> {
  return (await until(`MONITOR: ${what}`, () => timeline.find(pred, from), Boolean, 10_000))!;
}
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out (${ms} ms): ${what}`)), ms))]);
}

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
async function usdcOf(address: Address): Promise<bigint> {
  return (await chain.publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] })) as bigint;
}
async function chainStatus(onChainJobId: bigint): Promise<number> {
  const job = (await chain.publicClient.readContract({ address: escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'getJob', args: [onChainJobId] })) as { status: number };
  return Number(job.status);
}
const evaluatorNonce = (blockTag: 'latest' | 'pending') => chain.publicClient.getTransactionCount({ address: evaluator.address, blockTag });

/** The evaluator's txpool entries: nonce → hash. */
async function evaluatorPool(): Promise<Map<number, string>> {
  const pool = (await chain.rpc('txpool_content', [])) as { pending?: Record<string, Record<string, { hash: string }>>; queued?: Record<string, Record<string, { hash: string }>> };
  const out = new Map<number, string>();
  for (const part of [pool.pending ?? {}, pool.queued ?? {}]) {
    for (const [from, byNonce] of Object.entries(part)) {
      if (!same(from, evaluator.address)) continue;
      for (const [n, tx] of Object.entries(byNonce)) out.set(Number(n), lower(tx.hash));
    }
  }
  return out;
}

// ── jobs ──────────────────────────────────────────────────────────────────────

interface OnChainJob {
  onChainJobId: bigint;
  expiredAt: bigint;
}
interface TestJob extends OnChainJob {
  jobId: string;
}

async function submittedOnChain(ttlSeconds = 3600n): Promise<OnChainJob> {
  const block = await chain.publicClient.getBlock();
  const expiredAt = block.timestamp + ttlSeconds;
  const created = await write(requester, escrow, escrowAbi, 'createJob', [provider.address, evaluator.address, expiredAt, 'a1c-row9', hook]);
  const receipt = await chain.publicClient.getTransactionReceipt({ hash: created });
  const [event] = parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs: receipt.logs, eventName: 'JobCreated' });
  const onChainJobId = event!.args.jobId;
  await write(provider, escrow, escrowAbi, 'setProviderAgentId', [onChainJobId, AGENT_ID]);
  await write(requester, escrow, escrowAbi, 'setBudget', [onChainJobId, BUDGET, '0x']);
  await write(requester, escrow, escrowAbi, 'fund', [onChainJobId, BUDGET, '0x']);
  await write(provider, escrow, escrowAbi, 'submit', [onChainJobId, keccak256(toBytes(`a1c-${onChainJobId}`)), '0x']);
  return { onChainJobId, expiredAt };
}

let seq = 0;
/** A delivered job: on-chain Submitted, DB PAYMENT_PENDING / SUBMITTED, waiting for its automatic settlement. */
async function delivered(ttlSeconds = 3600n): Promise<TestJob> {
  const onChain = await submittedOnChain(ttlSeconds);
  const run = `${Date.now().toString(36)}-${++seq}`;
  const agent = (label: string) =>
    db.agent.create({
      data: { name: `${NAME_PREFIX} ${label}`, apiKeyHash: `${NAME_PREFIX}-${label}-${run}`, apiKeyPrefix: 'a1c', walletId: `${NAME_PREFIX}-${label}-${run}`, safeAddress: privateKeyToAccount(generatePrivateKey()).address, chainIds: [CHAIN_ID] },
      select: { id: true },
    });
  const req = await agent('requester');
  const prov = await agent('provider');
  const row = await db.job.create({
    data: {
      requesterId: req.id,
      providerId: prov.id,
      status: 'PAYMENT_PENDING',
      payload: { task: 'a1c-row9' },
      result: { ok: true },
      escrowKind: 'erc8183',
      escrowChainId: CHAIN_ID,
      escrowContract: getAddress(escrow),
      onChainJobId: onChain.onChainJobId.toString(),
      onChainStatus: 'SUBMITTED',
      evaluator: evaluator.address,
      budgetToken: USDC,
      budgetAmount: BUDGET.toString(),
      expiresAt: new Date(Number(onChain.expiredAt) * 1000),
      reservationStatus: 'PENDING',
      deliverableHash: keccak256(toBytes(`a1c-${onChain.onChainJobId}`)),
      providerAgentId: AGENT_ID.toString(),
      providerAgentIdStatus: 'BOUND',
    } as never,
    select: { id: true },
  });
  return { ...onChain, jobId: row.id };
}

async function wipe(): Promise<void> {
  // A dedicated database only (name `test` / `*_anvil` / `*_test`, enforced in vi.hoisted at the top of the file,
  // before anything connects): the ledger first (ON DELETE RESTRICT), then jobs and agents.
  await db.evaluatorTransaction.deleteMany({});
  await db.evaluatorRecoveryIncident.deleteMany({});
  await db.evaluatorChainState.deleteMany({});
  // Fail fast (with a message) instead of waiting forever on a lock a stray process of an earlier run might hold.
  await db.$transaction([db.$executeRawUnsafe("SET LOCAL lock_timeout = '20s'"), db.$executeRawUnsafe('TRUNCATE TABLE "Job", "Agent" CASCADE')]);
}

async function cleanRedis(): Promise<void> {
  for (const pattern of ['bull:escrow-settlement:*', 'agentfi:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

interface Row {
  id: string;
  nonce: number | null;
  jobId: string | null;
  kind: string;
  origin: string;
  action: string;
  decision: string | null;
  status: string;
  txHash: string;
  proofLevel: string | null;
  incidentId: string | null;
  broadcastAt: Date | null;
  sendError: string | null;
  createdAt: Date;
  gasLimit: string | null;
  maxFeePerGas: string | null;
  rawTx: string | null;
}
const rowsOf = (where: Record<string, unknown>) => db.evaluatorTransaction.findMany({ where, orderBy: { createdAt: 'asc' } }) as unknown as Promise<Row[]>;
/** Polls (with a timeout) until the job's first candidate is recorded AND answered SENT. */
async function sentRow(jobId: string, what: string): Promise<Row> {
  const row = await until(what, async () => (await rowsOf({ jobId }))[0], (r) => r?.status === 'SENT', 60_000);
  return row!;
}

// ── P0: this process's in-process settlement (the worker that signed the stuck head) ─────────────

let p0Lanes: RedisLaneLock;
const p0Alerts: EscrowAlert[] = [];

function p0Deps(): Erc8183Deps {
  return {
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
    releaseJobEscrow: async () => undefined,
    finalize: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    alert: (a) => {
      p0Alerts.push(a);
    },
    readNodeViews: (chainId, evaluatorAddress, hashes) => readNodeViews(chainId, evaluatorAddress, hashes, { proofTag: 'latest', urls: [chain.rpcUrl] }),
    evaluatorLanes: p0Lanes,
    proofTag: 'latest',
    recoveryCaps: () => null,
  } as Erc8183Deps;
}
const p0Settle = (jobId: string, attemptsMade = 0) =>
  processSettlementJob(p0Deps(), { data: { jobId, action: 'settle' }, attemptsMade, opts: { attempts: 3 } }).then(
    (result) => ({ result, error: null as Error | null }),
    (error: Error) => ({ result: null, error }),
  );
const reconcile = () => svc.reconcileEvaluatorCandidates(p0Deps(), CHAIN_ID);

/**
 * The stuck head: P0 settles X with automine OFF. Returns once X's `complete` is in the pool AND
 * P0's receipt wait has fetched it (the barrier is P0's own `eth_getTransactionByHash` of that hash:
 * from then on viem detects a replacement instead of waiting for a transaction it never saw).
 */
async function stuckHead(x: TestJob): Promise<{ nonce: number; hash: string; outcome: ReturnType<typeof p0Settle> }> {
  const mark = timeline.last;
  const outcome = p0Settle(x.jobId);
  const sent = await until('P0 broadcast of X', () => timeline.find((e) => e.source === 'P0' && e.kind === 'send-raw', mark), Boolean, 60_000);
  const hash = sent!.detail['hash'] as string;
  await until(
    'P0 receipt wait fetched X',
    () => timeline.find((e) => e.source === 'P0' && e.kind === 'request' && e.detail['method'] === 'eth_getTransactionByHash' && same((e.detail['params'] as string[])[0], hash), sent!.seq),
    Boolean,
    30_000,
  );
  const [row] = await rowsOf({ jobId: x.jobId });
  expect(same(row!.txHash, hash)).toBe(true);
  expect(row!.status).toBe('SENT');
  return { nonce: row!.nonce!, hash: lower(hash), outcome };
}

// ── children ──────────────────────────────────────────────────────────────────

function commonChildEnv(rpcUrl: string): Record<string, string> {
  return {
    NODE_ENV: 'development',
    API_SECRET: 'a1c-row9-api-secret-must-be-long-enough-1234',
    ADMIN_SECRET: 'a1c-row9-admin-secret-must-be-long-enough-123',
    DATABASE_URL: process.env['DATABASE_URL']!,
    REDIS_URL: process.env['A1C_REDIS_URL']!,
    WALLET_PROVIDER: 'local',
    ALCHEMY_API_KEY: 'a1c-row9-dummy',
    TURNKEY_API_PUBLIC_KEY: 'a1c-dummy',
    TURNKEY_API_PRIVATE_KEY: 'a1c-dummy',
    TURNKEY_ORGANIZATION_ID: 'a1c-dummy',
    OPERATOR_FEE_WALLET: '0x000000000000000000000000000000000000fEe1',
    TRANSACTION_WORKER_ENABLED: 'true',
    [`RPC_URL_${CHAIN_ID}`]: rpcUrl,
    [`AGENT_JOB_ESCROW_ADDRESS_${CHAIN_ID}`]: escrow,
    [`REPUTATION_HOOK_ADDRESS_${CHAIN_ID}`]: hook,
    [`IDENTITY_REGISTRY_ADDRESS_${CHAIN_ID}`]: identity,
    [`REPUTATION_REGISTRY_ADDRESS_${CHAIN_ID}`]: reputation,
    ESCROW_EVALUATOR_PRIVATE_KEY: ANVIL_KEYS[4]!,
    ESCROW_EVALUATION_DELAY_SECONDS: '0',
    EVALUATOR_PROOF_TAG: 'latest',
    BACKEND_PUBLIC_URL: 'http://127.0.0.1:3999',
    DOTENV_CONFIG_PATH: 'a1c-row9-no-dotenv',
    A1C_CHAIN_ID: String(CHAIN_ID),
    ...TEST_CAPS,
  };
}

function startS(args: string[]): Child {
  const child = startChild({
    name: 'S',
    entry: 'src/scripts/evaluator-recovery.ts',
    args,
    env: childEnv({ ...commonChildEnv(pS.url), A1C_FAKE_TTY: '1' }),
    timeline,
  });
  children.push(child);
  return child;
}
const execArgs = (op: string, nonce: number) => ['--chain', String(CHAIN_ID), '--execute', op, '--nonce', String(nonce), '--operator', OPERATOR, '--note', 'row 9 concurrency'];

/** Waits for S's typed-confirmation prompt (the barrier) and returns the phrase it asks for. */
async function promptOf(s: Child): Promise<string> {
  const { line } = await s.waitForLine(/^Type exactly: /, 120_000);
  return line.slice('Type exactly: '.length).trim();
}
function type(s: Child, phrase: string): number {
  const e = timeline.push('test', 'typed', { child: s.name, phrase });
  s.write(`${phrase}\n`);
  return e.seq;
}

// ── Redis MONITOR on the lane and the recovery lock ──────────────────────────

const redisDb = Number(new URL(process.env['A1C_REDIS_URL']!).pathname.replace('/', '') || '0');
const isLane = (kind: 'set' | 'release' | 'assert', token?: string) => (e: TimelineEvent) =>
  e.source === 'redis' && e.kind === kind && (token === undefined || e.detail['token'] === token);

async function startMonitor(): Promise<void> {
  monitorConn = new Redis(process.env['A1C_REDIS_URL']!);
  const m = (await monitorConn.monitor()) as unknown as { on(ev: 'monitor', fn: (time: string, args: string[], source: string, database: string) => void): void; disconnect(): void };
  monitor = m;
  m.on('monitor', (_time, args, source, database) => {
    if (Number(database) !== redisDb || !Array.isArray(args) || args.length < 2) return;
    const cmd = String(args[0]).toLowerCase();
    if (cmd === 'set' && args[1] === LANE_KEY) timeline.push('redis', 'set', { token: args[2], args: args.slice(3), client: source });
    else if (cmd === 'eval' && args[3] === LANE_KEY) {
      // MONITOR escapes the script text: matched by content (assertHeld asks `pttl`; the release `del`s).
      const script = String(args[1]);
      const kind = script === ASSERT_HELD_SCRIPT || script.includes("'pttl'") ? 'assert' : script.includes("'del'") ? 'release' : 'eval';
      timeline.push('redis', kind, { token: args[4], client: source });
    } else if (cmd === 'pexpire' && args[1] === LANE_KEY) timeline.push('redis', 'pexpire', { client: source });
    else if ((cmd === 'set' || cmd === 'eval') && (args[1] === RECOVERY_KEY || args[3] === RECOVERY_KEY)) timeline.push('redis', `recovery-${cmd}`, { client: source });
  });
}

// ── audit helpers ─────────────────────────────────────────────────────────────

/** Every evaluator tx in the pool right now has a ledger row, and its proxy saw that row BEFORE forwarding it. */
async function assertPoolAuthorised(): Promise<Map<number, string>> {
  const pool = await evaluatorPool();
  for (const [nonce, hash] of pool) {
    const rows = await rowsOf({ txHash: hash });
    expect(rows, `pool tx ${hash} at nonce ${nonce} has a ledger row`).toHaveLength(1);
    expect(rows[0]!.nonce).toBe(nonce);
    expect(rows[0]!.broadcastAt, `ledger row of ${hash} marked broadcast`).not.toBeNull();
    const probes = [...pW.sendRaws, ...pS.sendRaws, ...p0.sendRaws].filter((p) => same(p.hash, hash));
    expect(probes.length, `${hash} was broadcast through a proxy`).toBeGreaterThan(0);
    for (const p of probes) expect(p.verdict, `${hash}: ledger row present at broadcast`).toMatchObject({ row: true });
  }
  return pool;
}

async function sendRawProbe(_raw: Hex, hash: Hex): Promise<unknown> {
  const row = await db.evaluatorTransaction.findFirst({ where: { txHash: { equals: hash, mode: 'insensitive' } }, select: { id: true, status: true, broadcastAt: true, nonce: true } });
  return { row: row !== null, status: row?.status ?? null, broadcastMarked: row?.broadcastAt != null, nonce: row?.nonce ?? null };
}

/** After mining: P0 reconciles; the job of each `winner` is settled on its winner, once. */
async function settleAndCheck(jobs: Array<{ job: TestJob; winner: string; settledBy: 'P0' | 'W' }>): Promise<void> {
  await reconcile();
  for (const { job, settledBy } of jobs) {
    if (settledBy === 'P0') await p0Settle(job.jobId, 1);
  }
  await reconcile();
  for (const { job, winner, settledBy } of jobs) {
    if (settledBy === 'W') {
      await until(`W settled ${job.jobId}`, () => db.job.findUniqueOrThrow({ where: { id: job.jobId } }), (j) => j.onChainStatus === 'COMPLETED' && j.platformFeeAmount !== null, 60_000);
    }
    expect(await chainStatus(job.onChainJobId)).toBe(CHAIN_JOB_STATUS.Completed);
    const rows = await rowsOf({ jobId: job.jobId });
    const mined = rows.filter((r) => r.status === 'MINED_SUCCESS');
    expect(mined.map((r) => lower(r.txHash))).toEqual([lower(winner)]);
    for (const r of rows) if (!same(r.txHash, winner)) expect(r.status, `loser ${r.txHash} of ${job.jobId}`).toBe('DEAD');
    // the winner's receipt carries THIS job's JobCompleted (the contract's own event)
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: winner as Hex });
    const completed = parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs: receipt.logs, eventName: 'JobCompleted' }).filter((l) => l.args.jobId === job.onChainJobId);
    expect(completed).toHaveLength(1);
    const done = await db.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(done).toMatchObject({ onChainStatus: 'COMPLETED', platformFeeAmount: FEE.toString(), feedbackStatus: 'written', resolution: null });
    expect(same(done.settleTxHash, winner)).toBe(true);
    // the decision never changed: every non-cancel candidate of the job is the same COMPLETE / pay
    for (const r of rows.filter((x) => x.kind !== 'CANCEL')) expect({ action: r.action, decision: r.decision }).toEqual({ action: rows[0]!.action, decision: rows[0]!.decision });
  }
}

/** Lane ownership is observable: the key's token, and the MONITOR'd SET that wrote it. */
async function laneHolder(): Promise<string | null> {
  return redis.get(LANE_KEY);
}
/** Broadcasts a process made (seen by its proxy) after timeline position `from`. */
const sendsBy = (source: 'W' | 'S' | 'P0', from: number) => timeline.filter((e) => e.source === source && e.kind === 'send-raw', from);
const INTRUDER = 'a1c-row9-intruder';

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!AVAIL) return;
  step('start anvil');
  chain = await startLocalChain({ port: anvilTestPort(40), chainId: CHAIN_ID });
  db = new PrismaClient();
  redis = new Redis(process.env['A1C_REDIS_URL']!);
  p0Lanes = new RedisLaneLock(redis);
  step('wipe db');
  await wipe();
  step('clean redis');
  await cleanRedis();

  // USDC: the escrow must hold the chain's registered USDC (the boot check compares token()), so the
  // mock ERC-20's runtime code is placed at the Base Sepolia USDC address.
  const erc20 = readArtifact('MockERC20', 'MockERC20.sol');
  erc20Abi = erc20.abi;
  const mock = await chain.deploy(deployer, erc20);
  await chain.rpc('anvil_setCode', [USDC, await chain.publicClient.getCode({ address: mock })]);
  escrow = await chain.deploy(deployer, readArtifact('AgentJobEscrow'), [USDC, deployer.address, deployer.address, 0n, 30n]);
  identity = await chain.deploy(deployer, readArtifact('MockIdentityRegistry', 'MockIdentityRegistry.sol'));
  reputation = await chain.deploy(deployer, readArtifact('MockReputationRegistry', 'MockReputationRegistry.sol'));
  hook = await chain.deploy(deployer, readArtifact('ReputationHook'), [escrow, reputation, identity, evaluator.address, 1_000_000n, 500_000n, 50_000n]);
  await write(deployer, identity, readArtifact('MockIdentityRegistry', 'MockIdentityRegistry.sol').abi, 'setOwner', [AGENT_ID, provider.address]);
  await write(deployer, USDC, erc20Abi, 'mint', [requester.address, 1_000n * BUDGET]);
  await write(requester, USDC, erc20Abi, 'approve', [escrow, 1_000n * BUDGET]);
  startBlock = await chain.publicClient.getBlockNumber();
  step('contracts deployed');

  pW = new RpcBarrierProxy('W', chain.rpcUrl, timeline);
  pS = new RpcBarrierProxy('S', chain.rpcUrl, timeline);
  p0 = new RpcBarrierProxy('P0', chain.rpcUrl, timeline);
  for (const p of [pW, pS, p0]) {
    await p.start();
    p.onSendRaw = sendRawProbe;
  }
  process.env[`RPC_URL_${CHAIN_ID}`] = p0.url; // P0's evaluator signer → its proxy
  signer = createEvaluatorSigner(CHAIN_ID, ANVIL_KEYS[4]!);
  await startMonitor();

  const queueMod = await import('../queues/escrow-settlement.queue.js');
  addSettlementJob = (data) => queueMod.addSettlementJob(data);
  settlementQueue = queueMod.escrowSettlementQueue as never;

  step('start W');
  W = startChild({ name: 'W', entry: 'src/__tests__/helpers/a1c-settlement-worker.entry.ts', env: childEnv(commonChildEnv(pW.url)), timeline });
  children.push(W);
  const gate = await W.waitForLine(/^A1C-WORKER-GATE /, 120_000);
  expect(gate.line, 'W: the Q7 gate of the worker process is open (real boot check on these contracts)').toContain('"allowed":true');
  await W.waitForLine(/^A1C-WORKER-READY$/, 60_000);
}, 240_000);

afterAll(async () => {
  // The ordered evidence of the run (proxies, Redis MONITOR, child lines) next to the child logs.
  try {
    const dir = join(tmpdir(), 'agentfi-a1c-row9');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `timeline-${Date.now()}.json`), JSON.stringify(timeline.events, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  } catch {
    // evidence only
  }
  for (const c of children) await c.stop().catch(() => undefined);
  monitor?.disconnect();
  monitorConn?.disconnect();
  await settlementQueue?.close().catch(() => undefined);
  for (const p of [pW, pS, p0]) await p?.stop().catch(() => undefined);
  if (db) {
    // Leave the shared database clean: other Anvil suites deploy the escrow at the SAME address (same deployer
    // nonce), and a leftover Job (escrowContract, onChainJobId) collides with theirs.
    await wipe().catch(() => undefined);
    await db.$disconnect();
  }
  redis?.disconnect();
  chain?.stop();
}, 60_000);

afterEach(async () => {
  if (!AVAIL) return;
  // Only the test's own intruder token is ever removed here (a failed 3a must not cascade).
  if ((await laneHolder()) === INTRUDER) await redis.del(LANE_KEY);
});

beforeEach(async () => {
  if (!AVAIL) return;
  await automine(true);
  expect((await evaluatorPool()).size, 'the evaluator pool is empty at the start of a scenario').toBe(0);
  expect(await laneHolder()).toBeNull();
});

const CAPS_PER_TX = BigInt(TEST_CAPS[`EVALUATOR_RECOVERY_MAX_COST_WEI_${CHAIN_ID}`]!);

// ══ row 9 ════════════════════════════════════════════════════════════════════

describeA1('A1 row 9 — settlement worker (W) and recovery CLI (S) as two OS processes on the real contracts', () => {
  it('scenario 1: W takes the evaluator lane first and is held inside it → S (confirmed) waits on the lane; after W releases, S re-reads (W\'s candidate at N+1 in its plan), speeds up N; no collision, nothing unauthorised', async () => {
    const x = await delivered();
    const y = await delivered();
    const paidBefore = await usdcOf(provider.address);
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S);
    expect(phrase).toBe(`SPEED-UP ${CHAIN_ID} NONCE ${N} COMPLETE ${x.jobId}`);

    // W enters the lane for Y and is parked inside it (its first eth_fillTransaction: lane held, nothing signed yet).
    const m0 = timeline.last;
    const wHold = pW.hold('eth_fillTransaction');
    await addSettlementJob({ jobId: y.jobId, action: 'settle' });
    await withTimeout(wHold.reached, 60_000, 'W reaches its first eth_fillTransaction (inside the lane)');
    const wToken = await laneHolder();
    expect(wToken, 'W holds the lane').toBeTruthy();
    expect(await seen('W SET', isLane('set', wToken!), m0), 'the lane token was written by a SET while W is held').toBeTruthy();

    // S confirms; barrier: S's SET NX on the lane key (its own token) while the key still holds W's token.
    const typedAt = type(S, phrase);
    const sTry = await until('S contends for the lane', () => timeline.find((e) => isLane('set')(e) && e.detail['token'] !== wToken, typedAt), Boolean, 30_000);
    const sToken = sTry!.detail['token'] as string;
    expect(await laneHolder()).toBe(wToken);
    expect(S.exitCode(), 'S is waiting, not finished').toBeUndefined();
    expect(sendsBy('S', typedAt), 'S sent nothing while W holds the lane').toHaveLength(0);
    expect(await rowsOf({ origin: 'SCRIPT' })).toHaveLength(0);
    expect(await rowsOf({ jobId: y.jobId }), 'W signed nothing yet').toHaveLength(0);
    expect(pW.aborted).toHaveLength(0);

    wHold.release();
    const code = await withTimeout(S.exited, 120_000, 'S exits');
    expect(code, S.output()).toBe(0);

    // Order on one timeline: W sends and releases → S's lease (same token, its last SET) → S asserts and sends.
    const wSend = timeline.find((e) => e.source === 'W' && e.kind === 'send-raw', m0)!;
    const wRelease = await seen('W release', isLane('release', wToken!), m0);
    const sAssert = await seen('S assertHeld', isLane('assert', sToken), typedAt);
    const sSets = timeline.filter(isLane('set', sToken), typedAt);
    const sSend = timeline.find((e) => e.source === 'S' && e.kind === 'send-raw', typedAt)!;
    expect(wSend && wRelease && sAssert && sSend).toBeTruthy();
    expect(sSets[0]!.seq).toBeLessThan(wRelease.seq); // S contended while W held it
    expect(wSend.seq).toBeLessThan(wRelease.seq);
    expect(sSets[sSets.length - 1]!.seq).toBeGreaterThan(wRelease.seq); // S got it only after W's release
    expect(sAssert.seq).toBeGreaterThan(wRelease.seq);
    // assertHeld → send is one round trip: not compared across sources (MONITOR may lag the proxy); the code orders it.

    // Ledger: W's Y at N+1 (never N), S's speed-up at N; the plan S finished with shows both nonces.
    const [yRow] = await rowsOf({ jobId: y.jobId });
    const script = await rowsOf({ origin: 'SCRIPT' });
    expect(yRow).toMatchObject({ nonce: N + 1, origin: 'WORKER', kind: 'ORIGINAL' });
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ nonce: N, kind: 'SPEED_UP', jobId: x.jobId, action: 'COMPLETE', decision: (await rowsOf({ jobId: x.jobId }))[0]!.decision });
    expect(BigInt(script[0]!.gasLimit!) * BigInt(script[0]!.maxFeePerGas!)).toBeLessThanOrEqual(CAPS_PER_TX);
    expect(S.output()).toMatch(new RegExp(`nonce ${N}: speed-up ${script[0]!.txHash} sent → accepted`));
    expect(S.output()).toMatch(new RegExp(`stays open \\(queue: ${N}, ${N + 1}\\)`));
    expect(yRow!.createdAt.getTime()).toBeLessThanOrEqual(script[0]!.createdAt.getTime());

    // Anvil pool: N = S's speed-up (replaced the original), N+1 = W's Y; every one authorised.
    const pool = await assertPoolAuthorised();
    expect(pool.get(N)).toBe(lower(script[0]!.txHash));
    expect(pool.get(N + 1)).toBe(lower(yRow!.txHash));
    expect(pool.size).toBe(2);
    expect(await redis.get(RECOVERY_KEY), 'S released the recovery lock').toBeNull();
    expect(await laneHolder()).toBeNull();

    await mine();
    await automine(true);
    await head.outcome; // P0's wait follows the replacement (not interpreted)
    // P3-6 (24/10): S's speed-up is a recorded recovery operation (SCRIPT row of its incident): P0's wait reports it
    // as such — informational, with the incident and the operator — never as a manual send or a second worker.
    expect(p0Alerts.filter((a) => a.kind === 'evaluator-replaced' && a.jobId === x.jobId)).toEqual([]);
    expect(p0Alerts.filter((a) => a.kind === 'evaluator-replaced-by-recovery' && a.jobId === x.jobId)).toEqual([
      expect.objectContaining({
        severity: 'info',
        details: expect.objectContaining({ txHash: head.hash, recovery: expect.objectContaining({ incidentId: script[0]!.incidentId, operator: OPERATOR, kind: 'SPEED_UP' }) }),
      }),
    ]);
    await settleAndCheck([
      { job: x, winner: script[0]!.txHash, settledBy: 'P0' },
      { job: y, winner: yRow!.txHash, settledBy: 'W' },
    ]);
    expect((await usdcOf(provider.address)) - paidBefore).toBe(2n * (BUDGET - FEE));
    expect([...pW.aborted, ...pS.aborted, ...p0.aborted]).toHaveLength(0);
  }, 300_000);

  it('scenario 2: S takes the lane first (held in its critical section) → W blocks on the lane; W then signs at max(pending, live+1) = N+1 even with a LAGGING pending (proxy reports N), never S\'s nonce', async () => {
    const x = await delivered();
    const y = await delivered();
    const paidBefore = await usdcOf(provider.address);
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S);
    // S's critical section: after the phrase, its first eth_feeHistory is the in-lane re-read.
    const sHold = pS.hold('eth_feeHistory');
    const typedAt = type(S, phrase);
    await withTimeout(sHold.reached, 60_000, 'S reaches its in-lane re-read');
    const sToken = await laneHolder();
    expect(sToken, 'S holds the lane').toBeTruthy();
    expect(await seen('S SET', isLane('set', sToken!), typedAt), 'S took the lane after the phrase').toBeTruthy();

    // A lagging node for W: its `pending` nonce answers N (the head), as if S's replacement were not seen.
    const lagHex = `0x${N.toString(16)}`;
    const m1 = timeline.last;
    // viem fills the nonce with `eth_fillTransaction` on Anvil (or `eth_getTransactionCount(pending)` where
    // the node lacks it): both answers lag; a fill that already carries an explicit nonce is left alone.
    const unlag = pW.rewrite((method, params, result) => {
      if (method === 'eth_getTransactionCount' && params[1] === 'pending') return lagHex;
      const req = params[0] as { nonce?: string } | undefined;
      const filled = result as { tx?: { nonce?: string } } | null;
      if (method === 'eth_fillTransaction' && req && req.nonce === undefined && filled?.tx?.nonce !== undefined) {
        return { ...filled, tx: { ...filled.tx, nonce: lagHex } };
      }
      return undefined;
    });
    await addSettlementJob({ jobId: y.jobId, action: 'settle' });
    const wTry = await until('W contends for the lane', () => timeline.find((e) => isLane('set')(e) && e.detail['token'] !== sToken, m1), Boolean, 60_000);
    const wToken = wTry!.detail['token'] as string;
    expect(await laneHolder()).toBe(sToken);
    expect(await rowsOf({ jobId: y.jobId }), 'W signed nothing while S holds the lane').toHaveLength(0);
    expect(pW.count('eth_fillTransaction', m1), 'W did not get past the lane').toBe(0);

    sHold.release();
    const code = await withTimeout(S.exited, 120_000, 'S exits');
    expect(code, S.output()).toBe(0);
    const yRow = await sentRow(y.jobId, 'W recorded and sent Y');
    unlag();

    const script = await rowsOf({ origin: 'SCRIPT', nonce: N });
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ kind: 'SPEED_UP', jobId: x.jobId });
    expect(yRow).toMatchObject({ nonce: N + 1, origin: 'WORKER' });
    // the lag was real: W's signer read `pending` = N inside the lane, and still chose N+1 (R2-P2-3)
    const sRelease = await seen('S release', isLane('release', sToken!), typedAt);
    const wAssert = await seen('W assertHeld', isLane('assert', wToken), sRelease.seq);
    const wSets = timeline.filter(isLane('set', wToken), m1);
    expect(wSets[0]!.seq).toBeLessThan(sRelease.seq);
    expect(wSets[wSets.length - 1]!.seq).toBeGreaterThan(sRelease.seq);
    const lagged = timeline.filter(
      (e) => e.source === 'W' && e.kind === 'rewritten' && JSON.stringify(e.detail['to']).includes(`"${lagHex}"`) && e.detail['method'] === 'eth_fillTransaction',
      sRelease.seq,
    );
    expect(lagged.length, 'W read a lagging pending nonce inside the lane').toBeGreaterThan(0);
    const sSend = timeline.find((e) => e.source === 'S' && e.kind === 'send-raw', typedAt)!;
    const wSend = timeline.find((e) => e.source === 'W' && e.kind === 'send-raw', m1)!;
    expect(sSend.seq).toBeLessThan(sRelease.seq);
    expect(wSend.seq).toBeGreaterThan(sRelease.seq);
    expect(wAssert).toBeTruthy(); // W asserted its own lease before sending (one round trip: not compared across sources)

    const pool = await assertPoolAuthorised();
    expect(pool.get(N)).toBe(lower(script[0]!.txHash));
    expect(pool.get(N + 1)).toBe(lower(yRow!.txHash));
    expect(pool.size).toBe(2);

    await mine();
    await automine(true);
    await head.outcome;
    await settleAndCheck([
      { job: x, winner: script[0]!.txHash, settledBy: 'P0' },
      { job: y, winner: yRow!.txHash, settledBy: 'W' },
    ]);
    expect((await usdcOf(provider.address)) - paidBefore).toBe(2n * (BUDGET - FEE));
    expect([...pW.aborted, ...pS.aborted, ...p0.aborted]).toHaveLength(0);
  }, 300_000);

  it('scenario 3a: S\'s lane is taken over (key overwritten) while S is held before assertHeld → S broadcasts NOTHING (exit 3); its SCRIPT row stays SIGNED alive; W then signs Y at N+1, not N; the original wins N', async () => {
    const x = await delivered();
    const y = await delivered();
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S);
    const sHold = pS.hold('eth_feeHistory');
    const typedAt = type(S, phrase);
    await withTimeout(sHold.reached, 60_000, 'S reaches its in-lane re-read');
    const sToken = await laneHolder();
    expect(sToken).toBeTruthy();
    // The lease is lost: another holder's token is in the key (what an expiry + a new SET leaves).
    expect(await redis.set(LANE_KEY, INTRUDER, 'PX', 120_000, 'XX')).toBe('OK');
    sHold.release();
    const code = await withTimeout(S.exited, 120_000, 'S exits');
    expect(code, S.output()).toBe(3);
    expect(S.output()).toMatch(/the evaluator lane was lost before the send .*nothing sent; the recorded candidate stays SIGNED/);

    // Nothing left S: no eth_sendRawTransaction at its proxy; the assertHeld that refused it is in the MONITOR log.
    expect(sendsBy('S', typedAt), 'S broadcast nothing').toHaveLength(0);
    expect(await seen('S assertHeld', isLane('assert', sToken!), typedAt), 'S asked assertHeld with its token').toBeTruthy();
    const script = await rowsOf({ origin: 'SCRIPT', nonce: N });
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ kind: 'SPEED_UP', status: 'SIGNED', jobId: x.jobId });
    expect(script[0]!.sendError).toMatch(/not broadcast/);
    expect((await evaluatorPool()).get(N), 'the pool still has the ORIGINAL at N').toBe(head.hash);
    expect(await laneHolder(), 'S\'s compare-and-delete did not free a lane that is not its own').toBe(INTRUDER);
    expect(await redis.get(RECOVERY_KEY)).toBeNull();
    const incident = await db.evaluatorRecoveryIncident.findUniqueOrThrow({ where: { id: script[0]!.incidentId! } });
    // The open incident is REUSED (openIncident): the one of an earlier run whose queue was still pending at its end
    // stays open until a script run sees the queue unblocked — its budget (P12) keeps counting, fail-closed.
    expect(incident).toMatchObject({ openedBy: OPERATOR, closedAt: null });
    expect(incident.headNonce).toBeLessThanOrEqual(N);
    await redis.del(LANE_KEY);

    // W afterwards: two live candidates at N in the ledger (the original + S's unsent speed-up) → Y at N+1.
    const m1 = timeline.last;
    await addSettlementJob({ jobId: y.jobId, action: 'settle' });
    const yRow = await sentRow(y.jobId, 'W recorded and sent Y');
    expect(yRow.nonce).toBe(N + 1);
    expect(pW.sendRaws.filter((p) => same(p.hash, yRow.txHash))).toHaveLength(1);
    const pool = await assertPoolAuthorised();
    expect([...pool.entries()].sort()).toEqual([
      [N, head.hash],
      [N + 1, lower(yRow.txHash)],
    ]);
    expect(timeline.filter((e) => e.kind === 'send-raw', m1).map((e) => e.detail['hash'])).toEqual([lower(yRow.txHash)]);

    await mine();
    await automine(true);
    await head.outcome;
    await settleAndCheck([
      { job: x, winner: head.hash, settledBy: 'P0' },
      { job: y, winner: yRow.txHash, settledBy: 'W' },
    ]);
    // S's never-sent speed-up is DEAD by proof (its nonce consumed by the original), never mined.
    expect((await rowsOf({ id: script[0]!.id }))[0]).toMatchObject({ status: 'DEAD' });
  }, 300_000);

  // A1-DEFECT D-R9-1 — FIXED (23/10) (P3, user-visible text): the CLI wrote `Job.escrowError = "evaluator
  // recovery: <op> sent at nonce <N>"` (F-P3-3, visible to requester and provider through the API) BEFORE
  // `sendRaw`'s `assertHeld`. When the lease was lost in between, the send was refused (exit 3, nothing broadcast)
  // but the line stayed. Now the line is written only after `sendRaw` returned ("sent" for an accepted / already
  // known answer, "attempted" otherwise); a LeaseLostError writes nothing. Same steps as scenario 3a.
  it('scenario 3c — D-R9-1: after a lease lost before the broadcast (exit 3, nothing sent), Job.escrowError carries no "evaluator recovery:" line', async () => {
    const x = await delivered();
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;
    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S);
    const sHold = pS.hold('eth_feeHistory');
    const typedAt = type(S, phrase);
    try {
      await withTimeout(sHold.reached, 60_000, 'S reaches its in-lane re-read');
      expect(await redis.set(LANE_KEY, INTRUDER, 'PX', 120_000, 'XX')).toBe('OK');
      sHold.release();
      expect(await withTimeout(S.exited, 120_000, 'S exits')).toBe(3);
      expect(sendsBy('S', typedAt)).toHaveLength(0);
      const job = await db.job.findUniqueOrThrow({ where: { id: x.jobId } });
      timeline.push('test', 'd-r9-1', { escrowError: job.escrowError });
      // Review P3-1: no "evaluator recovery:" line at all — neither "sent" nor "attempted" — after a lost lease.
      expect(job.escrowError ?? '').not.toMatch(/evaluator recovery:/);
    } finally {
      sHold.release();
      await redis.del(LANE_KEY);
      await mine();
      await automine(true);
      await head.outcome;
      await reconcile();
      await p0Settle(x.jobId, 1);
      await reconcile();
    }
  }, 300_000);

  it('scenario 3b: W\'s lease runs below the margin (PEXPIRE) while W is held before assertHeld → W records nothing and sends nothing; the BullMQ retry then signs Y at N+1', async () => {
    const x = await delivered();
    const y = await delivered();
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const m0 = timeline.last;
    const wHold = pW.hold('eth_fillTransaction');
    await addSettlementJob({ jobId: y.jobId, action: 'settle' });
    await withTimeout(wHold.reached, 60_000, 'W reaches its first eth_fillTransaction (inside the lane)');
    const wToken = await laneHolder();
    expect(wToken).toBeTruthy();
    expect(await redis.pexpire(LANE_KEY, 3_000)).toBe(1); // remaining TTL below EVALUATOR_LANE_MIN_REMAINING_MS (30 s)
    wHold.release();
    const failed = await W!.waitForLine(new RegExp(`^A1C-WORKER-FAILED settle ${y.jobId} attempt 1 `), 60_000);
    expect(failed.line).toMatch(/LeaseLostError|not held with \d+ ms to spare/);
    expect(await seen('W assertHeld', isLane('assert', wToken!), m0), 'W asked assertHeld with its token').toBeTruthy();
    expect(timeline.filter((e) => e.source === 'W' && e.kind === 'send-raw', m0), 'W broadcast nothing').toHaveLength(0);
    expect(await rowsOf({ jobId: y.jobId }), 'nothing recorded for Y').toHaveLength(0);
    expect([...(await evaluatorPool()).entries()]).toEqual([[N, head.hash]]);

    // The lease expires by itself (no one renews it); then the retry runs (promoted, no backoff wait).
    await until('the lane key expired', () => laneHolder(), (v) => v === null, 10_000);
    const job = await settlementQueue.getJob(`settle-${y.jobId}`);
    expect(await job!.getState()).toBe('delayed');
    await job!.promote();
    const yRow = await sentRow(y.jobId, 'W recorded and sent Y on the retry');
    expect(yRow.nonce).toBe(N + 1);
    const pool = await assertPoolAuthorised();
    expect(pool.size).toBe(2);

    await mine();
    await automine(true);
    await head.outcome;
    await settleAndCheck([
      { job: x, winner: head.hash, settledBy: 'P0' },
      { job: y, winner: yRow.txHash, settledBy: 'W' },
    ]);
  }, 300_000);

  it('scenario 4a: between S\'s confirmation prompt and its execution, W sends Y and the head mines → S aborts inside the lane (exit 3: the nonce left the queue); nothing sent by S', async () => {
    const x = await delivered();
    const y = await delivered();
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S); // barrier: S has diagnosed N and waits for the phrase
    await addSettlementJob({ jobId: y.jobId, action: 'settle' });
    const yRow = await sentRow(y.jobId, 'W recorded and sent Y');
    expect(yRow.nonce).toBe(N + 1);
    await mine(); // X's original (N) and Y (N+1) mine
    await automine(true);
    await head.outcome;

    const typedAt = type(S, phrase);
    const code = await withTimeout(S.exited, 120_000, 'S exits');
    expect(code, S.output()).toBe(3);
    expect(S.output()).toMatch(new RegExp(`REFUSED: nonce ${N} is no longer in the queue`));
    expect(await seen('S SET', (e) => isLane('set')(e) && e.detail['token'] !== undefined, typedAt), 'S did enter the lane to re-read').toBeTruthy();
    expect(sendsBy('S', typedAt), 'S broadcast nothing').toHaveLength(0);
    expect(await rowsOf({ origin: 'SCRIPT' }), 'no SCRIPT row written by this run').toHaveLength(scriptRowsAtStart);
    expect((await evaluatorPool()).size).toBe(0);
    await settleAndCheck([
      { job: x, winner: head.hash, settledBy: 'P0' },
      { job: y, winner: yRow.txHash, settledBy: 'W' },
    ]);
  }, 300_000);

  it('scenario 4b: between S\'s prompt and its execution the job\'s on-chain status changes (third-party claimRefund after expiry; the head tx no longer in the pool) → fingerprint changed, S aborts (exit 3), nothing sent; then S cancels N (job terminal) and the ledger closes coherently', async () => {
    const x = await delivered(120n);
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;

    const S = startS(execArgs('speed-up', N));
    const phrase = await promptOf(S);
    // The head leaves the node's pool and the deadline passes; a third party's claimRefund mines alone.
    await chain.rpc('anvil_dropTransaction', [head.hash]);
    await chain.rpc('evm_setNextBlockTimestamp', [Number(x.expiredAt) + 1]);
    await chain.wallet(thirdParty).writeContract({ address: escrow, abi: escrowAbi, functionName: 'claimRefund', args: [x.onChainJobId], account: thirdParty, chain: null });
    await mine();
    await automine(true);
    expect(await chainStatus(x.onChainJobId)).toBe(CHAIN_JOB_STATUS.Expired);
    expect(await evaluatorNonce('latest')).toBe(N); // N not consumed

    const typedAt = type(S, phrase);
    const code = await withTimeout(S.exited, 120_000, 'S exits');
    expect(code, S.output()).toBe(3);
    expect(S.output()).toMatch(new RegExp(`REFUSED: the plan of nonce ${N} changed since the confirmation \\(fingerprint\\)`));
    expect(sendsBy('S', typedAt), 'S broadcast nothing').toHaveLength(0);
    expect(await rowsOf({ origin: 'SCRIPT', jobId: x.jobId })).toHaveLength(0);
    expect((await evaluatorPool()).size).toBe(0);

    // Close the nonce: the job is terminal on-chain → cancel N (R2-P2-1) with the real CLI, no race.
    const C = startS(execArgs('cancel', N));
    const cancelPhrase = await promptOf(C);
    expect(cancelPhrase).toBe(`CANCEL ${CHAIN_ID} NONCE ${N} DOES NOT SETTLE`);
    type(C, cancelPhrase);
    expect(await withTimeout(C.exited, 120_000, 'cancel exits'), C.output()).toBe(0);
    const cancel = (await rowsOf({ origin: 'SCRIPT', nonce: N, kind: 'CANCEL' }))[0]!;
    expect(cancel).toBeTruthy();
    await head.outcome.catch(() => undefined);
    await reconcile();
    await p0Settle(x.jobId, 1);
    await reconcile();
    const rows = await rowsOf({ nonce: N });
    expect(rows.find((r) => same(r.txHash, cancel.txHash))!.status).toBe('MINED_SUCCESS');
    expect(rows.find((r) => same(r.txHash, head.hash))!.status).toBe('DEAD');
    expect(await db.job.findUniqueOrThrow({ where: { id: x.jobId } })).toMatchObject({ onChainStatus: 'EXPIRED', resolution: null, platformFeeAmount: null });
    // The cancel run's reconciliation MAY enqueue the job's own action (addSettlementJob) for W while P0 settles
    // it too: whoever mirrors EXPIRED first raises provider-unpaid — once, across the processes (W's log + P0's
    // alerts). Wait until W has no settle of X queued or running.
    await until(
      'W has no settle of X queued or running',
      async () => {
        const j = await settlementQueue.getJob(`settle-${x.jobId}`);
        return j ? await j.getState() : 'none';
      },
      (s) => s === 'none' || s === 'completed' || s === 'failed',
      60_000,
    );
    // Count only once W is idle AND its stdout is drained (review P3-2): a duplicate alert from W arriving after a
    // first sighting must still fail the test. W prints every alert as `A1C-ALERT <kind> <jobId>` on the same
    // stream as its answer to `flush`; stdout keeps the write order, so after `A1C-FLUSH <n>` nothing W raised
    // before is still in flight.
    await until(
      'W idle (no settlement waiting, active or delayed)',
      async () => {
        const c = await settlementQueue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
        return Object.values(c).reduce((s, n) => s + n, 0);
      },
      (n) => n === 0,
      60_000,
    );
    const flushFrom = W!.lines.length;
    W!.write('flush\n');
    await W!.waitForLine(/^A1C-FLUSH \d+$/, 15_000, flushFrom);
    const unpaidInW = W!.lines.filter((l) => l.trim() === `A1C-ALERT provider-unpaid ${x.jobId}`).length;
    const unpaidInP0 = p0Alerts.filter((a) => a.kind === 'provider-unpaid' && a.jobId === x.jobId).length;
    timeline.push('test', '4b-provider-unpaid', { unpaidInW, unpaidInP0 });
    expect(unpaidInW + unpaidInP0).toBe(1);
  }, 300_000);

  // #194 review id 4363039154 (P2, functional) — FIXED: through the PRODUCTION CLI (`main()`: the process's own
  // escrowConfigGate + verifyEscrowConfigOnce), `--execute rebroadcast` was refused GATE_CLOSED before the
  // confirmation — the gate starts empty in the script's process and the first verification ran only after the
  // phrase. The script now verifies once before it reads the plan. S here is that exact path (the real script
  // as its own process, production deps).
  it('scenario 6 — #194-4363039154: a lost head (dropped from every node) → the production CLI rebroadcasts it (prompt, identical bytes, same hash); the job settles once on that hash', async () => {
    const x = await delivered();
    await automine(false);
    const head = await stuckHead(x);
    const N = head.nonce;
    const [row] = await rowsOf({ jobId: x.jobId });
    // lost-send: no node knows the head any more
    await chain.rpc('anvil_dropTransaction', [head.hash]);
    let sent = false;
    try {
      const S = startS(execArgs('rebroadcast', N));
      const first = await Promise.race([
        S.waitForLine(/^Type exactly: /, 120_000).then(() => 'prompt' as const),
        S.exited.then(() => 'exited' as const),
      ]);
      expect(first, S.output()).toBe('prompt');
      expect(S.output()).toMatch(/config gate \(Q7, this process\): verified/);
      const phrase = await promptOf(S);
      expect(phrase.startsWith(`REBROADCAST ${CHAIN_ID} NONCE ${N} `)).toBe(true);
      const typedAt = type(S, phrase);
      expect(await withTimeout(S.exited, 120_000, 'S exits'), S.output()).toBe(0);
      const sends = sendsBy('S', typedAt);
      expect(sends).toHaveLength(1);
      expect(same(sends[0]!.detail['hash'] as string, head.hash)).toBe(true);
      sent = true;
    } finally {
      if (!sent) {
        // The fix is absent (or S failed): put the identical bytes back so the head can mine and later scenarios run.
        await chain.rpc('eth_sendRawTransaction', [row!.rawTx]).catch(() => undefined);
      }
      await mine();
      await automine(true);
      await head.outcome;
    }
    // the same row, the same hash: no SCRIPT candidate for an identical rebroadcast
    expect((await rowsOf({ jobId: x.jobId })).map((r) => lower(r.txHash))).toEqual([head.hash]);
    await settleAndCheck([{ job: x, winner: head.hash, settledBy: 'P0' }]);
  }, 300_000);

  it('scenario 5: after all the races — every evaluator tx on chain had its ledger row before the broadcast; one winner per nonce, the rest DEAD; nothing live; no decision changed; no proxy request abandoned', async () => {
    await reconcile();
    const latest = await chain.publicClient.getBlockNumber();
    const mined: Array<{ hash: string; nonce: number }> = [];
    for (let b = startBlock + 1n; b <= latest; b++) {
      const block = await chain.publicClient.getBlock({ blockNumber: b, includeTransactions: true });
      for (const tx of block.transactions) if (same(tx.from, evaluator.address)) mined.push({ hash: lower(tx.hash), nonce: tx.nonce });
    }
    expect(mined.length).toBeGreaterThan(0);
    expect(new Set(mined.map((m) => m.nonce)).size, 'one mined tx per nonce').toBe(mined.length);
    expect(mined.map((m) => m.nonce).sort((a, b) => a - b)).toEqual(mined.map((_, i) => i));
    const allProbes = [...pW.sendRaws, ...pS.sendRaws, ...p0.sendRaws];
    for (const m of mined) {
      const rows = await rowsOf({ nonce: m.nonce });
      const row = rows.find((r) => same(r.txHash, m.hash));
      expect(row, `mined ${m.hash} (nonce ${m.nonce}) has a ledger row`).toBeTruthy();
      expect(['MINED_SUCCESS', 'MINED_REVERTED']).toContain(row!.status);
      for (const r of rows) if (r !== row) expect(r.status, `nonce ${m.nonce}: loser ${r.txHash}`).toBe('DEAD');
      const probes = allProbes.filter((p) => same(p.hash, m.hash));
      expect(probes.length, `${m.hash} went through a process proxy`).toBeGreaterThan(0);
      for (const p of probes) expect(p.verdict).toMatchObject({ row: true });
    }
    expect((await evaluatorPool()).size).toBe(0);
    expect(await rowsOf({ status: { in: ['SIGNED', 'SENT', 'SEND_UNCONFIRMED'] } }), 'nothing left live').toHaveLength(0);
    expect(await db.job.count({ where: { resolution: { not: null } } }), 'no decision changed').toBe(0);
    // every SCRIPT row spent an incident's budget within the per-tx cap
    const perIncident = new Map<string, bigint>();
    for (const r of await rowsOf({ origin: 'SCRIPT' })) {
      expect(r.incidentId).toBeTruthy();
      const cost = BigInt(r.gasLimit!) * BigInt(r.maxFeePerGas!);
      expect(cost).toBeLessThanOrEqual(CAPS_PER_TX);
      perIncident.set(r.incidentId!, (perIncident.get(r.incidentId!) ?? 0n) + cost);
    }
    expect(perIncident.size).toBeGreaterThan(0);
    for (const [, total] of perIncident) expect(total).toBeLessThanOrEqual(BigInt(TEST_CAPS[`EVALUATOR_RECOVERY_MAX_INCIDENT_COST_WEI_${CHAIN_ID}`]!));
    expect([...pW.aborted, ...pS.aborted, ...p0.aborted]).toHaveLength(0);
    expect(timeline.filter((e) => e.kind === 'proxy-error')).toHaveLength(0);
  }, 120_000);
});

/** SCRIPT rows written by earlier scenarios (e.g. 3a's never-sent speed-up): a scenario counts on top of them. */
let scriptRowsAtStart = 0;
beforeEach(async () => {
  if (!AVAIL) return;
  scriptRowsAtStart = await db.evaluatorTransaction.count({ where: { origin: 'SCRIPT' } });
});
