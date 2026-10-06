/**
 * Route-level tests — POST /v1/public/agents (unauthenticated self-registration).
 *
 * An unauthenticated caller must not be able to pick its own initial policy
 * (or tier): both are forced server-side. Prisma and the wallet provider are
 * mocked so the real route handler + `provisionAgent` run end-to-end.
 */
import { vi } from 'vitest';

// config/env.ts calls process.exit() on missing required env vars at module
// load time. Hoisted-stub the ones the route import chain requires.
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
  // No Safe deployment: provisionAgent falls back to the EOA address.
  delete process.env['SAFE_DEPLOYER_PRIVATE_KEY'];
});

const { mockDb, createWalletMock } = vi.hoisted(() => ({
  mockDb: {
    agent: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    agentPolicy: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  } as any,
  createWalletMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));

vi.mock('../services/wallet/index.js', () => ({
  getWalletService: () => ({ createWallet: createWalletMock }),
}));
vi.mock('../services/wallet/safe.service.js', () => ({
  SafeService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/identity/ens.service.js', () => ({
  EnsService: vi.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
vi.mock('../services/billing/pnl.service.js', () => ({
  PnLService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));

import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type AgentsModule = typeof import('../api/routes/agents.js');

const EOA = '0x1111111111111111111111111111111111111111';
const DEFAULT_POLICY = {
  maxValuePerTxEth: '1.0',
  maxDailyVolumeUsd: '10000',
  allowedContracts: [],
  allowedTokens: [],
  cooldownSeconds: 60,
};

let agentRoutes: AgentsModule['agentRoutes'];

beforeAll(async () => {
  ({ agentRoutes } = await import('../api/routes/agents.js'));
});

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('agentId', '');
  app.decorateRequest('agentTier', 'FREE');
  app.decorateRequest('isOperator', false);
  await app.register(agentRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  createWalletMock.mockResolvedValue({ walletId: 'wallet-1', address: EOA });
  mockDb.agent.create.mockImplementation(async ({ data }: { data: { name: string } }) => ({
    id: 'agent-new',
    name: data.name,
  }));
});

describe('POST /v1/public/agents — forced defaults', () => {
  it('ignores a caller-supplied policy and creates the default policy row', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/agents',
      payload: {
        name: 'self-registered',
        chainIds: [8453],
        tier: 'ENTERPRISE',
        policy: {
          maxValuePerTxEth: '1000000',
          maxDailyVolumeUsd: '0',
          allowedContracts: [],
          allowedTokens: [],
          cooldownSeconds: 0,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'agent-new', tier: 'FREE', walletAddress: EOA });
    expect(mockDb.agent.create).toHaveBeenCalledTimes(1);
    const { data } = mockDb.agent.create.mock.calls[0][0];
    expect(data.tier).toBe('FREE');
    expect(data.policy).toEqual({ create: DEFAULT_POLICY });

    await app.close();
  });

  it('creates the default policy row when no policy is supplied (no "no restrictions" agent)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/agents',
      payload: { name: 'minimal', chainIds: [8453] },
    });

    expect(res.statusCode).toBe(201);
    const { data } = mockDb.agent.create.mock.calls[0][0];
    expect(data.policy).toEqual({ create: DEFAULT_POLICY });

    await app.close();
  });

  it('a malformed caller policy is irrelevant: stripped before validation, defaults still applied', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/agents',
      payload: { name: 'bad-policy', policy: { maxValuePerTxEth: '' } },
    });

    expect(res.statusCode).toBe(201);
    const { data } = mockDb.agent.create.mock.calls[0][0];
    expect(data.policy).toEqual({ create: DEFAULT_POLICY });
    expect(data.chainIds).toEqual([1]);

    await app.close();
  });

  it('still validates the public fields (400 before any wallet is provisioned)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/public/agents',
      payload: { name: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Validation failed' });
    expect(createWalletMock).not.toHaveBeenCalled();
    expect(mockDb.agent.create).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('POST /v1/agents — operator path keeps accepting an explicit (valid) policy', () => {
  it('stores the supplied policy as-is', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: 'operator-made',
        tier: 'PRO',
        policy: { maxValuePerTxEth: '5', allowedTokens: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'] },
      },
    });

    expect(res.statusCode).toBe(201);
    const { data } = mockDb.agent.create.mock.calls[0][0];
    expect(data.tier).toBe('PRO');
    expect(data.policy).toEqual({
      create: {
        ...DEFAULT_POLICY,
        maxValuePerTxEth: '5',
        allowedTokens: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
      },
    });

    await app.close();
  });

  it.each(['', '   ', '1e3', '0x10', '5abc', 'unlimited'])(
    'rejects a malformed initial limit %j with 400 before provisioning a wallet',
    async (raw) => {
      const app = await buildApp();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { name: 'bad', policy: { maxValuePerTxEth: raw } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation failed' });
      expect(createWalletMock).not.toHaveBeenCalled();

      await app.close();
    },
  );
});
