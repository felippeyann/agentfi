/**
 * Route-level tests — A2A handshake error hygiene (S5).
 *
 * `POST /v1/agents/verify-handshake` falls back to EIP-1271 through the
 * operator's RPC URL (`getPrimaryRpcUrl` → `https://…alchemy.com/v2/<key>`)
 * and returned `details: err.message` on failure; `POST
 * /v1/agents/me/sign-handshake` did the same with the wallet provider's error.
 * Both now carry the sanitized message. viem's `createPublicClient` is
 * replaced by one whose `verifyMessage` fails the way viem does when the RPC
 * refuses the call — an HttpRequestError built from the very URL the route
 * derived from ALCHEMY_API_KEY.
 */
import { vi } from 'vitest';

const { ALCHEMY_KEY, TURNKEY_PRIVATE_KEY } = vi.hoisted(() => {
  const alchemy = 'Zq8mN3pL5vR7tX9wB2cD4fG6hJ1kM0aS';
  const turnkey = 'turnkey-api-private-key-0123456789abcdef';
  const g = globalThis as { __s5HandshakeEnv?: Record<string, string | undefined> };
  g.__s5HandshakeEnv = {
    ALCHEMY_API_KEY: process.env['ALCHEMY_API_KEY'],
    TURNKEY_API_PRIVATE_KEY: process.env['TURNKEY_API_PRIVATE_KEY'],
  };
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
  // Realistic operator secrets: config/chains.ts builds the Alchemy URLs from
  // ALCHEMY_API_KEY when it loads, so this must be set before any import.
  process.env['ALCHEMY_API_KEY'] = alchemy;
  process.env['TURNKEY_API_PRIVATE_KEY'] = turnkey;
  return { ALCHEMY_KEY: alchemy, TURNKEY_PRIVATE_KEY: turnkey };
});

const { mockDb, walletMock, rpcUrls } = vi.hoisted(() => ({
  mockDb: { agent: { findUnique: vi.fn() } } as any,
  walletMock: { signMessage: vi.fn() },
  rpcUrls: [] as string[],
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => walletMock }));
vi.mock('../services/wallet/safe.service.js', () => ({ SafeService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/identity/ens.service.js', () => ({
  EnsService: vi.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    // The EIP-1271 fallback's client: its RPC call fails the way viem reports
    // a refused HTTP request, with the transport's real URL in the message.
    createPublicClient: vi.fn((config: { transport: (opts: Record<string, unknown>) => { value?: { url?: string } } }) => {
      const url = config.transport({}).value?.url ?? 'unknown';
      rpcUrls.push(url);
      return {
        verifyMessage: async () => {
          throw new actual.HttpRequestError({
            url,
            status: 429,
            details: 'Your app has exceeded its compute units per second capacity.',
            body: { method: 'eth_call', params: [] },
          });
        },
      };
    }),
  };
});

import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { registerErrorHandler } from '../api/errors/handler.js';

type AgentsModule = typeof import('../api/routes/agents.js');

const AGENT_ID = 'cl00000000000000000agent01';
const SAFE = '0x2222222222222222222222222222222222222222';
const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

let agentRoutes: AgentsModule['agentRoutes'];

beforeAll(async () => {
  ({ agentRoutes } = await import('../api/routes/agents.js'));
});

afterAll(() => {
  const saved = (globalThis as { __s5HandshakeEnv?: Record<string, string | undefined> }).__s5HandshakeEnv ?? {};
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  mockDb.agent.findUnique.mockReset();
  walletMock.signMessage.mockReset();
  rpcUrls.length = 0;
});

async function buildApp() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('preHandler', async (request: any) => {
    request.agentId = AGENT_ID;
    request.agentTier = 'FREE';
  });
  await app.register(agentRoutes);
  return app;
}

describe('POST /v1/agents/verify-handshake (S5)', () => {
  it('an RPC failure in the EIP-1271 fallback answers 400 with sanitized details — the keyed Alchemy URL never leaves', async () => {
    const message = 'hello from agent B';
    const signature = await SIGNER.signMessage({ message }); // signed by an EOA that is NOT the target → EIP-1271 path
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message, signature, address: SAFE, chainId: 84532 },
    });

    // The route really used the operator's keyed URL…
    expect(rpcUrls).toEqual([`https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`]);
    // …and the agent gets the viem summary, nothing of the URL.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Verification failed',
      details: 'HTTP request failed. (Your app has exceeded its compute units per second capacity.)',
    });
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    await app.close();
  });

  it('a valid EOA handshake is unaffected', async () => {
    const message = 'hello from agent A';
    const signature = await SIGNER.signMessage({ message });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message, signature, address: SIGNER.address },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, address: SIGNER.address, verifiedVia: 'ecdsa' });
    expect(rpcUrls).toEqual([]);
    await app.close();
  });
});

describe('POST /v1/agents/me/sign-handshake (S5)', () => {
  it("the wallet provider's error is sanitized: no API private key, no provider URL query", async () => {
    mockDb.agent.findUnique.mockResolvedValue({ walletId: 'wallet-1', safeAddress: SAFE });
    walletMock.signMessage.mockRejectedValue(
      new Error(
        `Turnkey error 401: POST https://api.turnkey.com/public/v1/submit/sign_raw_payload?organizationId=org-123 rejected the stamp of api key ${TURNKEY_PRIVATE_KEY}`,
      ),
    );
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/v1/agents/me/sign-handshake', payload: { message: 'hi' } });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'Signing failed',
      details: 'Turnkey error 401: POST https://api.turnkey.com/[redacted] rejected the stamp of api key [redacted]',
    });
    expect(res.payload).not.toContain(TURNKEY_PRIVATE_KEY);
    expect(res.payload).not.toContain('org-123');
    await app.close();
  });
});

describe('agents routes — unexpected failures (S5)', () => {
  it('GET /v1/agents/me with a database failure answers the opaque 500 envelope', async () => {
    mockDb.agent.findUnique.mockRejectedValue(
      new Error("Can't reach database server at `db.prod.example.com`:`5432` (postgresql://agentfi:s3cret-db-pass@db.prod.example.com:5432/agentfi)"),
    );
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/v1/agents/me' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR', traceId: expect.stringMatching(/^[0-9a-f]{12}$/) });
    await app.close();
  });
});
