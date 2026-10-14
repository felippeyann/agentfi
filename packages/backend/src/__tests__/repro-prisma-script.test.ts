/**
 * `scripts/repro-prisma-worker-thread-crash.mjs` (item 7, #184) must not
 * report a failed run as a clean one (review of #184, P2): in the
 * `proc-disconnect` control a child that fails (a query error, a native
 * crash, a signal) ended its lifecycle like a clean one, the parent printed
 * "all workers completed" and exited 0.
 *
 * Reproduced without a database: the child's Prisma client is pointed at a
 * port nothing listens on, so its first query fails and the child exits 1.
 * Only child PROCESSES load Prisma here (never a worker thread).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/repro-prisma-worker-thread-crash.mjs');
const UNREACHABLE_DB = 'postgresql://agentfi:agentfi@127.0.0.1:1/agentfi_unreachable?connect_timeout=5';

function run(args: string[], databaseUrl: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 90_000,
  });
}

describe('repro-prisma-worker-thread-crash.mjs reports failed lifecycles (review of #184)', () => {
  it('proc-disconnect: a child that exits non-zero makes the run fail — no "all workers completed", exit code non-zero', () => {
    const result = run(['2', 'proc-disconnect'], UNREACHABLE_DB);

    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.stdout).toMatch(/workers=2 mode=proc-disconnect/);
    expect(result.stdout).not.toMatch(/all workers completed/);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr.slice(-2000)}`).not.toBe(0);
  }, 120_000);
});
