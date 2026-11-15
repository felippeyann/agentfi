/**
 * DB-backed — automatic x402 reconciliation (second x402 delivery, 2026-11-15).
 *
 * Real `ResourcePaymentService` + `X402ClientService` paying the P1 harness;
 * a test-controlled chain (`helpers/fake-chain-evidence.ts`) and clock.
 * Observed besides the DB: wallet signatures, paid requests reaching the
 * seller, chain reads. The real reader against FiatToken runs in the fork
 * demo (`npm run demo:x402:fork`).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env['RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS'] = 'true';
  process.env['NODE_ENV'] = 'test';
});

vi.mock('../api/middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { db } from '../db/client.js';
import { countedWhere, sumBaseUnits } from '../services/payments/resource-payment-ledger.js';
import {
  DEFAULT_AUTO_RECONCILE_CONFIG,
  autoReconcileConfigFromEnv,
  rearmAutoReconcile,
  runAutoReconcileCycle,
  type AutoReconcileConfig,
} from '../services/payments/resource-payment-auto-reconcile.js';
import { buildSpendReport } from '../services/payments/resource-payment-report.js';
import { ResourcePaymentService } from '../services/payments/resource-payment.service.js';
import { X402ClientService } from '../services/payments/x402-client.service.js';
import type { TypedDataSigner } from '../services/wallet/signer.js';
import { fakeChain } from './helpers/fake-chain-evidence.js';
import { isPaidRequest, loopbackOnly, startResourceServer, type FixtureOptions } from './helpers/x402-fixture.js';

const payer = privateKeyToAccount(generatePrivateKey());
const wallet: TypedDataSigner & { signatures: number } = {
  signatures: 0,
  async getWalletAddress() {
    return payer.address;
  },
  async signTypedData({ typedData }) {
    wallet.signatures++;
    const signature = await payer.signTypedData(typedData as unknown as TypedDataDefinition);
    return { signature, address: payer.address };
  },
};

const tag = randomBytes(4).toString('hex');
const createdAgents: string[] = [];
const open: Array<() => Promise<void>> = [];
let seq = 0;

const CONFIG: AutoReconcileConfig = {
  ...DEFAULT_AUTO_RECONCILE_CONFIG,
  expiryMarginSeconds: 60,
  maxAttempts: 3,
  backoffBaseMs: 30_000,
  backoffCapMs: 120_000,
  leaseMs: 60_000,
};

async function mkAgent(role: string) {
  seq++;
  const agent = await db.agent.create({
    data: {
      name: `x402 auto ${role} ${tag}-${seq}`,
      apiKeyHash: `x4a-${role}-${tag}-${seq}`,
      apiKeyPrefix: 'agfi_live_x4a',
      walletId: `x4a-wallet-${role}-${tag}-${seq}`,
      safeAddress: `0x6062${randomBytes(18).toString('hex')}`,
      chainIds: [84532],
      policy: { create: { maxValuePerTxUsd: '1', maxDailyVolumeUsd: '10000', cooldownSeconds: 0 } },
    },
  });
  createdAgents.push(agent.id);
  return agent;
}

async function setup(amount = '2', options: FixtureOptions = {}) {
  const provider = await mkAgent('prov');
  const requester = await mkAgent('req');
  const job = await db.job.create({
    data: { requesterId: requester.id, providerId: provider.id, status: 'ACCEPTED', payload: {}, reward: { amount, token: 'USDC', chainId: 84532 } },
  });
  const fixtureOptions: FixtureOptions = { price: '$0.40', ...options };
  const server = await startResourceServer(fixtureOptions);
  open.push(server.close);
  let paidRequests = 0;
  const transport = loopbackOnly(server.base);
  const hooks: { paidBody: Uint8Array | null } = { paidBody: null };
  const counting: typeof fetch = async (input, init) => {
    const paid = isPaidRequest(input);
    if (paid) paidRequests++;
    const response = await transport(input, init);
    if (!paid || !hooks.paidBody) return response;
    await response.arrayBuffer();
    return new Response(Buffer.from(hooks.paidBody), { status: response.status, headers: response.headers });
  };
  const svc = new ResourcePaymentService({ db, wallet, client: new X402ClientService({ fetch: counting, requestTimeoutMs: 400 }) });
  const chain = fakeChain();
  const clock = { now: new Date() };
  const cycle = (owner = 'w1', config: AutoReconcileConfig = CONFIG) =>
    runAutoReconcileCycle({ db, rpcFor: () => 'unused', readerFor: () => chain, config, now: () => clock.now, owner, jobId: job.id });
  return {
    provider,
    job,
    server,
    fixtureOptions,
    chain,
    clock,
    hooks,
    cycle,
    paidRequests: () => paidRequests,
    pay: (paymentId: string) => svc.payForResource({ jobId: job.id, agentId: provider.id, url: server.url, method: 'GET', paymentId }),
    advance: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

const counted = async (jobId: string) => sumBaseUnits(await db.resourcePayment.findMany({ where: { jobId, ...countedWhere(new Date()) } }));
const rows = (jobId: string) => db.resourcePayment.findMany({ where: { jobId }, include: { reconcileState: true }, orderBy: { reservedAt: 'asc' } });
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('x402 automatic reconciliation on Postgres', () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  afterAll(async () => {
    if (createdAgents.length > 0) {
      await db.dailyVolume.deleteMany({ where: { agentId: { in: createdAgents } } });
      await db.agent.deleteMany({ where: { id: { in: createdAgents } } });
    }
    await db.$disconnect();
  });

  it('1. a payment whose response was lost is proven automatically; nothing is signed, sent or re-fetched', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`lost_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    const signatures = wallet.signatures;
    const paid = t.paidRequests();
    const tx = t.chain.use(unknown!);

    const [outcome] = await t.cycle();
    expect(outcome).toMatchObject({ verdict: 'confirmed', applied: true, escalated: false });
    const [row] = await rows(t.job.id);
    expect(row).toMatchObject({ status: 'settled', settlementTxHash: tx });
    expect(row!.chainVerifiedAt).toBeInstanceOf(Date);
    expect(row!.reconcileState).toMatchObject({ lastVerdict: 'confirmed', leaseOwner: null, escalatedAt: null });
    expect(await counted(t.job.id)).toBe(400_000n);
    expect(wallet.signatures).toBe(signatures);
    expect(t.paidRequests()).toBe(paid);
    // Proven rows leave the work list.
    expect(await t.cycle()).toEqual([]);
  });

  it('2. restart: a lease left by a crashed worker blocks only until it expires; the next worker resumes', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`crash_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.use(unknown!);
    // Worker "dead" claimed the row and died before writing anything.
    await db.resourcePaymentReconcileState.create({
      data: { resourcePaymentId: unknown!.id, leaseOwner: 'dead', leaseUntil: new Date(t.clock.now.getTime() + 60_000), nextAttemptAt: t.clock.now },
    });
    expect(await t.cycle('restarted')).toEqual([]);
    expect((await rows(t.job.id))[0]!.status).toBe('unknown');
    t.advance(61_000);
    const [outcome] = await t.cycle('restarted');
    expect(outcome).toMatchObject({ verdict: 'confirmed', applied: true });
    expect((await rows(t.job.id))[0]!.status).toBe('settled');
  });

  it('3. two workers at once: every transition written once, no payment initiated', async () => {
    const t = await setup('2', { stall: 'paid' });
    for (let i = 0; i < 4; i++) {
      await expect(t.pay(`two${i}_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    }
    for (const row of await rows(t.job.id)) t.chain.use(row);
    const signatures = wallet.signatures;
    const paid = t.paidRequests();
    const [a, b] = await Promise.all([t.cycle('A'), t.cycle('B')]);
    const applied = [...a!, ...b!].filter((o) => o.applied);
    expect(applied).toHaveLength(4);
    expect(new Set(applied.map((o) => o.resourcePaymentId)).size).toBe(4);
    const final = await rows(t.job.id);
    expect(final.every((r) => r.status === 'settled' && r.chainVerifiedAt)).toBe(true);
    expect(await counted(t.job.id)).toBe(1_600_000n);
    expect(wallet.signatures).toBe(signatures);
    expect(t.paidRequests()).toBe(paid);
  });

  it('4. evidence source down: conservative state, bounded backoff, escalation — never read as "no payment"', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`down_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    // Even past validBefore on the "chain" clock, a failing read must not lapse it.
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    t.chain.failReads('connect ECONNREFUSED');

    let [o] = await t.cycle();
    expect(o).toMatchObject({ verdict: 'manual', transient: true, applied: false, escalated: false });
    expect(o!.nextAttemptAt!.getTime() - t.clock.now.getTime()).toBe(30_000);
    expect((await rows(t.job.id))[0]).toMatchObject({ status: 'unknown', reconcileState: { attempts: 1 } });
    expect(await counted(t.job.id)).toBe(400_000n);
    // Not due yet: not looked at.
    expect(await t.cycle()).toEqual([]);
    t.advance(30_000);
    [o] = await t.cycle();
    expect(o!.nextAttemptAt!.getTime() - t.clock.now.getTime()).toBe(60_000);
    t.advance(60_000);
    [o] = await t.cycle();
    expect(o).toMatchObject({ transient: true, escalated: true });
    const [escalated] = await rows(t.job.id);
    expect(escalated).toMatchObject({ status: 'unknown', reconcileState: { attempts: 3 } });
    expect(escalated!.reconcileState!.escalatedAt).toBeInstanceOf(Date);
    expect(await counted(t.job.id)).toBe(400_000n);
    t.advance(10 * 3_600_000);
    expect(await t.cycle()).toEqual([]);
    let [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]!.action).toMatch(/automatic reconciliation stopped/);

    // Source back + operator re-arms: the next cycle judges it on real evidence.
    t.chain.failReads(null);
    expect(await rearmAutoReconcile(db, [unknown!.id])).toBe(1);
    [o] = await t.cycle();
    expect(o).toMatchObject({ verdict: 'expired', applied: true });
    expect(await counted(t.job.id)).toBe(0n);
    [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]!.action).toBeNull();
  });

  it('a live unused authorization waits until validBefore + margin; a row the chain cannot judge escalates at once', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`wait_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(t.clock.now));
    const [o] = await t.cycle();
    expect(o!.verdict).toBe('wait');
    expect(o!.nextAttemptAt!.getTime()).toBe(unknown!.authorizationValidBefore!.getTime() + 61_000);

    await db.resourcePayment.create({
      data: {
        jobId: t.job.id, agentId: t.provider.id, paymentId: `legacy_${tag}_0123456789`, url: t.server.url, method: 'GET',
        network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '400000', payTo: t.server.seller.address,
        status: 'unknown', authorizationNonce: `0x${'cd'.repeat(32)}`,
      },
    });
    const outcomes = await t.cycle();
    expect(outcomes.map((x) => x.paymentId)).toEqual([`legacy_${tag}_0123456789`]);
    expect(outcomes[0]).toMatchObject({ verdict: 'manual', transient: false, escalated: true });
  });

  it('5. a proven payment with a body cut at the read limit stays visible as PARTIAL delivery', async () => {
    const t = await setup('2');
    t.hooks.paidBody = new Uint8Array(70 * 1024).fill(0x62);
    await t.pay(`partial_${tag}_0123456789`);
    const [row] = await rows(t.job.id);
    expect(row).toMatchObject({ status: 'settled', resourceTruncated: true, resourceBytes: 64 * 1024 });
    t.chain.use(row!);
    const [o] = await t.cycle();
    expect(o).toMatchObject({ verdict: 'confirmed', applied: true });
    const [agent] = await buildSpendReport(db, { jobId: t.job.id });
    const line = agent!.jobs[0]!.payments[0]!;
    expect(line).toMatchObject({ money: 'proven', delivery: 'partial', automatic: null });
    expect(line.action).toMatch(/NOT recoverable by reconciliation/);
    expect(line.action).toMatch(/new purchase/);
  });

  it('env config: latest-0 only on a local chain outside production; bad values fall back with a warning', () => {
    expect(autoReconcileConfigFromEnv({ X402_RECONCILE_HEAD: 'latest-0' }).config.head).toEqual({ tag: 'finalized' });
    expect(
      autoReconcileConfigFromEnv({ X402_RECONCILE_HEAD: 'latest-0', X402_RECONCILE_LOCAL_CHAIN: 'true', NODE_ENV: 'production' }).config.head,
    ).toEqual({ tag: 'finalized' });
    expect(autoReconcileConfigFromEnv({ X402_RECONCILE_HEAD: 'latest-0', X402_RECONCILE_LOCAL_CHAIN: 'true', NODE_ENV: 'development' }).config.head).toEqual({ confirmations: 0 });
    const bad = autoReconcileConfigFromEnv({ X402_RECONCILE_MAX_ATTEMPTS: '0', X402_RECONCILE_HEAD: 'pending' });
    expect(bad.problems).toHaveLength(2);
    expect(bad.config.maxAttempts).toBe(DEFAULT_AUTO_RECONCILE_CONFIG.maxAttempts);
    expect(autoReconcileConfigFromEnv({ X402_RECONCILE_ENABLED: 'false' }).enabled).toBe(false);
  });
});
