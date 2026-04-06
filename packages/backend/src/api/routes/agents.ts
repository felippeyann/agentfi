import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { TurnkeyService } from '../../services/wallet/turnkey.service.js';
import { SafeService } from '../../services/wallet/safe.service.js';
import { generateApiKey } from '../middleware/auth.js';
import { PolicyService } from '../../services/policy/policy.service.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { logger } from '../middleware/logger.js';

const db = new PrismaClient();
const turnkey = new TurnkeyService();
const safeService = new SafeService();
const policyService = new PolicyService(db);
const reputationService = new ReputationService();

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  chainIds: z.array(z.number()).min(1).default([1]),
  tier: z.enum(['FREE', 'PRO', 'ENTERPRISE']).default('FREE'),
  policy: z
    .object({
      maxValuePerTxEth: z.string().default('1.0'),
      maxDailyVolumeUsd: z.string().default('10000'),
      allowedContracts: z.array(z.string()).default([]),
      allowedTokens: z.array(z.string()).default([]),
      cooldownSeconds: z.number().default(60),
    })
    .optional(),
});

const updatePolicySchema = z.object({
  maxValuePerTxEth: z.string().optional(),
  maxDailyVolumeUsd: z.string().optional(),
  allowedContracts: z.array(z.string()).optional(),
  allowedTokens: z.array(z.string()).optional(),
  cooldownSeconds: z.number().optional(),
  active: z.boolean().optional(),
  /// ISO 8601 timestamp — sets a temporary policy that expires automatically (null clears expiry)
  expiresAt: z.string().datetime().nullish(),
});

export async function agentRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/agents — register a new agent, provision wallet, return API key.
   * The API key plaintext is returned ONCE. It cannot be recovered.
   */
  fastify.post('/v1/agents', async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const { plaintext, hash, prefix } = generateApiKey();

    // Provision Turnkey MPC wallet
    const { walletId, address } = await turnkey.createWallet(body.name);

    // Deploy Safe smart wallet if a deployer key is configured.
    // Falls back to EOA address for testnet / local dev without a funded deployer.
    let safeAddress = address;
    const deployerKey = process.env['SAFE_DEPLOYER_PRIVATE_KEY'];
    const primaryChain = body.chainIds[0] ?? 1;

    if (deployerKey) {
      try {
        const deployed = await safeService.deploySafeForAgent({
          ownerAddress: address as `0x${string}`,
          chainId: primaryChain,
          signerPrivateKey: deployerKey,
        });
        safeAddress = deployed.safeAddress;
        logger.info({ agentId: 'pending', safeAddress }, 'Safe deployed');
      } catch (err) {
        logger.warn({ err }, 'Safe deployment failed — using EOA address as fallback');
      }
    } else {
      logger.info('SAFE_DEPLOYER_PRIVATE_KEY not set — skipping Safe deployment, using EOA');
    }

    const agent = await db.agent.create({
      data: {
        name: body.name,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        walletId,
        safeAddress,
        chainIds: body.chainIds,
        tier: body.tier,
        billing: { create: {} },
        ...(body.policy && {
          policy: {
            create: {
              maxValuePerTxEth: body.policy.maxValuePerTxEth,
              maxDailyVolumeUsd: body.policy.maxDailyVolumeUsd,
              allowedContracts: body.policy.allowedContracts,
              allowedTokens: body.policy.allowedTokens,
              cooldownSeconds: body.policy.cooldownSeconds,
            },
          },
        }),
      },
    });

    logger.info({ agentId: agent.id, name: body.name }, 'Agent registered');

    // Return plaintext API key only once
    return reply.code(201).send({
      id: agent.id,
      name: agent.name,
      apiKey: plaintext, // shown once, never stored
      apiKeyPrefix: prefix,
      walletAddress: address,
      safeAddress,
      chainIds: body.chainIds,
      tier: body.tier,
    });
  });

  /**
   * GET /v1/agents/search — public discovery for agents. 
   * Returns a list of agents filtered by name or address.
   */
  fastify.get('/v1/agents/search', async (request, reply) => {
    try {
      const { q } = z.object({ q: z.string().min(2) }).parse(request.query);

      const agents = await db.agent.findMany({
        where: {
          active: true,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { safeAddress: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          safeAddress: true,
          chainIds: true,
          tier: true,
        },
        take: 10,
      });

      return { agents };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: err.errors });
      }
      throw err;
    }
  });

  /**
   * GET /v1/agents/me — agent info resolved from API key. Used by MCP server.
   */
  fastify.get('/v1/agents/me', async (request) => {
    const agent = await db.agent.findUnique({
      where: { id: request.agentId },
      include: { policy: true, billing: true },
    });

    if (!agent) return { error: 'Agent not found' };

    return {
      id: agent.id,
      name: agent.name,
      apiKeyPrefix: agent.apiKeyPrefix,
      walletAddress: agent.safeAddress,
      chainIds: agent.chainIds,
      active: agent.active,
      tier: agent.tier,
      policy: agent.policy,
      billing: agent.billing
        ? {
            txCountThisPeriod: agent.billing.txCountThisPeriod,
            totalFeesCollectedUsd: agent.billing.totalFeesCollectedUsd,
            subscriptionActive: agent.billing.subscriptionActive,
          }
        : null,
    };
  });

  /**
   * GET /v1/agents/:id — agent status and config.
   */
  fastify.get<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    if (request.agentId !== request.params.id) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const agent = await db.agent.findUnique({
      where: { id: request.params.id },
      include: { policy: true, billing: true },
    });

    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    return {
      id: agent.id,
      name: agent.name,
      apiKeyPrefix: agent.apiKeyPrefix,
      walletAddress: agent.safeAddress,
      chainIds: agent.chainIds,
      active: agent.active,
      tier: agent.tier,
      policy: agent.policy,
      billing: agent.billing
        ? {
            txCountThisPeriod: agent.billing.txCountThisPeriod,
            totalFeesCollectedUsd: agent.billing.totalFeesCollectedUsd,
            subscriptionActive: agent.billing.subscriptionActive,
          }
        : null,
    };
  });

  /**
   * PATCH /v1/agents/:id/policy — update operational policy.
   *
   * Pass `expiresAt` (ISO 8601) to create a temporary task-scoped policy.
   * The policy will be automatically rejected after that timestamp.
   * Pass `expiresAt: null` to clear a previous expiry and make the policy permanent.
   */
  fastify.patch<{ Params: { id: string } }>('/v1/agents/:id/policy', async (request, reply) => {
    if (request.agentId !== request.params.id) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    const { expiresAt, ...policyFields } = updatePolicySchema.parse(request.body);

    // Convert ISO 8601 → Date for Prisma; undefined means field not touched
    const policyData: Record<string, unknown> = { ...policyFields };
    if (expiresAt !== undefined) {
      policyData['expiresAt'] = expiresAt ? new Date(expiresAt) : null;
    }

    const agent = await policyService.setPolicy(request.params.id, policyData as any);
    return agent;
  });

  /**
   * GET /v1/agents/:id/manifest — fetch the service manifest of a peer agent.
   */
  fastify.get<{ Params: { id: string } }>('/v1/agents/:id/manifest', async (request, reply) => {
    const agent = await db.agent.findUnique({
      where: { id: request.params.id },
      select: { id: true, name: true, safeAddress: true, serviceManifest: true },
    });

    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return agent;
  });

  /**
   * PATCH /v1/agents/me/manifest — update your own service manifest.
   */
  fastify.patch('/v1/agents/me/manifest', async (request, reply) => {
    const manifestSchema = z.object({
      manifest: z.record(z.any()),
    });

    const { manifest } = manifestSchema.parse(request.body);

    const agent = await db.agent.update({
      where: { id: request.agentId },
      data: { serviceManifest: manifest },
    });

    return { success: true, serviceManifest: agent.serviceManifest };
  });

  /**
   * GET /v1/agents/:id/trust-report — fetch the reputation and trust metrics of an agent.
   */
  fastify.get<{ Params: { id: string } }>('/v1/agents/:id/trust-report', async (request, reply) => {
    const agent = await db.agent.findUnique({
      where: { id: request.params.id },
      select: { 
        id: true, 
        name: true, 
        safeAddress: true, 
        reputationScore: true, 
        a2aTxCount: true, 
        lastActiveAt: true,
        createdAt: true 
      },
    });

    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return agent;
  });

  /**
   * POST /v1/agents/me/sign-handshake — sign a message using the agent's wallet.
   * Used to prove identity or sign service agreements.
   */
  fastify.post('/v1/agents/me/sign-handshake', async (request) => {
    const signSchema = z.object({
      message: z.string().min(1),
    });

    const { message } = signSchema.parse(request.body);
    const agent = await db.agent.findUniqueOrThrow({
      where: { id: request.agentId },
      select: { walletId: true, safeAddress: true },
    });

    // TODO: implement Turnkey message signing for A2A handshakes
    // const signature = await turnkey.signMessage(agent.walletId!, message);
    const signature = `placeholder-${Date.now()}`;

    return {
      message,
      signature,
      address: agent.safeAddress,
      signer: 'AgentFi-MPC'
    };
  });

  /**
   * POST /v1/agents/verify-handshake — verify a peer's signature.
   */
  fastify.post('/v1/agents/verify-handshake', async (request) => {
    const verifySchema = z.object({
      message: z.string(),
      signature: z.string(),
      address: z.string(),
    });

    const { message, signature, address } = verifySchema.parse(request.body);

    // Simple verification for now — in prod would use EIP-1271 via viem
    // or direct ECDSA recovery if it's an EOA fallback.
    return { 
      valid: true, 
      details: 'Logic Sentinel: Placeholder verification — trust but verify.' 
    };
  });

  /**
   * DELETE /v1/agents/:id — deactivate agent (soft delete).
   */
  fastify.delete<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    if (request.agentId !== request.params.id) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    await db.agent.update({
      where: { id: request.params.id },
      data: { active: false },
    });

    await policyService.emergencyPause(request.params.id);
    return reply.code(204).send();
  });
}
