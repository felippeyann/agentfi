/**
 * S6: `GET /health/ready` is unauthenticated, outside the global rate limit,
 * and every call probed the database, Redis, the RPC provider and Turnkey's
 * API (quota). Now one probe serves all callers for a few seconds, concurrent
 * callers share the in-flight probe, and each client IP has its own
 * in-process limit (the endpoint must keep answering when Redis — the global
 * limiter's store — is down).
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

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => ({})) }));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({ healthCheck: async () => true }) }));

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { InProcessWindowLimiter, healthRoutes, type ReadinessChecks } from '../api/routes/health.js';

let clock = 0;
const apps: Array<ReturnType<typeof Fastify>> = [];

function fakeChecks(healthy = true, gate?: Promise<void>) {
  const calls = { database: 0, redis: 0, rpc: 0, turnkey: 0 };
  const probe = (name: keyof typeof calls) => async () => {
    calls[name]++;
    if (gate) await gate;
    return name === 'redis' ? healthy : true;
  };
  const checks: ReadinessChecks = {
    database: probe('database'),
    redis: probe('redis'),
    rpc: probe('rpc'),
    turnkey: probe('turnkey'),
  };
  return { checks, calls };
}

async function build(checks: ReadinessChecks, readyMaxPerMinute = 30) {
  clock = 1_000_000;
  const app = Fastify({ logger: false });
  await app.register(healthRoutes, { checks, readyCacheMs: 5_000, readyMaxPerMinute, now: () => clock });
  apps.push(app);
  return app;
}

const ready = (app: ReturnType<typeof Fastify>, remoteAddress = '198.51.100.1') =>
  app.inject({ method: 'GET', url: '/health/ready', remoteAddress });

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('GET /health/ready (S6)', () => {
  it('reuses one probe for 5 s, then probes again', async () => {
    const { checks, calls } = fakeChecks();
    const app = await build(checks);

    for (let i = 0; i < 5; i++) expect((await ready(app)).statusCode).toBe(200);
    expect(calls).toEqual({ database: 1, redis: 1, rpc: 1, turnkey: 1 });

    clock += 5_001;
    const res = await ready(app);
    expect(res.json()).toMatchObject({ status: 'ready', checks: { database: true, redis: true, rpc: true, turnkey: true } });
    expect(calls.turnkey).toBe(2);
  });

  it('concurrent callers share the in-flight probe', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const fake = fakeChecks(true, gate);
    const app = await build(fake.checks);

    const pending = Promise.all([ready(app), ready(app, '198.51.100.2'), ready(app, '198.51.100.3')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const results = await pending;

    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(fake.calls.database).toBe(1);
  });

  it('a degraded result is a 503 and is cached too', async () => {
    const { checks, calls } = fakeChecks(false);
    const app = await build(checks);
    const first = await ready(app);
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ status: 'degraded', checks: { redis: false } });
    expect((await ready(app)).statusCode).toBe(503);
    expect(calls.redis).toBe(1);
  });

  it('per client IP: past the limit → 429 with Retry-After; another IP is unaffected; the window resets', async () => {
    const { checks } = fakeChecks();
    const app = await build(checks, 3);
    for (let i = 0; i < 3; i++) expect((await ready(app)).statusCode).toBe(200);
    const limited = await ready(app);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await ready(app, '198.51.100.99')).statusCode).toBe(200);
    clock += 60_000;
    expect((await ready(app)).statusCode).toBe(200);
  });

  it('GET /health (liveness) is neither cached nor limited', async () => {
    const { checks, calls } = fakeChecks();
    const app = await build(checks, 1);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(calls.database).toBe(0);
  });
});

describe('InProcessWindowLimiter', () => {
  it('bounds its memory', () => {
    let now = 0;
    const limiter = new InProcessWindowLimiter(1, 60_000, () => now, 3);
    for (const ip of ['a', 'b', 'c']) expect(limiter.hit(ip)).toBeNull();
    expect(limiter.hit('a')).toBe(60);
    limiter.hit('d'); // map full → cleared, 'a' starts over
    expect(limiter.hit('a')).toBeNull();
    now += 60_000; // window over
    expect(limiter.hit('b')).toBeNull();
  });
});
