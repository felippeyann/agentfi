import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { getWalletService } from '../../services/wallet/index.js';
import { SafeService } from '../../services/wallet/safe.service.js';
import { generateApiKey } from '../middleware/auth.js';
import { PolicyService } from '../../services/policy/policy.service.js';
import { ReputationService } from '../../services/policy/reputation.service.js';
import { PnLService } from '../../services/billing/pnl.service.js';
import { EnsService } from '../../services/identity/ens.service.js';
import { logger } from '../middleware/logger.js';
const turnkey = getWalletService();
const safeService = new SafeService();
const policyService = new PolicyService(db);
const reputationService = new ReputationService();
const pnlService = new PnLService();
const ensService = new EnsService();

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

/**
 * Shared agent provisioning logic — called by both the operator-gated
 * `POST /v1/agents` endpoint and the public `POST /v1/public/agents`
 * endpoint. Both paths produce identical agent records; they differ
 * only in authentication and (for the public path) forced tier + rate
 * limiting.
 */
async function provisionAgent(
  body: z.infer<typeof createAgentSchema>,
): Promise<{
  id: string;
  name: string;
  apiKey: string;
  apiKeyPrefix: string;
  walletAddress: string;
  safeAddress: string;
  chainIds: number[];
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  ensName: string | null;
}> {
  const { plaintext, hash, prefix } = generateApiKey();

  // Provision wallet (Turnkey MPC or local, via factory).
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
    logger.info(
      'SAFE_DEPLOYER_PRIVATE_KEY not set — skipping Safe deployment, using EOA',
    );
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

  // Best-effort ENS subdomain registration. Failure here must not block
  // the agent from being usable — we simply leave ensName null.
  let ensName: string | null = null;
  if (ensService.isConfigured()) {
    const result = await ensService.registerSubdomain({
      name: body.name,
      agentId: agent.id,
      targetAddress: safeAddress,
    });
    if (result) {
      await db.agent.update({
        where: { id: agent.id },
        data: { ensName: result.fullName },
      });
      ensName = result.fullName;
    }
  }

  return {
    id: agent.id,
    name: agent.name,
    apiKey: plaintext, // shown once, never stored
    apiKeyPrefix: prefix,
    walletAddress: address,
    safeAddress,
    chainIds: body.chainIds,
    tier: body.tier,
    ensName,
  };
}

const updatePolicySchema = z.object({
  maxValuePerTxEth: z.string().optional(),
  maxDailyVolumeUsd: z.string().optional(),
  allowedContracts: z.array(z.string()).optional(),
  allowedTokens: z.array(z.string()).optional(),
  cooldownSeconds: z.number().optional(),
  active: z.boolean().optional(),
  /// ISO 8601 timestamp — sets a temporary policy that expires automatically (null clears expiry)
  expiresAt: z.string().datetime().nullish(),
  /// If true, returns calldata to sync this policy to the on-chain module
  syncOnChain: z.boolean().default(false),
});

export async function agentRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/agents — register a new agent, provision wallet, return API key.
   * The API key plaintext is returned ONCE. It cannot be recovered.
   */
  fastify.post('/v1/agents', async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const result = await provisionAgent(body);
    return reply.code(201).send(result);
  });

  /**
   * POST /v1/public/agents — open, unauthenticated self-registration.
   *
   * VISION.md calls for agents that can provision and fund their own wallets.
   * The operator-gated `/v1/agents` path requires a human-held `API_SECRET`;
   * this public path lets an agent bootstrap itself without one.
   *
   * Safeguards:
   *   - Per-IP rate limit (env `PUBLIC_REGISTRATION_RATE_LIMIT_PER_HOUR`,
   *     default 5). Operators can tighten via env.
   *   - Tier forced to FREE regardless of request body.
   *   - Policy defaults enforced even if caller omits them.
   *   - Wallet provisioning cost is real (when WALLET_PROVIDER=turnkey);
   *     rate limit caps operator's exposure.
   */
  fastify.post(
    '/v1/public/agents',
    {
      config: {
        rateLimit: {
          max: env.PUBLIC_REGISTRATION_RATE_LIMIT_PER_HOUR,
          timeWindow: '1 hour',
          keyGenerator: (request) => request.ip,
          errorResponseBuilder: (_request, context) => ({
            error: `Public agent registration rate limit exceeded. Retry after ${context.after}.`,
            hint: 'Contact the operator to register more agents via /v1/agents with API_SECRET, or self-host your own AgentFi instance.',
          }),
        },
      },
    },
    async (request, reply) => {
      const body = createAgentSchema.parse(request.body);
      // Force FREE tier — caller cannot self-assign PRO/ENTERPRISE.
      const result = await provisionAgent({ ...body, tier: 'FREE' });
      return reply.code(201).send(result);
    },
  );

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
      ensName: agent.ensName,
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
      ensName: agent.ensName,
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

    const { expiresAt, syncOnChain, ...policyFields } = updatePolicySchema.parse(request.body);

    // Convert ISO 8601 → Date for Prisma; undefined means field not touched
    const policyData: Record<string, unknown> = { ...policyFields };
    if (expiresAt !== undefined) {
      policyData['expiresAt'] = expiresAt ? new Date(expiresAt) : null;
    }

    const policy = await policyService.setPolicy(request.params.id, policyData as any);
    
    let onChainSync = null;
    if (syncOnChain) {
      const agent = await db.agent.findUniqueOrThrow({
        where: { id: request.params.id },
        select: { safeAddress: true, chainIds: true },
      });
      const chainId = agent.chainIds[0] ?? 1;
      const { getContracts } = await import('../../config/contracts.js');
      const contracts = getContracts(chainId);

      if (contracts.policyModule) {
        const actions: { to: string; value: string; data: string }[] = [];
        
        // 1. Sync core policy
        const coreCalldata = await policyService.onChain.buildSyncPolicyCalldata({
          safeAddress: agent.safeAddress as `0x${string}`,
          maxValuePerTxEth: policy.maxValuePerTxEth,
          cooldownSeconds: policy.cooldownSeconds,
          active: policy.active,
          expiresAt: policy.expiresAt,
        });
        actions.push({ to: contracts.policyModule, value: '0', data: coreCalldata });

        // 2. Sync whitelists if they were updated
        if (policyFields.allowedContracts) {
          const contractCalldata = await policyService.onChain.buildUpdateWhitelistCalldata({
            type: 'contract',
            safeAddress: agent.safeAddress as `0x${string}`,
            addresses: policyFields.allowedContracts,
            allowed: new Array(policyFields.allowedContracts.length).fill(true),
          });
          actions.push({ to: contracts.policyModule, value: '0', data: contractCalldata });
        }

        if (policyFields.allowedTokens) {
          const tokenCalldata = await policyService.onChain.buildUpdateWhitelistCalldata({
            type: 'token',
            safeAddress: agent.safeAddress as `0x${string}`,
            addresses: policyFields.allowedTokens,
            allowed: new Array(policyFields.allowedTokens.length).fill(true),
          });
          actions.push({ to: contracts.policyModule, value: '0', data: tokenCalldata });
        }

        onChainSync = {
          to: contracts.policyModule,
          chainId,
          actions,
          notice: "Execute these actions via 'execute_batch' to sync your policy on-chain."
        };
      }
    }

    return { ...policy, onChainSync };
  });

  /**
   * GET /v1/agents/:id/manifest — fetch the service manifest of a peer agent.
   */
  fastify.get<{ Params: { id: string } }>('/v1/agents/:id/manifest', async (request, reply) => {
    const agent = await db.agent.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        name: true,
        safeAddress: true,
        ensName: true,
        serviceManifest: true,
      },
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
   * Returns the signature + address so peers can verify-handshake.
   */
  fastify.post('/v1/agents/me/sign-handshake', async (request, reply) => {
    const schema = z.object({ message: z.string().min(1).max(4096) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const agent = await db.agent.findUnique({
      where: { id: request.agentId },
      select: { walletId: true, safeAddress: true },
    });
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    try {
      const { signature, address } = await turnkey.signMessage({
        walletId: agent.walletId,
        message: parsed.data.message,
      });
      return reply.send({
        message: parsed.data.message,
        signature,
        address,
        safeAddress: agent.safeAddress,
      });
    } catch (err) {
      logger.error({ err, agentId: request.agentId }, 'sign-handshake failed');
      return reply.code(500).send({
        error: 'Signing failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /v1/agents/verify-handshake — verify a peer's signature.
   *
   * Accepts either:
   *   - { message, signature, address }  — verifies signature at the
   *     given address (EOA via ECDSA recovery, or contract via EIP-1271)
   *   - { message, signature, agentId }  — looks the peer up in our DB
   *     and verifies against their registered safeAddress
   *
   * Returns { valid, address, verifiedVia: 'ecdsa' | 'eip1271' } on 200.
   * Rejects with 400 on bad input; does NOT return 200 when `valid: false`
   * to keep the API unambiguous.
   */
  fastify.post('/v1/agents/verify-handshake', async (request, reply) => {
    const schema = z.object({
      message: z.string().min(1).max(4096),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      agentId: z.string().min(1).optional(),
      chainId: z.number().int().default(1),
    }).refine((d) => d.address || d.agentId, {
      message: 'Either `address` or `agentId` is required',
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { message, signature, chainId } = parsed.data;

    let resolvedAddress = parsed.data.address;
    if (!resolvedAddress && parsed.data.agentId) {
      const peer = await db.agent.findUnique({
        where: { id: parsed.data.agentId },
        select: { safeAddress: true, active: true },
      });
      if (!peer || !peer.active) {
        return reply.code(404).send({ error: 'Peer agent not found or inactive' });
      }
      resolvedAddress = peer.safeAddress;
    }

    try {
      const { createPublicClient, http, getAddress, recoverMessageAddress } =
        await import('viem');
      const { getChain, getPrimaryRpcUrl } = await import('../../config/chains.js');

      const targetAddress = getAddress(resolvedAddress!);

      // First try ECDSA recovery (works for EOA). If the recovered address
      // matches the target, the target IS the signer.
      const recovered = await recoverMessageAddress({
        message,
        signature: signature as `0x${string}`,
      });
      if (getAddress(recovered) === targetAddress) {
        return reply.send({
          valid: true,
          address: targetAddress,
          verifiedVia: 'ecdsa',
        });
      }

      // If the target is a contract (Safe smart wallet), fall back to EIP-1271.
      const rpcUrl = getPrimaryRpcUrl(chainId);
      if (!rpcUrl) {
        return reply.send({
          valid: false,
          address: targetAddress,
          verifiedVia: 'ecdsa',
          reason: `ECDSA recovery mismatched; no RPC for chain ${chainId} to attempt EIP-1271.`,
        });
      }
      const publicClient = createPublicClient({
        chain: getChain(chainId),
        transport: http(rpcUrl),
      });
      const valid = await publicClient.verifyMessage({
        address: targetAddress,
        message,
        signature: signature as `0x${string}`,
      });
      return reply.send({
        valid,
        address: targetAddress,
        verifiedVia: valid ? 'eip1271' : 'ecdsa',
      });
    } catch (err) {
      logger.warn({ err }, 'verify-handshake error');
      return reply.code(400).send({
        error: 'Verification failed',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /v1/agents/me/pnl — profit & loss breakdown for the current agent.
   *
   * Directly serves the VISION.md thesis: "the moment an agent's earnings
   * exceed its costs, it has crossed a line that no AI system has crossed before."
   *
   * Query param:
   *   - since: optional ISO8601 period start (defaults to agent.createdAt)
   */
  fastify.get('/v1/agents/me/pnl', async (request, reply) => {
    const query = request.query as { since?: string };
    const since = query.since ? new Date(query.since) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      return reply.code(400).send({ error: 'Invalid `since` parameter (must be ISO8601)' });
    }
    return pnlService.computeAgentPnL({
      agentId: request.agentId,
      ...(since ? { since } : {}),
    });
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
