/**
 * Plan §5 question 7 — "max" withdrawals under a daily limit, on REAL
 * Postgres through the real withdraw routes.
 *
 * D15 / Q9 (#173): an Aave / Compound / ERC-4626 withdrawal of `max`
 * (`maxUint256`, "everything") has no amount to price, so while the agent's
 * policy has a daily limit it is refused (`503 PRICE_UNAVAILABLE`).
 *
 * The owner's rule (2026-10-14): such a withdrawal may proceed OUTSIDE the
 * outflow count only when the system PROVES, from the exact calldata the
 * backend built and the address the transaction is sent from, that it
 * returns the funds to the agent's own wallet and that there is no other
 * outflow or additional authorisation — no native value, no approve, a single
 * call, every recipient / receiver / owner argument equal to the sender —
 * and only to a trusted protocol contract from `config/contracts.ts` (the
 * Aave pool the configured PoolAddressesProvider reports, the configured
 * Compound Comet). An ERC-4626 vault is chosen by the agent: not trusted,
 * still refused. Explicit-amount withdrawals keep their accounting.
 *
 * Real: Postgres, the withdraw routes, the policy service, the DailyVolume
 * reservation, the synthetic test prices (84532: USDC = 1 USD). Faked: the
 * queue (a recorder), the simulator, notifications, the ERC-8183 runtime, the
 * chain reads (Aave's `getPool` answers POOL; decimals) and the contract
 * table (COMET, PROVIDER); in some cases the transaction builder is replaced
 * to show that the calldata — not the route's intent — decides.
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
  process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2000,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1';
  return {
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    simulations: 0,
    /** What Aave's PoolAddressesProvider answers to getPool(). */
    pool: '0x00000000000000000000000000000000000000Ab',
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
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: async () => undefined,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
}));
vi.mock('../config/contracts.js', async () => {
  const actual = await vi.importActual<typeof import('../config/contracts.js')>('../config/contracts.js');
  return {
    ...actual,
    getContracts: (chainId: number) => ({
      ...actual.getContracts(chainId),
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
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (functionName === 'getPool') {
          if (address.toLowerCase() !== '0x00000000000000000000000000000000000000a8') throw new Error(`getPool on unexpected ${address}`);
          return h.pool;
        }
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
import { encodeFunctionData, getAddress, maxUint256, type Address, type Hex } from 'viem';
import { TransactionBuilder } from '../services/transaction/builder.service.js';

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
  if (process.env['CI']) throw new Error('max-withdrawal.routes.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[max-withdrawal.routes.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
};
let m: Modules;

const NAME_PREFIX = 'q7-maxw';
const RUN = randomBytes(3).toString('hex');
const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const COMET = '0x00000000000000000000000000000000000000a7';
const POOL = '0x00000000000000000000000000000000000000Ab';
const ATTACKER = '0x000000000000000000000000000000000000bAd0';
const VAULT = '0x0000000000000000000000000000000000004626';
let seq = 0;

const AAVE_WITHDRAW_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

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

/** Daily limit 1000 USD unless overridden; no approval threshold in the way (withdrawals carry no ETH). */
async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `q7-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_q7',
      walletId: `q7-wallet-${RUN}-${seq}`,
      safeAddress: `0x7a7a${randomBytes(18).toString('hex')}`,
      chainIds: [CHAIN_ID],
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

async function app(agentId: string): Promise<FastifyInstance> {
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

async function volume(agentId: string): Promise<number> {
  const rows = await m.db.dailyVolume.findMany({ where: { agentId } });
  return rows.reduce((sum, r) => sum + Number(r.volumeUsd), 0);
}

async function rows(agentId: string) {
  return m.db.transaction.findMany({
    where: { agentId },
    select: { id: true, status: true, type: true, volumeState: true, volumeReservedUsd: true, volumePriceSource: true, metadata: true },
  });
}

async function onlyRow(agentId: string) {
  const all = await rows(agentId);
  expect(all).toHaveLength(1);
  return all[0]!;
}

const aaveMaxWithdrawData = (to: string) =>
  encodeFunctionData({ abi: AAVE_WITHDRAW_ABI, functionName: 'withdraw', args: [getAddress(USDC), maxUint256, getAddress(to)] });

describeDb('§5-7 — "max" withdrawals under a daily limit, on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, handler] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/errors/handler.js'),
    ]);
    m = { db: db.db, transactionRoutes: routes.transactionRoutes, registerErrorHandler: handler.registerErrorHandler };
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
    h.pool = POOL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Proven: outside the outflow count ──────────────────────────────────────

  it('Aave: a max withdrawal back to the agent\'s own wallet is accepted under a daily limit, counted as nothing, and marked', async () => {
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw', { asset: USDC, amount: 'max' });

    expect(res.statusCode, res.body).toBe(202);
    const row = await onlyRow(agent.id);
    expect(row).toMatchObject({ status: 'QUEUED', type: 'WITHDRAW', volumeState: null, volumeReservedUsd: null, volumePriceSource: null });
    expect((row.metadata as Record<string, unknown>)['volumeExemption']).toEqual({
      rule: 'max-withdrawal-to-own-wallet',
      protocol: 'aave-v3',
      target: getAddress(POOL),
      asset: getAddress(USDC),
      recipient: getAddress(agent.safeAddress),
    });
    expect(await volume(agent.id)).toBe(0);
    // What is queued is exactly what was proven: the pool, the agent as sender and recipient, no value.
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.data).toMatchObject({
      from: getAddress(agent.safeAddress),
      to: getAddress(POOL),
      value: '0',
      data: aaveMaxWithdrawData(agent.safeAddress),
    });
  });

  it('Compound: a max withdrawal from the configured Comet (funds return to the sender) is accepted under a daily limit, counted as nothing, and marked', async () => {
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw-compound', { asset: USDC, amount: 'max' });

    expect(res.statusCode, res.body).toBe(202);
    const row = await onlyRow(agent.id);
    expect(row).toMatchObject({ status: 'QUEUED', volumeState: null, volumeReservedUsd: null });
    expect((row.metadata as Record<string, unknown>)['volumeExemption']).toEqual({
      rule: 'max-withdrawal-to-own-wallet',
      protocol: 'compound-v3',
      target: getAddress(COMET),
      asset: getAddress(USDC),
      recipient: getAddress(agent.safeAddress),
    });
    expect(await volume(agent.id)).toBe(0);
    expect(h.queued[0]!.data).toMatchObject({ from: getAddress(agent.safeAddress), to: getAddress(COMET), value: '0' });
  });

  it('a proven max withdrawal does not consume the daily budget: the agent can still spend its full limit after it', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '25' });
    const a = await app(agent.id);
    expect((await post(a, '/v1/transactions/withdraw', { asset: USDC, amount: 'max' })).statusCode).toBe(202);
    const transfer = await post(a, '/v1/transactions/transfer', { token: USDC, to: ATTACKER, amount: '25' });
    expect(transfer.statusCode, transfer.body).toBe(202);
    expect(await volume(agent.id)).toBeCloseTo(25, 6);
  });

  // ── Explicit amounts: unchanged accounting ─────────────────────────────────

  it.each([
    ['/v1/transactions/withdraw', { asset: USDC, amount: '25' }],
    ['/v1/transactions/withdraw-compound', { asset: USDC, amount: '25' }],
    ['/v1/transactions/withdraw-erc4626', { vault: VAULT, asset: USDC, amount: '25' }],
  ])('%s with an explicit amount is still priced and counted (25 USD), unmarked', async (url, body) => {
    const agent = await mkAgent();
    const res = await post(await app(agent.id), url, body);
    expect(res.statusCode, res.body).toBe(202);
    const row = await onlyRow(agent.id);
    expect(row).toMatchObject({ volumeState: 'RESERVED', volumeReservedUsd: '25.000000', volumePriceSource: 'synthetic' });
    expect((row.metadata as Record<string, unknown>)['volumeExemption']).toBeUndefined();
    expect(await volume(agent.id)).toBeCloseTo(25, 6);
  });

  // ── Not proven: still refused under a daily limit ──────────────────────────

  it('ERC-4626: a max withdrawal from a vault the agent chose is still refused (503 PRICE_UNAVAILABLE) — the vault is not a trusted protocol contract', async () => {
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw-erc4626', { vault: VAULT, asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await rows(agent.id)).toHaveLength(0);
    expect(h.simulations).toBe(0);
  });

  it.each([
    ['the Compound Comet', COMET],
    ['the Aave pool', POOL],
  ])('ERC-4626: naming %s as the "vault" proves nothing (its ERC-4626 calldata is not that protocol\'s withdraw) — refused', async (_name, vault) => {
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw-erc4626', { vault, asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await rows(agent.id)).toHaveLength(0);
  });

  it('Aave: calldata that sends the withdrawal to another address is refused, whatever the route meant to build', async () => {
    vi.spyOn(TransactionBuilder.prototype, 'buildAaveWithdraw').mockImplementation((p: { poolAddress: Address; asset: Address; amount: bigint }) => ({
      to: p.poolAddress,
      data: aaveMaxWithdrawData(ATTACKER) as Hex,
      value: 0n,
      token: p.asset,
    }));
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw', { asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    expect(await rows(agent.id)).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
  });

  it('Aave: a max withdrawal carrying native value is refused', async () => {
    vi.spyOn(TransactionBuilder.prototype, 'buildAaveWithdraw').mockImplementation((p: { poolAddress: Address; asset: Address; to: Address }) => ({
      to: p.poolAddress,
      data: aaveMaxWithdrawData(p.to) as Hex,
      value: 1n,
      token: p.asset,
    }));
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw', { asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(await rows(agent.id)).toHaveLength(0);
  });

  it('Aave: a max withdrawal sent to a contract that is not the pool the configured provider reports is refused', async () => {
    vi.spyOn(TransactionBuilder.prototype, 'buildAaveWithdraw').mockImplementation((p: { asset: Address; to: Address }) => ({
      to: getAddress(VAULT),
      data: aaveMaxWithdrawData(p.to) as Hex,
      value: 0n,
      token: p.asset,
    }));
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw', { asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(await rows(agent.id)).toHaveLength(0);
  });

  it('Compound: calldata that is not exactly Comet.withdraw(asset, max) (here withdrawTo an outside address) is refused', async () => {
    vi.spyOn(TransactionBuilder.prototype, 'buildCompoundWithdraw').mockImplementation((p: { cometAddress: Address; asset: Address; amount: bigint }) => ({
      to: p.cometAddress,
      data: encodeFunctionData({
        abi: [
          {
            name: 'withdrawTo',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'asset', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [],
          },
        ] as const,
        functionName: 'withdrawTo',
        args: [getAddress(ATTACKER), p.asset, p.amount],
      }),
      value: 0n,
      token: p.asset,
    }));
    const agent = await mkAgent();
    const res = await post(await app(agent.id), '/v1/transactions/withdraw-compound', { asset: USDC, amount: 'max' });
    expect(res.statusCode, res.body).toBe(503);
    expect(await rows(agent.id)).toHaveLength(0);
  });

  // ── Without a daily limit ──────────────────────────────────────────────────

  it('without a daily limit: a proven max withdrawal is accepted and marked; an unproven one (ERC-4626) is accepted as before, unmarked, nothing reserved', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '0' });
    const a = await app(agent.id);
    expect((await post(a, '/v1/transactions/withdraw', { asset: USDC, amount: 'max' })).statusCode).toBe(202);
    expect((await post(a, '/v1/transactions/withdraw-erc4626', { vault: VAULT, asset: USDC, amount: 'max' })).statusCode).toBe(202);
    const all = await rows(agent.id);
    expect(all).toHaveLength(2);
    const aave = all.find((r) => (r.metadata as Record<string, unknown>)['protocol'] !== 'erc4626')!;
    const vault = all.find((r) => (r.metadata as Record<string, unknown>)['protocol'] === 'erc4626')!;
    expect((aave.metadata as Record<string, unknown>)['volumeExemption']).toMatchObject({ rule: 'max-withdrawal-to-own-wallet' });
    expect((vault.metadata as Record<string, unknown>)['volumeExemption']).toBeUndefined();
    expect(all.every((r) => r.volumeState === null)).toBe(true);
    expect(await volume(agent.id)).toBe(0);
  });
});
