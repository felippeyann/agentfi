/**
 * S12 — `GET /v1/wallet/allowances` must report the Aave V3 allowance against
 * the Pool, the contract an Aave supply calls and that pulls the tokens
 * (`transferFrom`), not against the PoolAddressesProvider. Before S12 the
 * default spenders were the Uniswap router and `aavePoolAddressProvider`,
 * so the Aave allowance always read 0 and was filtered out (found in #183).
 *
 * The Pool comes from the same source the Aave routes use (supply /
 * withdraw, and D20's trusted withdraw targets): `getPool()` on the chain's
 * configured PoolAddressesProvider, read with the chain's public client. A
 * provider that cannot be read, or answers no Pool, is an explicit error —
 * never a silent "no allowance".
 *
 * The RPC client is a recording fake: every `readContract` (address,
 * function, args) is checked, so the call contract is pinned here; the same
 * reads against a real EVM: wallets.allowances.anvil.ts.
 */
import Fastify from 'fastify';
import { getAddress, type Address } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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


const h = vi.hoisted(() => ({
  reads: [] as Array<{ chainId: number; address: string; functionName: string; args?: readonly unknown[] }>,
  /** What `getPool()` answers (an address), or an Error to throw. */
  pool: '' as string | Error,
  allowances: new Map<string, bigint>(),
  agent: { safeAddress: '0x1111111111111111111111111111111111111111', chainIds: [8453] },
}));

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../db/client.js', () => ({
  db: { agent: { findUnique: async () => h.agent } },
}));
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  return {
    ...actual,
    createChainPublicClient: (chainId: number) => ({
      readContract: async (p: { address: string; functionName: string; args?: readonly unknown[] }) => {
        h.reads.push({ chainId, address: p.address, functionName: p.functionName, ...(p.args ? { args: p.args } : {}) });
        if (p.functionName === 'getPool') {
          if (h.pool instanceof Error) throw h.pool;
          return h.pool;
        }
        if (p.functionName === 'allowance') {
          const [owner, spender] = p.args as [string, string];
          return h.allowances.get(`${p.address.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n;
        }
        throw new Error(`unexpected read ${p.functionName}`);
      },
    }),
  };
});

const CHAIN_ID = 8453;
/** config/contracts.ts, Base: the configured PoolAddressesProvider and SwapRouter02. */
const PROVIDER = getAddress('0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D');
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481');
/** AaveV3Base.POOL — what the provider's getPool() answers on Base. */
const POOL = getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const OWNER = h.agent.safeAddress;

function allow(token: string, spender: Address, amount: bigint) {
  h.allowances.set(`${token.toLowerCase()}:${OWNER.toLowerCase()}:${spender.toLowerCase()}`, amount);
}

let walletRoutes: typeof import('../api/routes/wallets.js')['walletRoutes'];
let registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];

beforeAll(async () => {
  ({ walletRoutes } = await import('../api/routes/wallets.js'));
  ({ registerErrorHandler } = await import('../api/errors/handler.js'));
});

beforeEach(() => {
  h.reads.length = 0;
  h.pool = POOL;
  h.allowances.clear();
  h.agent.chainIds = [CHAIN_ID];
});

async function getAllowances(query = `chainId=${CHAIN_ID}`) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string }).agentId = 'agent-1';
  });
  await app.register(walletRoutes);
  const res = await app.inject({ method: 'GET', url: `/v1/wallet/allowances?${query}` });
  await app.close();
  return res;
}

const spendersRead = () =>
  h.reads.filter((r) => r.functionName === 'allowance').map((r) => getAddress((r.args as [string, string])[1]));

describe('S12 — the Aave allowance is read against the Pool', () => {
  it('reports the USDC allowance the agent gave the Aave Pool, with the Pool as spender', async () => {
    allow(USDC, POOL, 250_000_000n);

    const res = await getAllowances();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([
      { token: USDC, symbol: 'USDC', spender: POOL, allowance: '250000000', allowanceFormatted: '250' },
    ]);
  });

  it('the Pool is getPool() of the configured PoolAddressesProvider, on the requested chain (the Aave routes\' source)', async () => {
    await getAllowances();

    const poolReads = h.reads.filter((r) => r.functionName === 'getPool');
    expect(poolReads).toEqual([{ chainId: CHAIN_ID, address: PROVIDER, functionName: 'getPool' }]);
  });

  it('every allowance(owner, spender) read uses the agent wallet as owner and the router or the Pool as spender — never the provider', async () => {
    await getAllowances();

    const allowanceReads = h.reads.filter((r) => r.functionName === 'allowance');
    // 2 common tokens on Base × 2 default spenders.
    expect(allowanceReads).toHaveLength(4);
    for (const r of allowanceReads) {
      expect(r.chainId).toBe(CHAIN_ID);
      expect([USDC, WETH]).toContain(r.address);
      expect(getAddress((r.args as [string, string])[0])).toBe(getAddress(OWNER));
    }
    expect(new Set(spendersRead())).toEqual(new Set([ROUTER, POOL]));
    expect(spendersRead()).not.toContain(PROVIDER);
  });

  it('the Uniswap router allowance is still reported (unchanged)', async () => {
    allow(WETH, ROUTER, 10n ** 18n);
    allow(USDC, POOL, 1n);

    const res = await getAllowances();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: WETH, spender: ROUTER, allowance: (10n ** 18n).toString() }),
        expect.objectContaining({ token: USDC, spender: POOL, allowance: '1' }),
      ]),
    );
  });
});

describe('S12 — a Pool that cannot be resolved is an error, never a silent 0', () => {
  it('getPool() fails (RPC error / revert): 502 AAVE_POOL_UNAVAILABLE naming the provider, no allowance reported', async () => {
    h.pool = new Error('execution reverted');
    allow(WETH, ROUTER, 5n);

    const res = await getAllowances();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'AAVE_POOL_UNAVAILABLE' });
    expect(res.json().error).toContain(PROVIDER);
    expect(res.json().error).toContain(String(CHAIN_ID));
    expect(spendersRead()).toEqual([]);
  });

  it('the RPC error text is not echoed (it can carry the RPC URL with its key)', async () => {
    h.pool = new Error('HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/sk-secret-key-123');

    const res = await getAllowances();

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/alchemy|sk-secret/);
  });

  it.each([
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['not an address', '0x1234'],
  ])('getPool() answers %s: 502 AAVE_POOL_UNAVAILABLE', async (_label, answer) => {
    h.pool = answer;

    const res = await getAllowances();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'AAVE_POOL_UNAVAILABLE' });
    expect(spendersRead()).toEqual([]);
  });
});

describe('S12 — unchanged paths', () => {
  it('an explicit ?spender= is the only spender read; the provider is not consulted', async () => {
    allow(USDC, ROUTER, 7n);

    const res = await getAllowances(`chainId=${CHAIN_ID}&spender=${ROUTER}`);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ token: USDC, spender: ROUTER, allowance: '7' })]);
    expect(h.reads.filter((r) => r.functionName === 'getPool')).toEqual([]);
    expect(new Set(spendersRead())).toEqual(new Set([ROUTER]));
  });

  it('a chain without Aave configured (Base Sepolia: provider = zero address) reads no getPool and answers 200', async () => {
    h.agent.chainIds = [84532];

    const res = await getAllowances('chainId=84532');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([]);
    expect(h.reads.filter((r) => r.functionName === 'getPool')).toEqual([]);
  });
});

