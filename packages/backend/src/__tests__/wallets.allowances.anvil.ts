/**
 * S12 on a real EVM (Anvil, chain id 8453): `GET /v1/wallet/allowances`
 * reads the agent's ERC-20 allowance for the Aave V3 Pool — the address
 * `getPool()` of the configured PoolAddressesProvider answers — and reports
 * the Pool as spender. Before S12 it read `allowance(wallet, provider)`, so an
 * approval of the Pool never showed (and an approval of the provider, which
 * Aave never uses, was reported instead).
 *
 * Real here: the route, viem's `readContract` against Anvil, ERC-20 storage
 * written by real `approve` transactions signed by the agent. Stand-ins: the
 * Base token addresses the route checks (USDC, WETH) hold the Foundry
 * `MockERC20` runtime (`anvil_setCode`), and the configured provider holds a
 * 10-byte runtime that returns AaveV3Base.POOL for any call (`getPool()`).
 * The database is a stub (the agent row only). No network: `createChainPublicClient`
 * reads only RPC_URL_8453 (Anvil). Anvil: `anvilTestPort(5)` (default 8750).
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

const h = vi.hoisted(() => ({ agent: { safeAddress: '', chainIds: [8453] } }));

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../db/client.js', () => ({ db: { agent: { findUnique: async () => h.agent } } }));
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  const { createPublicClient, http } = await import('viem');
  return {
    ...actual,
    createChainPublicClient: (chainId: number) =>
      createPublicClient({ chain: actual.getChain(chainId), transport: http(process.env[`RPC_URL_${chainId}`], { retryCount: 0, timeout: 3_000 }) }),
  };
});

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { anvilAccount, anvilTestPort, readArtifact, startLocalChain, type LocalChain } from './helpers/anvil-contracts.js';

const CHAIN_ID = 8453;
const PROVIDER = getAddress('0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D'); // config/contracts.ts, Base
const ROUTER = getAddress('0x2626664c2603336E57B271c5C0b26F421741e481'); // config/contracts.ts, Base SwapRouter02
const POOL = getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'); // AaveV3Base.POOL
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const WETH = getAddress('0x4200000000000000000000000000000000000006');
const ERC20 = readArtifact('MockERC20', 'MockERC20.sol');
/** PUSH20 POOL, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN — `getPool()` (any call) answers POOL. */
const PROVIDER_RUNTIME = `0x73${POOL.slice(2).toLowerCase()}60005260206000f3` as Hex;

const agent = anvilAccount(2);
let chain: LocalChain;

async function approve(token: Address, spender: Address, amount: bigint) {
  const hash = await chain.wallet(agent).writeContract({
    address: token,
    abi: ERC20.abi,
    functionName: 'approve',
    args: [spender, amount],
    account: agent,
    chain: null,
  });
  expect((await chain.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
}

async function getAllowances() {
  const [{ walletRoutes }, { registerErrorHandler }] = await Promise.all([
    import('../api/routes/wallets.js'),
    import('../api/errors/handler.js'),
  ]);
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string }).agentId = 'agent-s12';
  });
  await app.register(walletRoutes);
  const res = await app.inject({ method: 'GET', url: `/v1/wallet/allowances?chainId=${CHAIN_ID}` });
  await app.close();
  return res;
}

beforeAll(async () => {
  chain = await startLocalChain({ port: anvilTestPort(5), chainId: CHAIN_ID });
  process.env[`RPC_URL_${CHAIN_ID}`] = chain.rpcUrl;
  h.agent.safeAddress = agent.address;
  for (const token of [USDC, WETH]) await chain.rpc('anvil_setCode', [token, ERC20.deployedBytecode]);
  await chain.rpc('anvil_setCode', [PROVIDER, PROVIDER_RUNTIME]);

  await approve(USDC, POOL, 250_000_000n); // what an Aave supply of 250 USDC needs
  await approve(WETH, ROUTER, 10n ** 18n);
  await approve(USDC, PROVIDER, 999n); // an approval Aave never uses
});

afterAll(() => {
  chain?.stop();
});

describe('S12 on Anvil — the Aave allowance is the Pool\'s', () => {
  it('the provider\'s getPool() on chain answers the Pool (the stand-in works as the real provider does)', async () => {
    const pool = await chain.publicClient.readContract({
      address: PROVIDER,
      abi: [{ name: 'getPool', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }],
      functionName: 'getPool',
    });
    expect(getAddress(pool)).toBe(POOL);
  });

  it('reports the USDC approval of the Pool (spender = Pool) and the router\'s, never the provider', async () => {
    const res = await getAllowances();

    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as Array<{ token: string; spender: string; allowance: string }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: USDC, symbol: 'USDC', spender: POOL, allowance: '250000000', allowanceFormatted: '250' }),
        expect.objectContaining({ token: WETH, symbol: 'WETH', spender: ROUTER, allowance: (10n ** 18n).toString() }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => getAddress(r.spender))).not.toContain(PROVIDER);
  });

  it('a provider that reverts: 502 AAVE_POOL_UNAVAILABLE, not a silent empty list', async () => {
    await chain.rpc('anvil_setCode', [PROVIDER, '0xfe']); // INVALID: every call reverts
    try {
      const res = await getAllowances();
      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'AAVE_POOL_UNAVAILABLE' });
      expect(res.body).not.toContain(chain.rpcUrl);
    } finally {
      await chain.rpc('anvil_setCode', [PROVIDER, PROVIDER_RUNTIME]);
    }
  });

  it('no code at the provider: 502 AAVE_POOL_UNAVAILABLE', async () => {
    await chain.rpc('anvil_setCode', [PROVIDER, '0x']);
    try {
      const res = await getAllowances();
      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'AAVE_POOL_UNAVAILABLE' });
    } finally {
      await chain.rpc('anvil_setCode', [PROVIDER, PROVIDER_RUNTIME]);
    }
  });
});
