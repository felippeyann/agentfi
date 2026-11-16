/**
 * Guard for the harness operations that WIPE data (`resetTestDatabase` truncates every table,
 * `flushTestRedis` FLUSHDBs a logical DB). Same rules as `scripts/alpha/guard.mjs` (the wrapper
 * enforces them first; this is the independent second line when a script is run directly):
 * loopback host unless X402_DEMO_ALLOW_REMOTE=1, a database name containing e2e / demo / test
 * (and never `agentfi`), and a Redis logical DB other than 0.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function destructivePostgresProblem(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return 'database URL is not a valid URL';
  }
  const name = url.pathname.replace(/^\//, '');
  if (env['X402_DEMO_ALLOW_REMOTE'] !== '1' && !LOOPBACK.has(url.hostname)) {
    return `Postgres host "${url.hostname}" is not loopback; refusing to truncate it (X402_DEMO_ALLOW_REMOTE=1 overrides)`;
  }
  if (name === 'agentfi') return 'database "agentfi" is the dev database and is never reset';
  if (!/e2e|demo|test/i.test(name)) return `database name "${name || '(none)'}" does not contain e2e, demo or test; refusing to truncate it`;
  return null;
}

export function destructiveRedisProblem(redisUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    return 'Redis URL is not a valid URL';
  }
  if (env['X402_DEMO_ALLOW_REMOTE'] !== '1' && !LOOPBACK.has(url.hostname)) {
    return `Redis host "${url.hostname}" is not loopback; refusing to flush it (X402_DEMO_ALLOW_REMOTE=1 overrides)`;
  }
  const index = Number(url.pathname.replace(/^\//, '') || '0');
  if (!Number.isInteger(index) || index === 0) return 'Redis logical DB 0 is shared with the dev stack and is never flushed';
  return null;
}
