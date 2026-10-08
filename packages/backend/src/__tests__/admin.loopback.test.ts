/**
 * S6: the admin loopback gate cannot be fooled by X-Forwarded-For.
 *
 * `requireAdmin` used `request.ip`. With Fastify `trustProxy` on (now
 * configurable as TRUST_PROXY), `request.ip` is the left-most
 * `X-Forwarded-For` entry — chosen by the client — so a remote caller holding
 * the admin secret sent `X-Forwarded-For: 127.0.0.1` and passed the
 * "local-only" gate. The gate now requires the TCP peer AND every forwarded
 * hop to be loopback (api/middleware/local-request.ts).
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
  delete process.env['ADMIN_ALLOW_REMOTE'];
});

const { mockDb } = vi.hoisted(() => ({
  mockDb: { operatorSettlement: { findMany: vi.fn(async () => []) } } as any,
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../queues/transaction.queue.js', () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock('../services/policy/reputation.service.js', () => ({ ReputationService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/billing/operator.service.js', () => ({ OperatorService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forwardedAddresses, isLocalOnlyRequest, isLoopbackAddress } from '../api/middleware/local-request.js';

const ADMIN_SECRET = process.env['ADMIN_SECRET']!;
let app: FastifyInstance;

beforeAll(async () => {
  const { adminRoutes } = await import('../api/routes/admin.js');
  // trustProxy ON: the configuration where request.ip follows X-Forwarded-For.
  app = Fastify({ logger: false, trustProxy: true });
  app.get('/whoami', async (request) => ({ ip: request.ip }));
  await app.register(adminRoutes);
});

afterAll(async () => {
  await app.close();
});

function settlements(remoteAddress: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: '/admin/settlements',
    remoteAddress,
    headers: { 'x-admin-secret': ADMIN_SECRET, ...headers },
  });
}

describe('admin loopback gate with trustProxy on (S6)', () => {
  it('the spoof works on request.ip — which is why the gate no longer uses it', async () => {
    const res = await app.inject({ method: 'GET', url: '/whoami', remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(res.json()).toEqual({ ip: '127.0.0.1' });
  });

  it('a remote caller with X-Forwarded-For: 127.0.0.1 is refused (403)', async () => {
    const res = await settlements('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/local-only/);
  });

  it.each([
    ['x-forwarded-for', '203.0.113.9'],
    ['x-forwarded-for', '127.0.0.1, 203.0.113.9'],
    ['x-real-ip', '203.0.113.9'],
    ['forwarded', 'for=203.0.113.9;proto=https'],
    ['forwarded', 'for="[2001:db8::1]:4711"'],
  ])('a same-host proxy forwarding a remote client (%s: %s) is refused', async (header, value) => {
    expect((await settlements('127.0.0.1', { [header]: value })).statusCode).toBe(403);
  });

  it('a direct loopback request passes (also via an all-loopback chain)', async () => {
    expect((await settlements('127.0.0.1')).statusCode).toBe(200);
    expect((await settlements('::1')).statusCode).toBe(200);
    expect((await settlements('::ffff:127.0.0.1')).statusCode).toBe(200);
    expect((await settlements('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, ::1' })).statusCode).toBe(200);
  });

  it('the admin secret is still checked first', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/settlements', remoteAddress: '127.0.0.1', headers: { 'x-admin-secret': 'wrong' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('local-request helpers', () => {
  it('isLoopbackAddress', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('localhost')).toBe(false); // a name is not an address
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('forwardedAddresses parses every forwarding header', () => {
    expect(
      forwardedAddresses({
        'x-forwarded-for': '203.0.113.9:443, 10.0.0.2',
        forwarded: 'for=198.51.100.7;by=10.0.0.1, for="[2001:db8::1]:4711"',
        'cf-connecting-ip': '192.0.2.4',
      }),
    ).toEqual(['203.0.113.9', '10.0.0.2', '198.51.100.7', '2001:db8::1', '192.0.2.4']);
    expect(forwardedAddresses({})).toEqual([]);
  });

  it('isLocalOnlyRequest: unparseable forwarding data counts as remote', () => {
    expect(isLocalOnlyRequest({ headers: { 'x-forwarded-for': 'unknown' }, socket: { remoteAddress: '127.0.0.1' } })).toBe(false);
    expect(isLocalOnlyRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(isLocalOnlyRequest({ headers: {}, socket: null })).toBe(false);
  });
});
