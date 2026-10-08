/**
 * DB-backed regressions — pay-resource ledger on REAL Postgres (task P6,
 * second adversarial review 2026-10-08).
 *
 * The route suite uses an in-memory ledger; this one runs the real
 * `ResourcePaymentService` against the test database so the row locks
 * (`SELECT … FOR UPDATE`), the conditional retry transition and every
 * Prisma `where` shape the counting rules use are exercised by Postgres
 * itself. It started as the reviewer's throwaway proof: after one
 * `BUDGET_EXCEEDED` attempt, 5 parallel retries of one `paymentId` at $0.40
 * on a $1 budget produced 5 signatures, 5 settlements and ONE `settled` row
 * ($2.00 spent, $0.60 still reported remaining).
 *
 * Needs `DATABASE_URL` with the migrations applied (CI: `agentfi_test`).
 * Every row is created with a per-run tag and deleted afterwards.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  // The x402 fixture listens on 127.0.0.1.
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
import { ResourcePaymentError, ResourcePaymentService } from '../services/payments/resource-payment.service.js';
import { X402ClientService } from '../services/payments/x402-client.service.js';
import type { TypedDataSigner } from '../services/wallet/signer.js';
import { loopbackOnly, startResourceServer, type FixtureOptions } from './helpers/x402-fixture.js';

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

async function mkAgent(role: string, policy: Record<string, unknown> = {}) {
  seq++;
  const agent = await db.agent.create({
    data: {
      name: `p6 ledger ${role} ${tag}-${seq}`,
      apiKeyHash: `p6-${role}-${tag}-${seq}`,
      apiKeyPrefix: 'agfi_live_p6',
      walletId: `p6-wallet-${role}-${tag}-${seq}`,
      // 0x6060… never matches the agent search suite's queries.
      safeAddress: `0x6060${randomBytes(18).toString('hex')}`,
      chainIds: [84532],
      policy: { create: { maxValuePerTxEth: '1', maxDailyVolumeUsd: '10000', cooldownSeconds: 0, ...policy } },
    },
  });
  createdAgents.push(agent.id);
  return agent;
}

async function mkJob(providerId: string, requesterId: string, amount = '1') {
  return db.job.create({
    data: {
      requesterId,
      providerId,
      status: 'ACCEPTED',
      payload: {},
      reward: { amount, token: 'USDC', chainId: 84532 },
    },
  });
}

async function fixture(options: FixtureOptions = {}) {
  const server = await startResourceServer({ price: '$0.40', ...options });
  open.push(server.close);
  return server;
}

function service(base: string) {
  return new ResourcePaymentService({ db, wallet, client: new X402ClientService({ fetch: loopbackOnly(base) }) });
}

/** `PAID` = this call paid; `REPLAY` = it started after the payment and read the ledger row. */
function codeOf(result: PromiseSettledResult<{ replayed?: boolean }>): string {
  if (result.status === 'fulfilled') return result.value.replayed ? 'REPLAY' : 'PAID';
  const reason = result.reason as unknown;
  return reason instanceof ResourcePaymentError ? reason.code : String(reason);
}

async function countedBaseUnits(jobId: string): Promise<bigint> {
  const rows = await db.resourcePayment.findMany({ where: { jobId } });
  const now = Date.now();
  return rows
    .filter(
      (r) =>
        ['reserved', 'pending', 'settled', 'unknown'].includes(r.status) ||
        (r.status === 'refused' && (r.authorizationValidBefore?.getTime() ?? 0) > now),
    )
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
}

describe('pay-resource ledger on Postgres (P6)', () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  afterAll(async () => {
    if (createdAgents.length > 0) {
      // Jobs, payments and policies cascade with the agents.
      await db.dailyVolume.deleteMany({ where: { agentId: { in: createdAgents } } });
      await db.agent.deleteMany({ where: { id: { in: createdAgents } } });
    }
    await db.$disconnect();
  });

  it('concurrent retries of one paymentId pay once — looped (the reviewer\'s $2-on-a-$1-budget proof)', async () => {
    const ROUNDS = 5;
    const N = 5;
    for (let round = 0; round < ROUNDS; round++) {
      const provider = await mkAgent('prov');
      const requester = await mkAgent('req');
      const job = await mkJob(provider.id, requester.id);
      const f = await fixture();
      const svc = service(f.base);
      const paymentId = `race_${tag}_${round}_0123456789`;

      // 1) A refusal before signing leaves a retryable `failed_before_signing` row.
      await expect(
        svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId, maxAmount: '0.30' }),
      ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
      const before = wallet.signatures;

      // 2) N concurrent retries with the same paymentId.
      const results = await Promise.allSettled(
        Array.from({ length: N }, () =>
          svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId }),
        ),
      );

      const codes = results.map(codeOf);
      const rows = await db.resourcePayment.findMany({ where: { jobId: job.id } });
      // Exactly one payment: one signature, one settlement, one settled row.
      expect(wallet.signatures - before).toBe(1);
      expect(f.counts.settle).toBe(1);
      expect(codes.filter((c) => c === 'PAID')).toHaveLength(1);
      // The others were told the id is busy, or (if they started after the
      // winner finished) got the replay.
      for (const code of codes) expect(['PAID', 'REPLAY', 'PAYMENT_IN_PROGRESS']).toContain(code);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'settled', amount: '400000', paymentId });
      // What the ledger counts is what was actually settled.
      expect(await countedBaseUnits(job.id)).toBe(BigInt(f.counts.settle) * 400_000n);
    }
  }, 120_000);

  it('concurrent first attempts with one new paymentId pay once; different ids never overspend the budget', async () => {
    const provider = await mkAgent('prov');
    const requester = await mkAgent('req');
    const f = await fixture();
    const svc = service(f.base);

    const sameIdJob = await mkJob(provider.id, requester.id);
    const paymentId = `first_${tag}_0123456789`;
    const before = wallet.signatures;
    const same = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        svc.payForResource({ jobId: sameIdJob.id, agentId: provider.id, url: f.url, method: 'GET', paymentId }),
      ),
    );
    expect(same.map(codeOf).filter((c) => c === 'PAID')).toHaveLength(1);
    for (const result of same) expect(['PAID', 'REPLAY', 'PAYMENT_IN_PROGRESS']).toContain(codeOf(result));
    expect(wallet.signatures - before).toBe(1);

    // $1 budget, $0.40 each, 5 distinct ids in parallel: at most two fit.
    const budgetJob = await mkJob(provider.id, requester.id);
    const settledBefore = f.counts.settle;
    const distinct = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        svc.payForResource({
          jobId: budgetJob.id,
          agentId: provider.id,
          url: f.url,
          method: 'GET',
          paymentId: `distinct_${tag}_${i}_0123456789`,
        }),
      ),
    );
    expect(distinct.map(codeOf).filter((c) => c === 'PAID')).toHaveLength(2);
    for (const result of distinct) expect(['PAID', 'BUDGET_EXCEEDED']).toContain(codeOf(result));
    expect(f.counts.settle - settledBefore).toBe(2);
    expect(await countedBaseUnits(budgetJob.id)).toBe(800_000n);
  }, 60_000);

  it('a post-signature refusal stays counted until validBefore and blocks a second signature to the same payTo', async () => {
    const provider = await mkAgent('prov');
    const requester = await mkAgent('req');
    const job = await mkJob(provider.id, requester.id);
    const f = await fixture({ facilitator: 'reject-verify' });
    const svc = service(f.base);
    const paymentId = `refused_${tag}_0123456789`;

    await expect(
      svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId }),
    ).rejects.toMatchObject({ code: 'PAYMENT_REFUSED' });
    const [row] = await db.resourcePayment.findMany({ where: { jobId: job.id } });
    expect(row).toMatchObject({ status: 'refused' });
    expect(row!.authorizationValidBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(await countedBaseUnits(job.id)).toBe(400_000n);
    const signed = wallet.signatures;

    // Same id and a new id (payTo compared case-insensitively by Postgres): both 409, nothing signed.
    await expect(
      svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId }),
    ).rejects.toMatchObject({ code: 'OUTSTANDING_AUTHORIZATION' });
    await db.resourcePayment.update({ where: { id: row!.id }, data: { payTo: row!.payTo.toUpperCase().replace('0X', '0x') } });
    await expect(
      svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId: `other_${tag}_0123456789` }),
    ).rejects.toMatchObject({ code: 'OUTSTANDING_AUTHORIZATION' });
    expect(wallet.signatures).toBe(signed);

    // Once validBefore has passed it stops counting and the id is retried on the same row.
    await db.resourcePayment.update({ where: { id: row!.id }, data: { authorizationValidBefore: new Date(Date.now() - 1000) } });
    const free = await svc.payForResource({ jobId: job.id, agentId: provider.id, url: `${f.base}/free`, method: 'GET' });
    expect(free.remainingBudget.remaining).toBe('1000000');
    await expect(
      svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET', paymentId }),
    ).rejects.toMatchObject({ code: 'PAYMENT_REFUSED' });
    expect(wallet.signatures).toBe(signed + 1);
    expect(await db.resourcePayment.count({ where: { jobId: job.id } })).toBe(1);
  }, 60_000);

  it('a pre-0018 refused row (no validBefore) counts for the legacy window after its last update', async () => {
    const provider = await mkAgent('prov');
    const requester = await mkAgent('req');
    const job = await mkJob(provider.id, requester.id);
    const f = await fixture();
    await db.resourcePayment.create({
      data: {
        jobId: job.id,
        agentId: provider.id,
        paymentId: `legacy_${tag}_0123456789`,
        url: f.url,
        method: 'GET',
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: '400000',
        payTo: f.seller.address,
        status: 'refused',
      },
    });
    const svc = service(f.base);

    const free = await svc.payForResource({ jobId: job.id, agentId: provider.id, url: `${f.base}/free`, method: 'GET' });
    expect(free.remainingBudget.spent).toBe('400000');
    await expect(
      svc.payForResource({ jobId: job.id, agentId: provider.id, url: f.url, method: 'GET' }),
    ).rejects.toMatchObject({ code: 'OUTSTANDING_AUTHORIZATION' });
  }, 60_000);

  it('the daily volume spans jobs and includes DailyVolume; the per-payment cap and payee allowlist refuse before signing', async () => {
    const provider = await mkAgent('prov', { maxDailyVolumeUsd: '1', maxValuePerTxEth: '0.5' });
    const requester = await mkAgent('req');
    const f = await fixture();
    const svc = service(f.base);
    const today = new Date().toISOString().slice(0, 10);
    await db.dailyVolume.create({ data: { agentId: provider.id, date: today, volumeUsd: '0.15' } });

    const jobA = await mkJob(provider.id, requester.id);
    const jobB = await mkJob(provider.id, requester.id);
    // 0.15 + 0.40 = 0.55, then 0.95: both fit; a third (1.35) does not.
    await svc.payForResource({ jobId: jobA.id, agentId: provider.id, url: f.url, method: 'GET' });
    await svc.payForResource({ jobId: jobB.id, agentId: provider.id, url: f.url, method: 'GET' });
    const signed = wallet.signatures;
    await expect(
      svc.payForResource({ jobId: jobA.id, agentId: provider.id, url: f.url, method: 'GET' }),
    ).rejects.toMatchObject({ code: 'POLICY_VIOLATION', details: { rule: 'maxDailyVolume', spentToday: '0.95' } });

    // Per-payment cap below the price.
    await db.agentPolicy.update({ where: { agentId: provider.id }, data: { maxDailyVolumeUsd: '0', maxValuePerTxEth: '0.3' } });
    await expect(
      svc.payForResource({ jobId: jobB.id, agentId: provider.id, url: f.url, method: 'GET' }),
    ).rejects.toMatchObject({ code: 'POLICY_VIOLATION', details: { rule: 'maxValuePerTx' } });

    // A payee allowlist that does not name the seller.
    await db.agentPolicy.update({
      where: { agentId: provider.id },
      data: { maxValuePerTxEth: '1', allowedContracts: ['0x00000000000000000000000000000000000000c1'] },
    });
    await expect(
      svc.payForResource({ jobId: jobB.id, agentId: provider.id, url: f.url, method: 'GET' }),
    ).rejects.toMatchObject({ code: 'POLICY_VIOLATION', details: { rule: 'allowedContracts' } });
    expect(wallet.signatures).toBe(signed);
    expect(f.counts.settle).toBe(2);
  }, 60_000);
});
