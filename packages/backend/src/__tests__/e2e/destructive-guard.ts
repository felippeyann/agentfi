/**
 * Guard for the harness operations that WIPE data (`resetTestDatabase` truncates every table,
 * `flushTestRedis` FLUSHDBs a logical DB). Same rules as `scripts/alpha/guard.mjs` (the wrapper
 * enforces them first; this is the independent second line when a script is run directly):
 * loopback host unless X402_DEMO_ALLOW_REMOTE=1, no URL parameter that can redirect the Postgres
 * connection, a database name with e2e / demo / test as a whole underscore-separated word (and never
 * `agentfi`, `agentfi_c5`, `agentfi_alpha`), and a Redis logical DB other than 0.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const TEST_NAME = /(^|_)(e2e|demo|test)(_|$)/i;
const NEVER = new Set(['agentfi', 'agentfi_c5', 'agentfi_alpha']);
const PG_QUERY_ALLOWED = new Set(['schema', 'connection_limit', 'sslmode', 'pool_timeout', 'connect_timeout']);

/** `new URL('redis://[::1]:6379').hostname` is '[::1]'. */
const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, '');

/** A URL with its credentials masked, for messages. */
export function maskUrl(raw: string): string {
  return raw.replace(/\/\/[^/@]*@/, '//***@');
}

export function destructivePostgresProblem(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return 'database URL is not a valid URL';
  }
  const name = url.pathname.replace(/^\//, '');
  if (env['X402_DEMO_ALLOW_REMOTE'] !== '1' && !LOOPBACK.has(bareHost(url.hostname))) {
    return `Postgres host "${url.hostname}" is not loopback; refusing to truncate it (X402_DEMO_ALLOW_REMOTE=1 overrides)`;
  }
  for (const key of new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()))) {
    if (!PG_QUERY_ALLOWED.has(key)) return `Postgres URL parameter "${key}" is refused (host, hostaddr, service and options can redirect the connection)`;
  }
  if (NEVER.has(name.toLowerCase())) return `database "${name}" is never reset`;
  if (!TEST_NAME.test(name)) return `database name "${name || '(none)'}" must contain e2e, demo or test as a whole word between underscores; refusing to truncate it`;
  return null;
}

export function destructiveRedisProblem(redisUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    return 'Redis URL is not a valid URL';
  }
  if (env['X402_DEMO_ALLOW_REMOTE'] !== '1' && !LOOPBACK.has(bareHost(url.hostname))) {
    return `Redis host "${url.hostname}" is not loopback; refusing to flush it (X402_DEMO_ALLOW_REMOTE=1 overrides)`;
  }
  const index = Number(url.pathname.replace(/^\//, '') || '0');
  if (!Number.isInteger(index) || index === 0) return 'Redis logical DB 0 is shared with the dev stack and is never flushed';
  return null;
}
