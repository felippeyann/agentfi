/**
 * Plan §5 question 6 — a USD per-transaction cap on ORDINARY outflows, on
 * REAL Postgres through the real transaction / job routes.
 *
 * Before (D14 / Q8): `maxValuePerTxUsd` caps USDC x402 payments and ERC-8183
 * escrow budgets only; `/v1/transactions/*` are capped per transaction by
 * `maxValuePerTxEth` — native ETH only — so an ERC-20 transfer, a swap input,
 * a deposit, GMX collateral or a batch of ERC-20 transfers had no
 * per-transaction cap at all, whatever their USD value (the seam
 * `USD_PER_TX_CAP_APPLIES_TO_TRANSACTIONS` was off).
 *
 * The owner's decision (2026-10-14): a NEW field, `maxOutflowPerTxUsd`, NULL
 * for every existing row and for every new row that does not set it (no
 * inference from the ETH or the USDC cap). NULL blocks every ordinary outflow
 * with `403 USD_CAP_NOT_CONFIGURED` until the operator sets it — before
 * anything is simulated or reserved. Set, each outflow is compared at its
 * priced USD value (D15 pricing; unpriced → refused). Withdrawals are not
 * outflows (explicit or max), nor is a GMX close.
 *
 * Real: Postgres, the routes, the policy service, the DailyVolume
 * reservation, the synthetic test prices (84532: 1 ETH = 2000 USD, USDC =
 * 1 USD). Faked: the queue, the simulator (counted), the simulation cache,
 * notifications, GMX's execution-fee read, the ERC-8183 runtime, the chain
 * reads (Aave's getPool, decimals) and the contract table (executor, GMX,
 * Compound, Aave provider placeholders).
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
    nativeOnly: '84532:native=2000',
  };
  process.env['SYNTHETIC_TEST_PRICES_USD'] = prices.all;
  return {
    prices,
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    simulations: 0,
    simulationOwner: '',
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
      h.simulations++;
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
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
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
      executor: '0x00000000000000000000000000000000000E8ec0',
      policyModule: '0x00000000000000000000000000000000000000A9',
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "volumeUsd" FROM "DailyVolume" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('outflow-cap.routes.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[outflow-cap.routes.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  executeA2APayment: typeof import('../api/routes/transactions.js')['executeA2APayment'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  reserveJobEscrow: typeof import('../services/policy/escrow.service.js')['reserveJobEscrow'];
};
let m: Modules;

const NAME_PREFIX = 'q6-ocap';
const RUN = randomBytes(3).toString('hex');
const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH = '0x4200000000000000000000000000000000000006';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const VAULT = '0x0000000000000000000000000000000000004626';
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

/** A policy with every other limit out of the way (daily limit 100 000 USD, ETH cap 10). */
async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `q6-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_q6',
      walletId: `q6-wallet-${RUN}-${seq}`,
      safeAddress: `0x6c6c${randomBytes(18).toString('hex')}`,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '100000',
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
  await a.ready();
  return a;
}

function post(a: FastifyInstance, url: string, body: Record<string, unknown>) {
  return a.inject({ method: 'POST', url, payload: { chainId: CHAIN_ID, ...body } });
}

async function rows(agentId: string) {
  return m.db.transaction.findMany({ where: { agentId }, select: { id: true, volumeState: true, volumeReservedUsd: true } });
}

async function volume(agentId: string): Promise<number> {
  const all = await m.db.dailyVolume.findMany({ where: { agentId } });
  return all.reduce((sum, r) => sum + Number(r.volumeUsd), 0);
}

const usdcTransferData = (amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, amount] });

type Op = { name: string; url: string; body: Record<string, unknown>; usd: number };

/** Every ordinary outflow, at 20–25 USD. */
const OUTFLOWS: Op[] = [
  { name: 'transfer native', url: '/v1/transactions/transfer', body: { token: 'ETH', to: RECIPIENT, amount: '0.01' }, usd: 20 },
  { name: 'transfer ERC-20', url: '/v1/transactions/transfer', body: { token: USDC, to: RECIPIENT, amount: '25' }, usd: 25 },
  { name: 'swap WETH input', url: '/v1/transactions/swap', body: { fromToken: WETH, toToken: USDC, amountIn: '0.01', simulationId: 'sim-q6' }, usd: 20 },
  { name: 'swap ERC-20 input', url: '/v1/transactions/swap', body: { fromToken: USDC, toToken: WETH, amountIn: '25', simulationId: 'sim-q6' }, usd: 25 },
  {
    name: 'Curve swap',
    url: '/v1/transactions/swap-curve',
    body: { pool: VAULT, fromTokenIndex: 0, toTokenIndex: 1, fromTokenAddress: USDC, toTokenAddress: WETH, amountIn: '25', minAmountOut: '0' },
    usd: 25,
  },
  { name: 'Aave deposit', url: '/v1/transactions/deposit', body: { asset: USDC, amount: '25' }, usd: 25 },
  { name: 'Compound supply', url: '/v1/transactions/supply-compound', body: { asset: USDC, amount: '25' }, usd: 25 },
  { name: 'ERC-4626 deposit', url: '/v1/transactions/deposit-erc4626', body: { vault: VAULT, asset: USDC, amount: '25' }, usd: 25 },
  {
    name: 'GMX open (collateral)',
    url: '/v1/transactions/gmx-open',
    body: { market: 'ETH/USD', collateralToken: USDC, collateralAmount: '25', sizeDeltaUsd: '1', acceptablePrice: '1', isLong: true },
    usd: 25,
  },
  { name: 'batch native value', url: '/v1/transactions/batch', body: { actions: [{ to: RECIPIENT, value: '10000000000000000' }] }, usd: 20 },
  {
    name: 'batch ERC-20 transfer calldata',
    url: '/v1/transactions/batch',
    body: { actions: [{ to: USDC, data: usdcTransferData(25_000_000n) }] },
    usd: 25,
  },
];

/** Not outflows: value comes back to the agent. */
const NOT_OUTFLOWS: Op[] = [
  { name: 'Aave withdraw', url: '/v1/transactions/withdraw', body: { asset: USDC, amount: '25' }, usd: 25 },
  { name: 'Compound withdraw', url: '/v1/transactions/withdraw-compound', body: { asset: USDC, amount: '25' }, usd: 25 },
  { name: 'ERC-4626 withdraw', url: '/v1/transactions/withdraw-erc4626', body: { vault: VAULT, asset: USDC, amount: '25' }, usd: 25 },
  {
    name: 'GMX close',
    url: '/v1/transactions/gmx-close',
    body: { market: 'ETH/USD', collateralToken: USDC, sizeDeltaUsd: '1', acceptablePrice: '1', isLong: true },
    usd: 0,
  },
];

describeDb('§5-6 — USD cap on ordinary outflows (maxOutflowPerTxUsd), on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, handler, escrow] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/errors/handler.js'),
      import('../services/policy/escrow.service.js'),
    ]);
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      executeA2APayment: routes.executeA2APayment,
      registerErrorHandler: handler.registerErrorHandler,
      reserveJobEscrow: escrow.reserveJobEscrow,
    };
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.queued.length = 0;
    h.simulations = 0;
    process.env['SYNTHETIC_TEST_PRICES_USD'] = h.prices.all;
  });

  // ── Not configured (every policy before migration 0025) ────────────────────

  describe('cap not configured (NULL): every ordinary outflow is blocked with a diagnostic', () => {
    it.each(OUTFLOWS)('$name → 403 USD_CAP_NOT_CONFIGURED before anything is simulated or reserved', async (op) => {
      const agent = await mkAgent();
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'USD_CAP_NOT_CONFIGURED' });
      expect(res.json().error).toMatch(/maxOutflowPerTxUsd/);
      expect(await rows(agent.id)).toHaveLength(0);
      expect(await volume(agent.id)).toBe(0);
      expect(h.simulations).toBe(0);
      expect(h.queued).toHaveLength(0);
    });

    it.each(NOT_OUTFLOWS)('$name is not an outflow: accepted as before', async (op) => {
      const agent = await mkAgent();
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(202);
    });

    it('a zero-value transfer moves nothing out: not blocked', async () => {
      const agent = await mkAgent();
      const res = await post(await app(agent.id), '/v1/transactions/transfer', { token: 'ETH', to: RECIPIENT, amount: '0' });
      expect(res.statusCode, res.body).toBe(202);
    });

    it('legacy paid job: the reward reservation is refused (USD_CAP_NOT_CONFIGURED), nothing reserved', async () => {
      const requester = await mkAgent();
      const reservation = await m.reserveJobEscrow({ requesterId: requester.id, reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID } });
      expect(reservation).toMatchObject({ success: false, code: 'USD_CAP_NOT_CONFIGURED' });
      expect(await volume(requester.id)).toBe(0);
    });

    it('legacy A2A payment of a job created before the cap: refused at payment time (the binding check), no transaction row', async () => {
      const requester = await mkAgent();
      const provider = await mkAgent();
      const job = await m.db.job.create({
        data: { requesterId: requester.id, providerId: provider.id, payload: {}, reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID }, status: 'PAYMENT_PENDING' },
      });
      await expect(
        m.executeA2APayment({
          requesterId: requester.id,
          providerSafeAddress: provider.safeAddress,
          amount: '0.01',
          token: 'ETH',
          chainId: CHAIN_ID,
          jobId: job.id,
          intentId: `a2a-payment:${job.id}`,
        }),
      ).rejects.toThrow(/maxOutflowPerTxUsd/);
      expect(await rows(requester.id)).toHaveLength(0);
    });
  });

  // ── Configured ─────────────────────────────────────────────────────────────

  describe('cap configured: each outflow compared at its priced USD value', () => {
    it.each(OUTFLOWS)('$name within the cap (25 USD) → accepted and reserved as before', async (op) => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '25' });
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(202);
      expect(await volume(agent.id)).toBeCloseTo(op.usd, 6);
    });

    it.each(OUTFLOWS)('$name above the cap (19.99 USD) → 403 POLICY_VIOLATION rule maxOutflowPerTxUsd, nothing simulated or reserved', async (op) => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '19.99' });
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'maxOutflowPerTxUsd', limit: '19.99' });
      expect(await rows(agent.id)).toHaveLength(0);
      expect(await volume(agent.id)).toBe(0);
      expect(h.simulations).toBe(0);
    });

    it.each(OUTFLOWS)('$name unpriced (no trusted price) → 503 PRICE_UNAVAILABLE even without a daily limit', async (op) => {
      delete process.env['SYNTHETIC_TEST_PRICES_USD'];
      const agent = await mkAgent({ maxOutflowPerTxUsd: '1000', maxDailyVolumeUsd: '0' });
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE', rule: 'maxOutflowPerTxUsd' });
      expect(await rows(agent.id)).toHaveLength(0);
      expect(h.simulations).toBe(0);
    });

    it.each(NOT_OUTFLOWS)('$name is not capped: accepted with a cap far below its value', async (op) => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '1' });
      const res = await post(await app(agent.id), op.url, op.body);
      expect(res.statusCode, res.body).toBe(202);
    });

    it('a "max" withdrawal is not capped either (no daily limit: accepted, as before)', async () => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: null, maxDailyVolumeUsd: '0' });
      const res = await post(await app(agent.id), '/v1/transactions/withdraw', { asset: USDC, amount: 'max' });
      expect(res.statusCode, res.body).toBe(202);
    });

    it('maxValuePerTxUsd (the USDC x402 / escrow cap) does not cap ordinary outflows', async () => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '1000', maxValuePerTxUsd: '0.01' });
      const res = await post(await app(agent.id), '/v1/transactions/transfer', { token: USDC, to: RECIPIENT, amount: '25' });
      expect(res.statusCode, res.body).toBe(202);
    });

    it('batch: native value and ERC-20 transfers are ONE outflow — 15 + 10 = 25 USD passes a 25 cap, the same with 10.01 is refused', async () => {
      const ok = await mkAgent({ maxOutflowPerTxUsd: '25' });
      const fits = await post(await app(ok.id), '/v1/transactions/batch', {
        actions: [{ to: RECIPIENT, value: '7500000000000000' }, { to: USDC, data: usdcTransferData(10_000_000n) }],
      });
      expect(fits.statusCode, fits.body).toBe(202);
      const over = await mkAgent({ maxOutflowPerTxUsd: '25' });
      const refused = await post(await app(over.id), '/v1/transactions/batch', {
        actions: [{ to: RECIPIENT, value: '7500000000000000' }, { to: USDC, data: usdcTransferData(10_010_000n) }],
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'maxOutflowPerTxUsd' });
    });

    it('batch without a daily limit: a non-canonical ERC-20 transfer (the cap cannot see its amount) is refused; other calldata to an unlisted contract is not (that rule is daily-limit-only)', async () => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '1000', maxDailyVolumeUsd: '0' });
      const a = await app(agent.id);
      const dirty = `${usdcTransferData(25_000_000n)}00`;
      const nonCanonical = await post(a, '/v1/transactions/batch', { actions: [{ to: USDC, data: dirty }] });
      expect(nonCanonical.statusCode, nonCanonical.body).toBe(403);
      expect(nonCanonical.json()).toMatchObject({ code: 'NON_CANONICAL_ERC20_CALL' });
      const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RECIPIENT, 1n] });
      const other = await post(a, '/v1/transactions/batch', { actions: [{ to: USDC, data: approve }] });
      expect(other.statusCode, other.body).toBe(202);
    });

    it('batch without a daily limit: a decoded ERC-20 transfer to a recipient outside allowedRecipients is refused (now classified for the cap)', async () => {
      const agent = await mkAgent({ maxOutflowPerTxUsd: '1000', maxDailyVolumeUsd: '0', allowedRecipients: ['0x00000000000000000000000000000000000000c1'] });
      const res = await post(await app(agent.id), '/v1/transactions/batch', { actions: [{ to: USDC, data: usdcTransferData(1_000_000n) }] });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ rule: 'allowedRecipients' });
    });

    it('legacy paid job: a reward within the cap is reserved; above it the job is refused (403 rule maxOutflowPerTxUsd)', async () => {
      const ok = await mkAgent({ maxOutflowPerTxUsd: '20' });
      expect(await m.reserveJobEscrow({ requesterId: ok.id, reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID } })).toMatchObject({ success: true });
      const over = await mkAgent({ maxOutflowPerTxUsd: '19.99' });
      expect(await m.reserveJobEscrow({ requesterId: over.id, reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID } })).toMatchObject({
        success: false,
        code: 'POLICY_VIOLATION',
        rule: 'maxOutflowPerTxUsd',
      });
      expect(await volume(over.id)).toBe(0);
    });

    it('legacy A2A payment: within the cap → created; the cap lowered below it before payment → refused at payment time', async () => {
      const requester = await mkAgent({ maxOutflowPerTxUsd: '20' });
      const provider = await mkAgent();
      const pay = async () => {
        const job = await m.db.job.create({
          data: { requesterId: requester.id, providerId: provider.id, payload: {}, reward: { amount: '0.01', token: 'ETH', chainId: CHAIN_ID }, status: 'PAYMENT_PENDING' },
        });
        return m.executeA2APayment({
          requesterId: requester.id,
          providerSafeAddress: provider.safeAddress,
          amount: '0.01',
          token: 'ETH',
          chainId: CHAIN_ID,
          jobId: job.id,
          intentId: `a2a-payment:${job.id}`,
        });
      };
      await expect(pay()).resolves.toMatchObject({ status: 'QUEUED' });
      await m.db.agentPolicy.update({ where: { agentId: requester.id }, data: { maxOutflowPerTxUsd: '19.99' } });
      await expect(pay()).rejects.toThrow(/POLICY_VIOLATION.*maxOutflowPerTxUsd/);
      expect(await rows(requester.id)).toHaveLength(1);
    });
  });
});
