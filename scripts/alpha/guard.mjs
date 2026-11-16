/**
 * Destructive-target guard of the alpha demo (shared by scripts/alpha/demo.mjs; the same rules are enforced again,
 * independently, by the harness: packages/backend/src/__tests__/e2e/destructive-guard.ts).
 *
 * The demo RESETS (TRUNCATEs) a Postgres database and FLUSHES a Redis logical DB. Returns the problems that make a
 * target unsafe; an empty list means the target may be wiped.
 */
export const DEFAULT_DATABASE_URL = 'postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402';
export const DEFAULT_REDIS_URL = 'redis://localhost:6379/14';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_NAME = /e2e|demo|test/i;

export function destructiveProblems({ databaseUrl, redisUrl, allowRemote = false }) {
  const problems = [];
  let pg = null;
  let redis = null;
  try {
    pg = new URL(databaseUrl);
  } catch {
    problems.push(`X402_DEMO_DATABASE_URL is not a valid URL`);
  }
  try {
    redis = new URL(redisUrl);
  } catch {
    problems.push(`X402_DEMO_REDIS_URL is not a valid URL`);
  }
  if (pg) {
    const name = pg.pathname.replace(/^\//, '');
    if (!allowRemote && !LOOPBACK.has(pg.hostname)) problems.push(`Postgres host "${pg.hostname}" is not loopback (localhost, 127.0.0.1, ::1); set X402_DEMO_ALLOW_REMOTE=1 only if you really mean to wipe it`);
    if (name === 'agentfi') problems.push('database "agentfi" is the dev database and is never reset');
    else if (!TEST_NAME.test(name)) problems.push(`database name "${name || '(none)'}" does not contain e2e, demo or test: refusing to truncate it`);
  }
  if (redis) {
    const index = Number(redis.pathname.replace(/^\//, '') || '0');
    if (!allowRemote && !LOOPBACK.has(redis.hostname)) problems.push(`Redis host "${redis.hostname}" is not loopback; set X402_DEMO_ALLOW_REMOTE=1 only if you really mean to flush it`);
    if (!Number.isInteger(index) || index === 0) problems.push('Redis logical DB 0 is shared with the dev stack and is never flushed');
  }
  return problems;
}

export function isDefaultTarget(databaseUrl, redisUrl) {
  return databaseUrl === DEFAULT_DATABASE_URL && redisUrl === DEFAULT_REDIS_URL;
}

export function scopeBanner(databaseUrl, redisUrl) {
  const pg = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  return [
    '+------------------------------------------------------------------------------+',
    '| DESTRUCTIVE: this run will WIPE the following, then start its own processes   |',
    `|   Postgres  ${pg.hostname}:${pg.port || 5432}  database "${pg.pathname.replace(/^\//, '')}"  -> every table TRUNCATED`,
    `|   Redis     ${redis.hostname}:${redis.port || 6379}  logical DB ${redis.pathname.replace(/^\//, '') || '0'}  -> FLUSHDB`,
    '| Anything else you keep in them is lost. Use private targets (quickstart sec. 6). |',
    '+------------------------------------------------------------------------------+',
  ].join('\n');
}
