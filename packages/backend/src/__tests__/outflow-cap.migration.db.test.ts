/**
 * §5-6 — migration 0025 (`maxOutflowPerTxUsd`) tested on REAL Postgres
 * against rows that existed before it.
 *
 * The real migration files are applied with the real Prisma CLI
 * (`prisma migrate deploy`) to a scratch schema of the test database
 * (`?schema=q6mig_<tag>`, dropped afterwards):
 *   1. migrations 0001–0024 only (the database before §5-6);
 *   2. pre-0025 policy rows are seeded with raw SQL: the server defaults, a
 *      big ETH cap, a big USDC cap (`maxValuePerTxUsd`), non-decimal stored
 *      caps, lists, an expired and a paused policy, a daily-limited one;
 *   3. migration 0025 is applied;
 *   4. asserted: the new column is nullable with no default, NULL on every
 *      row (nothing inferred from the ETH or the USDC cap), and every other
 *      column of every row is byte-for-byte what it was;
 *   5. a row created after 0025 without the field is NULL too;
 *   6. behaviour of a migrated row: an ordinary outflow is refused
 *      USD_CAP_NOT_CONFIGURED, what is not an outflow is judged as before.
 *
 * Needs `DATABASE_URL` (migrated) and the right to create a schema. Skipped
 * (with a warning) when the database is unreachable locally; CI fails instead.
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
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, type AgentPolicy } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyService } from '../services/policy/policy.service.js';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "maxValuePerTxUsd" FROM "AgentPolicy" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}
const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('outflow-cap.migration.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[outflow-cap.migration.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(here, '../db');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const SCHEMA = `q6mig_${randomBytes(4).toString('hex')}`;
const MIGRATION = '0025_q6_outflow_usd_cap';

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

const A = '0x00000000000000000000000000000000000000a1';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NOW = new Date();

const SEEDS: Array<{ key: string; columns: Record<string, unknown> }> = [
  { key: 'default', columns: {} },
  { key: 'big-eth-cap', columns: { maxValuePerTxEth: '50', maxValuePerTxUsd: '50' } },
  { key: 'big-usdc-cap', columns: { maxValuePerTxEth: '0.01', maxValuePerTxUsd: '100000' } },
  { key: 'non-decimal-caps', columns: { maxValuePerTxEth: 'unlimited', maxValuePerTxUsd: '' } },
  { key: 'lists', columns: { allowedContracts: [A], allowedRecipients: [A], allowedTokens: [USDC] } },
  { key: 'expired', columns: { expiresAt: new Date(NOW.getTime() - 60_000) } },
  { key: 'paused', columns: { active: false, pausedByOperatorAt: new Date(NOW.getTime() - 60_000) } },
  { key: 'daily-limited', columns: { maxDailyVolumeUsd: '4', cooldownSeconds: 0 } },
];

function serviceOver(row: Partial<AgentPolicy>): PolicyService {
  const db = {
    agentPolicy: { findUnique: async () => row },
    dailyVolume: { findUnique: async () => null },
    resourcePayment: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return new PolicyService(db);
}

describeDb('migration 0025 (§5-6) on Postgres, against rows that existed before it', () => {
  let dir: string;
  let scratch: PrismaClient;
  const agentIds = new Map<string, string>();
  const pre = new Map<string, Record<string, unknown>>();
  const post = new Map<string, Record<string, unknown>>();

  // Distinct SQL text per phase: a cached prepared plan of the same text must not change result type across the ALTER.
  const rawRows = async (phase: string) =>
    scratch.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${SCHEMA}"."AgentPolicy" ORDER BY "agentId" /* ${phase} */`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'q6-migration-'));
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });

    // 1. Before §5-6: 0001–0024.
    migrationsDir(dir, (name) => name < MIGRATION);
    migrateDeploy(dir);

    // 2. Pre-0025 rows (raw SQL: the generated client already has the new column).
    for (const [i, seed] of SEEDS.entries()) {
      const agentId = `q6mig-agent-${i}`;
      agentIds.set(seed.key, agentId);
      await scratch.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
         VALUES ($1, $2, $3, 'agfi_live_q6', $4, $5, NOW())`,
        agentId,
        `q6 ${seed.key}`,
        `q6-hash-${i}`,
        `q6-wallet-${i}`,
        `0x${(0xb000 + i).toString(16).padStart(40, '0')}`,
      );
      const cols: string[] = ['"id"', '"agentId"', '"updatedAt"'];
      const values: unknown[] = [`q6mig-policy-${i}`, agentId, NOW];
      for (const [column, value] of Object.entries(seed.columns)) {
        cols.push(`"${column}"`);
        values.push(value);
      }
      const placeholders = values.map((_, n) => {
        const column = cols[n]!.replaceAll('"', '');
        return ['allowedContracts', 'allowedRecipients', 'allowedTokens'].includes(column) ? `$${n + 1}::text[]` : `$${n + 1}`;
      });
      await scratch.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."AgentPolicy" (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, ...values);
    }
    for (const row of await rawRows('pre')) {
      expect(row).not.toHaveProperty('maxOutflowPerTxUsd');
      pre.set(String(row['agentId']), row);
    }

    // 3. Apply 0025 — the real file, through the real CLI.
    migrationsDir(dir, () => true);
    const out = migrateDeploy(dir);
    expect(out).toContain(MIGRATION);
    for (const row of await rawRows('post')) post.set(String(row['agentId']), row);
  }, 180_000);

  afterAll(async () => {
    if (scratch) {
      await scratch.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
      await scratch.$disconnect();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('adds a nullable TEXT column with no default', async () => {
    const [column] = await scratch.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = '${SCHEMA}' AND table_name = 'AgentPolicy' AND column_name = 'maxOutflowPerTxUsd'`,
    );
    expect(column).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
  });

  it('every existing row is NULL — nothing inferred from maxValuePerTxEth or maxValuePerTxUsd — and every other column is unchanged', () => {
    expect(post.size).toBe(SEEDS.length);
    for (const seed of SEEDS) {
      const id = agentIds.get(seed.key)!;
      const { maxOutflowPerTxUsd, ...rest } = post.get(id)!;
      expect(maxOutflowPerTxUsd, seed.key).toBeNull();
      expect(rest, seed.key).toEqual(pre.get(id));
    }
  });

  it('a row created after 0025 without the field is NULL as well', async () => {
    await scratch.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
       VALUES ('q6mig-new', 'q6 new', 'q6-hash-new', 'agfi_live_q6', 'q6-wallet-new', '0x000000000000000000000000000000000000cafe', NOW())`,
    );
    const created = await scratch.agentPolicy.create({ data: { agentId: 'q6mig-new', maxValuePerTxEth: '7', maxValuePerTxUsd: '7' } });
    expect(created.maxOutflowPerTxUsd).toBeNull();
  });

  it('a migrated row blocks ordinary outflows (USD_CAP_NOT_CONFIGURED) and judges everything else as before', async () => {
    const migrated = await scratch.agentPolicy.findUniqueOrThrow({ where: { agentId: agentIds.get('big-usdc-cap')! } });
    const svc = serviceOver(migrated);
    const priced = { status: 'priced' as const, usd: '5.000000', source: 'oracle' as const };
    await expect(
      svc.validateTransaction({ agentId: migrated.agentId, targetContract: A as `0x${string}`, valueEth: '0', pricing: priced, outflow: true }),
    ).resolves.toMatchObject({ allowed: false, code: 'USD_CAP_NOT_CONFIGURED' });
    // A withdrawal (not an outflow) is judged by the pre-0025 rules only.
    await expect(
      svc.validateTransaction({ agentId: migrated.agentId, targetContract: A as `0x${string}`, valueEth: '0', valueUsd: '5', pricing: priced }),
    ).resolves.toMatchObject({ allowed: true });
  });
});
