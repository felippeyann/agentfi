/**
 * S7 — the routes that read the four mis-typed contract addresses, on REAL
 * Postgres, with the chain answered by a viem `custom` transport (so viem's
 * own address validation runs exactly as in production; only the JSON-RPC
 * answers are canned).
 *
 * The finding (G1 round, #173 review): four hard-coded addresses in
 * `config/contracts.ts` failed EIP-55, and so did the Base QuoterV2 in
 * `api/routes/transactions.ts` and the BTC/USD market in `gmx.service.ts`.
 * Checked against the official deployments and on-chain (2026-10-14): none of
 * them is a casing slip — every one is a wrong address with NO code on its
 * chain (see the PR). viem refuses them before any request:
 *   - Aave supply / withdraw on Base: `readContract(getPool)` on the provider
 *     throws "Address … is invalid" → 500;
 *   - a swap on Base: the quote throws inside `getQuotedAmountOut`, which
 *     swallows it and answers 0 → the swap is built with
 *     `amountOutMinimum = 0` (no slippage protection at all);
 *   - GMX open on Arbitrum: encoding `sendWnt(orderVault, …)` throws → 500;
 *     the "BTC/USD" market label likewise.
 *
 * Real here: the routes, the builder, `getContracts`, `gmxService.resolveMarket`,
 * viem (encoding, address checks, `readContract` / `simulateContract`), the
 * policy service, the DailyVolume reservation and the price service with a
 * stubbed CoinGecko. Faked: the JSON-RPC answers, the queue, the simulator
 * (captures what would be simulated), the simulation cache, notifications,
 * GMX's execution-fee read and the ERC-8183 runtime.
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
    simulated: [] as Array<{ chainId: number; to: string; data: string; value: bigint }>,
    /** Every eth_call the routes made: chain and target. */
    ethCalls: [] as Array<{ chainId: number; to: string; selector: string }>,
    simulationOwner: '',
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const error = (...args: unknown[]) => (process.env['S7_DEBUG'] ? console.error(...args) : undefined);
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
    async simulate(params: { chainId: number; to: string; data: string; value: bigint }) {
      h.simulated.push(params);
      return { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/transaction/simulation-cache.js', () => ({
  cacheSimulation: async () => undefined,
  getSimulation: async () => ({ agentId: h.simulationOwner, success: true, chainId: 8453 }),
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
vi.mock('../services/defi/gmx.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/defi/gmx.service.js')>('../services/defi/gmx.service.js');
  // The real market table and label resolution; only the DataStore fee read is canned.
  return {
    ...actual,
    gmxService: {
      resolveMarket: (label: string) => actual.gmxService.resolveMarket(label),
      getExecutionFee: async () => ({ executionFee: '0.0001', executionFeeWei: 100_000_000_000_000n }),
    },
  };
});
// A real viem client per chain whose JSON-RPC is answered here — or, with
// S7_FORK_RPC_<chainId> set (e.g. an Anvil fork of Base mainnet), by that
// fork: the same routes then read the real provider and the real QuoterV2.
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  const viem = await vi.importActual<typeof import('viem')>('viem');
  const POOL_8453 = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
  const getPoolSelector = viem.toFunctionSelector('getPool()');
  const quoteSelector = viem.toFunctionSelector('quoteExactInputSingle((address,address,uint256,uint24,uint160))');
  const decimalsSelector = viem.toFunctionSelector('decimals()');
  const forked = (chainId: number, url: string) =>
    viem.createPublicClient({
      chain: actual.getChain(chainId),
      transport: viem.http(url, {
        onFetchRequest: async (request: Request) => {
          const body = (await request.clone().json()) as unknown;
          for (const rpc of (Array.isArray(body) ? body : [body]) as Array<{ method: string; params?: unknown[] }>) {
            if (rpc.method !== 'eth_call') continue;
            const call = (rpc.params?.[0] ?? {}) as { to: string; data?: string; input?: string };
            const data = call.data ?? call.input ?? '0x';
            h.ethCalls.push({ chainId, to: viem.getAddress(call.to), selector: data.slice(0, 10) });
          }
        },
      }),
    });
  return {
    ...actual,
    createChainPublicClient: (chainId: number) => {
      const forkUrl = process.env[`S7_FORK_RPC_${chainId}`];
      if (forkUrl) return forked(chainId, forkUrl);
      return viem.createPublicClient({
        chain: actual.getChain(chainId),
        transport: viem.custom({
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_chainId') return viem.toHex(chainId);
            if (method !== 'eth_call') throw new Error(`unexpected RPC ${method}`);
            const call = (params?.[0] ?? {}) as { to: string; data: string };
            const selector = call.data.slice(0, 10);
            h.ethCalls.push({ chainId, to: viem.getAddress(call.to), selector });
            if (selector === getPoolSelector) return viem.encodeAbiParameters([{ type: 'address' }], [POOL_8453]);
            if (selector === decimalsSelector) return viem.encodeAbiParameters([{ type: 'uint8' }], [18]);
            if (selector === quoteSelector) {
              const [args] = viem.decodeAbiParameters(
                [{ type: 'tuple', components: [
                  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
                  { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
                  { name: 'sqrtPriceLimitX96', type: 'uint160' },
                ] }],
                `0x${call.data.slice(10)}`,
              ) as unknown as [{ amountIn: bigint; fee: number }];
              // 1 WETH = 2000 USDC at the 0.05% tier; the deeper tiers quote less.
              const perEth = args.fee === 500 ? 2000n : args.fee === 3000 ? 1990n : 1900n;
              const out = (args.amountIn * perEth) / 10n ** 12n;
              return viem.encodeAbiParameters(
                [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
                [out, 0n, 1, 100_000n],
              );
            }
            throw new Error(`unexpected eth_call ${selector} to ${call.to}`);
          },
        }),
      });
    },
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi, getAddress, toFunctionSelector } from 'viem';

const GET_POOL = toFunctionSelector('getPool()');
const QUOTE_EXACT_INPUT_SINGLE = toFunctionSelector('quoteExactInputSingle((address,address,uint256,uint24,uint160))');

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
  if (process.env['CI']) throw new Error('contracts.addresses.routes.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[contracts.addresses.routes.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  clearPriceCache: typeof import('../services/transaction/price.service.js')['clearPriceCache'];
};
let m: Modules;

const NAME_PREFIX = 's7-addresses';
const RUN = randomBytes(3).toString('hex');
const BASE = 8453;
const ARBITRUM = 42161;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

// The official deployments (sources in config/contracts.ts and the PR).
const AAVE_PROVIDER_BASE = '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D';
const AAVE_POOL_BASE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const QUOTER_V2_BASE = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const GMX_ORDER_VAULT = '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5';
const GMX_BTC_USD = '0x47c031236e19d024b42f8AE6780E44A573170703';
const GMX_ETH_USD = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';
let seq = 0;

/** Stub CoinGecko: ETH 2000 USD; the mainnet USDCs 1 USD. */
function coingecko(url: string): Response {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/simple/price?ids=ethereum')) return json({ ethereum: { usd: 2000 } });
  const match = /contract_addresses=(0x[0-9a-f]{40})/.exec(url);
  if (match) {
    const priced = [USDC_BASE.toLowerCase(), USDC_ARB.toLowerCase()];
    return json(priced.includes(match[1]!) ? { [match[1]!]: { usd: 1 } } : {});
  }
  return json({});
}

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

async function mkAgent(chainIds: number[]) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `s7-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_s7',
      walletId: `s7-wallet-${RUN}-${seq}`,
      safeAddress: `0x5757${randomBytes(18).toString('hex')}`,
      chainIds,
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '100000',
          cooldownSeconds: 0,
          // §5-6: a configured outflow cap out of the way (this suite tests other rules).
          maxOutflowPerTxUsd: '1000000',
        },
      },
    },
  });
}

async function app(agentId: string): Promise<FastifyInstance> {
  h.simulationOwner = agentId;
  const a = Fastify({ logger: Boolean(process.env['S7_DEBUG']) });
  m.registerErrorHandler(a);
  a.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agentId;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await a.register(m.transactionRoutes);
  await a.ready();
  return a;
}

const GMX_ABI = parseAbi([
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function sendWnt(address receiver, uint256 amount) payable',
  'function sendTokens(address token, address receiver, uint256 amount) payable',
]);
const SWAP_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);

/** The inner calls of a GMX multicall: [function name, args] each (createOrder's market from its raw word). */
function gmxInnerCalls(data: string) {
  const outer = decodeFunctionData({ abi: GMX_ABI, data: data as `0x${string}` });
  return (outer.args[0] as `0x${string}`[]).map((inner) => {
    try {
      const d = decodeFunctionData({ abi: GMX_ABI, data: inner });
      return { fn: d.functionName as string, args: d.args as readonly unknown[], raw: inner };
    } catch {
      return { fn: 'createOrder', args: [] as readonly unknown[], raw: inner };
    }
  });
}

describeDb('S7 — routes that read the corrected contract addresses (Postgres, viem with a canned chain)', () => {
  beforeAll(async () => {
    const [db, routes, handler, price] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/errors/handler.js'),
      import('../services/transaction/price.service.js'),
    ]);
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      registerErrorHandler: handler.registerErrorHandler,
      clearPriceCache: price.clearPriceCache,
    };
    // CoinGecko is stubbed; JSON-RPC to an S7 fork (viem's http transport) goes through.
    const realFetch = globalThis.fetch;
    const forks = [process.env['S7_FORK_RPC_8453'], process.env['S7_FORK_RPC_42161']].filter((u): u is string => Boolean(u));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (forks.some((f) => url.startsWith(f))) return realFetch(input, init);
      return coingecko(url);
    });
    await wipe();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.queued.length = 0;
    h.simulated.length = 0;
    h.ethCalls.length = 0;
    m.clearPriceCache();
  });

  it('Aave supply on Base: getPool is read from the official PoolAddressesProvider and the supply targets that Pool (was: 500, no request)', async () => {
    const agent = await mkAgent([BASE]);
    const res = await (await app(agent.id)).inject({
      method: 'POST',
      url: '/v1/transactions/deposit',
      payload: { chainId: BASE, asset: USDC_BASE, amount: '10' },
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.ethCalls).toContainEqual({ chainId: BASE, to: AAVE_PROVIDER_BASE, selector: GET_POOL });
    expect(h.simulated).toHaveLength(1);
    expect(getAddress(h.simulated[0]!.to)).toBe(AAVE_POOL_BASE);
  });

  it('Aave withdraw on Base: same provider read (was: 500)', async () => {
    const agent = await mkAgent([BASE]);
    const res = await (await app(agent.id)).inject({
      method: 'POST',
      url: '/v1/transactions/withdraw',
      payload: { chainId: BASE, asset: USDC_BASE, amount: '5' },
    });

    expect(res.statusCode, res.body).toBe(202);
    expect(h.ethCalls).toContainEqual({ chainId: BASE, to: AAVE_PROVIDER_BASE, selector: GET_POOL });
  });

  it('a swap on Base is quoted by the official QuoterV2 and keeps its slippage floor (was: no quote, amountOutMinimum 0)', async () => {
    const agent = await mkAgent([BASE]);
    const res = await (await app(agent.id)).inject({
      method: 'POST',
      url: '/v1/transactions/swap',
      payload: { chainId: BASE, fromToken: WETH_BASE, toToken: USDC_BASE, amountIn: '1', slippageTolerance: 0.5, simulationId: 'sim-s7' },
    });

    expect(res.statusCode, res.body).toBe(202);
    const swap = decodeFunctionData({ abi: SWAP_ABI, data: h.simulated[0]!.data as `0x${string}` });
    const params = swap.args[0] as { fee: number; amountOutMinimum: bigint };
    if (process.env['S7_FORK_RPC_8453']) {
      // Live fork quote: any sane ETH price leaves a floor above 100 USDC (was: 0).
      expect(params.amountOutMinimum).toBeGreaterThan(100_000_000n);
    } else {
      // Best tier 0.05%: 2000 USDC, minus 0.5% slippage (was: 0 — any price accepted).
      expect(params.amountOutMinimum).toBe(1_990_000_000n);
      expect(params.fee).toBe(500);
    }
    const quotes = h.ethCalls.filter((c) => c.selector === QUOTE_EXACT_INPUT_SINGLE);
    expect(quotes.map((q) => q.to)).toEqual([QUOTER_V2_BASE, QUOTER_V2_BASE, QUOTER_V2_BASE]);
  });

  it('GMX open ETH/USD on Arbitrum: execution fee and collateral go to the official OrderVault (was: 500)', async () => {
    const agent = await mkAgent([ARBITRUM]);
    const res = await (await app(agent.id)).inject({
      method: 'POST',
      url: '/v1/transactions/gmx-open',
      payload: {
        chainId: ARBITRUM, market: 'ETH/USD', collateralToken: USDC_ARB, collateralAmount: '10',
        sizeDeltaUsd: '20000000000000000000000000000000', acceptablePrice: '3000000000000000000000000000000000', isLong: true,
      },
    });

    expect(res.statusCode, res.body).toBe(202);
    const calls = gmxInnerCalls(h.simulated[0]!.data);
    expect(calls.map((c) => c.fn)).toEqual(['sendWnt', 'sendTokens', 'createOrder']);
    expect(getAddress(calls[0]!.args[0] as string)).toBe(GMX_ORDER_VAULT);
    expect(getAddress(calls[1]!.args[1] as string)).toBe(GMX_ORDER_VAULT);
    expect(calls[2]!.raw.toLowerCase()).toContain(GMX_ETH_USD.slice(2).toLowerCase());
  });

  it('GMX open by the "BTC/USD" label resolves to the official BTC/USD [WBTC.e-USDC] market (was: 500)', async () => {
    const agent = await mkAgent([ARBITRUM]);
    const res = await (await app(agent.id)).inject({
      method: 'POST',
      url: '/v1/transactions/gmx-open',
      payload: {
        chainId: ARBITRUM, market: 'BTC/USD', collateralToken: USDC_ARB, collateralAmount: '10',
        sizeDeltaUsd: '20000000000000000000000000000000', acceptablePrice: '70000000000000000000000000000000000', isLong: true,
      },
    });

    expect(res.statusCode, res.body).toBe(202);
    const calls = gmxInnerCalls(h.simulated[0]!.data);
    expect(calls[2]!.raw.toLowerCase()).toContain(GMX_BTC_USD.slice(2).toLowerCase());
  });
});
