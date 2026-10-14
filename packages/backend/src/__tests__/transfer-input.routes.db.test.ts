/**
 * `POST /v1/transactions/transfer` — `to` and `token` are validated by the
 * route's schema (review of #181, P2), on REAL Postgres.
 *
 * The finding: the schema took `to` and `token` as any string and the
 * handler called viem `getAddress()` on them later. In the viem this
 * backend runs (2.57), `getAddress` checks the hex shape only (`isAddress`
 * with `strict: false`) and re-checksums whatever it gets, so:
 *   - `to` / `token` that is not an address (`"agent-42"`, the symbol
 *     `"USDC"`) → `getAddress` throws inside the handler → 500;
 *   - a mixed-case `to` whose EIP-55 checksum is WRONG — what a typo in a
 *     checksummed address looks like — is silently re-checksummed: 202, and
 *     the transfer is built, simulated and queued to that address.
 * Both are now 400 VALIDATION_FAILED from the schema, with viem's strict
 * rule (`isAddress(x, { strict: true })`): all-lowercase, or mixed case with
 * a valid checksum. `token` is "ETH" (any case, as before) or such an address.
 *
 * Real here: the route, its zod schema, the error handler, the builder, viem,
 * the policy service, the DailyVolume reservation and the testnet synthetic
 * prices. Faked: the queue (jobs captured), the simulator (calls captured),
 * notifications, the fee price oracle and the ERC-8183 runtime.
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
    simulated: [] as Array<{ to: string; data: string; value: bigint }>,
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
    async simulate(params: { to: string; data: string; value: bigint }) {
      h.simulated.push(params);
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

import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "allowedRecipients" FROM "AgentPolicy" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('transfer-input.routes.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[transfer-input.routes.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
};
let m: Modules;

const NAME_PREFIX = 'integ-transfer-input';
const RUN = randomBytes(3).toString('hex');
const BASE_SEPOLIA = 84532;
const USDC_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** RECIPIENT with one letter's case flipped: same hex, checksum no longer valid (a typo's signature). */
const RECIPIENT_BAD_CHECKSUM = '0x70997970c51812dc3A010C7d01b50e0d17dc79C8';
/** USDC_84532 with one letter's case flipped. */
const USDC_BAD_CHECKSUM = '0x036cbD53842c5426634e7929541eC2318f3dCF7e';
let seq = 0;

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

async function mkAgent() {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `integ-ti-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_ti',
      walletId: `integ-ti-wallet-${RUN}-${seq}`,
      safeAddress: `0x7171${randomBytes(18).toString('hex')}`,
      chainIds: [BASE_SEPOLIA],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
        },
      },
    },
  });
}

async function transfer(body: Record<string, unknown>) {
  const agent = await mkAgent();
  const app = Fastify({ logger: false });
  m.registerErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agent.id;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await app.register(m.transactionRoutes);
  await app.ready();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfer',
      payload: { chainId: BASE_SEPOLIA, amount: '1', ...body },
    });
    const rows = await m.db.transaction.count({ where: { agentId: agent.id } });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, rows };
  } finally {
    await app.close();
  }
}

/** The issue paths of a 400 VALIDATION_FAILED body. */
function issuePaths(body: Record<string, unknown>): string[] {
  return ((body['details'] ?? []) as Array<{ path: unknown[] }>).map((d) => d.path.join('.'));
}

describeDb('transfer route: `to` and `token` are validated by the schema (review of #181, P2; Postgres)', () => {
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
    h.simulated.length = 0;
  });

  it('the fixtures: the bad-checksum variants are the same hex as valid addresses, and viem strict refuses them', () => {
    expect(RECIPIENT_BAD_CHECKSUM.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(USDC_BAD_CHECKSUM.toLowerCase()).toBe(USDC_84532.toLowerCase());
    expect(isAddress(RECIPIENT_BAD_CHECKSUM, { strict: true })).toBe(false);
    expect(isAddress(USDC_BAD_CHECKSUM, { strict: true })).toBe(false);
    // ...while getAddress (what the handler called) accepts and re-checksums them.
    expect(getAddress(RECIPIENT_BAD_CHECKSUM)).toBe(RECIPIENT);
  });

  it('a `to` that is not an address is 400 VALIDATION_FAILED on `to` (was: 500 from getAddress), nothing created', async () => {
    const res = await transfer({ token: 'ETH', to: 'agent-42' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(issuePaths(res.body)).toEqual(['to']);
    expect(res.rows).toBe(0);
    expect(h.simulated).toHaveLength(0);
  });

  it('a symbol in `token` ("USDC") is 400 VALIDATION_FAILED on `token` (was: 500), nothing created', async () => {
    const res = await transfer({ token: 'USDC', to: RECIPIENT });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(issuePaths(res.body)).toEqual(['token']);
    expect(res.rows).toBe(0);
  });

  it('a mixed-case `to` with a wrong EIP-55 checksum is 400 (was: 202, re-checksummed, simulated and queued)', async () => {
    const res = await transfer({ token: 'ETH', to: RECIPIENT_BAD_CHECKSUM, amount: '0.01' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(issuePaths(res.body)).toEqual(['to']);
    expect(res.rows).toBe(0);
    expect(h.simulated).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
  });

  it('a mixed-case `token` with a wrong EIP-55 checksum is 400 (was: 202)', async () => {
    const res = await transfer({ token: USDC_BAD_CHECKSUM, to: RECIPIENT });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(issuePaths(res.body)).toEqual(['token']);
    expect(res.rows).toBe(0);
  });

  it('control: an all-lowercase `to` and `token` (no checksum) are accepted — 202, the transfer pays the checksummed recipient', async () => {
    const res = await transfer({ token: USDC_84532.toLowerCase(), to: RECIPIENT.toLowerCase() });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.rows).toBe(1);
    expect(h.queued).toHaveLength(1);
    expect(getAddress(h.queued[0]!.data['to'] as string)).toBe(USDC_84532);
  });

  it('control: "eth" in any case is still the native asset', async () => {
    const res = await transfer({ token: 'eth', to: RECIPIENT, amount: '0.01' });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(h.queued[0]!.data).toMatchObject({ to: RECIPIENT, data: '0x' });
  });
});
