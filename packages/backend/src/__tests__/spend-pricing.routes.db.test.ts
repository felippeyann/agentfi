/**
 * Q9 (owner decision, 2026-10-14) — trusted prices for daily-volume
 * accounting, on REAL Postgres through the real transaction / job routes.
 *
 * The finding (A6 review leftovers, A6b): a spend whose USD value could not be
 * priced was counted as 0 against the daily limit —
 *   - an ERC-20 amount on Base Sepolia (84532): the oracle has no testnet
 *     prices, `tokenAmountToUsd` answers "0";
 *   - native value on 84532 was priced with the MAINNET ETH price (the price
 *     service's default native id), i.e. an untrusted proxy;
 *   - an ERC-20 swap input and GMX collateral were passed as `valueUsd: '0'`
 *     and never counted;
 *   - a token the oracle does not know (any chain) counted 0.
 * Rule now: with a daily limit, a spend with an unpriced component is refused
 * (503 PRICE_UNAVAILABLE) before anything is simulated or reserved; on a
 * testnet only explicitly configured synthetic prices
 * (`SYNTHETIC_TEST_PRICES_USD`) count; on a mainnet chain only the oracle.
 *
 * Real here: the routes, the policy service, the DailyVolume reservation and
 * the price service (`price.service.ts`) with its HTTP calls answered by a
 * stubbed CoinGecko (`fetch`): 1 ETH = 2000 USD, the mainnet USDCs = 1 USD,
 * every other token unknown. Faked: the queue, the simulator, the simulation
 * cache, notifications, GMX's execution-fee read and the ERC-8183 runtime.
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
  delete process.env['SYNTHETIC_TEST_PRICES_USD'];
  return {
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    /** CoinGecko URLs the price service fetched. */
    oracleCalls: [] as string[],
    /** The agent every cached simulation belongs to (the swap route checks it). */
    simulationOwner: '',
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  // Q9_DEBUG=1 prints the errors the routes log (an INTERNAL_ERROR answer hides them).
  const error = (...args: unknown[]) => (process.env['Q9_DEBUG'] ? console.error(...args) : undefined);
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
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: class {
    async simulate() {
      return { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/transaction/simulation-cache.js', () => ({
  cacheSimulation: async () => undefined,
  // Every simulationId was "issued" to the caller and succeeded.
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
    // Placeholder addresses: nothing is broadcast. (The configured Arbitrum GMX
    // OrderVault / Router fail viem's EIP-55 check — see the PR's findings.)
    getContracts: (chainId: number) => ({
      ...actual.getContracts(chainId),
      executor: '0x00000000000000000000000000000000000E8ec0',
      gmxExchangeRouter: '0x00000000000000000000000000000000000000a5',
      gmxOrderVault: '0x00000000000000000000000000000000000000a6',
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
  if (process.env['CI']) throw new Error('spend-pricing.routes.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[spend-pricing.routes.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  reserveJobEscrow: typeof import('../services/policy/escrow.service.js')['reserveJobEscrow'];
  clearPriceCache: typeof import('../services/transaction/price.service.js')['clearPriceCache'];
};
let m: Modules;

const NAME_PREFIX = 'q9-price';
const RUN = randomBytes(3).toString('hex');
const TESTNET = 84532;
const ARBITRUM = 42161;
const MAINNET = 1;
const USDC_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const WETH_84532 = '0x4200000000000000000000000000000000000006';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WBTC_MAINNET = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'; // the stub oracle has no price for it
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
let seq = 0;

/** Stub CoinGecko: ETH 2000 USD; the mainnet USDCs 1 USD; everything else unknown. */
function coingecko(url: string): Response {
  h.oracleCalls.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/simple/price?ids=ethereum')) return json({ ethereum: { usd: 2000 } });
  const match = /contract_addresses=(0x[0-9a-f]{40})/.exec(url);
  if (match) {
    const priced = [USDC_ARB.toLowerCase(), USDC_MAINNET.toLowerCase()];
    return json(priced.includes(match[1]!) ? { [match[1]!]: { usd: 1 } } : {});
  }
  return json({});
}

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

async function mkAgent(chainIds: number[], policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `q9-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_q9',
      walletId: `q9-wallet-${RUN}-${seq}`,
      safeAddress: `0x9a9a${randomBytes(18).toString('hex')}`,
      chainIds,
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          ...policy,
        },
      },
    },
  });
}

async function volume(agentId: string): Promise<number> {
  const row = await m.db.dailyVolume.findFirst({ where: { agentId, date: new Date().toISOString().slice(0, 10) } });
  return row ? Number(row.volumeUsd) : 0;
}

async function rows(agentId: string) {
  return m.db.transaction.findMany({ where: { agentId }, select: { id: true, volumeReservedUsd: true, volumeState: true } });
}

async function app(agentId: string): Promise<FastifyInstance> {
  h.simulationOwner = agentId;
  const a = Fastify({ logger: Boolean(process.env['Q9_DEBUG']) });
  m.registerErrorHandler(a);
  a.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agentId;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await a.register(m.transactionRoutes);
  await a.ready();
  return a;
}

function post(a: FastifyInstance, url: string, payload: Record<string, unknown>) {
  return a.inject({ method: 'POST', url, payload });
}

describeDb('Q9 — no spend counted as zero (reproduction on the real routes)', () => {
  beforeAll(async () => {
    const [db, routes, handler, escrow, price] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/errors/handler.js'),
      import('../services/policy/escrow.service.js'),
      import('../services/transaction/price.service.js'),
    ]);
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      registerErrorHandler: handler.registerErrorHandler,
      reserveJobEscrow: escrow.reserveJobEscrow,
      clearPriceCache: price.clearPriceCache,
    };
    vi.stubGlobal('fetch', async (input: string | URL) => coingecko(String(input)));
    await wipe();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env['SYNTHETIC_TEST_PRICES_USD'];
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.queued.length = 0;
    h.oracleCalls.length = 0;
    m.clearPriceCache();
    delete process.env['SYNTHETIC_TEST_PRICES_USD'];
  });

  it('ERC-20 transfer of 25 USDC on 84532 with a daily limit: refused 503, nothing reserved (was: accepted and counted 0)', async () => {
    const agent = await mkAgent([TESTNET]);
    const res = await post(await app(agent.id), '/v1/transactions/transfer', { chainId: TESTNET, token: USDC_84532, to: RECIPIENT, amount: '25' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await rows(agent.id)).toHaveLength(0);
    expect(await volume(agent.id)).toBe(0);
  });

  it('the same transfer with a configured synthetic USDC price counts 25 USD (was: 0)', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = `${TESTNET}:${USDC_84532}=1`;
    const agent = await mkAgent([TESTNET]);
    const res = await post(await app(agent.id), '/v1/transactions/transfer', { chainId: TESTNET, token: USDC_84532, to: RECIPIENT, amount: '25' });
    expect(res.statusCode, res.body).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(25, 6);
  });

  it('native value on 84532 is never priced with the mainnet ETH price: refused 503 without a synthetic price (was: counted at 2000 USD/ETH)', async () => {
    const agent = await mkAgent([TESTNET]);
    const res = await post(await app(agent.id), '/v1/transactions/transfer', { chainId: TESTNET, token: 'ETH', to: RECIPIENT, amount: '0.01' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await volume(agent.id)).toBe(0);
    expect(h.oracleCalls.filter((u) => u.includes('ids=ethereum'))).toHaveLength(0);
  });

  it('Uniswap swap with an ERC-20 input (25 USDC) on 84532 counts the input at the synthetic price (was: 0)', async () => {
    process.env['SYNTHETIC_TEST_PRICES_USD'] = `${TESTNET}:${USDC_84532}=1`;
    const agent = await mkAgent([TESTNET]);
    const res = await post(await app(agent.id), '/v1/transactions/swap', {
      chainId: TESTNET,
      fromToken: USDC_84532,
      toToken: WETH_84532,
      amountIn: '25',
      simulationId: 'sim-q9',
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(25, 6);
  });

  it('GMX open on Arbitrum counts the collateral at the oracle price (was: valueUsd "0")', async () => {
    const agent = await mkAgent([ARBITRUM]);
    const res = await post(await app(agent.id), '/v1/transactions/gmx-open', {
      chainId: ARBITRUM,
      market: 'ETH/USD',
      collateralToken: USDC_ARB,
      collateralAmount: '100',
      sizeDeltaUsd: '200000000000000000000000000000000',
      acceptablePrice: '1',
      isLong: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(100, 6);
  });

  it('a token the mainnet oracle cannot price is refused 503 with a daily limit (was: accepted and counted 0)', async () => {
    const agent = await mkAgent([MAINNET]);
    const res = await post(await app(agent.id), '/v1/transactions/transfer', { chainId: MAINNET, token: WBTC_MAINNET, to: RECIPIENT, amount: '1' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await volume(agent.id)).toBe(0);
  });

  it('legacy A2A reward in native value on 84532: refused (code PRICE_UNAVAILABLE) instead of reserved at the mainnet ETH price', async () => {
    const requester = await mkAgent([TESTNET]);
    const reservation = await m.reserveJobEscrow({ requesterId: requester.id, reward: { amount: '0.01', token: 'ETH', chainId: TESTNET } });
    expect(reservation).toMatchObject({ success: false, code: 'PRICE_UNAVAILABLE' });
    expect(await volume(requester.id)).toBe(0);
  });
});
