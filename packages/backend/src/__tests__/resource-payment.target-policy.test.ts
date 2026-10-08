/**
 * Route-level tests — outbound target policy of POST /v1/jobs/:id/pay-resource
 * (security task S4) under the DEFAULT configuration.
 *
 * `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS` is deliberately unset here (the
 * schema default `false` applies, as in production), and the service is built
 * without a `targetPolicy` unless a test injects a resolver. Every refusal
 * must happen before anything is fetched, signed or written to the ledger,
 * so the transport records calls and the ledger mock throws on any write.
 *
 * The pinned connection itself (real sockets through the undici Agent) is
 * covered in `outbound-target.test.ts` and, end to end with the fake
 * facilitator, in `resource-payment.routes.test.ts`.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  delete process.env['RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS'];
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

const { mockDb } = vi.hoisted(() => {
  const refuseWrite = async () => {
    throw new Error('the ledger must not be written when the target is refused');
  };
  const mockDb: any = {
    job: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    resourcePayment: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(refuseWrite),
      update: vi.fn(refuseWrite),
      upsert: vi.fn(refuseWrite),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(refuseWrite),
  };
  return { mockDb };
});

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));
vi.mock('../api/middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({}),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { Agent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../api/middleware/logger.js';
import { resourcePaymentRoutes } from '../api/routes/resource-payments.js';
import { env } from '../config/env.js';
import type { OutboundTargetPolicy, TargetLookup } from '../services/payments/outbound-target.js';
import { ResourcePaymentService } from '../services/payments/resource-payment.service.js';
import { X402ClientService } from '../services/payments/x402-client.service.js';
import type { TypedDataSigner } from '../services/wallet/signer.js';

const PROVIDER = 'agent-provider';
const REQUESTER = 'agent-requester';
const JOB_ID = 'job-1';

const wallet: TypedDataSigner & { signatures: number } = {
  signatures: 0,
  async getWalletAddress() {
    return '0x00000000000000000000000000000000000000a1';
  },
  async signTypedData() {
    wallet.signatures++;
    throw new Error('must not sign');
  },
};

interface TransportCall {
  url: string;
  redirect: string;
  dispatcher: unknown;
}

/** Records what the x402 client hands the transport and answers a free 200. */
function recordingTransport(calls: TransportCall[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: request.url,
      redirect: request.redirect,
      dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

let caller = PROVIDER;
let calls: TransportCall[] = [];
const open: Array<() => Promise<void>> = [];

async function buildApp(lookup?: TargetLookup, policy: OutboundTargetPolicy = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = caller;
    request.agentTier = 'FREE';
  });
  const client = new X402ClientService({ fetch: recordingTransport(calls) });
  const targetPolicy = { ...policy, ...(lookup ? { lookup } : {}) };
  await app.register(resourcePaymentRoutes, {
    service: new ResourcePaymentService({
      db: mockDb,
      wallet,
      client,
      ...(Object.keys(targetPolicy).length > 0 ? { targetPolicy } : {}),
    }),
  });
  open.push(() => app.close());
  return app;
}

function pay(app: FastifyInstance, url: string) {
  return app.inject({ method: 'POST', url: `/v1/jobs/${JOB_ID}/pay-resource`, payload: { url } });
}

function lookupReturning(addresses: Array<{ address: string; family: number }>) {
  return vi.fn<Parameters<TargetLookup>, ReturnType<TargetLookup>>(async () => addresses);
}

function lookupFailing(code: string) {
  return vi.fn<Parameters<TargetLookup>, ReturnType<TargetLookup>>(async () => {
    throw Object.assign(new Error(`getaddrinfo ${code}`), { code });
  });
}

function expectNothingHappened(): void {
  expect(calls).toHaveLength(0);
  expect(wallet.signatures).toBe(0);
  expect(mockDb.resourcePayment.create).not.toHaveBeenCalled();
  expect(mockDb.resourcePayment.update).not.toHaveBeenCalled();
  expect(mockDb.resourcePayment.upsert).not.toHaveBeenCalled();
  expect(mockDb.$transaction).not.toHaveBeenCalled();
}

describe('pay-resource outbound target policy — default configuration (S4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    wallet.signatures = 0;
    caller = PROVIDER;
    mockDb.job.findUnique.mockResolvedValue({
      id: JOB_ID,
      providerId: PROVIDER,
      requesterId: REQUESTER,
      status: 'ACCEPTED',
      reward: { amount: '1', token: 'USDC', chainId: 84532 },
    });
    mockDb.agent.findUnique.mockResolvedValue({
      id: PROVIDER,
      active: true,
      walletId: 'wallet-provider',
      policy: { active: true, expiresAt: null },
    });
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((close) => close()));
  });

  it('the private-host override is off by default', () => {
    expect(process.env['RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS']).toBeUndefined();
    expect(env.RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS).toBe('false');
  });

  describe('literal hosts are refused before any DNS lookup (400 INVALID_URL, refusal private-host)', () => {
    it.each([
      ['loopback (the admin API)', 'http://127.0.0.1:3000/admin/agents', '127.0.0.1'],
      ['localhost', 'http://localhost:3000/admin/agents', 'localhost'],
      ['localhost with a trailing dot', 'http://localhost./admin', 'localhost'],
      ['a *.localhost name', 'http://api.localhost/', 'api.localhost'],
      ['IPv6 loopback', 'http://[::1]:5432/', '::1'],
      ['cloud metadata (link-local)', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', '169.254.169.254'],
      ['RFC 1918 10/8', 'http://10.0.0.5/paid', '10.0.0.5'],
      ['RFC 1918 172.16/12', 'http://172.20.1.1/paid', '172.20.1.1'],
      ['RFC 1918 192.168/16 (Redis port)', 'http://192.168.1.10:6379/', '192.168.1.10'],
      ['CGNAT 100.64/10', 'http://100.64.0.1/', '100.64.0.1'],
      ['unspecified 0.0.0.0', 'http://0.0.0.0:3000/', '0.0.0.0'],
      ['decimal IPv4 (normalised to 127.0.0.1)', 'http://2130706433/', '127.0.0.1'],
      ['hex IPv4 (normalised to 127.0.0.1)', 'http://0x7f.1/', '127.0.0.1'],
      ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
      ['IPv4-mapped IPv6 metadata (hex form)', 'http://[::ffff:a9fe:a9fe]/', '::ffff:a9fe:a9fe'],
      ['NAT64 with a private embedded IPv4', 'http://[64:ff9b::10.0.0.1]/', '64:ff9b::a00:1'],
      ['IPv6 unique-local', 'http://[fd00::1]/', 'fd00::1'],
      ['IPv6 link-local', 'http://[fe80::1]/', 'fe80::1'],
      ['benchmarking 198.18/15', 'http://198.18.0.1/', '198.18.0.1'],
      ['IETF protocol assignments 192.0.0/24', 'http://192.0.0.170/', '192.0.0.170'],
      ['6to4 around RFC 1918', 'http://[2002:a00:1::]/', '2002:a00:1::'],
      ['local-use NAT64', 'http://[64:ff9b:1::808:808]/', '64:ff9b:1::808:808'],
      ['SIIT IPv4-translated loopback', 'http://[::ffff:0:7f00:1]/', '::ffff:0:7f00:1'],
    ])('%s: %s', async (_label, url, hostname) => {
      const lookup = lookupReturning([{ address: '93.184.216.34', family: 4 }]);
      const app = await buildApp(lookup);

      const res = await pay(app, url);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_URL', refusal: 'private-host', hostname });
      expect(res.json().error).toMatch(/private, loopback, link-local or reserved host/);
      expect(lookup).not.toHaveBeenCalled();
      expectNothingHappened();
    });

    it('also refuses with the real resolver wired (no injected lookup)', async () => {
      const app = await buildApp();

      const res = await pay(app, 'http://127.0.0.1:5432/');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_URL', refusal: 'private-host' });
      expectNothingHappened();
    });
  });

  describe('a public-looking name is judged by every address it resolves to', () => {
    it.each([
      [
        'one A record of several points at cloud metadata',
        [
          { address: '93.184.216.34', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
        '169.254.169.254',
      ],
      ['an A record to loopback', [{ address: '127.0.0.1', family: 4 }], '127.0.0.1'],
      ['an AAAA record IPv4-mapped to loopback', [{ address: '::ffff:7f00:1', family: 6 }], '::ffff:7f00:1'],
      ['an AAAA record in fc00::/7', [{ address: 'fd12:3456::1', family: 6 }], 'fd12:3456::1'],
      ['an AAAA record NAT64 to RFC 1918', [{ address: '64:ff9b::c0a8:1', family: 6 }], '64:ff9b::c0a8:1'],
      ['an A record in 198.18/15 (benchmarking)', [{ address: '198.19.0.1', family: 4 }], '198.19.0.1'],
      ['an A record in 192.0.0/24', [{ address: '192.0.0.8', family: 4 }], '192.0.0.8'],
      ['an AAAA record 6to4 around loopback', [{ address: '2002:7f00:1::1', family: 6 }], '2002:7f00:1::1'],
      ['an AAAA record in local-use NAT64', [{ address: '64:ff9b:1::808:808', family: 6 }], '64:ff9b:1::808:808'],
      ['an AAAA record in the SIIT form', [{ address: '::ffff:0:808:808', family: 6 }], '::ffff:0:808:808'],
    ])('refuses when %s (400 INVALID_URL, refusal no-public-address)', async (_label, addresses, address) => {
      const lookup = lookupReturning(addresses);
      const app = await buildApp(lookup);

      const res = await pay(app, 'https://metadata.attacker.example/latest/meta-data/');

      expect(res.statusCode).toBe(400);
      // P6: the same answer as a name that does not resolve at all.
      expect(res.json()).toEqual({
        error: 'url hostname does not resolve to a public address (metadata.attacker.example)',
        code: 'INVALID_URL',
        refusal: 'no-public-address',
        hostname: 'metadata.attacker.example',
      });
      // S5: the private address the name resolved to is never sent back (it
      // would let an agent map internal DNS names) — only logged.
      expect(res.json()).not.toHaveProperty('address');
      expect(res.payload).not.toContain(address);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ refusal: 'private-address', hostname: 'metadata.attacker.example', address }),
        expect.stringContaining('refused by the outbound target policy'),
      );
      expect(lookup).toHaveBeenCalledWith('metadata.attacker.example');
      expectNothingHappened();
    });

    it.each([
      ['NXDOMAIN', lookupFailing('ENOTFOUND')],
      ['no address at all', lookupReturning([])],
      ['a private address', lookupReturning([{ address: '10.1.2.3', family: 4 }])],
    ])(
      'an internal name cannot be probed: %s gets the same body (refusal no-public-address)',
      async (_label, lookup) => {
        const app = await buildApp(lookup);

        const res = await pay(app, 'https://db.corp.example/quote');

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: 'url hostname does not resolve to a public address (db.corp.example)',
          code: 'INVALID_URL',
          refusal: 'no-public-address',
          hostname: 'db.corp.example',
        });
        // The precise reason stays in the operator log.
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          expect.objectContaining({ refusal: expect.stringMatching(/^(unresolvable|private-address)$/) }),
          expect.stringContaining('refused by the outbound target policy'),
        );
        expectNothingHappened();
      },
    );

    it('a transient resolver failure is 502 PAYMENT_FAILED at stage "resolve", nothing signed or recorded', async () => {
      const app = await buildApp(lookupFailing('EAI_AGAIN'));

      const res = await pay(app, 'https://api.example.com/quote');

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'PAYMENT_FAILED', stage: 'resolve', timedOut: false, payment: null });
      expectNothingHappened();
    });

    it('authorisation is checked before anything is resolved: the requester gets 403 and no DNS query leaves', async () => {
      caller = REQUESTER;
      const lookup = lookupReturning([{ address: '93.184.216.34', family: 4 }]);
      const app = await buildApp(lookup);

      const res = await pay(app, 'https://api.example.com/quote');

      expect(res.statusCode).toBe(403);
      expect(lookup).not.toHaveBeenCalled();
      expectNothingHappened();
    });
  });

  describe('port policy (P6)', () => {
    it('development / test is unrestricted by default (no RESOURCE_PAYMENT_ALLOWED_PORTS)', async () => {
      expect(env.RESOURCE_PAYMENT_ALLOWED_PORTS).toBeUndefined();
      const app = await buildApp(lookupReturning([{ address: '93.184.216.34', family: 4 }]));

      const res = await pay(app, 'https://api.example.com:8443/quote');

      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['an explicit non-standard port', 'https://api.example.com:6379/', 6379],
      ['http on 8080', 'http://api.example.com:8080/quote', 8080],
    ])('the production default (80, 443) refuses %s before any DNS lookup', async (_label, url, port) => {
      const lookup = lookupReturning([{ address: '93.184.216.34', family: 4 }]);
      const app = await buildApp(lookup, { allowedPorts: [80, 443] });

      const res = await pay(app, url);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_URL', refusal: 'port-not-allowed', port, hostname: 'api.example.com' });
      expect(res.json().error).toMatch(/port .* is not allowed/);
      expect(lookup).not.toHaveBeenCalled();
      expectNothingHappened();
    });

    it.each([
      ['https without a port (443)', 'https://api.example.com/quote'],
      ['http without a port (80)', 'http://api.example.com/quote'],
      ['an explicit :443', 'https://api.example.com:443/quote'],
    ])('the production default allows %s', async (_label, url) => {
      const app = await buildApp(lookupReturning([{ address: '93.184.216.34', family: 4 }]), { allowedPorts: [80, 443] });

      const res = await pay(app, url);

      expect(res.statusCode).toBe(200);
    });
  });

  it('a public destination passes and the transport gets a pinned undici dispatcher and redirect "manual"; the dispatcher is torn down afterwards', async () => {
    const lookup = lookupReturning([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    const app = await buildApp(lookup);

    const res = await pay(app, 'https://api.example.com/quote?symbol=ETH');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payment: null, resource: { status: 200, body: { ok: true } } });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.example.com/quote?symbol=ETH');
    expect(call?.redirect).toBe('manual');
    expect(call?.dispatcher).toBeInstanceOf(Agent);
    expect((call?.dispatcher as { destroyed?: boolean }).destroyed).toBe(true);
    expect(wallet.signatures).toBe(0);
  });
});
