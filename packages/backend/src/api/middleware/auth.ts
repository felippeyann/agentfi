/**
 * API key authentication middleware for Fastify.
 * Agents authenticate via `x-api-key` header.
 * Keys are stored hashed (SHA-256) — plaintext never persists.
 */

import type { FastifyRequest, FastifyReply, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { db } from '../../db/client.js';

declare module 'fastify' {
  interface FastifyRequest {
    agentId: string;
    agentTier: 'FREE' | 'PRO' | 'ENTERPRISE';
    /**
     * `true` when the request was authenticated with the operator `API_SECRET`
     * rather than an agent key. Operator requests have no `agentId`.
     */
    isOperator: boolean;
  }
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Routes (`METHOD /route/pattern`) that accept the operator `API_SECRET` as an
 * alternative to an agent key. Keep this list short and explicit — operator
 * authority is only granted where a handler checks `request.isOperator`.
 */
const OPERATOR_CAPABLE_ROUTES: ReadonlySet<string> = new Set(['PATCH /v1/agents/:id/policy']);

/** Constant-time comparison of a presented `x-api-key` against the operator `API_SECRET`. */
export function isOperatorKey(presented: unknown): boolean {
  const expected = process.env['API_SECRET'] ?? '';
  if (typeof presented !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const authPlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.decorateRequest('agentId', '');
  fastify.decorateRequest('agentTier', 'FREE');
  fastify.decorateRequest('isOperator', false);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public / separately-authenticated endpoints
    const routeUrl = request.routeOptions?.url;
    if (routeUrl?.startsWith('/health')) return;
    if (routeUrl?.startsWith('/admin')) return;
    if (routeUrl?.startsWith('/.well-known')) return;
    if (routeUrl?.startsWith('/v1/public/')) return;
    if (routeUrl === '/v1/billing/webhook') return;
    if (routeUrl === '/v1/agents/search') return;
    if (routeUrl === '/v1/agents/verify-handshake') return;
    if (routeUrl === '/v1/agents/:id/manifest') return;
    if (routeUrl === '/v1/agents/:id/trust-report') return;
    // ERC-8004 feedback file: its keccak256 is committed on-chain by the
    // ReputationHook and any reputation consumer must be able to fetch it.
    if (routeUrl === '/v1/jobs/:id/feedback.json') return;
    // ERC-8004 registration file: the agentURI minted into the Identity
    // Registry (R2); explorers and reputation consumers resolve it anonymously.
    if (routeUrl === '/v1/agents/:id/erc8004.json') return;
    if (routeUrl?.startsWith('/mcp')) return;

    // Agent registration uses the operator API_SECRET, not an agent key
    if (routeUrl === '/v1/agents' && request.method === 'POST') {
      if (!isOperatorKey(request.headers['x-api-key'])) {
        reply.code(401).send({ error: 'Agent registration requires operator API_SECRET' });
        return;
      }
      request.isOperator = true;
      return;
    }

    // A few routes accept EITHER an agent key or the operator API_SECRET
    // (e.g. loosening an agent's policy). Anything else presented with the
    // operator secret falls through to the agent-key checks below and is rejected.
    if (
      routeUrl &&
      OPERATOR_CAPABLE_ROUTES.has(`${request.method} ${routeUrl}`) &&
      isOperatorKey(request.headers['x-api-key'])
    ) {
      request.isOperator = true;
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
