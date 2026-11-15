/**
 * DB-backed — x402 reconciliation on REAL Postgres with the real payment
 * flow (first x402 delivery, 2026-11-15).
 *
 * The real `ResourcePaymentService` + `X402ClientService` pay the P1 harness
 * (real x402 v2 resource server, fake facilitator); the chain is a
 * test-controlled `ChainEvidenceReader` (`helpers/fake-chain-evidence.ts`).
 * What is observed besides the DB status: signatures produced by the wallet,
 * requests the resource server received with a payment, facilitator calls.
 * FiatToken itself (authorizationState, AuthorizationUsed, Transfer) is
 * exercised on a Base Sepolia fork by `src/scripts/demo/x402-spend-demo.ts`.
 *
 * Needs `DATABASE_URL` with the migrations applied (CI: `agentfi_test`).
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
import { countedWhere, resourcePaymentSpentToday, sumBaseUnits } from '../services/payments/resource-payment-ledger.js';
import { reconcileResourcePayments, type ChainEvidenceReader } from '../services/payments/resource-payment-reconciliation.js';
import { buildSpendReport } from '../services/payments/resource-payment-report.js';
import { ResourcePaymentError, ResourcePaymentService } from '../services/payments/resource-payment.service.js';
import { X402ClientService } from '../services/payments/x402-client.service.js';
import type { TypedDataSigner } from '../services/wallet/signer.js';
import { fakeChain } from './helpers/fake-chain-evidence.js';
import { isPaidRequest, loopbackOnly, startResourceServer, type FixtureOptions } from './helpers/x402-fixture.js';

const payer = privateKeyToAccount(generatePrivateKey());
let onSign: (() => Promise<void>) | null = null;
const wallet: TypedDataSigner & { signatures: number } = {
  signatures: 0,
  async getWalletAddress() {
    return payer.address;
  },
  async signTypedData({ typedData }) {
    wallet.signatures++;
    const signature = await payer.signTypedData(typedData as unknown as TypedDataDefinition);
    if (onSign) await onSign();
    return { signature, address: payer.address };
  },
};

const tag = randomBytes(4).toString('hex');
const createdAgents: string[] = [];
const open: Array<() => Promise<void>> = [];
let seq = 0;

async function mkAgent(role: string, policy: Record<string, unknown> = {}) {
  seq++;
  const agent = await db.agent.create({
    data: {
      name: `x402 rec ${role} ${tag}-${seq}`,
      apiKeyHash: `x4r-${role}-${tag}-${seq}`,
      apiKeyPrefix: 'agfi_live_x4r',
      walletId: `x4r-wallet-${role}-${tag}-${seq}`,
      safeAddress: `0x6061${randomBytes(18).toString('hex')}`,
      chainIds: [84532],
      policy: { create: { maxValuePerTxUsd: '1', maxDailyVolumeUsd: '10000', cooldownSeconds: 0, ...policy } },
    },
  });
  createdAgents.push(agent.id);
  return agent;
}

async function setup(amount = '1', options: FixtureOptions = {}, policy: Record<string, unknown> = {}) {
  const provider = await mkAgent('prov', policy);
  const requester = await mkAgent('req');
  const job = await db.job.create({
    data: {
      requesterId: requester.id,
      providerId: provider.id,
      status: 'ACCEPTED',
      payload: {},
      reward: { amount, token: 'USDC', chainId: 84532 },
    },
  });
  // Kept by reference: tests flip `stall` / `facilitator` between attempts on the SAME URL.
  const fixtureOptions: FixtureOptions = { price: '$0.40', ...options };
  const server = await startResourceServer(fixtureOptions);
  open.push(server.close);
  let paidRequests = 0;
  const transport = loopbackOnly(server.base);
  const counting: typeof fetch = (input, init) => {
    if (isPaidRequest(input)) paidRequests++;
    return transport(input, init);
  };
  const svc = new ResourcePaymentService({
    db,
    wallet,
    client: new X402ClientService({ fetch: counting, requestTimeoutMs: 400 }),
  });
  const chain = fakeChain();
  const readers = new Map<number, ChainEvidenceReader>([[84532, chain]]);
  const pay = (paymentId: string) =>
    svc.payForResource({ jobId: job.id, agentId: provider.id, url: server.url, method: 'GET', paymentId });
  return {
    provider,
    job,
    server,
    fixtureOptions,
    chain,
    readers,
    pay,
    paidRequests: () => paidRequests,
    reconcile: (apply = true, staleAfterMs?: number) =>
      reconcileResourcePayments(db, { readers, apply, jobId: job.id, ...(staleAfterMs !== undefined ? { staleAfterMs } : {}) }),
  };
}

async function counted(jobId: string): Promise<bigint> {
  return sumBaseUnits(await db.resourcePayment.findMany({ where: { jobId, ...countedWhere(new Date()) } }));
}

async function onlyRow(jobId: string) {
  const rows = await db.resourcePayment.findMany({ where: { jobId } });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('x402 reconciliation on Postgres', () => {
  afterEach(async () => {
    onSign = null;
    await Promise.all(open.splice(0).map((close) => close()));
  });

  afterAll(async () => {
    if (createdAgents.length > 0) {
      await db.dailyVolume.deleteMany({ where: { agentId: { in: createdAgents } } });
      await db.agent.deleteMany({ where: { id: { in: createdAgents } } });
    }
    await db.$disconnect();
  });

  it('lost response after signing → unknown, kept counted; the chain proves the transfer → settled + chainVerifiedAt; a retry never re-signs', async () => {
    const t = await setup('1', { stall: 'paid' });
    const paymentId = `lost_${tag}_0123456789`;
    const before = wallet.signatures;

    await expect(t.pay(paymentId)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const unknown = await onlyRow(t.job.id);
    expect(unknown).toMatchObject({ status: 'unknown', payer: payer.address, authorizationMethod: 'eip3009' });
    expect(unknown.authorizationNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await counted(t.job.id)).toBe(400_000n);

    // Still unused and valid on-chain: nothing changes, nothing is released.
    let results = await t.reconcile();
    expect(results.map((r) => r.verdict.kind)).toEqual(['wait']);
    expect((await onlyRow(t.job.id)).status).toBe('unknown');
    expect(await counted(t.job.id)).toBe(400_000n);

    // The server settled after all.
    const tx = t.chain.use(unknown);
    results = await t.reconcile();
    expect(results[0]).toMatchObject({ applied: true, verdict: { kind: 'confirmed', txHash: tx } });
    const settled = await onlyRow(t.job.id);
    expect(settled).toMatchObject({ status: 'settled', settlementTxHash: tx });
    expect(settled.chainVerifiedAt).toBeInstanceOf(Date);
    expect(await counted(t.job.id)).toBe(400_000n);

    // Retry with the same id: replayed from the ledger, nothing signed or sent.
    delete t.fixtureOptions.stall;
    const paidBefore = t.paidRequests();
    const replay = await t.pay(paymentId);
    expect(replay.replayed).toBe(true);
    expect(wallet.signatures - before).toBe(1);
    expect(t.paidRequests()).toBe(paidBefore);
    expect(t.server.counts.settle).toBe(0);
  });

  it('lost response, authorization lapsed UNUSED on-chain → expired: budget and daily volume released, the same id may pay again (one new signature)', async () => {
    const t = await setup('1', { stall: 'paid' });
    const paymentId = `lapse_${tag}_0123456789`;
    await expect(t.pay(paymentId)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const unknown = await onlyRow(t.job.id);
    expect(await resourcePaymentSpentToday(db, t.provider.id, new Date())).toBe(400_000n);

    // Our clock alone is no evidence: a head before validBefore keeps it.
    t.chain.at(sec(unknown.authorizationValidBefore!) - 1);
    expect((await t.reconcile())[0]!.verdict.kind).toBe('wait');

    t.chain.at(sec(unknown.authorizationValidBefore!));
    const [result] = await t.reconcile();
    expect(result).toMatchObject({ applied: true, verdict: { kind: 'expired', reason: 'lapsed-unused' } });
    expect((await onlyRow(t.job.id)).status).toBe('expired');
    expect(await counted(t.job.id)).toBe(0n);
    expect(await resourcePaymentSpentToday(db, t.provider.id, new Date())).toBe(0n);

    delete t.fixtureOptions.stall;
    const signaturesBefore = wallet.signatures;
    const paid = await t.pay(paymentId);
    expect(paid.payment?.status).toBe('settled');
    expect(wallet.signatures - signaturesBefore).toBe(1);
    expect(t.server.counts.settle).toBe(1);
    expect(await counted(t.job.id)).toBe(400_000n);
  });

  it('dry-run writes nothing; a chain read failure is reported as manual and writes nothing', async () => {
    const t = await setup('1', { stall: 'paid' });
    await expect(t.pay(`dry_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    const unknown = await onlyRow(t.job.id);
    t.chain.use(unknown);
    const dry = await t.reconcile(false);
    expect(dry[0]).toMatchObject({ applied: false, verdict: { kind: 'confirmed' } });
    expect((await onlyRow(t.job.id)).status).toBe('unknown');

    t.chain.failReads('rpc down');
    const failed = await t.reconcile(true);
    expect(failed[0]!.verdict.kind).toBe('manual');
    expect((await onlyRow(t.job.id)).status).toBe('unknown');
    expect(await counted(t.job.id)).toBe(400_000n);
  });

  it('restart before signing: an abandoned `reserved` row holds the budget until reconciliation releases it', async () => {
    const t = await setup('0.5');
    // What a crash between the reservation and the signature leaves behind.
    await db.resourcePayment.create({
      data: {
        jobId: t.job.id,
        agentId: t.provider.id,
        paymentId: `crash_${tag}_0123456789`,
        url: t.server.url,
        method: 'GET',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '400000',
        payTo: t.server.seller.address,
        status: 'reserved',
        reservedAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    const before = wallet.signatures;
    await expect(t.pay(`next_${tag}_0123456789`)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(wallet.signatures).toBe(before);

    const results = await t.reconcile();
    expect(results.find((r) => r.row.paymentId.startsWith('crash_'))).toMatchObject({ applied: true, verdict: { kind: 'release-unsigned' } });
    expect(t.chain.reads).toEqual([]);

    const paid = await t.pay(`next2_${tag}_0123456789`);
    expect(paid.payment?.status).toBe('settled');
    expect(wallet.signatures - before).toBe(1);
  });

  it('a slow attempt whose reservation was released cannot send: markPending refuses, nothing reaches the server', async () => {
    const t = await setup('1');
    // Reconciliation runs (and judges every reservation stale) while the wallet is still signing.
    onSign = async () => {
      onSign = null;
      const results = await reconcileResourcePayments(db, { readers: t.readers, apply: true, jobId: t.job.id, staleAfterMs: 0 });
      expect(results.map((r) => r.verdict.kind)).toEqual(['release-unsigned']);
    };
    const error = await t.pay(`slow_${tag}_0123456789`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourcePaymentError);
    expect((error as ResourcePaymentError).code).toBe('LEDGER_ERROR');
    expect(t.paidRequests()).toBe(0);
    expect(t.server.counts.verify).toBe(0);
    expect((await onlyRow(t.job.id)).status).toBe('failed_before_signing');
    expect(await counted(t.job.id)).toBe(0n);
  });

  it('two reconciliation passes at once write each transition once', async () => {
    const t = await setup('1', { stall: 'paid' });
    await expect(t.pay(`twice_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    t.chain.use(await onlyRow(t.job.id));
    const passes = await Promise.all([t.reconcile(), t.reconcile(), t.reconcile()]);
    const applied = passes.flat().filter((r) => r.applied);
    expect(applied).toHaveLength(1);
    expect((await onlyRow(t.job.id)).status).toBe('settled');
  });

  it('a refusal that lapsed (no longer counted) but did settle on-chain is brought back as settled and flagged over-committed when it exceeds the budget', async () => {
    const t = await setup('0.5', { facilitator: 'reject-verify' });
    await expect(t.pay(`refA_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_REFUSED' });
    const refused = await onlyRow(t.job.id);
    expect(refused.status).toBe('refused');
    // Time passes: the refusal stops counting on our clock.
    await db.resourcePayment.update({ where: { id: refused.id }, data: { authorizationValidBefore: new Date(Date.now() - 1000) } });
    expect(await counted(t.job.id)).toBe(0n);
    // Meanwhile the budget was used by another payment to another payee.
    t.fixtureOptions.facilitator = 'accept';
    await db.resourcePayment.create({
      data: {
        jobId: t.job.id, agentId: t.provider.id, paymentId: `other_${tag}_0123456789`, url: 'https://other.example/x', method: 'GET',
        network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '400000', payTo: '0x4444444444444444444444444444444444444444',
        status: 'settled', chainVerifiedAt: new Date(),
      },
    });
    t.chain.use(refused);
    const results = await t.reconcile();
    expect(results.find((r) => r.row.id === refused.id)).toMatchObject({ applied: true, verdict: { kind: 'confirmed' } });
    expect(await counted(t.job.id)).toBe(800_000n);
    const [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]).toMatchObject({ overCommitted: true, committedUsdc: '0.8', provenUsdc: '0.8', budgetUsdc: '0.5' });
  });

  it('the operator report separates money from delivery and names the action', async () => {
    const t = await setup('1', { stall: 'paid' }, { maxDailyVolumeUsd: '0.6' });
    await expect(t.pay(`rep1_${tag}_0123456789`)).rejects.toMatchObject({ code: 'PAYMENT_OUTCOME_UNKNOWN' });
    delete t.fixtureOptions.stall;
    // Blocked by the operator's daily limit before anything is signed.
    const before = wallet.signatures;
    await expect(t.pay(`rep2_${tag}_0123456789`)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(wallet.signatures).toBe(before);

    let [agent] = await buildSpendReport(db, { agentId: t.provider.id });
    const lines = agent!.jobs[0]!.payments;
    const unknownLine = lines.find((p) => p.paymentId.startsWith('rep1_'))!;
    const blocked = lines.find((p) => p.paymentId.startsWith('rep2_'))!;
    expect(unknownLine).toMatchObject({ status: 'unknown', money: 'possibly-moved', delivery: 'no-response', counted: true });
    expect(unknownLine.action).toContain('reconcile');
    expect(blocked).toMatchObject({ status: 'failed_before_signing', money: 'not-moved', counted: false, action: null });
    expect(blocked.reason).toMatch(/daily/i);
    expect(agent!.policy).toMatchObject({ maxDailyVolumeUsd: '0.6' });
    expect(agent!.today.remainingDailyUsd).toBe('0.2');
    expect(agent!.pendingActions).toBe(1);

    t.chain.use(await db.resourcePayment.findFirstOrThrow({ where: { jobId: t.job.id, status: 'unknown' } }));
    await t.reconcile();
    [agent] = await buildSpendReport(db, { agentId: t.provider.id });
    const proven = agent!.jobs[0]!.payments.find((p) => p.paymentId.startsWith('rep1_'))!;
    expect(proven).toMatchObject({ status: 'settled', money: 'proven' });
    // Proven paid, but no paid response ever arrived: the report says so.
    expect(proven.delivery).toBe('no-response');
    expect(proven.action).toContain('not delivered');
  });

  it('a delivered purchase records the resource digest apart from the money (reported until proven)', async () => {
    const t = await setup('1');
    const paid = await t.pay(`ok_${tag}_0123456789`);
    const row = await onlyRow(t.job.id);
    expect(row).toMatchObject({ status: 'settled', responseStatus: 200, chainVerifiedAt: null, payer: payer.address });
    expect(row.resourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.resourceBytes).toBe(JSON.stringify(paid.resource?.body).length);
    const [agent] = await buildSpendReport(db, { jobId: t.job.id });
    expect(agent!.jobs[0]!.payments[0]).toMatchObject({ money: 'reported', delivery: 'delivered' });
    expect(agent!.jobs[0]!.payments[0]!.action).toContain('prove it on-chain');
  });
});

