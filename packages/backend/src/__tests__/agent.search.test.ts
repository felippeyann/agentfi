import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { agentRoutes } from '../api/routes/agents.js';

// Mock the dependencies
vi.mock('../../services/wallet/turnkey.service.js');
vi.mock('../../services/wallet/safe.service.js');
vi.mock('../middleware/auth.js', () => ({
  generateApiKey: () => ({ plaintext: 'test_key', hash: 'test_hash', prefix: 'test_prefix' }),
  authenticateAgent: (req: any, res: any, done: any) => {
    req.agentId = 'agent-1';
    req.agentTier = 'FREE';
    done();
  }
}));

const db = new PrismaClient();

describe('Agent Search Integration', () => {
  const app = fastify();

  beforeAll(async () => {
    await app.register(agentRoutes);
  });

  beforeEach(async () => {
    // Clear the database in order to avoid FK violations
    await db.feeEvent.deleteMany();
    await db.job.deleteMany();
    await db.transaction.deleteMany();
    await db.dailyVolume.deleteMany();
    await db.agentPolicy.deleteMany();
    await db.agentBilling.deleteMany();
    await db.agent.deleteMany();
    
    // Seed with test agents
    await db.agent.createMany({
      data: [
        {
          id: 'agent-1',
          name: 'Alpha Trader',
          safeAddress: '0x1111111111111111111111111111111111111111',
          apiKeyHash: 'hash1',
          apiKeyPrefix: 'prefix1',
          walletId: 'w1',
          chainIds: [1, 8453],
          active: true,
        },
        {
          id: 'agent-2',
          name: 'Beta Liquidity',
          safeAddress: '0x2222222222222222222222222222222222222222',
          apiKeyHash: 'hash2',
          apiKeyPrefix: 'prefix2',
          walletId: 'w2',
          chainIds: [1],
          active: true,
        },
        {
          id: 'agent-inactive',
          name: 'Gamma Inactive',
          safeAddress: '0x3333333333333333333333333333333333333333',
          apiKeyHash: 'hash3',
          apiKeyPrefix: 'prefix3',
          walletId: 'w3',
          chainIds: [1],
          active: false,
        }
      ]
    });
  });

  it('should find an agent by name (case-insensitive)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/search',
      query: { q: 'alpha' }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('Alpha Trader');
  });

  it('should find an agent by address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/search',
      query: { q: '0x2222' }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('Beta Liquidity');
  });

  it('should not return inactive agents', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/search',
      query: { q: 'Gamma' }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.agents).toHaveLength(0);
  });

  it('should return 400 for too short query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents/search',
      query: { q: 'a' }
    });

    if (response.statusCode !== 400) {
      console.log('DEBUG 400 test failed:', response.body);
    }
    expect(response.statusCode).toBe(400);
  });
});
