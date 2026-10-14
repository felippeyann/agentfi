/**
 * A6c / plan §5 question 8 — an operator approval of a PENDING_APPROVAL
 * transaction on a later UTC day, on REAL Postgres.
 *
 * A6b-R (#171) made the approval move the transaction's DailyVolume
 * reservation from its creation day to the approval day
 * (`moveReservationToDay`), but without checking the approval day's limit
 * (`maxDailyVolumeUsd`, which also counts the agent's x402 payments): the
 * operator's ordinary approval could push the approval day over the limit.
 *
 * The owner's rule (2026-10-14): the approval revalidates and reserves
 * atomically on the effective approval day, under the Agent lock, like every
 * other reservation. An ordinary approval never exceeds the daily limit — it
 * is refused with a stable code, the row stays PENDING_APPROVAL and its
 * reservation stays untouched on its creation day (nothing released or moved
 * on a refusal). An exception would need a separate, explicit, audited
 * operator act; no such interface exists, so the excess is refused. The
 * approval also re-checks that the agent and its policy are active and the
 * policy unexpired.
 *
 * Real: Postgres, the transfer route (creation + reservation), the admin
 * approve / reject routes, the x402 ledger's daily total. Faked: the BullMQ
 * queue (an in-memory recorder that can refuse an `add`), the simulator, the
 * notifications, the ERC-8183 runtime, and the clock — `Date` only
 * (`vi.useFakeTimers({ toFake: ['Date'] })`), so the routes create and approve
 * on chosen UTC days; Postgres and every timer keep real time. Prices: the
 * synthetic Base Sepolia price, 1 ETH = 2000 USD, so 0.01 ETH = 20 USD.
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
  const syntheticPrices = {
    all: '84532:native=2000,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
    tokensOnly: '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1',
  };
  process.env['SYNTHETIC_TEST_PRICES_USD'] = syntheticPrices.all;
  return {
    /** Jobs the routes enqueued, in order. */
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    /** true: the next `transactionQueue.add` throws (Redis down). */
    enqueueFails: false,
    syntheticPrices,
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
      if (h.enqueueFails) throw new Error('Connection is closed.');
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
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: async () => undefined,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Database availability ──────────────────────────────────────────────────

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "volumeReservedDate" FROM "Transaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('approval-day.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[approval-day.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

// ── Modules under test (after env + mocks) ─────────────────────────────────

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  adminRoutes: typeof import('../api/routes/admin.js')['adminRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
};
let m: Modules;

const NAME_PREFIX = 'a6c-appr';
const CHAIN_ID = 84532;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ADMIN = { 'x-admin-secret': process.env['ADMIN_SECRET'] as string };
const RUN = randomBytes(3).toString('hex');
let seq = 0;

/** The UTC days the tests run on (far from the real date: only `Date` is faked). */
const D1 = '2031-03-04';
const D2 = '2031-03-05';
const D3 = '2031-03-06';
const at = (day: string, time = '12:00:00.000') => new Date(`${day}T${time}Z`);

function setClock(when: Date): void {
  vi.setSystemTime(when);
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

/** An agent whose every transfer above 0.001 ETH waits for the operator; daily limit 1000 USD unless overridden. */
async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `a6c-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_a6c',
      walletId: `a6c-wallet-${RUN}-${seq}`,
      safeAddress: `0xa6c0${randomBytes(18).toString('hex')}`,
      chainIds: [CHAIN_ID],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '0.001',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          // §5-6: a configured outflow cap out of the way (this suite tests other rules).
          maxOutflowPerTxUsd: '1000000',
          ...policy,
        },
      },
    },
  });
}

async function volume(agentId: string, date: string): Promise<number> {
  const row = await m.db.dailyVolume.findFirst({ where: { agentId, date } });
  return row ? Number(row.volumeUsd) : 0;
}

/** Other spends the agent already made on `date` (as if earlier transfers had reserved them). */
async function setVolume(agentId: string, date: string, usd: string): Promise<void> {
  await m.db.dailyVolume.upsert({
    where: { agentId_date: { agentId, date } },
    create: { agentId, date, volumeUsd: usd },
    update: { volumeUsd: usd },
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
  await a.register(m.adminRoutes);
  await a.ready();
  return a;
}

/** A 0.01 ETH (20 USD) transfer created at `when`: PENDING_APPROVAL, 20 USD reserved on that day. */
async function pendingTransfer(a: FastifyInstance, when: Date, amount = '0.01'): Promise<string> {
  setClock(when);
  const res = await a.inject({
    method: 'POST',
    url: '/v1/transactions/transfer',
    payload: { chainId: CHAIN_ID, token: 'ETH', to: RECIPIENT, amount },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json().status).toBe('PENDING_APPROVAL');
  return res.json().transactionId as string;
}

function approve(a: FastifyInstance, id: string) {
  return a.inject({ method: 'POST', url: `/admin/transactions/${id}/approve`, headers: ADMIN });
}

function reject(a: FastifyInstance, id: string) {
  return a.inject({ method: 'POST', url: `/admin/transactions/${id}/reject`, headers: ADMIN });
}

async function row(id: string) {
  return m.db.transaction.findUnique({
    where: { id },
    select: { status: true, volumeState: true, volumeReservedUsd: true, volumeReservedDate: true },
  });
}

function queuedFor(id: string) {
  return h.queued.filter((q) => q.data['transactionId'] === id);
}

/** A counted x402 payment of `usdc` (whole USDC) by `agentId`, reserved at `when`. */
async function x402Payment(agentId: string, usdc: number, when: Date): Promise<void> {
  const requester = await mkAgent();
  const job = await m.db.job.create({
    data: { requesterId: requester.id, providerId: agentId, status: 'ACCEPTED', payload: {}, reward: { amount: '1', token: 'USDC', chainId: CHAIN_ID } },
  });
  await m.db.resourcePayment.create({
    data: {
      jobId: job.id,
      agentId,
      paymentId: `a6c_${RUN}_${seq}_${randomBytes(4).toString('hex')}`,
      url: 'https://resource.example/data',
      method: 'GET',
      network: `eip155:${CHAIN_ID}`,
      asset: USDC,
      amount: String(usdc * 1_000_000),
      payTo: RECIPIENT,
      status: 'settled',
      reservedAt: when,
    },
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────

describeDb('A6c — operator approval on a later UTC day, on Postgres', () => {
  beforeAll(async () => {
    const [db, routes, admin, handler] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/routes/admin.js'),
      import('../api/errors/handler.js'),
    ]);
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      adminRoutes: admin.adminRoutes,
      registerErrorHandler: handler.registerErrorHandler,
    };
    await wipe();
  });

  afterAll(async () => {
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.queued.length = 0;
    h.enqueueFails = false;
    process.env['SYNTHETIC_TEST_PRICES_USD'] = h.syntheticPrices.all;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── The defect ─────────────────────────────────────────────────────────────

  it('reproduction: an approval on a later UTC day that would exceed that day\'s limit is refused — APPROVAL_DAILY_LIMIT, still PENDING_APPROVAL, reservation untouched on its creation day', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    // On D2 the agent has already spent 990 of its 1000 USD on its own.
    await setVolume(agent.id, D2, '990');

    setClock(at(D2));
    const res = await approve(a, id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'APPROVAL_DAILY_LIMIT' });
    expect(await row(id)).toEqual({ status: 'PENDING_APPROVAL', volumeState: 'RESERVED', volumeReservedUsd: '20.000000', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(990, 6);
    expect(queuedFor(id)).toHaveLength(0);
  });

  it('the refusal tells the operator the day, the limit, what is committed and what was requested', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await setVolume(agent.id, D2, '990');
    setClock(at(D2));
    const body = (await approve(a, id)).json();
    expect(body.details).toEqual({ day: D2, limitUsd: '1000', committedUsd: '990.000000', requestedUsd: '20.000000' });
    expect(body.error).toMatch(/1000 USD/);
  });

  // ── UTC rollover ───────────────────────────────────────────────────────────

  it('UTC rollover: requested at 23:59:59.900 on D1 and approved at 00:00:00.100 on D2 is judged against D2 — refused while D2 is full, accepted once it fits, moved once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1, '23:59:59.900'));
    expect((await row(id))?.volumeReservedDate).toBe(D1);
    await setVolume(agent.id, D2, '981');

    setClock(at(D2, '00:00:00.100'));
    const refused = await approve(a, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('APPROVAL_DAILY_LIMIT');
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(981, 6);

    // One USD of D2 is given back (another spend of D2 released): 980 + 20 = 1000 fits exactly.
    await setVolume(agent.id, D2, '980');
    const accepted = await approve(a, id);
    expect(accepted.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeState: 'RESERVED', volumeReservedDate: D2 });
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(1000, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('UTC rollover: the same transaction approved at 23:59:59.999 on D1 stays on D1 (no move, D2 untouched)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1, '23:59:59.900'));
    await setVolume(agent.id, D2, '995');
    setClock(at(D1, '23:59:59.999'));
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(995, 6);
  });

  // ── Concurrency ────────────────────────────────────────────────────────────

  it('two approvals racing for the last room of the approval day: exactly the one that fits passes', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const first = await pendingTransfer(a, at(D1, '10:00:00.000'));
    const second = await pendingTransfer(a, at(D1, '11:00:00.000'));
    await setVolume(agent.id, D2, '970'); // room for 30 USD: one 20 USD transfer, not two

    setClock(at(D2));
    const responses = await Promise.all([approve(a, first), approve(a, second)]);

    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 409)?.json().code).toBe('APPROVAL_DAILY_LIMIT');
    expect(await volume(agent.id, D2)).toBeCloseTo(990, 6);
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6); // the refused one, still on its creation day
    const rows = await Promise.all([row(first), row(second)]);
    expect(rows.map((r) => r?.status).sort()).toEqual(['PENDING_APPROVAL', 'QUEUED']);
    expect(rows.find((r) => r?.status === 'PENDING_APPROVAL')?.volumeReservedDate).toBe(D1);
    expect(rows.find((r) => r?.status === 'QUEUED')?.volumeReservedDate).toBe(D2);
    expect(h.queued).toHaveLength(1);
  });

  it('three approvals racing, room for two: exactly two pass and the approval day ends at its limit, never above', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const ids = [
      await pendingTransfer(a, at(D1, '09:00:00.000')),
      await pendingTransfer(a, at(D1, '10:00:00.000')),
      await pendingTransfer(a, at(D1, '11:00:00.000')),
    ];
    await setVolume(agent.id, D2, '960'); // 960 + 20 + 20 = 1000 ≤ 1000; a third would be 1020

    setClock(at(D2));
    const responses = await Promise.all(ids.map((id) => approve(a, id)));

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200, 409]);
    expect(await volume(agent.id, D2)).toBeCloseTo(1000, 6);
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(h.queued).toHaveLength(2);
  });

  // ── Retries ────────────────────────────────────────────────────────────────

  it('retry after a refusal: the refusal moved and released nothing; the retry passes once the day has room and moves it once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await setVolume(agent.id, D2, '1000');

    setClock(at(D2));
    for (let i = 0; i < 3; i++) {
      const res = await approve(a, id);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('APPROVAL_DAILY_LIMIT');
    }
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeState: 'RESERVED', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(1000, 6);

    // The operator raises the daily limit (a policy change of its own, outside the approval).
    await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { maxDailyVolumeUsd: '1020' } });
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(1020, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('retry after an enqueue failure on the approval day: 503, back to PENDING_APPROVAL with the reservation counted once on that day; the retry neither moves nor counts it again', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));

    setClock(at(D2));
    h.enqueueFails = true;
    const failed = await approve(a, id);
    expect(failed.statusCode).toBe(503);
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeState: 'RESERVED', volumeReservedDate: D2 });
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(20, 6);

    h.enqueueFails = false;
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeReservedDate: D2 });
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(20, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('retry after an enqueue failure, approved again on the next day: it follows the approval to that day, checked against it', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    setClock(at(D2));
    h.enqueueFails = true;
    expect((await approve(a, id)).statusCode).toBe(503);
    h.enqueueFails = false;

    await setVolume(agent.id, D3, '990');
    setClock(at(D3));
    const refused = await approve(a, id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('APPROVAL_DAILY_LIMIT');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D2 });
    expect(await volume(agent.id, D2)).toBeCloseTo(20, 6);

    await setVolume(agent.id, D3, '500');
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await volume(agent.id, D2)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D3)).toBeCloseTo(520, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  // ── Duplicate approvals ────────────────────────────────────────────────────

  it('a double callback (two concurrent approvals of one transaction on a later day): one wins, moved once, counted once, enqueued once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await setVolume(agent.id, D2, '100');

    setClock(at(D2));
    const [x, y] = await Promise.all([approve(a, id), approve(a, id)]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes[0]).toBe(200);
    // The loser: 409 when it lost under the lock, 400 when the winner had committed before its first read.
    expect([400, 409]).toContain(codes[1]);
    const loser = x.statusCode === 200 ? y : x;
    if (loser.statusCode === 409) expect(loser.json().code).toBe('APPROVAL_NOT_PENDING');

    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeReservedDate: D2 });
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(120, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('a duplicate approval after the first one answers 400 and changes nothing', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    setClock(at(D2));
    expect((await approve(a, id)).statusCode).toBe(200);
    expect((await approve(a, id)).statusCode).toBe(400);
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(20, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('an approval racing a rejection of the same transaction: exactly one wins and the reservation ends where the winner leaves it', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    setClock(at(D2));
    const [approval, rejection] = await Promise.all([approve(a, id), reject(a, id)]);
    expect([approval.statusCode, rejection.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const final = await row(id);
    if (approval.statusCode === 200) {
      expect(final).toMatchObject({ status: 'QUEUED', volumeState: 'RESERVED', volumeReservedDate: D2 });
      expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
      expect(await volume(agent.id, D2)).toBeCloseTo(20, 6);
      expect(queuedFor(id)).toHaveLength(1);
    } else {
      expect(final).toMatchObject({ status: 'FAILED', volumeState: 'RELEASED', volumeReservedDate: D1 });
      expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
      expect(await volume(agent.id, D2)).toBeCloseTo(0, 6);
      expect(queuedFor(id)).toHaveLength(0);
    }
  });

  // ── Unchanged paths ────────────────────────────────────────────────────────

  it('same-day approval is unchanged: approved, the reservation stays where it is, counted once', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1, '09:00:00.000'));
    await setVolume(agent.id, D1, '1000'); // the day is exactly full, this transfer included
    setClock(at(D1, '18:00:00.000'));
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeState: 'RESERVED', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(1000, 6);
    expect(queuedFor(id)).toHaveLength(1);
  });

  it('without a daily limit a later-day approval still moves the reservation to the approval day (nothing to check)', async () => {
    const agent = await mkAgent({ maxDailyVolumeUsd: '0' });
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await setVolume(agent.id, D2, '5000');
    setClock(at(D2));
    expect((await approve(a, id)).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'QUEUED', volumeReservedDate: D2 });
    expect(await volume(agent.id, D1)).toBeCloseTo(0, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(5020, 6);
  });

  // ── What the approval day counts ───────────────────────────────────────────

  it('the approval day\'s x402 payments count against its limit too', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await x402Payment(agent.id, 985, at(D2, '08:00:00.000')); // DailyVolume of D2 is 0; x402 985 + 20 > 1000

    setClock(at(D2));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_DAILY_LIMIT');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D1 });
    expect(await volume(agent.id, D2)).toBeCloseTo(0, 6);
  });

  it('a same-day approval after the daily limit was lowered below the day\'s total is refused (revalidated on the effective day)', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1, '09:00:00.000'));
    await setVolume(agent.id, D1, '990');
    await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { maxDailyVolumeUsd: '980' } });
    setClock(at(D1, '18:00:00.000'));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_DAILY_LIMIT');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(990, 6);
  });

  it('a pending spend that reserved nothing (unpriced while no daily limit applied) is refused once a daily limit applies — APPROVAL_UNCOUNTED_SPEND', async () => {
    // §5-6: a configured outflow cap refuses an unpriced outflow at the
    // request; a non-decimal stored cap reads as unlimited, which is how a
    // pre-0025 row (or a hand-edited one) can still carry such a spend.
    const agent = await mkAgent({ maxDailyVolumeUsd: '0', maxOutflowPerTxUsd: 'unlimited' });
    const a = await app(agent.id);
    process.env['SYNTHETIC_TEST_PRICES_USD'] = h.syntheticPrices.tokensOnly; // native value unpriced
    const id = await pendingTransfer(a, at(D1));
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeState: null });
    process.env['SYNTHETIC_TEST_PRICES_USD'] = h.syntheticPrices.all;
    await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { maxDailyVolumeUsd: '1000' } });

    setClock(at(D1, '18:00:00.000'));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_UNCOUNTED_SPEND');
    expect((await row(id))?.status).toBe('PENDING_APPROVAL');
    expect(queuedFor(id)).toHaveLength(0);
  });

  // ── Policy and agent state at approval ─────────────────────────────────────

  it('a policy paused since the request: refused (APPROVAL_POLICY_INACTIVE), nothing moved', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await m.db.agentPolicy.update({ where: { agentId: agent.id }, data: { active: false } });
    setClock(at(D2));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_POLICY_INACTIVE');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(await volume(agent.id, D2)).toBeCloseTo(0, 6);
    expect(queuedFor(id)).toHaveLength(0);
  });

  it('a policy that expired since the request: refused (APPROVAL_POLICY_EXPIRED), nothing moved', async () => {
    const agent = await mkAgent({ expiresAt: at(D2, '06:00:00.000') });
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    setClock(at(D2, '07:00:00.000'));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_POLICY_EXPIRED');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D1 });
    expect(await volume(agent.id, D1)).toBeCloseTo(20, 6);
    expect(queuedFor(id)).toHaveLength(0);
  });

  it('an agent paused since the request: refused (APPROVAL_AGENT_PAUSED), nothing moved', async () => {
    const agent = await mkAgent();
    const a = await app(agent.id);
    const id = await pendingTransfer(a, at(D1));
    await m.db.agent.update({ where: { id: agent.id }, data: { active: false } });
    setClock(at(D1, '18:00:00.000'));
    const res = await approve(a, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('APPROVAL_AGENT_PAUSED');
    expect(await row(id)).toMatchObject({ status: 'PENDING_APPROVAL', volumeReservedDate: D1 });
    expect(queuedFor(id)).toHaveLength(0);
  });
});
