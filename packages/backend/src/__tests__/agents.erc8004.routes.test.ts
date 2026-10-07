/**
 * Route-level tests — ERC-8004 registration file and identity view (R2).
 *
 *  - GET /v1/agents/:id/erc8004.json is public (no x-api-key, through the real
 *    auth middleware) and follows the EIP-8004 registration-v1 shape:
 *    type/name/description, services[] (manifest as `web`, ENS when set, no MCP
 *    unless MCP_PUBLIC_URL), x402Support false, active, registrations[] from
 *    REGISTERED identities only (`eip155:<chainId>:<registry>`),
 *    supportedTrust ["reputation"]; 404 for an unknown agent
 *  - GET /v1/agents/:id returns `erc8004: [{ chainId, registry, agentId, status }]`
 *  - buildRegistrationFile advertises the MCP endpoint when configured
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
  (globalThis as { __savedBackendUrl?: string | undefined }).__savedBackendUrl = process.env['BACKEND_PUBLIC_URL'];
  process.env['BACKEND_PUBLIC_URL'] = 'https://api.example.test/';
  delete process.env['MCP_PUBLIC_URL'];
});

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentPolicy: { findUnique: vi.fn(), upsert: vi.fn() },
  } as any,
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/wallet/safe.service.js', () => ({ SafeService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/identity/ens.service.js', () => ({
  EnsService: vi.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));

import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildRegistrationFile, REGISTRATION_FILE_TYPE } from '../services/job/erc8004-identity.service.js';

type AgentsModule = typeof import('../api/routes/agents.js');
type AuthModule = typeof import('../api/middleware/auth.js');

const AGENT_KEY = 'agfi_live_0123456789abcdef0123456789abcdef';
const AGENT = {
  id: 'cl00000000000000000agent01',
  name: 'Research Bot',
  active: true,
  ensName: 'research-bot.agentfi.eth',
  apiKeyPrefix: 'agfi_live_012345',
  safeAddress: '0x2222222222222222222222222222222222222222',
  chainIds: [84532],
  tier: 'FREE',
  policy: null,
  billing: null,
  identities: [
    { chainId: 8453, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', erc8004AgentId: null, status: 'REGISTERING' },
    { chainId: 84532, registry: '0x8004a818bfb912233c491871b3d84c89a494bd9e', erc8004AgentId: '9598', status: 'REGISTERED' },
  ],
};

let agentRoutes: AgentsModule['agentRoutes'];
let authMiddleware: AuthModule['authMiddleware'];

beforeAll(async () => {
  ({ agentRoutes } = await import('../api/routes/agents.js'));
  ({ authMiddleware } = await import('../api/middleware/auth.js'));
});

afterAll(() => {
  // Do not leak the URL override into later test files of the same worker.
  const saved = (globalThis as { __savedBackendUrl?: string | undefined }).__savedBackendUrl;
  if (saved === undefined) delete process.env['BACKEND_PUBLIC_URL'];
  else process.env['BACKEND_PUBLIC_URL'] = saved;
});

beforeEach(() => {
  vi.clearAllMocks();
  const keyHash = createHash('sha256').update(AGENT_KEY).digest('hex');
  mockDb.agent.findUnique.mockImplementation(async ({ where }: { where: { id?: string; apiKeyHash?: string } }) => {
    if (where.apiKeyHash) return where.apiKeyHash === keyHash ? { id: AGENT.id, active: true, tier: 'FREE' } : null;
    return where.id === AGENT.id ? { ...AGENT } : null;
  });
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authMiddleware);
  await app.register(agentRoutes);
  return app;
}

describe('GET /v1/agents/:id/erc8004.json', () => {
  it('is public and returns the EIP-8004 registration-v1 file', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${AGENT.id}/erc8004.json` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const file = res.json();
    expect(file).toEqual({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Research Bot',
      description: expect.stringContaining('ERC-8183'),
      services: [
        { name: 'web', endpoint: `https://api.example.test/v1/agents/${AGENT.id}/manifest` },
        { name: 'ENS', endpoint: 'research-bot.agentfi.eth', version: 'v1' },
      ],
      x402Support: false,
      active: true,
      // Only REGISTERED identities; registry checksummed in the CAIP-style agentRegistry.
      registrations: [{ agentId: 9598, agentRegistry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e' }],
      supportedTrust: ['reputation'],
    });
    expect(file).not.toHaveProperty('image');
    // The route asked for the identities with the agent, in one query.
    expect(mockDb.agent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: AGENT.id }, select: expect.objectContaining({ identities: expect.anything() }) }),
    );
    await app.close();
  });

  it('serves an inactive agent with active:false and no registrations before the first mint', async () => {
    mockDb.agent.findUnique.mockResolvedValueOnce({ ...AGENT, active: false, ensName: null, identities: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${AGENT.id}/erc8004.json` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: false, registrations: [], services: [{ name: 'web' }] });
    await app.close();
  });

  it('404s for an unknown agent', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/agents/nope/erc8004.json' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('agent responses expose the ERC-8004 identities', () => {
  it('GET /v1/agents/:id returns erc8004 [{ chainId, registry, agentId, status }]', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${AGENT.id}`, headers: { 'x-api-key': AGENT_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json().erc8004).toEqual([
      { chainId: 8453, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: null, status: 'REGISTERING' },
      { chainId: 84532, registry: '0x8004a818bfb912233c491871b3d84c89a494bd9e', agentId: '9598', status: 'REGISTERED' },
    ]);
    await app.close();
  });

  it('GET /v1/agents/:id still requires the agent key (only the .json file is public)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/agents/${AGENT.id}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('buildRegistrationFile', () => {
  it('advertises the MCP endpoint when MCP_PUBLIC_URL is configured', () => {
    const file = buildRegistrationFile(
      { id: 'a1', name: 'A', active: true, ensName: null },
      [],
      { backendPublicUrl: 'https://api.example.test', mcpPublicUrl: 'https://api.example.test/mcp/sse' },
    );
    expect(file.type).toBe(REGISTRATION_FILE_TYPE);
    expect(file.services).toEqual([
      { name: 'web', endpoint: 'https://api.example.test/v1/agents/a1/manifest' },
      { name: 'MCP', endpoint: 'https://api.example.test/mcp/sse', version: LATEST_PROTOCOL_VERSION },
    ]);
  });

  it('keeps an agentId beyond 2^53 as a decimal string', () => {
    const big = '123456789012345678901234567890';
    const file = buildRegistrationFile({ id: 'a1', name: 'A', active: true, ensName: null }, [
      { chainId: 8453, registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', erc8004AgentId: big, status: 'REGISTERED' },
    ], { backendPublicUrl: 'https://x.test' });
    expect(file.registrations).toEqual([{ agentId: big, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }]);
  });
});
