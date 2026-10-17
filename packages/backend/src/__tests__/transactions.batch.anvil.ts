/**
 * A6d — `POST /v1/transactions/batch` end to end on REAL local contracts
 * (Anvil, chain id 84532) and REAL Postgres.
 *
 * `AgentExecutor.executeBatch` requires `msg.value >= ΣV + F`, F =
 * floor(ΣV × feeBps / 10 000) on the SUM of the action values; it reverts
 * `InsufficientValueForFee(sent, required)` otherwise. Before A6d the route
 * sent ΣV only, so every agent batch with ≥ 334 wei of native value failed
 * its simulation (found in #182, contract-level side finding in
 * contract-identity.executor.anvil.ts).
 *
 * Real here: the batch route, its policy checks, pricing (synthetic test
 * price 2000 USD / ETH on 84532, Q9), the outflow cap and the DailyVolume
 * reservation on Postgres (DATABASE_URL), the production simulation path
 * (`eth_call` dry-run via `estimateGas`, as in production without Tenderly),
 * the S9 identity check of the deployed executor + module, the transaction
 * processor + pre-submit guard, the submitter (signing with the agent's
 * local-wallet key, broadcasting to Anvil), the monitor, the stranded-QUEUED
 * sweep; `AgentPolicyModule` / `AgentExecutor` deployed from the Foundry
 * artifacts. Faked: the BullMQ queue (jobs captured and run through the
 * processor by the test), notifications, the fee oracle (2000 USD / ETH,
 * fees only) and FeeEvent persistence (captured).
 *
 * Skipped with a warning when DATABASE_URL is not a reachable, migrated
 * database (fails on CI). Anvil: `anvilTestPort(6)` (default 8751).
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => {
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
  process.env['WALLET_PROVIDER'] = 'local';
  // Q9: Base Sepolia native value priced only with an explicit synthetic price.
  process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2000';
  return {
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    feeEvents: [] as Array<{ transactionId: string; feeAmountWei: bigint; feeBps: number }>,
    simulations: [] as Array<{ value: bigint; provider: string; success: boolean }>,
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('bullmq', () => ({
  Queue: class {
    add = async () => undefined;
    getJob = async () => undefined;
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: {
    add: async (name: string, data: Record<string, unknown>) => {
      h.queued.push({ name, data });
      return { id: `job-${h.queued.length}` };
    },
  },
}));
vi.mock('../services/notification.service.js', () => ({ notificationService: { notify: async () => undefined } }));
// Fees / revenue only (the processor prices the collected fee); policy accounting on 84532 uses the synthetic price.
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6),
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
// The production simulation path (eth_call / estimateGas against the chain) in place of the dev / test mock.
vi.mock('../services/transaction/simulator.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/transaction/simulator.service.js')>('../services/transaction/simulator.service.js');
  type Params = Parameters<InstanceType<typeof actual.SimulatorService>['simulate']>[0];
  type Result = Awaited<ReturnType<InstanceType<typeof actual.SimulatorService>['simulate']>>;
  class EthCallSimulator extends actual.SimulatorService {
    override async simulate(params: Params): Promise<Result> {
      const result = await (this as unknown as { simulateWithEthCall(p: Params): Promise<Result> }).simulateWithEthCall(params);
      h.simulations.push({ value: params.value, provider: result.provider, success: result.success });
      return result;
    }
  }
  return { ...actual, SimulatorService: EthCallSimulator };
});
// Hermetic: the chain client reads only RPC_URL_84532 (Anvil), never a public RPC.
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  const { createPublicClient, http } = await import('viem');
  return {
    ...actual,
    createChainPublicClient: (chainId: number) =>
      createPublicClient({ chain: actual.getChain(chainId), transport: http(process.env[`RPC_URL_${chainId}`], { retryCount: 0, timeout: 5_000 }) }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BaseError, decodeErrorResult, encodeFunctionData, getAddress, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { anvilAccount, anvilTestPort, deployPolicyStack, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "broadcastTxHash" FROM "Transaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('transactions.batch.anvil.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[transactions.batch.anvil] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const CHAIN_ID = 84532;
const NAME_PREFIX = 'a6d-batch';
const RUN = randomBytes(3).toString('hex');
const EXECUTOR_ABI = readArtifact('AgentExecutor').abi;
const FEE_WALLET = getAddress(process.env['OPERATOR_FEE_WALLET']!);
const T1 = getAddress('0x00000000000000000000000000000000000a6d01');
const T2 = getAddress('0x00000000000000000000000000000000000a6d02');
/** A target whose code is INVALID: any call to it reverts (the simulation must see it). */
const REVERTER = getAddress('0x00000000000000000000000000000000000a6dff');
/** floor(ΣV × 30 / 10 000): the executor's own formula (AgentExecutor.calculateFee). */
const feeOf = (sum: bigint) => (sum * 30n) / 10_000n;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  processor: typeof import('../queues/transaction.processor.js');
  stranded: typeof import('../services/transaction/stranded-queued.js');
  SubmitterService: typeof import('../services/transaction/submitter.service.js')['SubmitterService'];
  MonitorService: typeof import('../services/transaction/monitor.service.js')['MonitorService'];
  getWalletService: typeof import('../services/wallet/index.js')['getWalletService'];
  policyStack: typeof import('../config/policy-stack-boot.runtime.js');
};
let m: Modules;
let chain: LocalChain;
let executor: Address;
let app: FastifyInstance;
let callerId = '';
let seq = 0;

beforeAll(async () => {
  if (!DB_READY) return;
  chain = await startLocalChain({ port: anvilTestPort(6), chainId: CHAIN_ID });
  const operator = anvilAccount(1).address;
  // The S9 verification compares executor.feeWallet() with OPERATOR_FEE_WALLET and feeBps() with FEE_BPS (30).
  const stack = await deployPolicyStack(chain, { deployer: anvilAccount(0), operator, feeWallet: FEE_WALLET });
  executor = stack.executor;
  process.env['POLICY_MODULE_ADDRESS_84532'] = stack.policyModule;
  process.env['RPC_URL_84532'] = chain.rpcUrl;
  process.env['EXECUTOR_ADDRESS_84532'] = executor;
  process.env['POLICY_OPERATOR_ADDRESS_84532'] = operator;
  await chain.rpc('anvil_setCode', [REVERTER, '0xfe']);

  m = {
    db: (await import('../db/client.js')).db,
    transactionRoutes: (await import('../api/routes/transactions.js')).transactionRoutes,
    registerErrorHandler: (await import('../api/errors/handler.js')).registerErrorHandler,
    processor: await import('../queues/transaction.processor.js'),
    stranded: await import('../services/transaction/stranded-queued.js'),
    SubmitterService: (await import('../services/transaction/submitter.service.js')).SubmitterService,
    MonitorService: (await import('../services/transaction/monitor.service.js')).MonitorService,
    getWalletService: (await import('../services/wallet/index.js')).getWalletService,
    policyStack: await import('../config/policy-stack-boot.runtime.js'),
  };
  await wipe();
  // S9: the real identity check of the deployed executor + module (fee wallet, 30 bps) opens the gate.
  expect(await m.policyStack.runPolicyStackBootCheck('api')).toMatchObject({ fatal: null, verified: [CHAIN_ID] });

  app = Fastify({ logger: false });
  m.registerErrorHandler(app);
  app.decorateRequest('agentId', '');
  app.decorateRequest('agentTier', 'FREE');
  app.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string }).agentId = callerId;
  });
  await app.register(m.transactionRoutes);
  await app.ready();
});

afterAll(async () => {
  if (!DB_READY) return;
  await wipe().catch(() => undefined);
  m?.policyStack.__stopPolicyStackRecheckForTests();
  await app?.close();
  await m?.db.$disconnect();
  chain?.stop();
});

beforeEach(() => {
  h.queued.length = 0;
  h.feeEvents.length = 0;
  h.simulations.length = 0;
});

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentBilling.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

/** An EOA-mode agent (local wallet = safeAddress) funded with 1 ETH on Anvil. */
async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  const name = `${NAME_PREFIX} ${RUN}-${seq}`;
  const { walletId, address } = await m.getWalletService().createWallet(name);
  await chain.setBalance(address, parseEther('1'));
  const agent = await m.db.agent.create({
    data: {
      name,
      apiKeyHash: `a6d-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_a6d',
      walletId,
      safeAddress: address,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '0.5',
          maxValueForAutoApprovalEth: '0.5',
          maxDailyVolumeUsd: '1000',
          maxOutflowPerTxUsd: '1000',
          cooldownSeconds: 0,
          allowedContracts: [],
          allowedRecipients: [],
          allowedTokens: [],
          ...policy,
        },
      },
    },
  });
  callerId = agent.id;
  return { ...agent, eoa: getAddress(address) };
}

function postBatch(values: string[], targets: Address[] = [T1, T2]) {
  return app.inject({
    method: 'POST',
    url: '/v1/transactions/batch',
    payload: { chainId: CHAIN_ID, actions: values.map((value, i) => ({ to: targets[i % targets.length], value, data: '0x' })) },
  });
}

/** Runs every captured job through the real processor (guard → submitter → Anvil) and waits for the receipts. */
async function drain(): Promise<Array<{ txHash: Hex | null; error?: string }>> {
  const jobs = h.queued.splice(0);
  const monitors: Promise<void>[] = [];
  const submitter = new m.SubmitterService({ client: () => chain.publicClient as never });
  const monitor = new m.MonitorService(m.db, {
    getReceipt: (_chainId, hash) => chain.publicClient.getTransactionReceipt({ hash }),
    sleep: () => new Promise((r) => setTimeout(r, 50)),
  });
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const results: Array<{ txHash: Hex | null; error?: string }> = [];
  for (const job of jobs) {
    try {
      const out = await m.processor.processTransactionJob(
        { data: job.data as never, attemptsMade: 0, opts: { attempts: 3 } },
        {
          db: m.db,
          submitter,
          monitor,
          feeService: {
            incrementTxUsage: async () => undefined,
            recordFeeEvent: async (p: { transactionId: string; feeAmountWei: bigint; feeBps: number }) => {
              h.feeEvents.push({ transactionId: p.transactionId, feeAmountWei: p.feeAmountWei, feeBps: p.feeBps });
            },
          } as never,
          logger,
          trackMonitor: (p) => monitors.push(p),
        },
      );
      results.push({ txHash: out.txHash });
    } catch (err) {
      results.push({ txHash: null, error: (err as Error).message });
    }
  }
  await Promise.all(monitors);
  return results;
}

const balance = (address: Address) => chain.publicClient.getBalance({ address });

async function volume(agentId: string): Promise<number> {
  const all = await m.db.dailyVolume.findMany({ where: { agentId } });
  return all.reduce((sum, r) => sum + Number(r.volumeUsd), 0);
}

describeDb('A6d on Anvil — the executor contract itself', () => {
  it('executeBatch with msg.value = ΣV (what the route sent before A6d) reverts InsufficientValueForFee(334, 335); ΣV + F passes', async () => {
    const agent = await mkAgent();
    const data = encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [[{ target: T1, value: 334n, token: zeroAddress, data: '0x' }]],
    });
    let revertData: Hex | undefined;
    try {
      await chain.publicClient.call({ account: agent.eoa, to: executor, data, value: 334n });
    } catch (err) {
      revertData = ((err as BaseError).walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data;
    }
    expect(revertData).toBeDefined();
    const decoded = decodeErrorResult({ abi: EXECUTOR_ABI, data: revertData! });
    expect(decoded.errorName).toBe('InsufficientValueForFee');
    expect(decoded.args).toEqual([334n, 335n]);
    await expect(chain.publicClient.call({ account: agent.eoa, to: executor, data, value: 335n })).resolves.toBeDefined();
  });
});

describeDb('A6d on Anvil — the route sends ΣV + F and the executor collects F', () => {
  it.each([
    ['334 wei (the threshold)', ['334']],
    ['200 + 200 wei (fee on the sum: 1 wei; per action it would be 0 + 0 and revert)', ['200', '200']],
    ['0.01 ETH', ['10000000000000000']],
    ['0.004 + 0.006 ETH', ['4000000000000000', '6000000000000000']],
  ])('%s: the real simulation passes, the batch is mined, each target gets its value, the fee wallet gets exactly F, and the FeeEvent records F', async (_label, values) => {
    const agent = await mkAgent();
    const sum = values.reduce((s, v) => s + BigInt(v), 0n);
    const fee = feeOf(sum);
    const before = { t1: await balance(T1), t2: await balance(T2), fee: await balance(FEE_WALLET) };

    const res = await postBatch(values);

    expect(res.statusCode, res.body).toBe(202);
    expect(h.simulations).toEqual([{ value: sum + fee, provider: 'eth_call', success: true }]);
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.data).toMatchObject({ to: executor, value: (sum + fee).toString(), feeAmountWei: fee.toString(), routedViaExecutor: true });

    const [result] = await drain();
    expect(result!.txHash, result!.error).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: result!.txHash! });
    expect(receipt.status).toBe('success');
    const sent = await chain.publicClient.getTransaction({ hash: result!.txHash! });
    expect(sent.value).toBe(sum + fee);
    expect(getAddress(sent.to!)).toBe(getAddress(executor));

    const perTarget = (target: Address) => values.reduce((s, v, i) => s + ([T1, T2][i % 2] === target ? BigInt(v) : 0n), 0n);
    expect((await balance(T1)) - before.t1).toBe(perTarget(T1));
    expect((await balance(T2)) - before.t2).toBe(perTarget(T2));
    expect((await balance(FEE_WALLET)) - before.fee).toBe(fee);

    const row = await m.db.transaction.findFirstOrThrow({ where: { agentId: agent.id } });
    expect(row).toMatchObject({ status: 'CONFIRMED', type: 'BATCH', amountIn: sum.toString() });
    // Revenue: the FeeEvent is what the executor collected on-chain.
    expect(h.feeEvents).toEqual(fee > 0n ? [{ transactionId: row.id, feeAmountWei: fee, feeBps: 30 }] : []);
  });

  it('the stranded-QUEUED sweep re-enqueues from queuePayload with the same ΣV + F, and that batch is mined too', async () => {
    const agent = await mkAgent();
    const sum = 10_000_000_000_000_000n;
    const fee = feeOf(sum);
    const before = await balance(FEE_WALLET);

    const res = await postBatch([sum.toString()]);
    expect(res.statusCode, res.body).toBe(202);
    h.queued.length = 0; // the crash between the row and the enqueue: the job is lost

    const requeued: Array<{ name: string; data: Record<string, unknown> }> = [];
    await m.stranded.recoverStrandedQueuedTransactions(
      {
        db: m.db,
        queue: { add: async (name: string, data: Record<string, unknown>) => { requeued.push({ name, data }); return {} as never; }, getJob: async () => undefined } as never,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
      // Never a 0-ms age cut-off against Postgres timestamps (clock skew).
      { olderThan: new Date(Date.now() + 60_000), limit: 100 },
    );
    const mine = requeued.filter((j) => j.data['agentId'] === agent.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data).toMatchObject({ value: (sum + fee).toString(), feeAmountWei: fee.toString(), routedViaExecutor: true });

    h.queued.push(...mine);
    const [result] = await drain();
    expect(result!.txHash, result!.error).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.publicClient.getTransactionReceipt({ hash: result!.txHash! })).status).toBe('success');
    expect((await balance(FEE_WALLET)) - before).toBe(fee);
  });

  it('the simulation is real: a batch whose action reverts is 422 before anything is reserved or sent', async () => {
    const agent = await mkAgent();
    const nonce = await chain.publicClient.getTransactionCount({ address: agent.eoa });

    const res = await postBatch(['1000'], [REVERTER]);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toMatch(/Batch simulation failed/);
    expect(h.simulations).toHaveLength(1);
    expect(h.simulations[0]).toMatchObject({ provider: 'eth_call', success: false });
    expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(0);
    expect(await volume(agent.id)).toBe(0);
    expect(await chain.publicClient.getTransactionCount({ address: agent.eoa })).toBe(nonce);
  });
});

describeDb('A6d on Anvil — the USD policy counts ΣV + F (D15 / D17 / A6)', () => {
  it('the reservation is the synthetic price of ΣV + F, committed once on confirmation', async () => {
    const agent = await mkAgent();

    const res = await postBatch(['10000000000000000']); // 0.01 ETH = 20 USD, + 0.00003 ETH = 0.06 USD

    expect(res.statusCode, res.body).toBe(202);
    expect(await m.db.transaction.findFirstOrThrow({ where: { agentId: agent.id } })).toMatchObject({
      volumeState: 'RESERVED',
      volumeReservedUsd: '20.060000',
      volumePriceSource: 'synthetic',
    });
    expect(await volume(agent.id)).toBeCloseTo(20.06, 6);
    await drain();
    expect(await m.db.transaction.findFirstOrThrow({ where: { agentId: agent.id } })).toMatchObject({ status: 'CONFIRMED', volumeState: 'COMMITTED' });
    expect(await volume(agent.id)).toBeCloseTo(20.06, 6);
  });

  it('above maxOutflowPerTxUsd: 403 before any simulation, nothing reserved, nothing sent', async () => {
    const agent = await mkAgent({ maxOutflowPerTxUsd: '10' });
    const nonce = await chain.publicClient.getTransactionCount({ address: agent.eoa });

    const res = await postBatch(['10000000000000000']);

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'maxOutflowPerTxUsd', limit: '10' });
    expect(h.simulations).toEqual([]);
    expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(0);
    expect(await chain.publicClient.getTransactionCount({ address: agent.eoa })).toBe(nonce);
  });

  it('ΣV exactly at maxOutflowPerTxUsd is refused (F on top); ΣV + F exactly at it is accepted and mined', async () => {
    const atCap = await mkAgent({ maxOutflowPerTxUsd: '20' });
    const refused = await postBatch(['10000000000000000']);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ rule: 'maxOutflowPerTxUsd' });
    expect(await m.db.transaction.count({ where: { agentId: atCap.id } })).toBe(0);

    await mkAgent({ maxOutflowPerTxUsd: '20.06' });
    const ok = await postBatch(['10000000000000000']);
    expect(ok.statusCode, ok.body).toBe(202);
    const [result] = await drain();
    expect((await chain.publicClient.getTransactionReceipt({ hash: result!.txHash! })).status).toBe('success');
  });

  it('the daily limit binds on ΣV + F: a batch that would exceed the remaining room is 403, nothing reserved or sent', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '30' });
    expect((await postBatch(['10000000000000000'])).statusCode).toBe(202); // 20.06 reserved
    h.queued.length = 0;
    h.simulations.length = 0;

    const res = await postBatch(['5000000000000000']); // 10 USD + 0.03 USD fee: 30.09 > 30

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toMatch(/Daily volume limit/);
    expect(await volume(agent.id)).toBeCloseTo(20.06, 6);
    expect(h.queued).toEqual([]);
  });
});
