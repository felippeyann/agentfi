/**
 * A6b — migration 0024 (`Transaction.broadcastTxHash`) tested on REAL Postgres
 * against rows that existed before it.
 *
 * The real migration files are applied with the real Prisma CLI
 * (`prisma migrate deploy`) to a scratch schema of the test database
 * (`?schema=a6bmig_<tag>`, dropped afterwards), as the Q8 migration test does:
 *   1. every migration before 0024;
 *   2. pre-0024 Transaction rows in each state the A6 code leaves them, written
 *      with raw SQL: QUEUED never stamped, QUEUED stamped (an attempt threw
 *      after its stamp, BullMQ retrying), a legacy A2A payment QUEUED and
 *      stamped, SUBMITTED, FAILED + HELD, CONFIRMED + COMMITTED;
 *   3. 0024 applied;
 *   4. every existing column of every row is unchanged and the new column is
 *      NULL (no backfill: the hash of an attempt stamped before 0024 is
 *      unknown);
 *   5. behaviour of the A6b code on those rows: a row stamped before 0024
 *      cannot be handed to the chain (no hash) — it is FAILED with its
 *      reservation HELD (counted), never released; a never-stamped row still
 *      fails normally; a row stamped after 0024 (hash recorded) is handed to
 *      the chain; a SUBMITTED row is left alone.
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
import {
  markBroadcastAttempt,
  settleVolumeAfterFailure,
  stopStampedTransaction,
} from '../services/policy/daily-volume.js';

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
  if (process.env['CI']) throw new Error('broadcast-tx-hash.migration.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[broadcast-tx-hash.migration.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(here, '../db');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const SCHEMA = `a6bmig_${randomBytes(4).toString('hex')}`;
const MIGRATION = '0024_a6b_broadcast_tx_hash';
const AGENT = 'a6bmig-agent';
const TODAY = new Date().toISOString().slice(0, 10);
const OLD_HASH = keccak256(toHex('a6bmig-submitted'));

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

/** Pre-0024 rows: id → the SQL values of the columns that differ from the defaults. */
const SEEDS: Record<string, string> = {
  'queued-fresh': `'QUEUED', NULL, 0, NULL, 'RESERVED', NULL`,
  'queued-stamped': `'QUEUED', NULL, 1, NOW() - INTERVAL '5 minutes', 'RESERVED', NULL`,
  'a2a-queued-stamped': `'QUEUED', NULL, 1, NOW() - INTERVAL '5 minutes', NULL, '{"a2aPayment": true, "jobId": "a6bmig-job"}'::jsonb`,
  submitted: `'SUBMITTED', '${OLD_HASH}', 1, NOW() - INTERVAL '5 minutes', 'RESERVED', NULL`,
  'failed-held': `'FAILED', NULL, 2, NOW() - INTERVAL '1 hour', 'HELD', NULL`,
  confirmed: `'CONFIRMED', '${keccak256(toHex('a6bmig-confirmed'))}', 1, NOW() - INTERVAL '1 hour', 'COMMITTED', NULL`,
};

type Row = Record<string, unknown>;

describeDb('migration 0024 (A6b) on Postgres, against rows that existed before it', () => {
  let dir: string;
  let scratch: PrismaClient;
  const before = new Map<string, Row>();
  const after = new Map<string, Row>();

  const volume = async () =>
    Number(
      (await scratch.$queryRawUnsafe<Array<{ volumeUsd: string }>>(`SELECT "volumeUsd" FROM "${SCHEMA}"."DailyVolume" WHERE "agentId" = $1 AND "date" = $2`, AGENT, TODAY))[0]
        ?.volumeUsd ?? '0',
    );
  const status = async (id: string) =>
    (await scratch.$queryRawUnsafe<Array<{ status: string; txHash: string | null; volumeState: string | null }>>(
      `SELECT "status"::text AS "status", "txHash", "volumeState"::text AS "volumeState" FROM "${SCHEMA}"."Transaction" WHERE "id" = $1`,
      id,
    ))[0];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'a6b-migration-'));
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });

    // 1. Everything before 0024.
    migrationsDir(dir, (name) => name < MIGRATION);
    migrateDeploy(dir);
    const columns = (
      await scratch.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'Transaction'`,
      )
    ).map((c) => c.column_name);
    expect(columns).toContain('broadcastAttempts');
    expect(columns).not.toContain('broadcastTxHash');

    // 2. Pre-0024 rows (raw SQL: the generated client already has the column).
    await scratch.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
       VALUES ($1, 'a6b migration', 'a6bmig-hash', 'agfi_live_a6b', 'a6bmig-wallet', '0x000000000000000000000000000000000000a6b0', NOW())`,
      AGENT,
    );
    // 20 USD reserved by each RESERVED/HELD/COMMITTED row (4 × 20 = 80 counted today).
    await scratch.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."DailyVolume" ("id", "agentId", "date", "volumeUsd", "updatedAt") VALUES ('a6bmig-dv', $1, $2, '100.000000', NOW())`,
      AGENT,
      TODAY,
    );
    for (const [id, values] of Object.entries(SEEDS)) {
      await scratch.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."Transaction"
           ("id", "agentId", "chainId", "type", "status", "txHash", "broadcastAttempts", "broadcastAttemptedAt", "volumeState", "metadata",
            "volumeReservedUsd", "volumeReservedDate", "updatedAt")
         VALUES ($1, $2, 84532, 'TRANSFER', ${values},
                 CASE WHEN $1 = 'a2a-queued-stamped' THEN NULL ELSE '20.000000' END,
                 CASE WHEN $1 = 'a2a-queued-stamped' THEN NULL ELSE $3 END, NOW())`,
        id,
        AGENT,
        TODAY,
      );
    }
    for (const row of await scratch.$queryRawUnsafe<Row[]>(`SELECT * FROM "${SCHEMA}"."Transaction"`)) before.set(row['id'] as string, row);

    // 3. Apply 0024 — the real file, through the real CLI. A fresh client
    // afterwards: Postgres refuses a cached `SELECT *` plan whose columns changed.
    migrationsDir(dir, () => true);
    expect(migrateDeploy(dir)).toContain(MIGRATION);
    await scratch.$disconnect();
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });
    for (const row of await scratch.$queryRawUnsafe<Row[]>(`SELECT * FROM "${SCHEMA}"."Transaction"`)) after.set(row['id'] as string, row);
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
      expect(row['broadcastTxHash'], id).toBeNull();
      const { broadcastTxHash: _added, ...rest } = row;
      expect(rest, id).toEqual(before.get(id));
    }
  });

  it('a row stamped before 0024 (no hash) cannot be handed to the chain: FAILED with its reservation HELD, never released', async () => {
    const counted = await volume();
    const stop = await stopStampedTransaction(scratch, 'queued-stamped', 'Agent paused before submission', { handToChain: true });
    expect(stop).toEqual({ outcome: 'failed', broadcastAttempted: true });
    expect(await settleVolumeAfterFailure(scratch, 'queued-stamped')).toBe('held');
    expect(await status('queued-stamped')).toEqual({ status: 'FAILED', txHash: null, volumeState: 'HELD' });
    expect(await volume()).toBeCloseTo(counted, 6);

    // The legacy A2A payment: FAILED, broadcastAttempted → its callers do not refund the job.
    expect(await stopStampedTransaction(scratch, 'a2a-queued-stamped', 'sendRawTransaction failed', { handToChain: true })).toEqual({
      outcome: 'failed',
      broadcastAttempted: true,
    });
  });

  it('a row stamped after 0024 records its signed hash and is handed to the chain with it', async () => {
    const hash = keccak256(toHex('a6bmig-new-attempt'));
    await markBroadcastAttempt(scratch, 'queued-fresh', hash);
    const stop = await stopStampedTransaction(scratch, 'queued-fresh', 'Agent paused before submission', { handToChain: true });
    expect(stop).toEqual({ outcome: 'handed-to-chain', txHash: hash });
    expect(await status('queued-fresh')).toEqual({ status: 'SUBMITTED', txHash: hash, volumeState: 'RESERVED' });
  });

  it('rows that already left QUEUED are not touched', async () => {
    for (const id of ['submitted', 'failed-held', 'confirmed']) {
      expect(await stopStampedTransaction(scratch, id, 'x', { handToChain: true }), id).toEqual({ outcome: 'not-queued' });
    }
    expect(await status('submitted')).toEqual({ status: 'SUBMITTED', txHash: OLD_HASH, volumeState: 'RESERVED' });
  });
});
