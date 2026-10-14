/**
 * C3e item 4 — the pre-submit guard's stale-bind skip on REAL Postgres.
 *
 * C3d (H14 dry-run) made the guard re-check a queued `setProviderAgentId`
 * right before signing (`vetBindBeforeBroadcast`: the job must still be live
 * and Funded) and mark it FAILED without broadcasting when it is not. That
 * FAILED write was unconditional. The vet reads the job and the chain, and a
 * stalled-job redelivery of the same BullMQ job can run concurrently: while
 * delivery A waits on its vet, delivery B (whose vet ran before the
 * cancellation) broadcasts the bind and writes SUBMITTED + txHash. A's FAILED
 * then overwrote a broadcast row, and the identity outcome ran as FAILED for
 * a transaction that may mine (the receipt monitor then never records it: its
 * write is conditional on SUBMITTED).
 *
 * Real: Postgres and the pre-submit guard with the real A6 / A6b row stops
 * (`stopStampedTransaction`). Faked: the ERC-8183 runtime (`vetBindBeforeBroadcast`
 * controlled by the test, `onEscrowTxOutcome` recorded), the finalizer, the
 * Q7 gate (verified).
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
  return {
    vet: null as null | ((jobId: string) => Promise<string | null>),
    outcomes: [] as Array<{ transactionId: string; status: string; error?: string | null }>,
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  vetBindBeforeBroadcast: (jobId: string) => (h.vet ? h.vet(jobId) : Promise.resolve(null)),
  onEscrowTxOutcome: async (outcome: { transactionId: string; status: string; error?: string | null }) => {
    h.outcomes.push(outcome);
  },
}));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: async () => undefined }));
vi.mock('../config/escrow-verification.runtime.js', () => ({
  escrowConfigGate: (chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }),
}));

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "broadcastTxHash" FROM "Transaction" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('bind-skip.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[bind-skip.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const NAME_PREFIX = 'c3e-bind';
const RUN = Date.now().toString(36);
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_STAMPED = `0x${'c'.repeat(64)}`;

describeDb('C3e item 4 — the stale-bind skip never overwrites a broadcast (Postgres)', () => {
  let db: PrismaClient;
  let guard: typeof import('../services/transaction/pre-submit-guard.js');
  let seq = 0;

  async function wipe() {
    const agents = { name: { startsWith: NAME_PREFIX } };
    await db.transaction.deleteMany({ where: { agent: agents } });
    await db.agent.deleteMany({ where: agents });
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    guard = await import('../services/transaction/pre-submit-guard.js');
    await wipe();
  });
  beforeEach(async () => {
    await wipe();
    h.vet = null;
    h.outcomes.length = 0;
  });
  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  async function queuedBind(extra: Record<string, unknown> = {}) {
    const walletId = `${NAME_PREFIX}-${RUN}-${++seq}`;
    const agent = await db.agent.create({
      data: { name: `${NAME_PREFIX} provider`, apiKeyHash: walletId, apiKeyPrefix: 'sim', walletId, safeAddress: privateKeyToAccount(generatePrivateKey()).address, chainIds: [84532] },
    });
    return db.transaction.create({
      data: {
        agentId: agent.id,
        type: 'ERC8004_IDENTITY',
        chainId: 84532,
        status: 'QUEUED',
        intentId: `erc8183:bindAgent:job-${RUN}-${seq}`,
        metadata: { jobId: `job-${RUN}-${seq}`, erc8183: true, erc8004: true, escrowStep: 'bindAgent' },
        ...extra,
      },
    });
  }

  it('delivery A vets a stale bind while delivery B broadcasts it: A leaves the SUBMITTED row alone and runs no FAILED outcome', async () => {
    const tx = await queuedBind();
    let releaseVet!: () => void;
    const vetDone = new Promise<void>((resolve) => (releaseVet = resolve));
    let vetEntered!: () => void;
    const inVet = new Promise<void>((resolve) => (vetEntered = resolve));
    h.vet = async () => {
      vetEntered(); // A has read the row (QUEUED, no hash) and is vetting
      await vetDone; // A's vet is slow (it reads the job and the chain)
      return 'job is CANCELLED / FUNDED — setProviderAgentId is only valid while the job is live and Funded';
    };

    const deliveryA = guard.preSubmitGuard(db, tx.id);
    await inVet;
    // Meanwhile delivery B (its vet ran before the cancellation) stamped, broadcast and recorded the bind.
    await db.transaction.update({ where: { id: tx.id }, data: { broadcastAttemptedAt: new Date(), broadcastAttempts: 1, broadcastTxHash: HASH_B } });
    await db.transaction.update({ where: { id: tx.id }, data: { status: 'SUBMITTED', txHash: HASH_B } });
    releaseVet();
    const decision = await deliveryA;

    expect(decision.action).toBe('skip');
    expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({ status: 'SUBMITTED', txHash: HASH_B, error: null });
    expect(h.outcomes).toEqual([]);
  });

  it('an earlier attempt of the bind was stamped (signed, maybe sent) and the job is now stale: handed to the chain, not FAILED', async () => {
    const tx = await queuedBind({ broadcastAttemptedAt: new Date(), broadcastAttempts: 1, broadcastTxHash: HASH_STAMPED });
    h.vet = async () => 'job is CANCELLED / FUNDED';

    const decision = await guard.preSubmitGuard(db, tx.id);

    expect(decision).toMatchObject({ action: 'skip', reason: expect.stringContaining(HASH_STAMPED) });
    expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({ status: 'SUBMITTED', txHash: HASH_STAMPED });
    expect(h.outcomes).toEqual([]);
  });

  it('control: a never-stamped stale bind is FAILED without a broadcast and the identity lane moves on (unchanged behaviour)', async () => {
    const tx = await queuedBind();
    h.vet = async () => 'job is CANCELLED / FUNDED';

    const decision = await guard.preSubmitGuard(db, tx.id);

    expect(decision).toMatchObject({ action: 'fail', reason: expect.stringContaining(guard.BIND_SKIPPED_BEFORE_SUBMISSION) });
    expect(await db.transaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({ status: 'FAILED', txHash: null });
    expect(h.outcomes).toEqual([expect.objectContaining({ transactionId: tx.id, status: 'FAILED' })]);
  });
});
