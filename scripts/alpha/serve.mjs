#!/usr/bin/env node
/**
 * `npm run alpha:serve -- --out-dir <dir> [--stop-file <file>] [--yes]` — starts the REAL LOCAL BACKEND of the fork
 * demo and keeps it running for an agent framework (`npm run demo:x402:serve` in packages/backend), with the same
 * destructive-target rules as `alpha:demo`: refused targets stop here, the banner says what will be wiped, and
 * non-default targets need --yes (or typing "wipe"). Relative paths are resolved against the directory you ran npm in.
 * Stop it with Ctrl+C or by creating the stop file (default <out-dir>/stop).
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmWipe } from './confirm.mjs';
import { DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL, destructiveProblems } from './guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'packages', 'backend');
const DATABASE_URL = process.env.X402_DEMO_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
const REDIS_URL = process.env.X402_DEMO_REDIS_URL?.trim() || DEFAULT_REDIS_URL;
const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
// npm sets INIT_CWD to the directory the user ran `npm run` in.
const base = process.env.INIT_CWD || process.cwd();

const problems = destructiveProblems({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, allowRemote: process.env.X402_DEMO_ALLOW_REMOTE === '1' });
if (problems.length > 0) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log('Nothing was started (quickstart section 6).');
  process.exitCode = 2;
} else if (!value('--out-dir')) {
  console.log('usage: npm run alpha:serve -- --out-dir <dir> [--stop-file <file>] [--yes]');
  process.exitCode = 2;
} else if (!(await confirmWipe({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, assumeYes: argv.includes('--yes') }))) {
  process.exitCode = 4;
} else {
  const outDir = resolve(base, value('--out-dir'));
  const stopFile = value('--stop-file') ? resolve(base, value('--stop-file')) : join(outDir, 'stop');
  const child =
    process.platform === 'win32'
      ? spawn(`npm run demo:x402:serve -- --out-dir "${outDir}" --stop-file "${stopFile}"`, { cwd: BACKEND, shell: true, stdio: 'inherit', env: process.env })
      : spawn('npm', ['run', 'demo:x402:serve', '--', '--out-dir', outDir, '--stop-file', stopFile], { cwd: BACKEND, stdio: 'inherit', env: process.env });
  // Ctrl+C already reaches the whole foreground process group (and the console on Windows): serve stops itself, so
  // only wait for it (forwarding SIGINT would deliver it twice). A SIGTERM sent to this process alone is forwarded.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
