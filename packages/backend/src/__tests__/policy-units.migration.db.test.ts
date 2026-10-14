/**
 * Q8 — migration 0021 (`maxValuePerTxUsd`, `allowedRecipients`) tested on REAL
 * Postgres against rows that existed before it.
 *
 * The real migration files are applied with the real Prisma CLI
 * (`prisma migrate deploy`) to a scratch schema of the test database
 * (`?schema=q8mig_<tag>`, dropped afterwards):
 *   1. migrations 0001–0020 only (the database as it is before Q8);
 *   2. pre-Q8 policy rows are seeded with raw SQL: the server default, a custom
 *      ETH cap, non-decimal stored caps ("unlimited", "", "1e3" — which meant
 *      "no limit"), non-empty and empty `allowedContracts`, an expired policy
 *      and a paused one;
 *   3. migration 0021 is applied (`migrate deploy` again);
 *   4. the backfill is asserted row by row (exact text copies);
 *   5. behaviour: for every seeded row, the USDC spend verdicts (x402
 *      pay-resource and ERC-8183 escrow both call `evaluateUsdcSpend`) and the
 *      native-transfer verdicts (`PolicyService.validateTransaction`, the
 *      migrated row read through Prisma from the scratch schema) are identical
 *      before and after; the ONLY change is that an ERC-20 transfer to a
 *      recipient outside a non-empty (copied) list is now refused.
 *
 * "Before" verdicts: `evaluateUsdcSpendPreQ8` below is the pre-Q8 reading of
 * `usdc-spend-policy.ts` at 3a9f9df (per-tx = `maxValuePerTxEth` read in USD,
 * payee list = `allowedContracts`), copied verbatim in its decision order; a
 * pre-Q8 transaction verdict is `validateTransaction` on the pre-Q8 row
 * WITHOUT a recipient (Q8 added only the recipient check to it; the USD seam
 * is off).
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
import { getAddress, type Address } from 'viem';
import { evaluateUsdcSpend, policyDecimalToMicro } from '../services/policy/usdc-spend-policy.js';
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
  if (process.env['CI']) throw new Error('policy-units.migration.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[policy-units.migration.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

// ── Scratch schema + the real migration files ────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(here, '../db');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const SCHEMA = `q8mig_${randomBytes(4).toString('hex')}`;
const MIGRATION = '0021_q8_policy_units';

function scratchUrl(): string {
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('schema', SCHEMA);
  return url.toString();
}

/** A temp copy of schema.prisma + migration_lock.toml + the given migrations. */
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

// ── Seeded pre-Q8 rows ───────────────────────────────────────────────────────

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000B2';
const STRANGER = '0x00000000000000000000000000000000000000c3';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NOW = new Date();

type Seed = {
  key: string;
  /** Pre-Q8 columns; omitted ones take the 0020 database defaults. */
  columns: Partial<{
    maxValuePerTxEth: string;
    maxDailyVolumeUsd: string;
    allowedContracts: string[];
    allowedTokens: string[];
    active: boolean;
    expiresAt: Date;
    pausedByOperatorAt: Date;
    cooldownSeconds: number;
  }>;
};

const SEEDS: Seed[] = [
  { key: 'default', columns: {} },
  { key: 'custom-eth-cap', columns: { maxValuePerTxEth: '0.25', allowedContracts: [A, B] } },
  { key: 'big-cap-empty-list', columns: { maxValuePerTxEth: '5', allowedContracts: [] } },
  { key: 'non-decimal-unlimited', columns: { maxValuePerTxEth: 'unlimited', allowedContracts: [A] } },
  { key: 'non-decimal-empty', columns: { maxValuePerTxEth: '' } },
  { key: 'non-decimal-exponent', columns: { maxValuePerTxEth: '1e3', allowedTokens: [USDC] } },
  { key: 'expired', columns: { expiresAt: new Date(NOW.getTime() - 60_000), allowedContracts: [A] } },
  { key: 'paused', columns: { active: false, pausedByOperatorAt: new Date(NOW.getTime() - 60_000), allowedContracts: [B] } },
  { key: 'daily-limited', columns: { maxValuePerTxEth: '3', maxDailyVolumeUsd: '4', allowedContracts: [A] } },
];

type PreRow = {
  agentId: string;
  maxValuePerTxEth: string;
  maxValueForAutoApprovalEth: string;
  maxDailyVolumeUsd: string;
  allowedContracts: string[];
  allowedTokens: string[];
  cooldownSeconds: number;
  active: boolean;
  expiresAt: Date | null;
  pausedByOperatorAt: Date | null;
  updatedAt: Date;
};

/**
 * Pre-Q8 reading of `evaluateUsdcSpend` (usdc-spend-policy.ts at 3a9f9df),
 * same decision order: paused, expired, allowedTokens, allowedContracts as the
 * payee list, `maxValuePerTxEth` read in USD, daily limit.
 */
function evaluateUsdcSpendPreQ8(
  policy: PreRow,
  request: { amount: bigint; token: string; payee: string; spentTodayMicroUsd: bigint; now: Date },
): { allowed: true } | { allowed: false; rule: string } {
  const listed = (list: string[], address: string) => list.some((e) => e.toLowerCase() === address.toLowerCase());
  if (!policy.active) return { allowed: false, rule: 'policyPaused' };
  if (policy.expiresAt && policy.expiresAt < request.now) return { allowed: false, rule: 'policyExpired' };
  if (policy.allowedTokens.length > 0 && !listed(policy.allowedTokens, request.token)) return { allowed: false, rule: 'allowedTokens' };
  if (policy.allowedContracts.length > 0 && !listed(policy.allowedContracts, request.payee)) return { allowed: false, rule: 'allowedContracts' };
  const perTx = policyDecimalToMicro(policy.maxValuePerTxEth);
  if (perTx !== null && request.amount > perTx) return { allowed: false, rule: 'maxValuePerTx' };
  const daily = policyDecimalToMicro(policy.maxDailyVolumeUsd);
  if (daily !== null && daily > 0n && request.spentTodayMicroUsd + request.amount > daily) return { allowed: false, rule: 'maxDailyVolume' };
  return { allowed: true };
}

/** The Q8 rename of the two refusal rules; every other rule keeps its name. */
const RENAMED: Record<string, string> = { maxValuePerTx: 'maxValuePerTxUsd', allowedContracts: 'allowedRecipients' };

function serviceOver(row: Partial<AgentPolicy>): PolicyService {
  const db = {
    agentPolicy: { findUnique: async () => row },
    dailyVolume: { findUnique: async () => null },
    resourcePayment: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return new PolicyService(db);
}

describeDb('migration 0021 (Q8) on Postgres, against rows that existed before it', () => {
  let dir: string;
  let scratch: PrismaClient;
  const agentIds = new Map<string, string>();
  const pre = new Map<string, PreRow>();
  const post = new Map<string, AgentPolicy>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'q8-migration-'));
    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });

    // 1. The database before Q8: 0001–0020.
    migrationsDir(dir, (name) => name < MIGRATION);
    migrateDeploy(dir);
    const before = await scratch.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'AgentPolicy'`,
    );
    const columns = before.map((c) => c.column_name);
    expect(columns).toContain('maxValuePerTxEth');
    expect(columns).not.toContain('maxValuePerTxUsd');
    expect(columns).not.toContain('allowedRecipients');

    // 2. Pre-Q8 rows, written with raw SQL (the generated client already has the Q8 columns).
    for (const [i, seed] of SEEDS.entries()) {
      const agentId = `q8mig-agent-${i}`;
      agentIds.set(seed.key, agentId);
      await scratch.$executeRawUnsafe(
        `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
         VALUES ($1, $2, $3, 'agfi_live_q8', $4, $5, NOW())`,
        agentId,
        `q8 ${seed.key}`,
        `q8-hash-${i}`,
        `q8-wallet-${i}`,
        `0x${(0xa000 + i).toString(16).padStart(40, '0')}`,
      );
      const cols: string[] = ['"id"', '"agentId"', '"updatedAt"'];
      const values: unknown[] = [`q8mig-policy-${i}`, agentId, NOW];
      for (const [column, value] of Object.entries(seed.columns)) {
        cols.push(`"${column}"`);
        values.push(value);
      }
      const placeholders = values.map((_, n) => {
        const column = cols[n]!.replaceAll('"', '');
        if (column === 'allowedContracts' || column === 'allowedTokens') return `$${n + 1}::text[]`;
        return `$${n + 1}`;
      });
      await scratch.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."AgentPolicy" (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, ...values);
    }
    const preRows = await scratch.$queryRawUnsafe<PreRow[]>(`SELECT * FROM "${SCHEMA}"."AgentPolicy"`);
    for (const seed of SEEDS) {
      const row = preRows.find((r) => r.agentId === agentIds.get(seed.key));
      if (!row) throw new Error(`seed ${seed.key} missing`);
      pre.set(seed.key, row);
    }

    // 3. Apply 0021 — the real file, through the real CLI.
    migrationsDir(dir, () => true);
    const out = migrateDeploy(dir);
    expect(out).toContain(MIGRATION);

    // Read the migrated rows through the generated client (it matches the post-0021 schema).
    for (const seed of SEEDS) {
      post.set(seed.key, await scratch.agentPolicy.findUniqueOrThrow({ where: { agentId: agentIds.get(seed.key)! } }));
    }
  }, 180_000);

  afterAll(async () => {
    if (scratch) {
      await scratch.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
      await scratch.$disconnect();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('backfills every existing row exactly: maxValuePerTxUsd = maxValuePerTxEth (text), allowedRecipients = allowedContracts', () => {
    for (const seed of SEEDS) {
      const before = pre.get(seed.key)!;
      const after = post.get(seed.key)!;
      expect(after.maxValuePerTxUsd, seed.key).toBe(before.maxValuePerTxEth);
      expect(after.allowedRecipients, seed.key).toEqual(before.allowedContracts);
      // Nothing else moved.
      expect(after.maxValuePerTxEth, seed.key).toBe(before.maxValuePerTxEth);
      expect(after.allowedContracts, seed.key).toEqual(before.allowedContracts);
      expect(after.allowedTokens, seed.key).toEqual(before.allowedTokens);
      expect(after.maxDailyVolumeUsd, seed.key).toBe(before.maxDailyVolumeUsd);
      expect(after.active, seed.key).toBe(before.active);
      expect(after.expiresAt?.getTime() ?? null, seed.key).toBe(before.expiresAt?.getTime() ?? null);
      expect(after.pausedByOperatorAt?.getTime() ?? null, seed.key).toBe(before.pausedByOperatorAt?.getTime() ?? null);
    }
    // The non-decimal values are copied as text (still "unlimited", never converted).
    expect(post.get('non-decimal-unlimited')!.maxValuePerTxUsd).toBe('unlimited');
    expect(post.get('non-decimal-empty')!.maxValuePerTxUsd).toBe('');
    expect(post.get('non-decimal-exponent')!.maxValuePerTxUsd).toBe('1e3');
    expect(post.get('default')!.maxValuePerTxUsd).toBe('1.0');
    expect(post.get('custom-eth-cap')!.allowedRecipients).toEqual([A, B]);
  });

  it('a row created after 0021 without the new fields gets maxValuePerTxUsd "1.0" and no recipient restriction', async () => {
    await scratch.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."Agent" ("id", "name", "apiKeyHash", "apiKeyPrefix", "walletId", "safeAddress", "updatedAt")
       VALUES ('q8mig-new', 'q8 new', 'q8-hash-new', 'agfi_live_q8', 'q8-wallet-new', '0x000000000000000000000000000000000000beef', NOW())`,
    );
    const created = await scratch.agentPolicy.create({ data: { agentId: 'q8mig-new', maxValuePerTxEth: '7', allowedContracts: [A] } });
    expect(created.maxValuePerTxUsd).toBe('1.0'); // the column default, never the ETH number
    expect(created.allowedRecipients).toEqual([]);
  });

  it('USDC spends (x402 pay-resource and ERC-8183 escrow): the same verdict for every row before and after', () => {
    const amounts = [1n, 249_999n, 250_000n, 250_001n, 999_999n, 1_000_000n, 1_000_001n, 3_000_000n, 3_000_001n, 5_000_000n, 5_000_001n, 10n ** 12n];
    const payees = [A, B, B.toLowerCase(), STRANGER];
    const spentToday = [0n, 1_500_000n];
    let compared = 0;
    for (const seed of SEEDS) {
      for (const amount of amounts) {
        for (const payee of payees) {
          for (const spent of spentToday) {
            const before = evaluateUsdcSpendPreQ8(pre.get(seed.key)!, { amount, token: USDC, payee, spentTodayMicroUsd: spent, now: NOW });
            const after = evaluateUsdcSpend(post.get(seed.key)!, { amount, token: USDC, recipient: payee, spentTodayMicroUsd: spent, now: NOW });
            const label = `${seed.key} amount=${amount} payee=${payee} spent=${spent}`;
            expect(after.allowed, label).toBe(before.allowed);
            if (!before.allowed && !after.allowed) expect(after.rule, label).toBe(RENAMED[before.rule] ?? before.rule);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(SEEDS.length * amounts.length * payees.length * spentToday.length);
  });

  it('native ETH transfers: the same verdict for every row before and after (their `to` was already the checked call target)', async () => {
    const values = ['0', '0.1', '0.25', '0.26', '1', '1.01', '5', '6', '2000'];
    const recipients = [A, getAddress(B), STRANGER] as Address[];
    for (const seed of SEEDS) {
      const before = serviceOver({ ...pre.get(seed.key)! });
      const after = new PolicyService(scratch); // reads the migrated row from Postgres
      for (const valueEth of values) {
        for (const to of recipients) {
          const label = `${seed.key} ${valueEth} ETH to ${to}`;
          const was = await before.validateTransaction({ agentId: agentIds.get(seed.key)!, targetContract: to, valueEth });
          const now = await after.validateTransaction({ agentId: agentIds.get(seed.key)!, targetContract: to, recipient: to, valueEth });
          expect(now.allowed, label).toBe(was.allowed);
          expect(now.requiresApproval ?? false, label).toBe(was.requiresApproval ?? false);
        }
      }
    }
  });

  it('the one narrowing: an ERC-20 transfer to a recipient outside a non-empty copied list is now refused', async () => {
    const changed: string[] = [];
    for (const seed of SEEDS) {
      const row = pre.get(seed.key)!;
      // The token contract must be an allowed call target, as before (unchanged).
      const token = (row.allowedContracts[0] ?? USDC) as Address;
      const before = serviceOver({ ...row });
      const after = new PolicyService(scratch);
      for (const to of [A, getAddress(B), STRANGER] as Address[]) {
        const was = await before.validateTransaction({ agentId: agentIds.get(seed.key)!, targetContract: token, tokenAddress: token, valueEth: '0' });
        const now = await after.validateTransaction({
          agentId: agentIds.get(seed.key)!,
          targetContract: token,
          tokenAddress: token,
          recipient: to,
          valueEth: '0',
        });
        if (was.allowed !== now.allowed) {
          // Only ever a narrowing, and only for a non-empty list that does not name the recipient.
          expect(was.allowed).toBe(true);
          expect(now.reason).toMatch(/allowed recipients whitelist/);
          expect(row.allowedContracts.length).toBeGreaterThan(0);
          expect(row.allowedContracts.map((c) => c.toLowerCase())).not.toContain(to.toLowerCase());
          changed.push(`${seed.key}:${to}`);
        }
      }
    }
    // Rows with an empty allowedContracts never change; the listed ones refuse exactly their strangers.
    expect(changed.sort()).toEqual(
      [
        `custom-eth-cap:${STRANGER}`,
        `daily-limited:${getAddress(B)}`,
        `daily-limited:${STRANGER}`,
        `non-decimal-unlimited:${getAddress(B)}`,
        `non-decimal-unlimited:${STRANGER}`,
      ].sort(),
    );
  });
});
