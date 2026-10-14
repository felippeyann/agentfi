/**
 * DB-backed regressions — the escrow job reservation on REAL Postgres (C3d
 * review, P2-3): `reserveEscrowJobSpend` checks the policy, increments
 * DailyVolume and creates the Job row in ONE transaction under the
 * requester's Agent row lock, the lock the x402 ledger (P6) takes too.
 *
 *  - an x402 reservation (the real `ResourcePaymentService` against the
 *    loopback x402 fixture) racing an escrow job of the same agent near the
 *    limit: never both (looped, both start orders);
 *  - two escrow jobs of one agent racing near the limit: never both;
 *  - a failing Job insert rolls the DailyVolume increment back; a refusal
 *    leaves nothing behind;
 *  - two agents creating jobs for each other at once do not deadlock (the
 *    Agent lock is `FOR NO KEY UPDATE`, compatible with the foreign-key
 *    `FOR KEY SHARE` of the Job insert).
 *
 * Needs `DATABASE_URL` with the migrations applied. Every row is created with
 * a per-run tag and deleted afterwards. Skipped (with a warning) when the
 * database is unreachable locally; CI fails instead.
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
  // The x402 fixture listens on 127.0.0.1.
  process.env['RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS'] = 'true';
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
// escrow.service.ts imports the transaction queue (BullMQ + Redis); none of it runs here.
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: async () => undefined } }));

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { TypedDataSigner } from '../services/wallet/signer.js';
import { loopbackOnly, startResourceServer } from './helpers/x402-fixture.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "reservedValueUsd" FROM "Job" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('escrow-spend-policy.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[escrow-spend-policy.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const { db } = await import('../db/client.js');
const { reserveEscrowJobSpend } = await import('../services/policy/escrow.service.js');
const { ResourcePaymentService } = await import('../services/payments/resource-payment.service.js');
const { X402ClientService } = await import('../services/payments/x402-client.service.js');

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const tag = randomBytes(4).toString('hex');
const createdAgents: string[] = [];
const open: Array<() => Promise<void>> = [];
let seq = 0;

const payer = privateKeyToAccount(generatePrivateKey());
const wallet: TypedDataSigner = {
  async getWalletAddress() {
    return payer.address;
  },
  async signTypedData({ typedData }) {
    const signature = await payer.signTypedData(typedData as unknown as TypedDataDefinition);
    return { signature, address: payer.address };
  },
};

async function mkAgent(role: string, policy: Record<string, unknown> | null = {}) {
  seq++;
  const agent = await db.agent.create({
    data: {
      name: `c3d spend ${role} ${tag}-${seq}`,
      apiKeyHash: `c3d-spend-${role}-${tag}-${seq}`,
      apiKeyPrefix: 'agfi_live_c3d',
      walletId: `c3d-spend-wallet-${role}-${tag}-${seq}`,
      safeAddress: `0x6061${randomBytes(18).toString('hex')}`,
      chainIds: [84532],
      ...(policy
        ? { policy: { create: { maxValuePerTxUsd: '100', maxDailyVolumeUsd: '0', cooldownSeconds: 0, allowedContracts: [], allowedRecipients: [], allowedTokens: [], ...policy } } }
        : {}),
    },
  });
  createdAgents.push(agent.id);
  return agent;
}

const today = () => new Date().toISOString().slice(0, 10);
async function committedUsd(agentId: string): Promise<number> {
  const row = await db.dailyVolume.findUnique({ where: { agentId_date: { agentId, date: today() } } });
  return Number(row?.volumeUsd ?? '0');
}

function reserve(requesterId: string, providerId: string, payee: string, amount: string) {
  return reserveEscrowJobSpend(
    { requesterId, chainId: 84532, amount, token: USDC, payee },
    (tx, r) =>
      tx.job.create({
        data: {
          requesterId,
          providerId,
          payload: { c3d: 'spend' },
          reward: { amount, token: 'USDC', chainId: 84532 },
          status: 'PENDING',
          reservedAmount: amount,
          reservedToken: 'USDC',
          reservedChainId: 84532,
          reservedAt: new Date(),
          reservationStatus: 'PENDING',
          reservedValueUsd: r.reservedValueUsd,
        },
      }),
  );
}

describeDb('escrow job reservation on Postgres (C3d review P2-3)', () => {
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

  it('an x402 payment racing an escrow job of the same agent near the limit: never both (6 runs, both start orders)', async () => {
    const server = await startResourceServer({ price: '$0.40' });
    open.push(server.close);
    const svc = new ResourcePaymentService({ db, wallet, client: new X402ClientService({ fetch: loopbackOnly(server.base) }) });
    const outcomes = { escrow: 0, x402: 0 };

    for (let i = 0; i < 6; i++) {
      // X provides job J (it pays x402 resources on it) and requests a 5 USDC escrow job; limit 5.2.
      const x = await mkAgent(`x${i}`, { maxDailyVolumeUsd: '5.2' });
      const r = await mkAgent(`r${i}`, null);
      const p = await mkAgent(`p${i}`, null);
      const j = await db.job.create({
        data: { requesterId: r.id, providerId: x.id, status: 'ACCEPTED', payload: {}, reward: { amount: '1', token: 'USDC', chainId: 84532 } },
      });
      const escrow = () => reserve(x.id, p.id, p.safeAddress, '5');
      const x402 = () => svc.payForResource({ jobId: j.id, agentId: x.id, url: server.url, method: 'GET' });
      const settled =
        i % 2 === 0
          ? await Promise.allSettled([escrow(), x402()])
          : await Promise.allSettled([x402(), escrow()]).then(([a, b]) => [b, a] as const);
      const [escrowRes, x402Res] = settled;
      const escrowOk = escrowRes.status === 'fulfilled' && escrowRes.value.success === true;
      const x402Ok = x402Res.status === 'fulfilled';
      expect(escrowOk && x402Ok, `run ${i}: both the 5 USDC job and the $0.40 payment passed a 5.2 limit`).toBe(false);
      expect(escrowOk || x402Ok, `run ${i}: neither passed`).toBe(true);
      if (escrowOk) outcomes.escrow++;
      if (x402Ok) outcomes.x402++;

      // What is committed never exceeds the limit: DailyVolume + counted x402 rows.
      const x402Rows = await db.resourcePayment.findMany({ where: { agentId: x.id, status: { in: ['reserved', 'pending', 'settled', 'unknown'] } } });
      const x402Usd = x402Rows.reduce((sum, row) => sum + Number(row.amount) / 1e6, 0);
      expect((await committedUsd(x.id)) + x402Usd).toBeLessThanOrEqual(5.2);
      expect(await committedUsd(x.id)).toBe(escrowOk ? 5 : 0);
      expect(await db.job.count({ where: { requesterId: x.id } })).toBe(escrowOk ? 1 : 0);
    }
    expect(outcomes.escrow + outcomes.x402).toBe(6);
  }, 120_000);

  it('deterministic overlap: an x402 payment started while the escrow reservation is open waits for it and is refused (no overshoot)', async () => {
    // Without the Agent lock this test fails: the x402 reserve reads the
    // committed DailyVolume (0, the job's increment is not committed yet),
    // passes, and both the 5 USDC job and the $0.40 payment land on a 5.2 limit.
    const server = await startResourceServer({ price: '$0.40' });
    open.push(server.close);
    const svc = new ResourcePaymentService({ db, wallet, client: new X402ClientService({ fetch: loopbackOnly(server.base) }) });
    const x = await mkAgent('overlap', { maxDailyVolumeUsd: '5.2' });
    const r = await mkAgent('overlap-r', null);
    const p = await mkAgent('overlap-p', null);
    const j = await db.job.create({
      data: { requesterId: r.id, providerId: x.id, status: 'ACCEPTED', payload: {}, reward: { amount: '1', token: 'USDC', chainId: 84532 } },
    });

    let x402: Promise<unknown> | null = null;
    const escrow = await reserveEscrowJobSpend({ requesterId: x.id, chainId: 84532, amount: '5', token: USDC, payee: p.safeAddress }, async (tx, res) => {
      // The reservation passed its check and holds the transaction open: the
      // x402 payment of the same agent starts now and is given 2.5 s to finish.
      x402 = svc.payForResource({ jobId: j.id, agentId: x.id, url: server.url, method: 'GET' }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([x402, new Promise((resolve) => setTimeout(resolve, 2_500))]);
      return tx.job.create({
        data: { requesterId: x.id, providerId: p.id, payload: {}, reward: { amount: '5', token: 'USDC', chainId: 84532 }, status: 'PENDING', reservedValueUsd: res.reservedValueUsd },
      });
    });
    expect(escrow).toMatchObject({ success: true, reservedValueUsd: '5' });
    const payment = (await x402!) as { ok: boolean; error?: { code?: string; details?: { rule?: string } } };
    expect(payment.ok).toBe(false);
    expect(payment.error).toMatchObject({ code: 'POLICY_VIOLATION', details: { rule: 'maxDailyVolume' } });
    expect(await committedUsd(x.id)).toBe(5);
    expect(await db.resourcePayment.count({ where: { agentId: x.id, status: { in: ['reserved', 'pending', 'settled'] } } })).toBe(0);
  }, 60_000);

  it('two escrow jobs of one agent racing near the limit: exactly one is created and reserved (looped)', async () => {
    for (let i = 0; i < 5; i++) {
      const x = await mkAgent(`twin${i}`, { maxDailyVolumeUsd: '8' });
      const p = await mkAgent(`twin-p${i}`, null);
      const [a, b] = await Promise.all([reserve(x.id, p.id, p.safeAddress, '5'), reserve(x.id, p.id, p.safeAddress, '5')]);
      expect([a.success, b.success].sort()).toEqual([false, true]);
      const refused = (a.success ? b : a) as { rule?: string; spentToday?: string };
      expect(refused).toMatchObject({ rule: 'maxDailyVolume', spentToday: '5' });
      expect(await committedUsd(x.id)).toBe(5);
      expect(await db.job.count({ where: { requesterId: x.id } })).toBe(1);
    }
  });

  it('a failing Job insert rolls the DailyVolume increment back; a refusal leaves nothing behind', async () => {
    const x = await mkAgent('rollback', { maxDailyVolumeUsd: '100', maxValuePerTxUsd: '1000' });
    const p = await mkAgent('rollback-p', null);
    await expect(
      reserveEscrowJobSpend({ requesterId: x.id, chainId: 84532, amount: '7', token: USDC, payee: p.safeAddress }, async () => {
        throw new Error('insert failed (constraint)');
      }),
    ).rejects.toThrow(/insert failed/);
    expect(await committedUsd(x.id)).toBe(0);

    const refused = await reserve(x.id, p.id, p.safeAddress, '150');
    expect(refused).toMatchObject({ success: false, rule: 'maxDailyVolume' });
    expect(await committedUsd(x.id)).toBe(0);
    expect(await db.job.count({ where: { requesterId: x.id } })).toBe(0);

    const ok = await reserve(x.id, p.id, p.safeAddress, '7');
    expect(ok).toMatchObject({ success: true, reservedValueUsd: '7' });
    expect(await committedUsd(x.id)).toBe(7);
  });

  it('two agents creating jobs for each other at the same time do not deadlock (looped)', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await mkAgent(`cross-a${i}`, { maxDailyVolumeUsd: '100' });
      const b = await mkAgent(`cross-b${i}`, { maxDailyVolumeUsd: '100' });
      const [ab, ba] = await Promise.all([reserve(a.id, b.id, b.safeAddress, '3'), reserve(b.id, a.id, a.safeAddress, '4')]);
      expect(ab).toMatchObject({ success: true });
      expect(ba).toMatchObject({ success: true });
      expect(await committedUsd(a.id)).toBe(3);
      expect(await committedUsd(b.id)).toBe(4);
    }
  });
});
