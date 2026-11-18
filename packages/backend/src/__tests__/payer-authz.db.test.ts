/**
 * Payer authorization audit (docs/architecture/payer-authorization.md), on
 * REAL Postgres through the REAL auth middleware and routes: what an agent API
 * key (the PAYER credential: the provider of an ACCEPTED job, holding only its
 * own `agfi_` key) can and cannot do to its own policy and to other agents'
 * data.
 *
 *  - POL-WIDEN   every widening shape the policy PATCH could be handed — each
 *                field, clearing lists ("empty = unrestricted"), null / zero
 *                values, unpausing, later / cleared expiry, lower cooldown,
 *                a tightening mixed with one widening, other spellings of a
 *                field (silently ignored, never written) — is 403 and leaves
 *                the stored row byte-for-byte unchanged
 *  - POL-FIRST   an agent WITHOUT a policy row (registered before the row was
 *                always created) is judged against the registration defaults:
 *                its first PATCH cannot seed limits above them; and operator
 *                registration without `policy` now creates the default row
 *  - POL-TIGHTEN the same credential may still tighten (and a pause sticks)
 *  - POL-RACE    the verdict is atomic with the write: a stale read can no
 *                longer widen over a concurrent tightening, and a "neutral"
 *                `active: true` can no longer land after the operator's kill
 *                switch (both fail on the previous read -> classify -> write
 *                sequence; here a test transaction holds the Agent lock while
 *                the request is in flight, which is deterministic)
 *  - OPERATOR    the operator secret still loosens / resumes (both directions)
 *  - OTHER       another agent's policy / profile / job, the operator secret
 *                on agent-only routes, NOT_PROVIDER on pay-resource
 *
 * Faked: the wallet provider, the escrow runtime (off), the queues, the x402
 * client (never reached by these tests). Skipped (with a warning) when
 * DATABASE_URL is not a reachable, migrated database; on CI an unreachable
 * database fails the suite. Locally use a PRIVATE database and Redis index
 * (e.g. agentfi_authz_test, Redis DB 8), never a shared one.
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
  // Base Sepolia USDC at 1 USD (a configured synthetic test price) so a legacy paid job is priced.
  process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1';
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
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: async () => ({ id: 'q' }) } }));
vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({
    // POST /v1/agents provisions a wallet: a synthetic one, never a provider.
    createWallet: async () => {
      const { randomBytes: rb } = await import('node:crypto');
      return { walletId: `authz-reg-${rb(6).toString('hex')}`, address: `0x${rb(20).toString('hex')}` };
    },
  }),
}));
vi.mock('../services/wallet/safe.service.js', () => ({ SafeService: class {} }));
vi.mock('../services/identity/ens.service.js', () => ({ EnsService: class { isConfigured() { return false; } } }));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: class {} }));
vi.mock('../services/policy/reputation.service.js', () => ({ ReputationService: class { async recordJobOutcome() {} } }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
  onEscrowTxOutcome: async () => undefined,
  getEscrowToken: async () => '0x0',
  startEscrow: async () => undefined,
  enqueueSubmit: async () => undefined,
  requestCancellationReject: async () => true,
  contestJob: async () => ({ outcome: 'held' }),
}));
vi.mock('../api/routes/transactions.js', () => ({ executeA2APayment: async () => ({ transactionId: 't', status: 'QUEUED' }) }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: async () => undefined }));

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "pausedByOperatorAt" FROM "AgentPolicy" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('payer-authz.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[payer-authz.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  agentRoutes: typeof import('../api/routes/agents.js')['agentRoutes'];
  jobRoutes: typeof import('../api/routes/jobs.js')['jobRoutes'];
  resourcePaymentRoutes: typeof import('../api/routes/resource-payments.js')['resourcePaymentRoutes'];
  ResourcePaymentService: typeof import('../services/payments/resource-payment.service.js')['ResourcePaymentService'];
  PolicyService: typeof import('../services/policy/policy.service.js')['PolicyService'];
  PolicyBusyError: typeof import('../services/policy/policy.service.js')['PolicyBusyError'];
  createTransactionWithVolume: typeof import('../services/policy/daily-volume.js')['createTransactionWithVolume'];
  DEFAULT_AGENT_POLICY: typeof import('../services/policy/policy-authority.js')['DEFAULT_AGENT_POLICY'];
  authMiddleware: typeof import('../api/middleware/auth.js')['authMiddleware'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
};
let m: Modules;
let app: FastifyInstance;

const NAME_PREFIX = 'authz-db';
const RUN = randomBytes(3).toString('hex');
const OPERATOR = { 'x-api-key': process.env['API_SECRET'] as string };
const RECIPIENT_A = '0x00000000000000000000000000000000000000a1';
const RECIPIENT_B = '0x00000000000000000000000000000000000000b2';
const CONTRACT_A = '0x00000000000000000000000000000000000000c1';
const CONTRACT_B = '0x00000000000000000000000000000000000000c2';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
let seq = 0;

interface Fixture {
  id: string;
  key: string;
  headers: { 'x-api-key': string };
}

async function mkAgent(policy: Record<string, unknown> | null = {}): Promise<Fixture> {
  seq++;
  const key = `agfi_live_${randomBytes(32).toString('hex')}`;
  const agent = await m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: createHash('sha256').update(key).digest('hex'),
      apiKeyPrefix: key.slice(0, 16),
      walletId: `authz-wallet-${RUN}-${seq}`,
      safeAddress: `0x${randomBytes(20).toString('hex')}`,
      chainIds: [84532],
      ...(policy
        ? {
            policy: {
              create: {
                maxValuePerTxEth: '1.0',
                maxValuePerTxUsd: '5',
                maxOutflowPerTxUsd: '100',
                maxDailyVolumeUsd: '1000',
                allowedContracts: [CONTRACT_A, CONTRACT_B],
                allowedRecipients: [RECIPIENT_A, RECIPIENT_B],
                allowedTokens: [USDC],
                cooldownSeconds: 60,
                ...policy,
              },
            },
          }
        : {}),
    },
  });
  return { id: agent.id, key, headers: { 'x-api-key': key } };
}

async function mkJob(requesterId: string, providerId: string, status = 'ACCEPTED') {
  return m.db.job.create({
    data: {
      requesterId,
      providerId,
      payload: { t: 1 },
      reward: { amount: '5.0', token: 'USDC', chainId: 84532 },
      status: status as never,
    },
  });
}

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length === 0) return;
  await m.db.resourcePayment.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.transaction.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.agentBilling.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.job.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { providerId: { in: ids } }] } });
  await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  await m.db.agent.deleteMany({ where: { id: { in: ids } } });
}

const patchPolicy = (id: string, headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/v1/agents/${id}/policy`, headers, payload });

async function row(agentId: string) {
  const policy = await m.db.agentPolicy.findUnique({ where: { agentId } });
  if (!policy) throw new Error('no policy row');
  const { updatedAt: _u, ...rest } = policy;
  return rest;
}

beforeAll(async () => {
  if (!DB_READY) return;
  const [db, agents, jobs, rp, rps, ps, auth, errors, dv, pa] = await Promise.all([
    import('../db/client.js'),
    import('../api/routes/agents.js'),
    import('../api/routes/jobs.js'),
    import('../api/routes/resource-payments.js'),
    import('../services/payments/resource-payment.service.js'),
    import('../services/policy/policy.service.js'),
    import('../api/middleware/auth.js'),
    import('../api/errors/handler.js'),
    import('../services/policy/daily-volume.js'),
    import('../services/policy/policy-authority.js'),
  ]);
  m = {
    db: db.db,
    agentRoutes: agents.agentRoutes,
    jobRoutes: jobs.jobRoutes,
    resourcePaymentRoutes: rp.resourcePaymentRoutes,
    ResourcePaymentService: rps.ResourcePaymentService,
    PolicyService: ps.PolicyService,
    PolicyBusyError: ps.PolicyBusyError,
    createTransactionWithVolume: dv.createTransactionWithVolume,
    DEFAULT_AGENT_POLICY: pa.DEFAULT_AGENT_POLICY,
    authMiddleware: auth.authMiddleware,
    registerErrorHandler: errors.registerErrorHandler,
  };
  await wipe();
  app = Fastify({ logger: false });
  m.registerErrorHandler(app);
  await app.register(m.authMiddleware);
  await app.register(m.agentRoutes);
  await app.register(m.jobRoutes);
  // A service that can never reach a wallet or the network: these tests stop at the authorization checks.
  const service = new m.ResourcePaymentService({ db: m.db, wallet: {} as never, client: {} as never });
  await app.register(m.resourcePaymentRoutes, { service });
  await app.ready();
});

afterAll(async () => {
  if (!DB_READY) return;
  await wipe();
  await app?.close();
  await m.db.$disconnect();
});

afterEach(async () => {
  if (DB_READY) await wipe();
});

describeDb('POL-WIDEN: the payer key cannot widen its own policy (every shape is 403, nothing is written)', () => {
  const widenings: Array<[string, Record<string, unknown>, string[]]> = [
    ['raise maxValuePerTxUsd (the x402 per-payment cap)', { maxValuePerTxUsd: '6' }, ['maxValuePerTxUsd']],
    ['raise maxValuePerTxEth', { maxValuePerTxEth: '1.000000000000000001' }, ['maxValuePerTxEth']],
    ['raise maxOutflowPerTxUsd', { maxOutflowPerTxUsd: '100.000001' }, ['maxOutflowPerTxUsd']],
    ['raise maxDailyVolumeUsd', { maxDailyVolumeUsd: '1000.000001' }, ['maxDailyVolumeUsd']],
    ['"0" daily volume (= no limit)', { maxDailyVolumeUsd: '0' }, ['maxDailyVolumeUsd']],
    ['add a recipient', { allowedRecipients: [RECIPIENT_A, RECIPIENT_B, '0x00000000000000000000000000000000000000d3'] }, ['allowedRecipients']],
    ['replace the recipient list with a new address', { allowedRecipients: ['0x00000000000000000000000000000000000000d3'] }, ['allowedRecipients']],
    ['clear allowedRecipients (empty = unrestricted)', { allowedRecipients: [] }, ['allowedRecipients']],
    ['clear allowedContracts', { allowedContracts: [] }, ['allowedContracts']],
    ['clear allowedTokens', { allowedTokens: [] }, ['allowedTokens']],
    ['add a contract', { allowedContracts: [CONTRACT_A, CONTRACT_B, '0x00000000000000000000000000000000000000c3'] }, ['allowedContracts']],
    ['add a token', { allowedTokens: [USDC, '0x00000000000000000000000000000000000000e4'] }, ['allowedTokens']],
    ['lower the cooldown', { cooldownSeconds: 59 }, ['cooldownSeconds']],
    ['zero cooldown', { cooldownSeconds: 0 }, ['cooldownSeconds']],
    ['a tightening mixed with one widening (all-or-nothing)', { maxValuePerTxUsd: '1', allowedRecipients: [] }, ['allowedRecipients']],
    ['a tightening of every field plus one clear list', { maxValuePerTxEth: '0.5', maxValuePerTxUsd: '1', maxOutflowPerTxUsd: '1', maxDailyVolumeUsd: '1', cooldownSeconds: 120, allowedTokens: [] }, ['allowedTokens']],
  ];

  it.each(widenings)('%s', async (_label, body, loosened) => {
    const payer = await mkAgent();
    const before = await row(payer.id);
    const res = await patchPolicy(payer.id, payer.headers, body);
    expect(res.statusCode).toBe(403);
    expect(res.json().loosenedFields).toEqual(loosened);
    expect(await row(payer.id)).toEqual(before);
  });

  it('a null / non-decimal / numeric / hex / exponent / empty limit is 400 or 403 — never stored', async () => {
    const payer = await mkAgent();
    const before = await row(payer.id);
    for (const body of [
      { maxValuePerTxUsd: null },
      { maxValuePerTxUsd: '' },
      { maxValuePerTxUsd: '1e3' },
      { maxValuePerTxUsd: '0x10' },
      { maxValuePerTxUsd: ' 5' },
      { maxValuePerTxUsd: 5 },
      { maxValuePerTxUsd: '5.0000001' },
      { maxValuePerTxEth: 'unlimited' },
      { maxDailyVolumeUsd: '-1' },
      { maxOutflowPerTxUsd: '1e2' },
      { allowedRecipients: ['not-an-address'] },
      { cooldownSeconds: '0' },
      { cooldownSeconds: -1 },
      { cooldownSeconds: 1.5 },
      { cooldownSeconds: 31_536_001 },
      { allowedContracts: ['uniswap-router'] },
      { allowedTokens: ['USDC'] },
      { active: 'true' },
      { expiresAt: 'tomorrow' },
    ]) {
      const res = await patchPolicy(payer.id, payer.headers, body);
      expect([400, 403], JSON.stringify(body)).toContain(res.statusCode);
    }
    expect(await row(payer.id)).toEqual(before);
  });

  it('maxOutflowPerTxUsd: setting it while NULL (not configured = outflows blocked) is 403; the operator configures it', async () => {
    const payer = await mkAgent({ maxOutflowPerTxUsd: null });
    const res = await patchPolicy(payer.id, payer.headers, { maxOutflowPerTxUsd: '1' });
    expect(res.statusCode).toBe(403);
    expect((await row(payer.id)).maxOutflowPerTxUsd).toBeNull();
  });

  it('unpausing (active: true) after a pause is 403 and a changed expiry (cleared / later) is 403', async () => {
    const paused = await mkAgent({ active: false });
    expect((await patchPolicy(paused.id, paused.headers, { active: true })).statusCode).toBe(403);
    expect((await row(paused.id)).active).toBe(false);

    const soon = new Date(Date.now() + 3_600_000);
    const expiring = await mkAgent({ expiresAt: soon });
    expect((await patchPolicy(expiring.id, expiring.headers, { expiresAt: null })).statusCode).toBe(403);
    expect((await patchPolicy(expiring.id, expiring.headers, { expiresAt: new Date(soon.getTime() + 1000).toISOString() })).statusCode).toBe(403);
    expect((await row(expiring.id)).expiresAt?.getTime()).toBe(soon.getTime());
  });

  it('an EXPIRED policy cannot be revived by the agent (clearing or moving the expiry later is 403)', async () => {
    const expired = await mkAgent({ expiresAt: new Date(Date.now() - 60_000) });
    expect((await patchPolicy(expired.id, expired.headers, { expiresAt: null })).statusCode).toBe(403);
    expect((await patchPolicy(expired.id, expired.headers, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).statusCode).toBe(403);
  });

  it('other spellings of a field (snake_case, the legacy name, an unknown key) are ignored: 200, nothing widened', async () => {
    const payer = await mkAgent();
    const before = await row(payer.id);
    const res = await patchPolicy(payer.id, payer.headers, {
      max_value_per_tx_usd: '999999',
      maxValuePerTx: '999999',
      maxValuePerTxUSD: '999999',
      allowed_recipients: [],
      tier: 'ENTERPRISE',
      agentId: 'someone-else',
      pausedByOperatorAt: null,
      maxValueForAutoApprovalEth: '999',
    });
    expect(res.statusCode).toBe(200);
    expect(await row(payer.id)).toEqual(before);
    const agent = await m.db.agent.findUniqueOrThrow({ where: { id: payer.id } });
    expect(agent.tier).toBe('FREE');
  });

});

describeDb('POL-FIRST: an agent without a policy row cannot seed its own limits (judged against the registration defaults)', () => {
  // Defaults: maxValuePerTxEth 1.0, maxValuePerTxUsd 1.0, maxOutflowPerTxUsd NULL, maxDailyVolumeUsd 10000, cooldown 60.
  const seedings: Array<[string, Record<string, unknown>, string[]]> = [
    ['maxValuePerTxUsd above the default', { maxValuePerTxUsd: '1.000001' }, ['maxValuePerTxUsd']],
    ['maxValuePerTxUsd 1e9', { maxValuePerTxUsd: '1000000000' }, ['maxValuePerTxUsd']],
    ['maxValuePerTxEth above the default', { maxValuePerTxEth: '1.000000000000000001' }, ['maxValuePerTxEth']],
    ['maxOutflowPerTxUsd from nothing (any value)', { maxOutflowPerTxUsd: '0.01' }, ['maxOutflowPerTxUsd']],
    ['maxOutflowPerTxUsd 1e9', { maxOutflowPerTxUsd: '1000000000' }, ['maxOutflowPerTxUsd']],
    ['maxDailyVolumeUsd above the default', { maxDailyVolumeUsd: '10000.000001' }, ['maxDailyVolumeUsd']],
    ['maxDailyVolumeUsd "0" (= no limit)', { maxDailyVolumeUsd: '0' }, ['maxDailyVolumeUsd']],
    ['cooldown below the default', { cooldownSeconds: 59 }, ['cooldownSeconds']],
    ['cooldown 0', { cooldownSeconds: 0 }, ['cooldownSeconds']],
    ['everything at once', { maxValuePerTxUsd: '1000000000', maxOutflowPerTxUsd: '1000000000', maxDailyVolumeUsd: '0', cooldownSeconds: 0 }, ['maxValuePerTxUsd', 'maxOutflowPerTxUsd', 'maxDailyVolumeUsd', 'cooldownSeconds']],
    ['a valid limit mixed with one seeding', { maxValuePerTxUsd: '0.5', maxDailyVolumeUsd: '0' }, ['maxDailyVolumeUsd']],
  ];

  it.each(seedings)('first PATCH: %s is 403 and creates no row', async (_label, body, loosened) => {
    const payer = await mkAgent(null);
    const res = await patchPolicy(payer.id, payer.headers, body);
    expect(res.statusCode).toBe(403);
    expect(res.json().loosenedFields).toEqual(loosened);
    expect(await m.db.agentPolicy.findUnique({ where: { agentId: payer.id } })).toBeNull();
  });

  it('first PATCH at or below the defaults is accepted; unnamed fields take the column defaults (outflow cap stays NULL)', async () => {
    const below = await mkAgent(null);
    const res = await patchPolicy(below.id, below.headers, {
      maxValuePerTxUsd: '0.5',
      maxValuePerTxEth: '0.25',
      maxDailyVolumeUsd: '100',
      cooldownSeconds: 120,
      allowedRecipients: [RECIPIENT_A],
      allowedTokens: [USDC],
    });
    expect(res.statusCode).toBe(200);
    expect(await row(below.id)).toMatchObject({
      maxValuePerTxUsd: '0.5',
      maxValuePerTxEth: '0.25',
      maxOutflowPerTxUsd: null,
      maxDailyVolumeUsd: '100',
      cooldownSeconds: 120,
      allowedRecipients: [RECIPIENT_A],
      allowedTokens: [USDC],
      active: true,
    });

    const equal = await mkAgent(null);
    const same = await patchPolicy(equal.id, equal.headers, {
      maxValuePerTxUsd: '1.0',
      maxValuePerTxEth: '1.0',
      maxOutflowPerTxUsd: null,
      maxDailyVolumeUsd: '10000',
      cooldownSeconds: 60,
    });
    expect(same.statusCode).toBe(200);
    expect(await row(equal.id)).toMatchObject({ maxValuePerTxUsd: '1.0', maxOutflowPerTxUsd: null, maxDailyVolumeUsd: '10000', cooldownSeconds: 60 });
  });

  it('the operator is not bound by the defaults: it gives a row-less agent any first policy', async () => {
    const payer = await mkAgent(null);
    const res = await patchPolicy(payer.id, OPERATOR, { maxValuePerTxUsd: '50', maxOutflowPerTxUsd: '500', maxDailyVolumeUsd: '0', cooldownSeconds: 0 });
    expect(res.statusCode).toBe(200);
    expect(await row(payer.id)).toMatchObject({ maxValuePerTxUsd: '50', maxOutflowPerTxUsd: '500', maxDailyVolumeUsd: '0', cooldownSeconds: 0 });
  });

  it('operator registration WITHOUT a policy creates the default row; the new agent key cannot raise it', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/agents', headers: OPERATOR, payload: { name: `${NAME_PREFIX} ${RUN}-reg`, chainIds: [84532] } });
    expect(res.statusCode, res.body).toBe(201);
    const { id, apiKey } = res.json() as { id: string; apiKey: string };
    // The baseline an agent without a row is judged against cannot drift from what registration stores.
    expect(await row(id)).toMatchObject(m.DEFAULT_AGENT_POLICY);
    expect(await row(id)).toMatchObject({
      maxValuePerTxEth: '1.0',
      maxValuePerTxUsd: '1.0',
      maxOutflowPerTxUsd: null,
      maxDailyVolumeUsd: '10000',
      allowedContracts: [],
      allowedRecipients: [],
      allowedTokens: [],
      cooldownSeconds: 60,
      active: true,
    });
    const headers = { 'x-api-key': apiKey };
    expect((await patchPolicy(id, headers, { maxOutflowPerTxUsd: '1000000000' })).statusCode).toBe(403);
    expect((await patchPolicy(id, headers, { maxValuePerTxUsd: '2' })).statusCode).toBe(403);
    expect((await patchPolicy(id, headers, { maxValuePerTxUsd: '0.5' })).statusCode).toBe(200);
  });

  it('operator registration WITH a policy still stores it as given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: OPERATOR,
      payload: { name: `${NAME_PREFIX} ${RUN}-reg2`, chainIds: [84532], policy: { maxValuePerTxUsd: '25', maxOutflowPerTxUsd: '300', cooldownSeconds: 0 } },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await row((res.json() as { id: string }).id)).toMatchObject({ maxValuePerTxUsd: '25', maxOutflowPerTxUsd: '300', cooldownSeconds: 0 });
  });
});

describeDb('POL-TIGHTEN: the payer key can still tighten (and the kill switch it flips sticks)', () => {
  it('lower caps, a subset of each list, a longer cooldown and an earlier expiry apply', async () => {
    const payer = await mkAgent();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await patchPolicy(payer.id, payer.headers, {
      maxValuePerTxUsd: '1',
      maxValuePerTxEth: '0.5',
      maxOutflowPerTxUsd: '10',
      maxDailyVolumeUsd: '100',
      allowedRecipients: [RECIPIENT_A.toUpperCase().replace('0X', '0x')],
      allowedContracts: [CONTRACT_A],
      cooldownSeconds: 300,
      expiresAt,
    });
    expect(res.statusCode).toBe(200);
    const after = await row(payer.id);
    expect(after).toMatchObject({ maxValuePerTxUsd: '1', maxValuePerTxEth: '0.5', maxOutflowPerTxUsd: '10', maxDailyVolumeUsd: '100', cooldownSeconds: 300 });
    expect(after.allowedContracts).toEqual([CONTRACT_A]);
  });

  it('pausing itself (active: false) applies; it cannot be undone with the same key', async () => {
    const payer = await mkAgent();
    expect((await patchPolicy(payer.id, payer.headers, { active: false })).statusCode).toBe(200);
    expect((await patchPolicy(payer.id, payer.headers, { active: true })).statusCode).toBe(403);
    expect((await row(payer.id)).active).toBe(false);
  });
});

describeDb('POL-RACE: the tighten-only verdict is atomic with the write', () => {
  /**
   * Holds the Agent row lock in a test transaction, runs `inLock` while it is
   * held, fires the request meanwhile and releases the lock after 400 ms.
   * With the atomic write the request waits for the lock and then judges the
   * row as the test transaction left it; the old read -> classify -> write
   * judged the row as it was BEFORE and then overwrote it.
   */
  async function requestDuringLock(
    agentId: string,
    inLock: (tx: Parameters<Parameters<typeof m.db.$transaction>[0]>[0]) => Promise<void>,
    send: () => ReturnType<typeof patchPolicy>,
  ) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = m.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE`;
        await inLock(tx);
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await lockTaken;
    const pending = send();
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await holder;
    return pending;
  }

  it("an agent PATCH {active: true} cannot overtake the operator's kill switch", async () => {
    const payer = await mkAgent();
    const res = await requestDuringLock(
      payer.id,
      async (tx) => {
        await tx.agentPolicy.update({ where: { agentId: payer.id }, data: { active: false, pausedByOperatorAt: new Date() } });
      },
      () => patchPolicy(payer.id, payer.headers, { active: true }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().loosenedFields).toEqual(['active']);
    const after = await row(payer.id);
    expect(after.active).toBe(false);
    expect(after.pausedByOperatorAt).not.toBeNull();
  });

  it('a stale read cannot widen over a concurrent tightening (100 -> 50 by one request, 80 by the other: 80 is refused)', async () => {
    const payer = await mkAgent({ maxValuePerTxUsd: '100' });
    const res = await requestDuringLock(
      payer.id,
      async (tx) => {
        await tx.agentPolicy.update({ where: { agentId: payer.id }, data: { maxValuePerTxUsd: '50' } });
      },
      () => patchPolicy(payer.id, payer.headers, { maxValuePerTxUsd: '80' }),
    );
    expect(res.statusCode).toBe(403);
    expect((await row(payer.id)).maxValuePerTxUsd).toBe('50');
  });

  it('concurrent tightenings end at the minimum, never above it', async () => {
    const payer = await mkAgent({ maxValuePerTxUsd: '100' });
    const caps = Array.from({ length: 8 }, (_, i) => String(90 - i * 5));
    const results = await Promise.all(caps.map((cap) => patchPolicy(payer.id, payer.headers, { maxValuePerTxUsd: cap })));
    for (const res of results) expect([200, 403]).toContain(res.statusCode);
    expect((await row(payer.id)).maxValuePerTxUsd).toBe(String(Math.min(...caps.map(Number))));
  });

  it('the REAL kill switch (pauseByOperator) fired together with agent PATCH {active: true}: the policy always ends paused', async () => {
    const service = new m.PolicyService(m.db);
    for (let i = 0; i < 12; i++) {
      const payer = await mkAgent();
      // alternate which one is sent first; both are in flight together
      const calls = i % 2 === 0
        ? [patchPolicy(payer.id, payer.headers, { active: true }), service.pauseByOperator(payer.id)]
        : [service.pauseByOperator(payer.id), patchPolicy(payer.id, payer.headers, { active: true })];
      const settled = await Promise.all(calls);
      const res = settled.find((r) => typeof r === 'object') as Awaited<ReturnType<typeof patchPolicy>>;
      expect([200, 403], `round ${i}`).toContain(res.statusCode);
      expect((await row(payer.id)).active, `round ${i}: HTTP ${res.statusCode}`).toBe(false);
    }
  });

  it('no row yet: concurrent first PATCHes are serialized (no 500 from a create race) and end at the minimum', async () => {
    const payer = await mkAgent(null);
    const caps = ['0.9', '0.8', '0.7', '0.6', '0.5', '0.4'];
    const results = await Promise.all(caps.map((cap) => patchPolicy(payer.id, payer.headers, { maxValuePerTxUsd: cap })));
    for (const res of results) expect([200, 403], res.body).toContain(res.statusCode);
    expect(results.some((res) => res.statusCode === 200)).toBe(true);
    expect((await row(payer.id)).maxValuePerTxUsd).toBe('0.4');
    expect(await m.db.agentPolicy.count({ where: { agentId: payer.id } })).toBe(1);
  });

  it('no row yet: an operator create racing an agent seeding attempt never ends above what the operator wrote', async () => {
    const payer = await mkAgent(null);
    const [op, agent] = await Promise.all([
      patchPolicy(payer.id, OPERATOR, { maxValuePerTxUsd: '0.2' }),
      patchPolicy(payer.id, payer.headers, { maxValuePerTxUsd: '0.9' }),
    ]);
    expect(op.statusCode).toBe(200);
    expect([200, 403]).toContain(agent.statusCode);
    // agent first (0.9 <= default 1.0, accepted) then operator 0.2; or operator first and the agent's 0.9 is a widening (403)
    expect((await row(payer.id)).maxValuePerTxUsd).toBe('0.2');
  });

  it('a lock that cannot be had in time is PolicyBusyError (the route answers 503), not a hang or a 500; nothing is written', async () => {
    const payer = await mkAgent();
    const before = await row(payer.id);
    const service = new m.PolicyService(m.db);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = m.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${payer.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await lockTaken;
    const started = Date.now();
    await expect(
      service.patchPolicyAtomically(payer.id, { maxValuePerTxUsd: '1' }, () => null, { maxWait: 2_000, timeout: 5_000, lockTimeoutMs: 300 }),
    ).rejects.toBeInstanceOf(m.PolicyBusyError);
    expect(Date.now() - started).toBeLessThan(4_000);
    release();
    await holder;
    expect(await row(payer.id)).toEqual(before);
  });
});

describeDb('OPERATOR: the operator secret keeps its authority (both directions)', () => {
  it('loosens what the agent key was refused, and resumes a paused policy', async () => {
    const payer = await mkAgent({ active: false });
    expect((await patchPolicy(payer.id, payer.headers, { maxValuePerTxUsd: '50' })).statusCode).toBe(403);
    const op = await patchPolicy(payer.id, OPERATOR, { maxValuePerTxUsd: '50', allowedRecipients: [], active: true });
    expect(op.statusCode).toBe(200);
    expect(await row(payer.id)).toMatchObject({ maxValuePerTxUsd: '50', allowedRecipients: [], active: true });
  });

  it('is 404 for an unknown agent id and creates the row for an agent without one', async () => {
    expect((await patchPolicy('cl000000000000000000nobody', OPERATOR, { maxValuePerTxUsd: '1' })).statusCode).toBe(404);
    const bare = await mkAgent(null);
    expect((await patchPolicy(bare.id, OPERATOR, { maxValuePerTxUsd: '1' })).statusCode).toBe(200);
  });

  it('the operator-pause bookkeeping survives: pauseByOperator + resumeByOperator on the same row', async () => {
    const payer = await mkAgent();
    const service = new m.PolicyService(m.db);
    expect(await service.pauseByOperator(payer.id)).toBe(true);
    expect((await row(payer.id)).active).toBe(false);
    expect(await service.resumeByOperator(payer.id)).toBe('reactivated');
    expect((await row(payer.id)).active).toBe(true);
  });

  it('documented: an agent PATCH {active: false} after an operator pause clears the stamp, so the admin resume leaves it inactive and the operator secret resumes it', async () => {
    const payer = await mkAgent();
    const service = new m.PolicyService(m.db);
    await service.pauseByOperator(payer.id);
    expect((await patchPolicy(payer.id, payer.headers, { active: false })).statusCode).toBe(200);
    expect((await row(payer.id)).pausedByOperatorAt).toBeNull();
    expect(await service.resumeByOperator(payer.id)).toBe('left_inactive');
    expect((await patchPolicy(payer.id, OPERATOR, { active: true })).statusCode).toBe(200);
    expect((await row(payer.id)).active).toBe(true);
  });

  it('pauseByOperator is a no-op on an agent without a policy row (the operator stops it with Agent.active = false)', async () => {
    const bare = await mkAgent(null);
    const service = new m.PolicyService(m.db);
    expect(await service.pauseByOperator(bare.id)).toBe(false);
    await m.db.agent.update({ where: { id: bare.id }, data: { active: false } });
    expect((await app.inject({ method: 'GET', url: '/v1/agents/me', headers: bare.headers })).statusCode).toBe(403);
  });
});

describeDb('DAILY-PAUSED: the binding daily-limit check applies to a paused policy too', () => {
  it('a reservation over the daily limit is refused even when the policy was paused after the unlocked pre-check', async () => {
    const payer = await mkAgent({ maxDailyVolumeUsd: '10', active: false });
    const data = { agentId: payer.id, chainId: 84532, type: 'TRANSFER' as const, status: 'QUEUED' as const };
    const over = await m.createTransactionWithVolume(m.db, { agentId: payer.id, valueUsd: '50', priceSource: 'synthetic', data });
    expect(over).toMatchObject({ ok: false, code: 'DAILY_LIMIT' });
    expect(await m.db.transaction.count({ where: { agentId: payer.id } })).toBe(0);
    const fits = await m.createTransactionWithVolume(m.db, { agentId: payer.id, valueUsd: '5', priceSource: 'synthetic', data });
    expect(fits).toMatchObject({ ok: true });
  });

  const postPaidJob = (requester: Fixture, providerId: string, amount: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: requester.headers,
      // 84532 is a chain WITHOUT the escrow contract in this suite (escrow runtime off): the legacy reservation.
      payload: { providerId, payload: { t: 1 }, reward: { amount, token: 'USDC', chainId: 84532 } },
    });
  const dailyVolume = async (agentId: string) =>
    (await m.db.dailyVolume.findMany({ where: { agentId } })).reduce((sum, row) => sum + Number(row.volumeUsd), 0);

  it('POST /v1/jobs (legacy): a PAUSED requester cannot post paid jobs that reserve nothing (403 POLICY_PAUSED, no job, no volume)', async () => {
    const requester = await mkAgent({ maxDailyVolumeUsd: '10', active: false });
    const provider = await mkAgent();
    for (let i = 0; i < 3; i++) {
      const res = await postPaidJob(requester, provider.id, '4');
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'POLICY_PAUSED' });
    }
    expect(await m.db.job.count({ where: { requesterId: requester.id } })).toBe(0);
    expect(await dailyVolume(requester.id)).toBe(0);

    // After the operator's resume the daily limit binds: 4 + 4 fit in 10, the third is refused.
    expect((await patchPolicy(requester.id, OPERATOR, { active: true })).statusCode).toBe(200);
    expect((await postPaidJob(requester, provider.id, '4')).statusCode).toBe(201);
    expect((await postPaidJob(requester, provider.id, '4')).statusCode).toBe(201);
    expect((await postPaidJob(requester, provider.id, '4')).statusCode).toBe(400);
    expect(await dailyVolume(requester.id)).toBeCloseTo(8, 6);
  });

  it('POST /v1/jobs (legacy): an EXPIRED requester policy is 403 POLICY_PAUSED as well', async () => {
    const requester = await mkAgent({ maxDailyVolumeUsd: '10', expiresAt: new Date(Date.now() - 60_000) });
    const provider = await mkAgent();
    const res = await postPaidJob(requester, provider.id, '4');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'POLICY_PAUSED' });
    expect(await m.db.job.count({ where: { requesterId: requester.id } })).toBe(0);
  });
});

describeDb('OTHER: other agents\' data and operator-only credentials', () => {
  it("the payer cannot read or change another agent's policy / profile, nor deactivate it", async () => {
    const payer = await mkAgent();
    const victim = await mkAgent();
    const before = await row(victim.id);
    expect((await patchPolicy(victim.id, payer.headers, { maxValuePerTxUsd: '1' })).statusCode).toBe(403);
    expect((await patchPolicy(victim.id, payer.headers, { active: false })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/agents/${victim.id}`, headers: payer.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/v1/agents/${victim.id}`, headers: payer.headers })).statusCode).toBe(403);
    expect(await row(victim.id)).toEqual(before);
    expect((await m.db.agent.findUniqueOrThrow({ where: { id: victim.id } })).active).toBe(true);
  });

  it('the operator secret is refused on agent-only routes (it only opens the explicit operator-capable route)', async () => {
    const payer = await mkAgent();
    const job = await mkJob(payer.id, (await mkAgent()).id);
    for (const [method, url, payload] of [
      ['GET', '/v1/agents/me', undefined],
      ['GET', `/v1/agents/${payer.id}`, undefined],
      ['DELETE', `/v1/agents/${payer.id}`, undefined],
      ['PATCH', `/v1/jobs/${job.id}`, { status: 'COMPLETED' }],
      ['POST', `/v1/jobs/${job.id}/pay-resource`, { url: 'https://example.invalid/x' }],
      ['POST', '/v1/jobs', { providerId: payer.id, payload: {} }],
    ] as const) {
      const res = await app.inject({ method, url, headers: OPERATOR, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await m.db.agent.findUniqueOrThrow({ where: { id: payer.id } })).active).toBe(true);
  });

  it('a deactivated agent key is refused everywhere (403)', async () => {
    const payer = await mkAgent();
    await m.db.agent.update({ where: { id: payer.id }, data: { active: false } });
    expect((await app.inject({ method: 'GET', url: '/v1/agents/me', headers: payer.headers })).statusCode).toBe(403);
    expect((await patchPolicy(payer.id, payer.headers, { active: true })).statusCode).toBe(403);
  });

  it("the payer cannot read or move a job it is not part of, and the requester cannot pay from its budget", async () => {
    const requester = await mkAgent();
    const payer = await mkAgent();
    const stranger = await mkAgent();
    const job = await mkJob(requester.id, payer.id);

    // read / write: the stranger and the payer-on-someone-else's-job
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${job.id}`, headers: stranger.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/v1/jobs/${job.id}`, headers: stranger.headers, payload: { status: 'FAILED' } })).statusCode).toBe(403);
    expect((await m.db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('ACCEPTED');

    // pay-resource: provider only (NOT_PROVIDER names who the caller is; nothing is fetched or recorded)
    for (const who of [requester, stranger]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/pay-resource`,
        headers: who.headers,
        payload: { url: 'https://example.invalid/resource' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'NOT_PROVIDER' });
    }
    expect(await m.db.resourcePayment.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('the budget (reward) cannot be changed through the provider PATCH', async () => {
    const requester = await mkAgent();
    const payer = await mkAgent();
    const job = await mkJob(requester.id, payer.id);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/jobs/${job.id}`,
      headers: payer.headers,
      payload: { status: 'FAILED', reward: { amount: '999999', token: 'USDC', chainId: 84532 } },
    });
    expect(res.statusCode).toBe(200);
    const after = await m.db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.reward).toEqual({ amount: '5.0', token: 'USDC', chainId: 84532 });
  });

  it('a paid self-job on a non-escrow chain is 400 and creates nothing (no self-minted budget)', async () => {
    const payer = await mkAgent();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: payer.headers,
      payload: { providerId: payer.id, payload: { t: 1 }, reward: { amount: '100000', token: 'USDC', chainId: 8453 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'JOB_PROVIDER_IS_REQUESTER' });
    expect(await m.db.job.count({ where: { requesterId: payer.id } })).toBe(0);
  });
});
