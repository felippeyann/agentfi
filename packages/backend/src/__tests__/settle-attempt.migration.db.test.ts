/**
 * C3e item 2 — migration 0023 (`Job.settleAttemptAt`) tested on REAL Postgres
 * against rows that existed before it.
 *
 * Same method as the Q8 / A6b migration tests: the real migration files are
 * applied with the real Prisma CLI (`prisma migrate deploy`) to a scratch
 * schema of the test database (`?schema=c3emig_<tag>`, dropped afterwards):
 *   1. every migration before 0023;
 *   2. pre-0023 escrow Job rows in the states the C3d code leaves them, written
 *      with raw SQL: SUBMITTED without a settlement, SUBMITTED with a reverted
 *      settlement hash, CONTESTED, SETTLING with an operator decision,
 *      COMPLETED, and a free (non-escrow) job;
 *   3. 0023 applied (only it);
 *   4. every existing column of every row is unchanged and the new column is
 *      NULL (no backfill);
 *   5. behaviour on the migrated rows: with no stamp the operator decision
 *      follows today's rule (resolvable when no settlement can mine); a stamp
 *      written after 0023 makes the same row "settlement in progress".
 *
 * Skipped (with a warning) when the database is unreachable locally; CI fails.
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
});

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { resolveEscrowJob, type Erc8183Deps } from '../services/job/escrow-erc8183.service.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "settleAttemptAt" FROM "Job" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('settle-attempt.migration.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[settle-attempt.migration.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(here, '../db');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const SCHEMA = `c3emig_${randomBytes(4).toString('hex')}`;
const MIGRATION = '0023_c3e_settle_attempt';
const REVERTED = keccak256(toHex('c3emig-reverted-settlement'));

function scratchUrl(): string {
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('schema', SCHEMA);
  return url.toString();
}

function migrationsDir(dir: string, upTo: (name: string) => boolean): void {
  copyFileSync(join(DB_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  copyFileSync(join(DB_DIR, 'migrations', 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
  for (const name of readdirSync(join(DB_DIR, 'migrations'))) {
    if (!/^\d{4}_/.test(name) || !upTo(name)) continue;
    cpSync(join(DB_DIR, 'migrations', name), join(dir, 'migrations', name), { recursive: true });
  }
}

function migrateDeploy(dir: string): string {
  return execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
    env: { ...process.env, DATABASE_URL: scratchUrl(), PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Pre-0023 Job rows: id → status, onChainStatus, settleTxHash, contestedAt, resolution, escrowKind. */
const SEEDS: Record<string, string> = {
  'submitted-fresh': `'PAYMENT_PENDING', 'SUBMITTED', NULL, NULL, NULL, 'erc8183'`,
  'submitted-reverted': `'PAYMENT_PENDING', 'SUBMITTED', '${REVERTED}', NULL, NULL, 'erc8183'`,
  contested: `'PAYMENT_PENDING', 'CONTESTED', NULL, NOW() - INTERVAL '10 minutes', NULL, 'erc8183'`,
  'settling-decided': `'PAYMENT_PENDING', 'SETTLING', NULL, NOW() - INTERVAL '10 minutes', 'refund', 'erc8183'`,
  completed: `'COMPLETED', 'COMPLETED', '${keccak256(toHex('c3emig-complete'))}', NULL, NULL, 'erc8183'`,
  free: `'PENDING', NULL, NULL, NULL, NULL, NULL`,
};

type Row = Record<string, unknown>;

describeDb('migration 0023 (C3e) on Postgres, against rows that existed before it', () => {
  let dir: string;
  let scratch: PrismaClient;
  const before = new Map<string, Row>();
  const after = new Map<string, Row>();

  function deps(): Erc8183Deps {
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    return {
      db: scratch,
      queue: { add: async () => undefined } as never,
      settlement: { add: async () => undefined },
      // The chain still says Submitted; the one recorded settlement reverted.
      publicClient: () => ({ readContract: async () => ({ status: 2, budget: 1n }), getTransactionReceipt: async () => ({ status: 'reverted', logs: [] }) }) as never,
      evaluatorSigner: () => {
        throw new Error('no signing in this test');
      },
      config: { evaluatorAddress: null, jobTtlSeconds: 604_800, evaluationDelaySeconds: 0, backendPublicUrl: 'http://localhost:3000', chain: () => null },
      releaseJobEscrow: async () => undefined,
      finalize: async () => undefined,
      logger: quiet,
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'c3e-migration-'));
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });

    // 1. Everything before 0023.
    migrationsDir(dir, (name) => name < MIGRATION);
    migrateDeploy(dir);
    const columns = (
      await scratch.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'Job'`,
      )
    ).map((c) => c.column_name);
    expect(columns).toContain('settleTxHash');
    expect(columns).not.toContain('settleAttemptAt');

    // 2. Pre-0023 rows (raw SQL: the generated client already has the column).
    for (const [id, addr] of [
      ['c3emig-requester', '0x000000000000000000000000000000000000c3e1'],
      ['c3emig-provider', '0x000000000000000000000000000000000000c3e2'],
    ] as const) {
      await scratch.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
         VALUES ($1, $1, $1, 'agfi_live_c3e', $1, $2, NOW())`,
        id,
        addr,
      );
    }
    let onChainJobId = 0;
    for (const [id, values] of Object.entries(SEEDS)) {
      onChainJobId++;
      await scratch.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."Job"
           ("id", "requesterId", "providerId", "payload", "reward", "status", "onChainStatus", "settleTxHash", "contestedAt", "resolution", "escrowKind",
            "escrowChainId", "escrowContract", "onChainJobId", "updatedAt")
         VALUES ($1, 'c3emig-requester', 'c3emig-provider', '{}'::jsonb, '{}'::jsonb, ${values},
                 84532, '0x00000000000000000000000000000000000E5C20', $2, NOW())`,
        id,
        String(onChainJobId),
      );
    }
    for (const row of await scratch.$queryRawUnsafe<Row[]>(`SELECT * FROM "${SCHEMA}"."Job"`)) before.set(row['id'] as string, row);

    // 3. Apply 0023 only — the real file, through the real CLI; a fresh client afterwards.
    migrationsDir(dir, (name) => name <= MIGRATION);
    expect(migrateDeploy(dir)).toContain(MIGRATION);
    await scratch.$disconnect();
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });
    for (const row of await scratch.$queryRawUnsafe<Row[]>(`SELECT * FROM "${SCHEMA}"."Job"`)) after.set(row['id'] as string, row);
  }, 180_000);

  afterAll(async () => {
    if (scratch) {
      await scratch.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
      await scratch.$disconnect();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the column NULL on every existing row and changes nothing else', () => {
    expect([...after.keys()].sort()).toEqual(Object.keys(SEEDS).sort());
    for (const [id, row] of after) {
      expect(row['settleAttemptAt'], id).toBeNull();
      const { settleAttemptAt: _added, ...rest } = row;
      expect(rest, id).toEqual(before.get(id));
    }
  });

  it('without a stamp the C3d rule is unchanged: a contested job and one whose only settlement reverted are resolvable', async () => {
    for (const id of ['contested', 'submitted-reverted']) {
      expect(await resolveEscrowJob(deps(), { jobId: id, decision: 'refund', note: 'c3e migration', operator: 'ops' }), id).toMatchObject({
        outcome: 'scheduled',
      });
    }
  });

  it('a stamp written after 0023 (a settlement send not resolved yet) makes the same decision a 409 SETTLEMENT_IN_PROGRESS', async () => {
    await scratch.$executeRawUnsafe(`UPDATE "${SCHEMA}"."Job" SET "settleAttemptAt" = NOW() WHERE "id" = 'submitted-fresh'`);
    expect(await resolveEscrowJob(deps(), { jobId: 'submitted-fresh', decision: 'refund', note: 'c3e migration', operator: 'ops' })).toMatchObject({
      outcome: 'refused',
      code: 'SETTLEMENT_IN_PROGRESS',
      // G1 review P3-2: the stamp now goes with the signed hash; the message says a send is not resolved yet.
      message: expect.stringMatching(/settlement was being sent at .*it may still mine/),
    });
    expect((await scratch.job.findUniqueOrThrow({ where: { id: 'submitted-fresh' } })).resolution).toBeNull();
  });
});
