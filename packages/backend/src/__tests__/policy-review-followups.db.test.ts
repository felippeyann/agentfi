/**
 * Review follow-ups of #178 (approval on a later UTC day) and #180 ("max"
 * withdrawals), on REAL Postgres through the real routes.
 *
 *  1. (#178, P2) `APPROVAL_UNCOUNTED_SPEND` refused every pending row with no
 *     reservation under a daily limit — also one counted as zero ON PURPOSE:
 *     a GMX close is created with pricing `zero` (value comes back to the
 *     agent) and its native execution fee can still exceed the approval
 *     threshold, so it waits for the operator and could never be approved
 *     while a daily limit applied. Only an UNPRICED spend must be refused.
 *  2. (#178, P2) The approval-day limit check compared IEEE-754 floats:
 *     DailyVolume 0.200000 + x402 0.1 = 0.30000000000000004 > 0.3, so a spend
 *     that fills a 0.3 USD limit exactly was refused.
 *  3. (#180, P1) The max-withdrawal proof compared the calldata with
 *     `agent.safeAddress`, but the transaction is signed by the key behind
 *     `walletId`. In Safe mode `safeAddress` is the Safe and the signer its
 *     owner EOA, so Comet (which pays `msg.sender`) sends the funds to the EOA
 *     while the row was recorded as returning them to the Safe, uncounted.
 *
 * Real: Postgres, the transaction routes, the admin approve route, the
 * DailyVolume reservation, the x402 ledger total, the synthetic test prices
 * (84532: 1 ETH = 2000 USD, USDC = 1 USD). Faked: the queue (recorder), the
 * simulator, notifications, the ERC-8183 runtime, GMX's execution fee
 * (0.0001 ETH), chain reads (Aave's getPool, decimals), the contract table,
 * the wallet provider's `getWalletAddress` (per walletId), and `Date` only.
 *
 * Skipped (with a warning) when DATABASE_URL is not a reachable, migrated
 * database; on CI an unreachable database fails the suite.
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
  const prices = {
    all: '84532:native=2000,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
    tokensOnly: '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
  };
  process.env['SYNTHETIC_TEST_PRICES_USD'] = prices.all;
  return {
    prices,
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    simulationOwner: '',
    /** walletId → the address that signs for it (or an Error when the provider cannot resolve it). */
    signers: new Map<string, string | Error>(),
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
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6),
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: class {
    async simulate() {
      return { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/transaction/simulation-cache.js', () => ({
  cacheSimulation: async () => undefined,
  getSimulation: async () => ({ agentId: h.simulationOwner, success: true, chainId: 84532 }),
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({
    getWalletAddress: async (walletId: string) => {
      const signer = h.signers.get(walletId);
      if (signer instanceof Error) throw signer;
      if (!signer) throw new Error(`[local-wallet] wallet ${walletId} not found`);
      return signer;
    },
  }),
}));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: async () => undefined,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
}));
vi.mock('../services/defi/gmx.service.js', () => ({
  gmxService: {
    getExecutionFee: async () => ({ executionFee: '0.0001', executionFeeWei: 100_000_000_000_000n }),
    resolveMarket: () => '0x70d95587d40a2caf56bd97485ab3eec10bee6336',
  },
}));
vi.mock('../config/contracts.js', async () => {
  const actual = await vi.importActual<typeof import('../config/contracts.js')>('../config/contracts.js');
  return {
    ...actual,
    getContracts: (chainId: number) => ({
      ...actual.getContracts(chainId),
      gmxExchangeRouter: '0x00000000000000000000000000000000000000a5',
      gmxOrderVault: '0x00000000000000000000000000000000000000a6',
      compoundCometUsdc: '0x00000000000000000000000000000000000000a7',
      aavePoolAddressProvider: '0x00000000000000000000000000000000000000a8',
    }),
  };
});
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  return {
    ...actual,
    createChainPublicClient: () => ({
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'getPool') return '0x00000000000000000000000000000000000000Ab';
        if (functionName === 'decimals') return 18;
        throw new Error(`unexpected read ${functionName}`);
      },
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';

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
  if (process.env['CI']) throw new Error('policy-review-followups.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[policy-review-followups.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  adminRoutes: typeof import('../api/routes/admin.js')['adminRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
};
let m: Modules;

const NAME_PREFIX = 'c45-rfu';
const RUN = randomBytes(3).toString('hex');
const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const ADMIN = { 'x-admin-secret': process.env['ADMIN_SECRET'] as string };
const D1 = '2031-07-08';
const D2 = '2031-07-09';
const at = (day: string, time = '12:00:00.000') => new Date(`${day}T${time}Z`);
let seq = 0;

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  await m.db.job.deleteMany({ where: { OR: [{ requester: agents }, { provider: agents }] } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

/**
 * Every ETH-carrying request above 0.00001 ETH waits for the operator; daily
 * limit 1000 USD unless overridden. By default the wallet signs as the agent's
 * own address (`safeAddress`), i.e. EOA mode.
 */
async function mkAgent(policy: Record<string, unknown> = {}, signer?: string | Error) {
  seq++;
  const safeAddress = getAddress(`0xfa11${randomBytes(18).toString('hex')}`);
  const walletId = `rfu-wallet-${RUN}-${seq}`;
  h.signers.set(walletId, signer ?? safeAddress);
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `rfu-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_rfu',
      walletId,
      safeAddress,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '0.00001',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          ...policy,
        },
      },
    },
  });
}

async function app(agentId: string): Promise<FastifyInstance> {
  h.simulationOwner = agentId;
  const a = Fastify({ logger: false });
  m.registerErrorHandler(a);
  a.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agentId;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await a.register(m.transactionRoutes);
  await a.register(m.adminRoutes);
  await a.ready();
  return a;
}

function post(a: FastifyInstance, url: string, body: Record<string, unknown>) {
  return a.inject({ method: 'POST', url, payload: { chainId: CHAIN_ID, ...body } });
}

function approve(a: FastifyInstance, id: string) {
  return a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN });
}

async function row(id: string) {
  return m.db.transaction.findUnique({ where: { id }, select: { status: true, volumeState: true, volumeReservedDate: true, metadata: true } });
}

async function volume(agentId: string, date: string): Promise<number> {
  const r = await m.db.dailyVolume.findFirst({ where: { agentId, date } });
  return r ? Number(r.volumeUsd) : 0;
}

/** A counted x402 payment of `micro` base units (6 decimals) by `agentId`, reserved at `when`. */
async function x402Payment(agentId: string, micro: bigint, when: Date): Promise<void> {
  const requester = await mkAgent();
  const job = await m.db.job.create({
    data: { requesterId: requester.id, providerId: agentId, status: 'ACCEPTED', payload: {}, reward: { amount: '1', token: 'USDC', chainId: CHAIN_ID } },
  });
  await m.db.resourcePayment.create({
    data: {
      jobId: job.id,
      agentId,
      paymentId: `rfu_${RUN}_${randomBytes(4).toString('hex')}`,
      url: 'https://resource.example/data',
      method: 'GET',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC,
      amount: micro.toString(),
      payTo: RECIPIENT,
      status: 'settled',
      reservedAt: when,
    },
  });
}

const gmxClose = { market: 'ETH/USD', collateralToken: USDC, sizeDeltaUsd: '1', acceptablePrice: '1', isLong: true };

describeDb('#178 / #180 review follow-ups, on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, admin, handler] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/routes/admin.js'),
      import('../api/errors/handler.js'),
    ]);
    m = { db: db.db, transactionRoutes: routes.transactionRoutes, adminRoutes: admin.adminRoutes, registerErrorHandler: handler.registerErrorHandler };
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(D1));
    h.queued.length = 0;
    process.env['SYNTHETIC_TEST_PRICES_USD'] = h.prices.all;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Zero-counted vs unpriced (#178, P2) ─────────────────────────────────

  describe('1 — a spend counted as zero on purpose is approvable under a daily limit; an unpriced one is not', () => {
    it('reproduction: a GMX close waiting for approval (execution fee above the threshold) is approved on a later day under a daily limit', async () => {
      const agent = await mkAgent();
      const a = await app(agent.id);
      const res = await post(a, '/v1/transactions/gmx-close', gmxClose);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json().status).toBe('PENDING_APPROVAL');
      const id = res.json().transactionId as string;
      expect((await row(id))?.volumeState).toBeNull();

      vi.setSystemTime(at(D2));
      const approved = await approve(a, id);
      expect(approved.statusCode, approved.body).toBe(200);
      expect((await row(id))?.status).toBe('QUEUED');
      expect(await volume(agent.id, D2)).toBe(0); // nothing to count
    });

    it('the row records why nothing was reserved: "zero" for the GMX close, "unpriced" for an unpriced transfer', async () => {
      const agent = await mkAgent({ maxDailyVolumeUsd: '0' });
      const a = await app(agent.id);
      const close = (await post(a, '/v1/transactions/gmx-close', gmxClose)).json().transactionId as string;
      process.env['SYNTHETIC_TEST_PRICES_USD'] = h.prices.tokensOnly; // native value unpriced
      const transfer = (await post(a, '/v1/transactions/transfer', { token: 'ETH', to: RECIPIENT, amount: '0.01' })).json().transactionId as string;
      expect(((await row(close))?.metadata as Record<string, unknown>)['volumeAccounting']).toBe('zero');
      expect(((await row(transfer))?.metadata as Record<string, unknown>)['volumeAccounting']).toBe('unpriced');
    });

    it('an unpriced pending transfer is still refused once a daily limit applies (APPROVAL_UNCOUNTED_SPEND)', async () => {
      const agent = await mkAgent({ maxDailyVolumeUsd: '0' });
      const a = await app(agent.id);
      process.env['SYNTHETIC_TEST_PRICES_USD'] = h.prices.tokensOnly;
      const id = (await post(a, '/v1/transactions/transfer', { token: 'ETH', to: RECIPIENT, amount: '0.01' })).json().transactionId as string;
      process.env['SYNTHETIC_TEST_PRICES_USD'] = h.prices.all;
      await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { maxDailyVolumeUsd: '1000' } });
      const res = await approve(a, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('APPROVAL_UNCOUNTED_SPEND');
      expect((await row(id))?.status).toBe('PENDING_APPROVAL');
    });

    it('a row from before the record (no marker, no reservation) is refused under a daily limit — conservative: it cannot be told apart from an unpriced spend', async () => {
      const agent = await mkAgent();
      const a = await app(agent.id);
      const id = (await post(a, '/v1/transactions/gmx-close', gmxClose)).json().transactionId as string;
      // As written before this fix: the same row without the marker.
      const current = (await row(id))!.metadata as Record<string, unknown>;
      const { volumeAccounting: _dropped, ...legacy } = current;
      await m.db.transaction.update({ where: { id }, data: { metadata: legacy as never } });
      const res = await approve(a, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('APPROVAL_UNCOUNTED_SPEND');
    });
  });

  // ── 2. Exact comparison (#178, P2) ─────────────────────────────────────────

  describe('2 — the approval-day limit is compared exactly (micro-USD), not in floating point', () => {
    it('reproduction: 0.2 USD moved to a day with 0.1 USD of x402 fills a 0.3 USD limit exactly — approved', async () => {
      const agent = await mkAgent({ maxDailyVolumeUsd: '0.3' });
      const a = await app(agent.id);
      const res = await post(a, '/v1/transactions/transfer', { token: 'ETH', to: RECIPIENT, amount: '0.0001' }); // 0.2 USD
      expect(res.json().status).toBe('PENDING_APPROVAL');
      const id = res.json().transactionId as string;
      await x402Payment(agent.id, 100_000n, at(D2, '08:00:00.000')); // 0.1 USDC on D2

      vi.setSystemTime(at(D2));
      const approved = await approve(a, id);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await volume(agent.id, D2)).toBeCloseTo(0.2, 6);
    });

    it('one micro-dollar over the limit is still refused, with exact numbers in the details', async () => {
      const agent = await mkAgent({ maxDailyVolumeUsd: '0.299999' });
      const a = await app(agent.id);
      const id = (await post(a, '/v1/transactions/transfer', { token: 'ETH', to: RECIPIENT, amount: '0.0001' })).json().transactionId as string;
      await x402Payment(agent.id, 100_000n, at(D2, '08:00:00.000'));
      vi.setSystemTime(at(D2));
      const res = await approve(a, id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'APPROVAL_DAILY_LIMIT',
        details: { day: D2, limitUsd: '0.299999', committedUsd: '0.100000', requestedUsd: '0.200000' },
      });
      expect((await row(id))?.volumeReservedDate).toBe(D1);
    });
  });

  // ── 3. Prove against the signer (#180, P1) ─────────────────────────────────

  describe('3 — a max withdrawal is proven against the address that SIGNS it', () => {
    it.each([
      ['Aave', '/v1/transactions/withdraw'],
      ['Compound', '/v1/transactions/withdraw-compound'],
    ])('reproduction (%s): Safe mode — the wallet signs as its owner EOA, not as safeAddress — no exemption, refused under a daily limit', async (_name, url) => {
      const ownerEoa = getAddress(`0x0e0a${randomBytes(18).toString('hex')}`);
      const agent = await mkAgent({}, ownerEoa);
      const res = await post(await app(agent.id), url, { asset: USDC, amount: 'max' });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
      expect(res.json().error).toMatch(/signed by/);
      expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(0);
    });

    it.each([
      ['Aave', '/v1/transactions/withdraw'],
      ['Compound', '/v1/transactions/withdraw-compound'],
    ])('reproduction (%s): the signing address cannot be resolved — no exemption (fail closed)', async (_name, url) => {
      const agent = await mkAgent({}, new Error('Turnkey: wallet accounts unavailable'));
      const res = await post(await app(agent.id), url, { asset: USDC, amount: 'max' });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    });

    it('EOA mode (the signer IS the agent wallet): still proven, the recipient recorded is the signer', async () => {
      const agent = await mkAgent();
      const res = await post(await app(agent.id), '/v1/transactions/withdraw-compound', { asset: USDC, amount: 'max' });
      expect(res.statusCode, res.body).toBe(202);
      const created = await m.db.transaction.findFirstOrThrow({ where: { agentId: agent.id }, select: { metadata: true } });
      expect((created.metadata as Record<string, unknown>)['volumeExemption']).toMatchObject({
        protocol: 'compound-v3',
        recipient: getAddress(agent.safeAddress),
      });
    });
  });
});
