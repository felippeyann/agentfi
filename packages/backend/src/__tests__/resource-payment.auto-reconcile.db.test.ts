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
import { resolveManually, type ChainEvidenceReader } from '../services/payments/resource-payment-reconciliation.js';
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
  const cycle = (owner = 'w1', config: AutoReconcileConfig = CONFIG, second?: ChainEvidenceReader) =>
    runAutoReconcileCycle({ db, rpcFor: () => 'unused', readerFor: () => chain, secondReaderFor: () => second, config, now: () => clock.now, owner, jobId: job.id });
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

  it('4. evidence source down: conservative state, bounded backoff, an ALERT (not a stop) after N, retries continue — never read as "no payment"', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`down_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    // Even with the "chain" far past validBefore, a failing read must not lapse it.
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    t.chain.failReads('connect ECONNREFUSED');
    const signatures = wallet.signatures;

    let [o] = await t.cycle();
    expect(o).toMatchObject({ verdict: 'manual', transient: true, applied: false, escalated: false, stopped: false });
    expect(o!.nextAttemptAt!.getTime() - t.clock.now.getTime()).toBe(30_000);
    expect((await rows(t.job.id))[0]).toMatchObject({ status: 'unknown', reconcileState: { attempts: 1 } });
    expect(await counted(t.job.id)).toBe(400_000n);
    expect(await t.cycle()).toEqual([]); // not due yet
    t.advance(30_000);
    [o] = await t.cycle();
    expect(o!.nextAttemptAt!.getTime() - t.clock.now.getTime()).toBe(60_000);
    t.advance(60_000);
    [o] = await t.cycle();
    expect(o).toMatchObject({ transient: true, escalated: true, stopped: false });
    let [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]!.automatic).toMatch(/^ALERT since/);
    // Retries continue at the cap; the alert is not repeated.
    t.advance(120_000);
    [o] = await t.cycle();
    expect(o).toMatchObject({ transient: true, escalated: false, stopped: false });
    expect(o!.nextAttemptAt!.getTime() - t.clock.now.getTime()).toBe(120_000);
    expect((await rows(t.job.id))[0]).toMatchObject({ status: 'unknown', reconcileState: { attempts: 4 } });
    expect(await counted(t.job.id)).toBe(400_000n);
    expect(wallet.signatures).toBe(signatures);

    // Source back: the expiry is proven by the primary AND a second source on the same block → applied, alert cleared.
    t.chain.failReads(null);
    t.advance(120_000);
    const second = fakeChain();
    second.at(sec(unknown!.authorizationValidBefore!) + 3600);
    [o] = await t.cycle('w1', CONFIG, second);
    expect(o).toMatchObject({ verdict: 'expired', applied: true });
    expect(await counted(t.job.id)).toBe(0n);
    [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]).toMatchObject({ action: null, automatic: null });
  });

  it('a stop that follows a transient alert is announced again, with its own reason', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`stopafter_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    t.chain.failReads('down');
    const alerts: string[] = [];
    const cycle = () =>
      runAutoReconcileCycle({
        db, rpcFor: () => 'unused', readerFor: () => t.chain, config: CONFIG, now: () => t.clock.now, jobId: t.job.id,
        onEscalate: (o) => alerts.push(o.stopped ? 'stop' : 'alert'),
      });
    for (let i = 0; i < 3; i++) {
      await cycle();
      t.advance(120_000);
    }
    expect(alerts).toEqual(['alert']);
    t.chain.failReads(null);
    const [o] = await cycle(); // expiry, no second source → stop
    expect(o).toMatchObject({ stopped: true, escalated: true });
    expect(alerts).toEqual(['alert', 'stop']);
    expect((await rows(t.job.id))[0]!.reconcileState!.escalationReason).toMatch(/second evidence source/);
  });

  it('x402:ops auto uses the second evidence source like the worker (an agreeing source releases, none stops)', async () => {
    const { parseOpsArgs, runOps } = await import('../scripts/x402-ops.js');
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`cliauto_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    const second = fakeChain();
    second.at(sec(unknown!.authorizationValidBefore!) + 3600);
    const args = parseOpsArgs(['auto', '--job', t.job.id, '--second-rpc', 'second://', '--confirmations', '0', '--local-chain']);
    if (typeof args === 'string') throw new Error(args);
    const printed: string[] = [];
    const code = await runOps(args, {
      db,
      rpcFor: () => 'primary://',
      print: (l) => printed.push(l),
      readerFor: (url) => (url === 'second://' ? second : t.chain),
      secondRpcFor: () => undefined,
    });
    expect(code).toBe(0);
    expect((await rows(t.job.id))[0]!.status).toBe('expired');
    expect(second.reads.some((r) => r.startsWith('blockHash:'))).toBe(true);
  });

  it('a partial failure (head answers, authorizationState throws) is transient — never expired', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`partfail_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    t.chain.failState_ = 'execution reverted (rate limited)';
    const [o] = await t.cycle('w1', CONFIG, fakeChain());
    expect(o).toMatchObject({ verdict: 'manual', transient: true, applied: false });
    expect((await rows(t.job.id))[0]!.status).toBe('unknown');
  });

  it('expiry without proof from a second source is handed to the operator; a disagreeing source stops it; an agreeing one applies it', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`second_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);

    // No second source configured.
    let [o] = await t.cycle();
    expect(o).toMatchObject({ verdict: 'manual', applied: false, escalated: true, stopped: true });
    expect(o!.note).toMatch(/second evidence source/);
    expect((await rows(t.job.id))[0]!.status).toBe('unknown');
    expect(await counted(t.job.id)).toBe(400_000n);
    t.advance(24 * 3_600_000);
    expect(await t.cycle()).toEqual([]); // stopped: only an operator re-arms
    let [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]!.action).toMatch(/automatic reconciliation stopped/);

    // A second source on ANOTHER chain view (different block hash, e.g. a fork vs the real network).
    await rearmAutoReconcile(db, [unknown!.id]);
    const otherView = fakeChain();
    otherView.fork_ = 'c';
    [o] = await t.cycle('w1', CONFIG, otherView);
    expect(o).toMatchObject({ verdict: 'manual', applied: false, stopped: true });
    expect(o!.note).toMatch(/disagree/);
    expect((await rows(t.job.id))[0]!.status).toBe('unknown');

    // A second source that saw the transfer at the same block: disagrees on the state → stop, never release.
    await rearmAutoReconcile(db, [unknown!.id]);
    const sawIt = fakeChain();
    sawIt.use(unknown!);
    [o] = await t.cycle('w1', CONFIG, sawIt);
    expect(o).toMatchObject({ applied: false, stopped: true });
    expect(await counted(t.job.id)).toBe(400_000n);

    // An agreeing second source.
    await rearmAutoReconcile(db, [unknown!.id]);
    [o] = await t.cycle('w1', CONFIG, fakeChain());
    expect(o).toMatchObject({ verdict: 'expired', applied: true });
    [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]!.action).toBeNull();
  });

  it('a chain head that does not move past validBefore backs off and alerts instead of looping every tick', async () => {
    const t = await setup('2', { stall: 'paid' });
    await expect(t.pay(`lag_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(t.clock.now)); // head frozen here
    t.clock.now = new Date(unknown!.authorizationValidBefore!.getTime() + 10 * 60_000);
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const [o] = await t.cycle();
      expect(o).toMatchObject({ verdict: 'wait', applied: false });
      expect(o!.nextAttemptAt!.getTime()).toBeGreaterThan(t.clock.now.getTime());
      seen.push(o!.escalated);
      t.advance(o!.nextAttemptAt!.getTime() - t.clock.now.getTime());
    }
    expect(seen).toEqual([false, false, true]);
    expect((await rows(t.job.id))[0]).toMatchObject({ status: 'unknown', reconcileState: { attempts: 3 } });
  });

  it('a source that fails is not hammered: the other rows of that chain are skipped for the rest of the cycle', async () => {
    const t = await setup('2', { stall: 'paid' });
    for (let i = 0; i < 3; i++) await expect(t.pay(`skip${i}_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    t.chain.failReads('timeout');
    const outcomes = await t.cycle();
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.transient && !o.applied)).toBe(true);
    expect(outcomes.filter((o) => o.note.startsWith('skipped:'))).toHaveLength(2);
  });

  it('a new attempt on the same row starts a fresh schedule; resolve re-arms; the report falls back to manual actions when automation is off or silent', async () => {
    const t = await setup('2', { stall: 'paid' });
    const paymentId = `reuse_${tag}_0123456789`;
    await expect(t.pay(paymentId)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [unknown] = await rows(t.job.id);
    t.chain.at(sec(unknown!.authorizationValidBefore!) + 3600);
    await t.cycle(); // no second source → stopped
    expect((await rows(t.job.id))[0]!.reconcileState).toMatchObject({ stopped: true });

    let [agent] = await buildSpendReport(db, { jobId: t.job.id, automationEnabled: false });
    expect(agent!.jobs[0]!.payments[0]!.action).toMatch(/automatic reconciliation stopped/);

    // Operator resolves it (attestation) → schedule deleted; the agent retries the same id → fresh state.
    expect((await resolveManually(db, { jobId: t.job.id, paymentId, outcome: 'expired', operator: 'owner', note: 'checked on the explorer', apply: true })).ok).toBe(true);
    expect((await rows(t.job.id))[0]!.reconcileState).toBeNull();
    await t.cycle(); // creates no state: the expired row is not reconcilable
    await expect(t.pay(paymentId)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const [retried] = await rows(t.job.id);
    expect(retried).toMatchObject({ status: 'unknown', reconcileState: null });
    expect(retried!.authorizationNonce).not.toBe(unknown!.authorizationNonce);

    // A stale schedule left on the row (e.g. an old stop) is wiped by the next takeover too.
    await db.resourcePaymentReconcileState.create({ data: { resourcePaymentId: retried!.id, stopped: true, escalatedAt: new Date(), escalationReason: 'old' } });
    await db.resourcePayment.update({ where: { id: retried!.id }, data: { status: 'expired' } });
    await expect(t.pay(paymentId)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    expect((await rows(t.job.id))[0]!.reconcileState).toBeNull();

    // Automation off: the report gives the manual action instead of staying silent.
    [agent] = await buildSpendReport(db, { jobId: t.job.id, automationEnabled: false });
    expect(agent!.jobs[0]!.payments[0]!.action).toMatch(/disabled .*x402:ops reconcile --apply/);
    // Automation on but the worker never visited for > 10 min: "is the worker running?".
    [agent] = await buildSpendReport(db, { jobId: t.job.id, now: new Date(Date.now() + 11 * 60_000) });
    expect(agent!.jobs[0]!.payments[0]!.action).toMatch(/is the worker running\?/);
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

  // ── Lease expiry while a worker is still reading the chain (2026-11-16) ────────────────────────────
  // Worker A claims a row, then its RPC stalls past `leaseMs`. Worker B claims the SAME row and
  // judges it. These tests hold A inside `head()` (a gate), let B run, then release A.
  describe('a lease that expires while its owner is still reading the chain', () => {
    function gated(chain: ReturnType<typeof fakeChain>, after: 'read' | 'fail') {
      let release!: () => void;
      let entered!: () => void;
      const open = new Promise<void>((r) => (release = r));
      const inside = new Promise<void>((r) => (entered = r));
      const reader: ChainEvidenceReader = {
        ...chain,
        async head() {
          entered();
          await open;
          if (after === 'fail') throw new Error('request timed out after 120s');
          return chain.head();
        },
      };
      return { reader, release, inside };
    }
    const cycleOf = (t: Awaited<ReturnType<typeof setup>>, owner: string, reader: ChainEvidenceReader, at: Date, config: AutoReconcileConfig, alerts?: string[]) =>
      runAutoReconcileCycle({
        db, rpcFor: () => 'unused', readerFor: () => reader, config, now: () => at, owner, jobId: t.job.id,
        ...(alerts ? { onEscalate: (o) => alerts.push(o.verdict) } : {}),
      });

    async function lostResponse(label: string) {
      const t = await setup('2', { stall: 'paid' });
      await expect(t.pay(`${label}_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
      const [unknown] = await rows(t.job.id);
      return { t, unknown: unknown! };
    }

    it('L1. (characterisation) the winner already settled the row; the stale worker resumes with a CONFLICTING verdict (would release): nothing is written, the winner\'s state is intact', async () => {
      const { t, unknown } = await lostResponse('l1');
      // A's (stale, single-source) view says the authorization lapsed unused → it would release the budget.
      const staleChain = fakeChain();
      staleChain.at(sec(unknown.authorizationValidBefore!) + 3600);
      const slow = gated(staleChain, 'read');
      const t0 = t.clock.now;
      const aConfig = { ...CONFIG, singleSourceExpiry: true };
      const a = cycleOf(t, 'A', slow.reader, t0, aConfig);
      await slow.inside; // A holds the lease and is inside the RPC
      expect((await rows(t.job.id))[0]!.reconcileState).toMatchObject({ leaseOwner: 'A' });

      // The lease (60 s) expires; B claims the same row and PROVES the transfer.
      const later = new Date(t0.getTime() + CONFIG.leaseMs + 1000);
      const tx = t.chain.use(unknown);
      const [b] = await cycleOf(t, 'B', t.chain, later, CONFIG);
      expect(b).toMatchObject({ verdict: 'confirmed', applied: true });
      const settled = (await rows(t.job.id))[0]!;
      expect(settled).toMatchObject({ status: 'settled', settlementTxHash: tx });
      expect(settled.reconcileState).toMatchObject({ lastVerdict: 'confirmed', leaseOwner: null });

      slow.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ verdict: 'manual', transient: true, applied: false, escalated: false }); // lease lost: no release on a stale view
      const after = (await rows(t.job.id))[0]!;
      expect(after).toMatchObject({ status: 'settled', settlementTxHash: tx, reconciledAt: settled.reconciledAt, reconcileNote: settled.reconcileNote });
      expect(after.reconcileState).toMatchObject({ lastVerdict: 'confirmed', attempts: 0, leaseOwner: null, stopped: false });
      expect(await counted(t.job.id)).toBe(400_000n); // counted once, never released
    });

    it('L2. the stale worker fails AFTER the winner proved the payment: no alert, no state written over the winner', async () => {
      const { t, unknown } = await lostResponse('l2');
      const slow = gated(t.chain, 'fail');
      const t0 = t.clock.now;
      const alerts: string[] = [];
      const oneStrike = { ...CONFIG, maxAttempts: 1 }; // one transient failure alerts the operator
      const a = cycleOf(t, 'A', slow.reader, t0, oneStrike, alerts);
      await slow.inside;
      t.chain.use(unknown);
      const [b] = await cycleOf(t, 'B', t.chain, new Date(t0.getTime() + CONFIG.leaseMs + 1000), CONFIG);
      expect(b).toMatchObject({ verdict: 'confirmed', applied: true });
      slow.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ transient: true, applied: false, escalated: false });
      expect(alerts).toEqual([]); // an alert about a row already proven would be false
      expect((await rows(t.job.id))[0]).toMatchObject({
        status: 'settled',
        reconcileState: { lastVerdict: 'confirmed', attempts: 0, leaseOwner: null, escalatedAt: null, stopped: false },
      });
    });

    it('L3. both are inside the RPC; the first released writes the transition once, the other finds the row moved and writes nothing over it', async () => {
      const { t, unknown } = await lostResponse('l3');
      const tx = t.chain.use(unknown);
      // B's (stale, single-source) view says lapsed-unused: it would release the budget.
      const lapsed = fakeChain();
      lapsed.at(sec(unknown.authorizationValidBefore!) + 3600);
      const gateA = gated(t.chain, 'read');
      const gateB = gated(lapsed, 'read');
      const t0 = t.clock.now;
      const a = cycleOf(t, 'A', gateA.reader, t0, CONFIG);
      await gateA.inside;
      const b = cycleOf(t, 'B', gateB.reader, new Date(t0.getTime() + CONFIG.leaseMs + 1000), { ...CONFIG, singleSourceExpiry: true });
      await gateB.inside; // B claimed the expired lease and is inside the RPC too
      expect((await rows(t.job.id))[0]!.reconcileState).toMatchObject({ leaseOwner: 'B' });

      gateA.release();
      const [aOutcome] = await a; // A no longer owns the lease: its transition is still the only judged-by-proof write
      expect(aOutcome).toMatchObject({ verdict: 'confirmed', applied: true });
      gateB.release();
      const [bOutcome] = await b;
      expect(bOutcome).toMatchObject({ verdict: 'expired', applied: false, raced: true });
      const final = (await rows(t.job.id))[0]!;
      expect(final).toMatchObject({ status: 'settled', settlementTxHash: tx });
      // B's stale "expired" judgement is not recorded over a settled row; the lease is free.
      expect(final.reconcileState).toMatchObject({ leaseOwner: null, leaseUntil: null, stopped: false, escalatedAt: null });
      expect(final.reconcileState!.lastVerdict).not.toBe('expired');
      expect(await counted(t.job.id)).toBe(400_000n);
    });

    it('L1b. worker B is still INSIDE its RPC (holds the lease) when the stale worker A resumes with a would-release verdict: A releases nothing, writes nothing, alerts nobody', async () => {
      const { t, unknown } = await lostResponse('l1b');
      const stale = fakeChain();
      stale.at(sec(unknown.authorizationValidBefore!) + 3600);
      const gateA = gated(stale, 'read');
      const gateB = gated(t.chain, 'read');
      const t0 = t.clock.now;
      const alerts: string[] = [];
      const a = cycleOf(t, 'A', gateA.reader, t0, { ...CONFIG, singleSourceExpiry: true, maxAttempts: 1 }, alerts);
      await gateA.inside;
      const b = cycleOf(t, 'B', gateB.reader, new Date(t0.getTime() + CONFIG.leaseMs + 1000), CONFIG);
      await gateB.inside; // B holds the lease and is inside its RPC; the row is untouched
      gateA.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ applied: false, escalated: false });
      expect(alerts).toEqual([]);
      expect((await rows(t.job.id))[0]).toMatchObject({ status: 'unknown', reconcileState: { leaseOwner: 'B' } });
      expect(await counted(t.job.id)).toBe(400_000n); // not released by the stale view

      const tx = t.chain.use(unknown); // B reads the real chain
      gateB.release();
      const [bOutcome] = await b;
      expect(bOutcome).toMatchObject({ verdict: 'confirmed', applied: true });
      expect((await rows(t.job.id))[0]).toMatchObject({ status: 'settled', settlementTxHash: tx });
      expect(await counted(t.job.id)).toBe(400_000n);
    });

    it('L4. the row leaves the reconcilable set (another writer) while this worker, still owning its lease, fails transiently: the alert is dropped', async () => {
      const { t, unknown } = await lostResponse('l4');
      const slow = gated(t.chain, 'fail');
      const alerts: string[] = [];
      const a = cycleOf(t, 'A', slow.reader, t.clock.now, { ...CONFIG, maxAttempts: 1 }, alerts);
      await slow.inside;
      // A live attempt / the CLI ends the row outside the reconciler; A still owns the lease.
      await db.resourcePayment.update({ where: { id: unknown.id }, data: { status: 'expired', reconciledAt: new Date(), reconcileNote: 'ended by another writer' } });
      slow.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ transient: true, applied: false, escalated: false, stopped: false });
      expect(alerts).toEqual([]);
      expect((await rows(t.job.id))[0]!.reconcileState).toMatchObject({ leaseOwner: null, escalatedAt: null, stopped: false });
    });

    it('L6. a would-release `expired` verdict RACES the row (changed by another writer, still open): the conditional write returns raced, nothing is released or alerted', async () => {
      const { t, unknown } = await lostResponse('l6');
      const stale = fakeChain();
      stale.at(sec(unknown.authorizationValidBefore!) + 3600); // unused and past validBefore: would release
      const slow = gated(stale, 'read');
      const alerts: string[] = [];
      const a = cycleOf(t, 'A', slow.reader, t.clock.now, { ...CONFIG, singleSourceExpiry: true, maxAttempts: 1 }, alerts);
      await slow.inside;
      // A still owns its lease; another writer touches the row (status unchanged, updatedAt moves): the row stays open.
      await db.resourcePayment.update({ where: { id: unknown.id }, data: { error: 'touched by another writer' } });
      slow.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ verdict: 'expired', applied: false, raced: true, escalated: false, stopped: false });
      expect(alerts).toEqual([]);
      const [row] = await rows(t.job.id);
      expect(row).toMatchObject({ status: 'unknown' }); // nothing released
      expect(row!.reconcileState).toMatchObject({ leaseOwner: null, escalatedAt: null, stopped: false });
      expect(row!.reconcileState!.lastVerdict).toBeNull(); // a raced verdict records no diagnostics
      expect(await counted(t.job.id)).toBe(400_000n);
    });

    it('L5. a row proven by another writer loses its stale escalation: no ALERT / STOPPED is left on it', async () => {
      const { t, unknown } = await lostResponse('l5');
      const t0 = t.clock.now;
      await db.resourcePaymentReconcileState.create({
        data: { resourcePaymentId: unknown.id, nextAttemptAt: t0, attempts: 5, escalatedAt: t0, escalationReason: 'evidence source unavailable (5 times in a row)' },
      });
      t.chain.use(unknown);
      const slow = gated(t.chain, 'read');
      const a = cycleOf(t, 'A', slow.reader, t0, CONFIG);
      await slow.inside;
      // Another worker (or a live attempt) proves the row first, outside this lease.
      await db.resourcePayment.update({ where: { id: unknown.id }, data: { status: 'settled', chainVerifiedAt: new Date(), reconciledAt: new Date() } });
      slow.release();
      const [aOutcome] = await a;
      expect(aOutcome).toMatchObject({ applied: false, raced: true });
      expect((await rows(t.job.id))[0]!.reconcileState).toMatchObject({ leaseOwner: null, escalatedAt: null, escalationReason: null, stopped: false });
      const [agent] = await buildSpendReport(db, { jobId: t.job.id });
      expect(agent!.jobs[0]!.payments[0]!.automatic).toBeNull();
    });
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
