/**
 * S8 — the operator-triggered on-chain policy sync, end to end on REAL
 * Postgres and REAL local contracts (Anvil).
 *
 * Real here: the admin / agent routes, Prisma on DATABASE_URL, the local
 * wallet provider (the agent's EOA key lives in this process, as with
 * WALLET_PROVIDER=local), the transaction processor + pre-submit guard, the
 * submitter (signing with the agent's key, broadcasting to Anvil), the monitor
 * (receipts from Anvil), `AgentPolicyModule` / `AgentExecutor` deployed from
 * the Foundry artifacts. Faked: the BullMQ queue (jobs are captured and run
 * through `processTransactionJob` by the test), notifications, fees.
 *
 * What it pins (S8 acceptance):
 *  - only the admin credential triggers a sync, and only of the policy stored
 *    in the DB (no free-form calldata), sent DIRECTLY to the module from the
 *    agent's own EOA (msg.sender == safe in EOA mode), never via the executor;
 *  - the module's policy reads back equal to the DB policy afterwards;
 *  - an agent-initiated PATCH cannot change the on-chain policy;
 *  - the API shows the DB policy and the on-chain policy apart while a sync
 *    is pending or has failed;
 *  - the kill switch reaches the chain while the agent is paused.
 *
 * Skipped with a warning when DATABASE_URL is not a reachable, migrated
 * database (fails on CI). Anvil: `anvilTestPort(1)` (default 8746), chain 84532.
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
  return { queued: [] as Array<{ name: string; data: Record<string, unknown> }> };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const error = (...args: unknown[]) => (process.env['S8_DEBUG'] ? console.error(...args) : undefined);
  const logger: Record<string, unknown> = { info: noop, warn: noop, error, debug: noop, trace: noop, fatal: noop };
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
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, parseEther, type Address, type Hex } from 'viem';
import {
  anvilAccount,
  anvilTestPort,
  deployPolicyStack,
  readArtifact,
  startLocalChain,
  type LocalChain,
} from './helpers/anvil-contracts.js';

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
  if (process.env['CI']) throw new Error('policy-sync.routes.anvil.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[policy-sync.routes.anvil] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const CHAIN_ID = 84532;
const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
const NAME_PREFIX = 's8-sync';
const RUN = randomBytes(3).toString('hex');
const MODULE_ABI = readArtifact('AgentPolicyModule').abi;
const C1 = getAddress('0x00000000000000000000000000000000000c0001');
const C2 = getAddress('0x00000000000000000000000000000000000c0002');
const T1 = getAddress('0x00000000000000000000000000000000000e0001');

type Modules = {
  db: typeof import('../db/client.js')['db'];
  adminRoutes: typeof import('../api/routes/admin.js')['adminRoutes'];
  agentRoutes: typeof import('../api/routes/agents.js')['agentRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  processor: typeof import('../queues/transaction.processor.js');
  SubmitterService: typeof import('../services/transaction/submitter.service.js')['SubmitterService'];
  MonitorService: typeof import('../services/transaction/monitor.service.js')['MonitorService'];
  getWalletService: typeof import('../services/wallet/index.js')['getWalletService'];
  policyStack: typeof import('../config/policy-stack-boot.runtime.js');
  policyStackState: typeof import('../config/policy-stack-verification.runtime.js');
};
let m: Modules;
let chain: LocalChain;
let policyModule: Address;
let executor: Address;
let app: FastifyInstance;
let seq = 0;

/** The agent the next request authenticates as (agent routes); null = operator (`isOperator`). */
let caller: { agentId: string } | null = null;

beforeAll(async () => {
  if (!DB_READY) return;
  chain = await startLocalChain({ port: anvilTestPort(1), chainId: CHAIN_ID });
  const deployer = anvilAccount(0);
  ({ policyModule, executor } = await deployPolicyStack(chain, {
    deployer,
    operator: anvilAccount(1).address,
    // The S9 verification compares executor.feeWallet() with OPERATOR_FEE_WALLET.
    feeWallet: getAddress(process.env['OPERATOR_FEE_WALLET']!),
  }));
  process.env['RPC_URL_84532'] = chain.rpcUrl;
  process.env['POLICY_MODULE_ADDRESS_84532'] = policyModule;
  process.env['EXECUTOR_ADDRESS_84532'] = executor;
  process.env['POLICY_OPERATOR_ADDRESS_84532'] = anvilAccount(1).address;

  m = {
    db: (await import('../db/client.js')).db,
    adminRoutes: (await import('../api/routes/admin.js')).adminRoutes,
    agentRoutes: (await import('../api/routes/agents.js')).agentRoutes,
    registerErrorHandler: (await import('../api/errors/handler.js')).registerErrorHandler,
    processor: await import('../queues/transaction.processor.js'),
    SubmitterService: (await import('../services/transaction/submitter.service.js')).SubmitterService,
    MonitorService: (await import('../services/transaction/monitor.service.js')).MonitorService,
    getWalletService: (await import('../services/wallet/index.js')).getWalletService,
    policyStack: await import('../config/policy-stack-boot.runtime.js'),
    policyStackState: await import('../config/policy-stack-verification.runtime.js'),
  };
  await wipe();
  // S9: the real boot check against the real deployment — the sync is gated on it.
  const verdict = await m.policyStack.runPolicyStackBootCheck('api');
  expect(verdict).toMatchObject({ fatal: null, verified: [CHAIN_ID] });

  app = Fastify({ logger: false });
  m.registerErrorHandler(app);
  app.decorateRequest('agentId', '');
  app.decorateRequest('agentTier', 'FREE');
  app.decorateRequest('isOperator', false);
  app.addHook('preHandler', async (request) => {
    const r = request as unknown as { agentId: string; isOperator: boolean };
    if (caller) {
      r.agentId = caller.agentId;
      r.isOperator = false;
    } else {
      r.isOperator = true;
    }
  });
  await app.register(m.adminRoutes);
  await app.register(m.agentRoutes);
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
  caller = null;
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

/** An EOA-mode agent: a local wallet whose address is its `safeAddress`, funded on Anvil unless `fund` is false. */
async function mkAgent(policy: Record<string, unknown>, opts: { fund?: boolean; safeAddress?: Address } = {}) {
  seq++;
  const name = `${NAME_PREFIX} ${RUN}-${seq}`;
  const { walletId, address } = await m.getWalletService().createWallet(name);
  if (opts.fund !== false) await chain.setBalance(address, parseEther('1'));
  const agent = await m.db.agent.create({
    data: {
      name,
      apiKeyHash: `s8-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_s8',
      walletId,
      safeAddress: opts.safeAddress ?? address,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '0.5',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          allowedContracts: [],
          allowedRecipients: [],
          allowedTokens: [],
          ...policy,
        },
      },
    },
  });
  return { ...agent, eoa: address };
}

const adminHeaders = { 'x-admin-secret': ADMIN_SECRET };

async function syncStatus(agentId: string) {
  const res = await app.inject({ method: 'GET', url: `/admin/agents/${agentId}/policy/onchain`, headers: adminHeaders });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function requestSync(agentId: string) {
  return app.inject({ method: 'POST', url: `/admin/agents/${agentId}/policy/sync`, headers: adminHeaders });
}

/** Runs every captured transaction job through the real processor and waits for the receipts. */
async function drain(
  opts: { attemptsMade?: number; betweenGuardAndSigning?: () => Promise<void> } = {},
): Promise<Array<{ txHash: Hex | null; error?: string; outcome?: string }>> {
  const jobs = h.queued.splice(0);
  const monitors: Promise<void>[] = [];
  const real = new m.SubmitterService({ client: () => chain.publicClient as never });
  // The processor calls submit() only after the pre-submit guard passed; the real
  // submitter then signs inside the wallet lane and calls onBeforeBroadcast.
  const submitter = {
    submit: async (params: Parameters<typeof real.submit>[0]) => {
      await opts.betweenGuardAndSigning?.();
      return real.submit(params);
    },
  };
  const monitor = new m.MonitorService(m.db, {
    getReceipt: (_chainId, hash) => chain.publicClient.getTransactionReceipt({ hash }),
    sleep: () => new Promise((r) => setTimeout(r, 50)),
  });
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const results: Array<{ txHash: Hex | null; error?: string; outcome?: string }> = [];
  for (const job of jobs) {
    const jobLike = { data: job.data as never, attemptsMade: opts.attemptsMade ?? 0, opts: { attempts: 3 } };
    try {
      const out = await m.processor.processTransactionJob(jobLike, {
        db: m.db,
        submitter,
        monitor,
        feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never,
        logger,
        trackMonitor: (p) => monitors.push(p),
      });
      results.push({ txHash: out.txHash, ...('outcome' in out ? { outcome: out.outcome } : {}) });
    } catch (err) {
      results.push({ txHash: null, error: (err as Error).message });
      // BullMQ's last attempt: the permanent-failure handler.
      await m.processor.handleFailedTransactionJob({ ...jobLike, attemptsMade: 3 }, err as Error, {
        db: m.db,
        deadLetterQueue: { add: async () => undefined } as never,
        logger,
      });
    }
  }
  await Promise.all(monitors);
  return results;
}

async function onChainPolicy(safe: Address) {
  return chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'getPolicy', args: [safe] }) as Promise<{
    maxValuePerTx: bigint;
    cooldownBetweenTx: bigint;
    active: boolean;
    policyExpiresAt: bigint;
    numAllowedContracts: bigint;
    numAllowedTokens: bigint;
  }>;
}

async function hasPolicy(safe: Address): Promise<boolean> {
  return chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'hasPolicy', args: [safe] }) as Promise<boolean>;
}

async function contractAllowedRaw(safe: Address, target: Address): Promise<boolean> {
  return chain.publicClient.readContract({ address: policyModule, abi: MODULE_ABI, functionName: 'isContractAllowed', args: [safe, target] }) as Promise<boolean>;
}

describeDb('S8 — operator-triggered sync takes effect on-chain', () => {
  it('syncs the DB policy (limits + both whitelists) from the agent EOA straight to the module, then reads back in sync', async () => {
    const agent = await mkAgent({ allowedContracts: [C1, C2], allowedRecipients: [], allowedTokens: [T1] });

    const before = await syncStatus(agent.id);
    expect(before.status).toBe('out-of-sync');
    expect(before.onChain.hasPolicy).toBe(false);
    expect(before.differences.length).toBeGreaterThan(0);

    const res = await requestSync(agent.id);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.transactions.map((t: { call: string }) => t.call).sort()).toEqual(['setPolicy', 'updateContractWhitelist', 'updateTokenWhitelist']);
    // Every queued call goes to the module itself, signed by the agent's wallet — never via the executor.
    expect(h.queued).toHaveLength(3);
    for (const job of h.queued) {
      expect(getAddress(job.data['to'] as string)).toBe(getAddress(policyModule));
      expect(getAddress(job.data['from'] as string)).toBe(getAddress(agent.eoa));
      expect(job.data['walletId']).toBe(agent.walletId);
      expect(job.data['value']).toBe('0');
      expect(job.data['routedViaExecutor']).toBe(false);
    }

    // Pending: the DB policy and the on-chain policy are shown apart.
    const pending = await syncStatus(agent.id);
    expect(pending.status).toBe('pending');
    expect(pending.pending).toHaveLength(3);
    expect(pending.onChain.hasPolicy).toBe(false);
    expect(pending.db.maxValuePerTxWei).toBe(parseEther('0.5').toString());

    const results = await drain();
    expect(results.every((r) => r.txHash !== null)).toBe(true);

    const after = await syncStatus(agent.id);
    expect(after.status).toBe('in-sync');
    expect(after.differences).toEqual([]);

    const read = await onChainPolicy(agent.eoa);
    expect(read.maxValuePerTx).toBe(parseEther('0.5'));
    expect(read.cooldownBetweenTx).toBe(0n);
    expect(read.active).toBe(true);
    expect(read.policyExpiresAt).toBe(0n);
    expect(read.numAllowedContracts).toBe(2n);
    expect(read.numAllowedTokens).toBe(1n);
    expect(await contractAllowedRaw(agent.eoa, C1)).toBe(true);
    expect(await contractAllowedRaw(agent.eoa, getAddress('0x00000000000000000000000000000000000c0099'))).toBe(false);

    // Nothing left to do: a second sync queues nothing.
    const again = await requestSync(agent.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'in-sync', transactions: [] });
    expect(h.queued).toHaveLength(0);
  });

  it('a later whitelist change is synced by REMOVING the dropped entry on-chain (not only adding)', async () => {
    const agent = await mkAgent({ allowedContracts: [C1, C2], allowedRecipients: [] });
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    await drain();
    expect(await contractAllowedRaw(agent.eoa, C2)).toBe(true);

    const patch = await app.inject({ method: 'PATCH', url: `/v1/agents/${agent.id}/policy`, payload: { allowedContracts: [C1] } });
    expect(patch.statusCode).toBe(200);
    const drift = await syncStatus(agent.id);
    expect(drift.status).toBe('out-of-sync');
    expect(drift.differences.join(' ')).toContain(C2);

    const res = await requestSync(agent.id);
    expect(res.statusCode).toBe(202);
    expect(res.json().transactions.map((t: { call: string }) => t.call)).toEqual(['updateContractWhitelist']);
    await drain();

    expect(await contractAllowedRaw(agent.eoa, C2)).toBe(false);
    expect((await onChainPolicy(agent.eoa)).numAllowedContracts).toBe(1n);
    expect((await syncStatus(agent.id)).status).toBe('in-sync');
  });

  it('the kill switch with syncOnChain pushes the pause on-chain while the agent is paused, and the resume pushes it back', async () => {
    const agent = await mkAgent({});
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    await drain();
    expect((await onChainPolicy(agent.eoa)).active).toBe(true);

    const pause = await app.inject({ method: 'POST', url: `/admin/agents/${agent.id}/pause`, headers: adminHeaders, payload: { syncOnChain: true } });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().active).toBe(false);
    expect(pause.json().onChainSync.status).toBe('pending');
    await drain();
    expect((await onChainPolicy(agent.eoa)).active).toBe(false);
    expect((await syncStatus(agent.id)).status).toBe('in-sync');

    const resume = await app.inject({ method: 'POST', url: `/admin/agents/${agent.id}/resume`, headers: adminHeaders, payload: { syncOnChain: true } });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().onChainSync.status).toBe('pending');
    await drain();
    expect((await onChainPolicy(agent.eoa)).active).toBe(true);
  });
});

describeDb('S8 — nobody else can change the on-chain policy', () => {
  it('without the admin credential the sync route answers 401 and nothing is queued', async () => {
    const agent = await mkAgent({});
    const res = await app.inject({ method: 'POST', url: `/admin/agents/${agent.id}/policy/sync` });
    expect(res.statusCode).toBe(401);
    expect(h.queued).toHaveLength(0);
    expect(await hasPolicy(agent.eoa)).toBe(false);
  });

  it('an agent PATCH with syncOnChain gets no calldata, queues nothing and leaves the chain as it was (DB vs chain shown apart)', async () => {
    const agent = await mkAgent({ cooldownSeconds: 0 });
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    await drain();

    caller = { agentId: agent.id };
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${agent.id}/policy`,
      payload: { cooldownSeconds: 30, syncOnChain: true },
    });
    expect(patch.statusCode).toBe(200);
    const sync = patch.json().onChainSync;
    expect(sync).not.toHaveProperty('actions');
    expect(JSON.stringify(sync)).not.toMatch(/0x[0-9a-f]{64,}/i);
    expect(h.queued).toHaveLength(0);
    caller = null;

    expect((await onChainPolicy(agent.eoa)).cooldownBetweenTx).toBe(0n);
    const status = await syncStatus(agent.id);
    expect(status.status).toBe('out-of-sync');
    expect(status.db.cooldownSeconds).toBe(30);
    expect(status.onChain.cooldownSeconds).toBe(0);
  });

  it('the admin batch refuses the policy module as a target (the executor path can never sync)', async () => {
    const agent = await mkAgent({});
    const res = await app.inject({
      method: 'POST',
      url: '/admin/transactions/batch',
      headers: adminHeaders,
      payload: { chainId: CHAIN_ID, agentId: agent.id, actions: [{ to: policyModule, value: '0', data: '0x12345678' }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('POLICY_MODULE_TARGET');
    expect(h.queued).toHaveLength(0);
  });

  it('a Safe-mode agent (safeAddress is not its signing EOA) is refused: msg.sender would not be the safe', async () => {
    const agent = await mkAgent({}, { safeAddress: getAddress('0x00000000000000000000000000000000005afe01') });
    const res = await requestSync(agent.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('POLICY_SYNC_WALLET_MODE');
    expect(h.queued).toHaveLength(0);
    expect((await syncStatus(agent.id)).walletMode).toBe('safe');
  });

  it('a policy the module cannot hold (maxValuePerTxEth "0") is refused, not rounded', async () => {
    const agent = await mkAgent({ maxValuePerTxEth: '0' });
    const res = await requestSync(agent.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('POLICY_NOT_REPRESENTABLE');
    expect(h.queued).toHaveLength(0);
  });
});

describeDb('S9 — the sync is gated on the AgentExecutor / AgentPolicyModule verification', () => {
  it('unverified (process restarted, nothing read yet): 503 CONTRACTS_UNVERIFIED, nothing queued; the kill switch reports the refusal; verified again → syncs', async () => {
    const agent = await mkAgent({});
    m.policyStackState.__resetPolicyStackVerificationForTests();

    const res = await requestSync(agent.id);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'refused', code: 'CONTRACTS_UNVERIFIED' });
    expect((await syncStatus(agent.id)).contracts).toMatchObject({ allowed: false, state: 'not-verified-yet' });

    const pause = await app.inject({ method: 'POST', url: `/admin/agents/${agent.id}/pause`, headers: adminHeaders, payload: { syncOnChain: true } });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ active: false, onChainSync: { status: 'refused', code: 'CONTRACTS_UNVERIFIED' } });
    expect(h.queued).toHaveLength(0);
    expect(await hasPolicy(agent.eoa)).toBe(false);

    // The real check against the real deployment verifies the chain again.
    expect(await m.policyStack.runPolicyStackBootCheck('api')).toMatchObject({ verified: [CHAIN_ID] });
    expect((await syncStatus(agent.id)).contracts).toMatchObject({ allowed: true, state: 'verified' });
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    await drain();
    expect((await onChainPolicy(agent.eoa)).active).toBe(false); // the paused DB policy
  });
});

describeDb('S8 — DB vs on-chain while a sync is pending or failed', () => {
  it('a sync whose transactions fail (no gas) shows status "failed" with the on-chain policy unchanged', async () => {
    const agent = await mkAgent({}, { fund: false });
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    const results = await drain({ attemptsMade: 2 });
    expect(results.every((r) => r.txHash === null)).toBe(true);
    // A stamped attempt is handed to the chain (A6b); the re-poll declares it dropped.
    await m.processor.repollSubmittedTransactions(
      {
        db: m.db,
        feeService: { incrementTxUsage: async () => undefined, recordFeeEvent: async () => undefined } as never,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        getReceipt: async () => null,
        isKnownTransaction: async () => false,
        // Never a 0-ms age cut-off against Postgres timestamps (clock skew).
        now: () => new Date(Date.now() + 60_000),
      },
      { olderThanMs: 0, dropAfterMs: 0, limit: 100 },
    );

    const status = await syncStatus(agent.id);
    expect(status.status).toBe('failed');
    expect(status.lastFailure).not.toBeNull();
    expect(status.onChain.hasPolicy).toBe(false);
    expect(status.db.active).toBe(true);
  });

  it('#179 review P2-2: a pause landing AFTER the guard but before the signature does not let the stale setPolicy(active) reach the chain', async () => {
    const agent = await mkAgent({});
    expect((await requestSync(agent.id)).statusCode).toBe(202); // setPolicy(active = true)

    // Deterministic race: the guard has passed (the DB still says active); the
    // operator pause lands before the worker signs and broadcasts.
    const results = await drain({
      betweenGuardAndSigning: async () => {
        await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { active: false } });
      },
    });

    expect(results).toEqual([expect.objectContaining({ txHash: null })]);
    expect(await hasPolicy(agent.eoa)).toBe(false); // nothing reached the chain
    const rows = await m.db.transaction.findMany({ where: { agentId: agent.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'FAILED', txHash: null, broadcastAttemptedAt: null });
    expect(rows[0]!.error).toMatch(/superseded/i);
  });

  it('a queued sync the DB has since superseded is not signed (the guard re-derives it from the current policy)', async () => {
    const agent = await mkAgent({});
    expect((await requestSync(agent.id)).statusCode).toBe(202); // setPolicy(active = true)
    // Before the worker runs, the operator changes the DB policy again (no new sync yet).
    await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { maxValuePerTxEth: '0.1' } });
    const results = await drain();
    expect(results.every((r) => r.txHash === null)).toBe(true);
    expect(await hasPolicy(agent.eoa)).toBe(false);
    const rows = await m.db.transaction.findMany({ where: { agentId: agent.id } });
    expect(rows.every((r) => r.status === 'FAILED' && /superseded/i.test(r.error ?? ''))).toBe(true);

    // A new sync pushes the current policy.
    expect((await requestSync(agent.id)).statusCode).toBe(202);
    await drain();
    expect((await onChainPolicy(agent.eoa)).maxValuePerTx).toBe(parseEther('0.1'));
  });
});
