/**
 * API key authentication middleware for Fastify.
 * Agents authenticate via `x-api-key` header.
 * Keys are stored hashed (SHA-256) — plaintext never persists.
 */

import type { FastifyRequest, FastifyReply, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    agentId: string;
    agentTier: 'FREE' | 'PRO' | 'ENTERPRISE';
  }
}

const db = new PrismaClient();

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

const authPlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.decorateRequest('agentId', '');
  fastify.decorateRequest('agentTier', 'FREE');

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public / separately-authenticated endpoints
    if (request.routeOptions?.url?.startsWith('/health')) return;
    if (request.routeOptions?.url?.startsWith('/admin')) return;
    if (request.routeOptions?.url?.startsWith('/.well-known')) return;
    if (request.routeOptions?.url === '/v1/billing/webhook') return;
    if (request.routeOptions?.url?.startsWith('/mcp')) return;

    // Agent registration uses the operator API_SECRET, not an agent key
    if (request.routeOptions?.url === '/v1/agents' && request.method === 'POST') {
      const operatorSecret = request.headers['x-api-key'];
      const expectedSecret = process.env['API_SECRET'] ?? '';
      if (!operatorSecret || operatorSecret !== expectedSecret) {
        reply.code(401).send({ error: 'Agent registration requires operator API_SECRET' });
      }
      return;
    }

    const apiKey = request.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      reply.code(401).send({ error: 'Missing x-api-key header' });
      return;
    }

    if (!apiKey.startsWith('agfi_')) {
      reply.code(401).send({ error: 'Invalid API key format' });
      return;
    }

    const hash = hashApiKey(apiKey);
    const agent = await db.agent.findUnique({
      where: { apiKeyHash: hash },
      select: { id: true, active: true, tier: true },
    });

    if (!agent) {
      reply.code(401).send({ error: 'Invalid API key' });
      return;
    }

    if (!agent.active) {
      reply.code(403).send({ error: 'Agent is deactivated' });
      return;
    }

    request.agentId = agent.id;
    request.agentTier = agent.tier;
  });

  done();
};

export const authMiddleware = fp(authPlugin);

/**
 * Generates a new API key. Returns the plaintext once — never stored.
 * Caller must store the hash in the DB.
 */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString('hex');
  const plaintext = `agfi_live_${raw}`;
  const hash = hashApiKey(plaintext);
  const prefix = plaintext.slice(0, 16); // e.g. "agfi_live_ab12cd"
  return { plaintext, hash, prefix };
}
