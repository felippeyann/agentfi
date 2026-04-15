import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getAddress, parseUnits, maxUint256 } from 'viem';
import { db } from '../../db/client.js';
import { TransactionBuilder } from '../../services/transaction/builder.service.js';
import { SimulatorService } from '../../services/transaction/simulator.service.js';
import { ExecutorService } from '../../services/transaction/executor.service.js';
import { PolicyService } from '../../services/policy/policy.service.js';
import { FeeService } from '../../services/policy/fee.service.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { weiToUsd, tokenAmountToUsd } from '../../services/transaction/price.service.js';
import { cacheSimulation, getSimulation } from '../../services/transaction/simulation-cache.js';
import { getContracts } from '../../config/contracts.js';
import { createChainPublicClient } from '../../config/chains.js';
import { logger } from '../middleware/logger.js';
import { notificationService } from '../../services/notification.service.js';
import type { Address } from 'viem';
const builder = new TransactionBuilder();
const simulator = new SimulatorService();
const executor = new ExecutorService();
const policyService = new PolicyService(db);
const feeService = new FeeService(db);

const NATIVE_WETH_BY_CHAIN: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  8453: '0x4200000000000000000000000000000000000006',
  84532: '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
};

// Well-known token decimals by checksummed address (multi-chain)
const KNOWN_DECIMALS: Record<string, number> = {
  // USDC
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 6,  // ETH
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 6,  // Base
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 6,  // Arbitrum
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': 6,  // Polygon
  // USDT
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': 6,  // ETH
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': 6,  // Arbitrum
  // WBTC
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 8,  // ETH
  '0x68f180fcCe6836688e9084f035309E29Bf0A2095': 8,  // Optimism
};

const ERC20_DECIMALS_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

/**
 * Resolves token decimals: static map first, then on-chain lookup.
 */
async function getTokenDecimals(address: string, chainId: number): Promise<number> {
  const checksummed = getAddress(address);
  if (KNOWN_DECIMALS[checksummed] !== undefined) return KNOWN_DECIMALS[checksummed]!;

  const client = createChainPublicClient(chainId);

  const decimals = await client.readContract({
    address: checksummed as Address,
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
  });
  return Number(decimals);
}

// Uniswap V3 QuoterV2 ABI — get exact output amount before swapping
const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut',                  type: 'uint256' },
      { name: 'sqrtPriceX96After',          type: 'uint160' },
      { name: 'initializedTicksCrossed',    type: 'uint32'  },
      { name: 'gasEstimate',               type: 'uint256' },
    ],
  },
] as const;

// QuoterV2 addresses per chain
const QUOTER_ADDRESSES: Record<number, `0x${string}`> = {
  1:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  8453:  '0x3d4e44Eb1374240CE5F1B136aa68B6bF57c6F809',
  42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  137:   '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

/**
 * Gets expected amountOut from Uniswap QuoterV2.
 * Falls back to 0n on error (no slippage protection — acceptable for testnet).
 */
async function getQuotedAmountOut(params: {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  fee: number;
}): Promise<bigint> {
  try {
    const quoterAddress = QUOTER_ADDRESSES[params.chainId];
    if (!quoterAddress) return 0n;

    const client = createChainPublicClient(params.chainId);

    const [amountOut] = await client.simulateContract({
      address: quoterAddress,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn:           params.tokenIn,
        tokenOut:          params.tokenOut,
        amountIn:          params.amountIn,
        fee:               params.fee,
        sqrtPriceLimitX96: 0n,
      }],
    }).then(r => r.result as [bigint, bigint, number, bigint]);

    return amountOut;
  } catch {
    return 0n; // graceful fallback — no slippage protection on testnet
  }
}

const simulateSwapSchema = z.object({
  fromToken: z.string(),
  toToken: z.string(),
  amountIn: z.string(),
  chainId: z.number().default(1),
  slippageTolerance: z.number().min(0.01).max(50).default(0.5),
});

const executeSwapSchema = simulateSwapSchema.extend({
  simulationId: z.string().min(1),
  idempotencyKey: z.string().optional(),
});

const transferSchema = z.object({
  token: z.string(), // "ETH" or token address
  to: z.string(),
  amount: z.string(),
  chainId: z.number().default(1),
  idempotencyKey: z.string().optional(),
});

const depositSchema = z.object({
  asset: z.string(), // token address
  amount: z.string(),
  chainId: z.number().default(1),
  idempotencyKey: z.string().optional(),
});

const withdrawSchema = z.object({
  asset: z.string(),
  amount: z.string(), // "max" or decimal amount
  chainId: z.number().default(1),
  idempotencyKey: z.string().optional(),
});

export async function transactionRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/transactions/simulate — simulate without submitting.
   */
  fastify.post('/v1/transactions/simulate', async (request, reply) => {
    const body = simulateSwapSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;
    const amountInDecimals = await getTokenDecimals(body.fromToken, body.chainId);

    const txData = builder.buildUniswapSwap({
      chainId: body.chainId,
      tokenIn: getAddress(body.fromToken),
      tokenOut: getAddress(body.toToken),
      fee: 3000,
      recipient: getAddress(agent.safeAddress),
      amountIn: parseUnits(body.amountIn, amountInDecimals),
      amountOutMinimum: 0n,
    });

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    // Cache server-side so /swap can verify the simulationId was issued here
    if (sim.simulationId) {
      await cacheSimulation(sim.simulationId, {
        agentId: request.agentId,
        success: sim.success,
        chainId: body.chainId,
      }).catch(() => {}); // non-fatal — /swap will reject unknown IDs
    }

    return {
      success: sim.success,
      gasEstimate: sim.gasUsed,
      gasPrice: sim.gasPrice,
      error: sim.error,
      simulationId: sim.simulationId,
    };
  });

  /**
   * POST /v1/transactions/swap — execute a token swap.
   */
  fastify.post('/v1/transactions/swap', async (request, reply) => {
    const body = executeSwapSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    // Idempotency check
    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    // Verify simulationId was issued by this server for this agent
    const cachedSim = await getSimulation(body.simulationId).catch(() => null);
    if (!cachedSim) {
      return reply.code(422).send({
        error: 'Simulation ID not found or expired. Run simulate_swap first, then execute within 10 minutes.',
      });
    }
    if (cachedSim.agentId !== request.agentId) {
      return reply.code(403).send({ error: 'Simulation ID does not belong to this agent.' });
    }
    if (!cachedSim.success) {
      return reply.code(422).send({ error: 'Cannot execute a swap whose simulation failed. Run simulate_swap first.' });
    }

    // Check tx limit for tier
    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({
        error: `Monthly transaction limit reached for ${request.agentTier} tier. Upgrade to increase limits.`,
      });
    }

    const amountInDecimals = await getTokenDecimals(body.fromToken, body.chainId);
    const amountInWei = parseUnits(body.amountIn, amountInDecimals);
    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const isNativeInput = isNativeWeth(body.chainId, body.fromToken);

    // Policy check — target is the Uniswap router, not the token address
    const swapContracts = getContracts(body.chainId);
    const valueUsd = isNativeInput ? await weiToUsd(amountInWei, body.chainId) : '0';
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: swapContracts.uniswapV3Router,
      tokenAddress: getAddress(body.fromToken),
      valueEth: isNativeInput ? body.amountIn : '0',
      valueUsd,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    // Try fee tiers from most to least liquid — use first one that returns a quote
    const FEE_TIERS = [500, 3000, 10000] as const;
    let bestFee: 500 | 3000 | 10000 = 500;
    let quotedOut = 0n;

    for (const fee of FEE_TIERS) {
      const q = await getQuotedAmountOut({
        chainId: body.chainId,
        tokenIn:  getAddress(body.fromToken) as `0x${string}`,
        tokenOut: getAddress(body.toToken)   as `0x${string}`,
        amountIn: amountInWei,
        fee,
      });
      if (q > quotedOut) { quotedOut = q; bestFee = fee; }
    }

    const slippageBps = BigInt(Math.floor(body.slippageTolerance * 100)); // e.g. 1% → 100 bps
    const amountOutMinimum = quotedOut > 0n
      ? (quotedOut * (10000n - slippageBps)) / 10000n
      : 0n;

    logger.info({ bestFee, quotedOut: quotedOut.toString(), amountOutMinimum: amountOutMinimum.toString() }, 'Swap quote');

    const txData = builder.buildUniswapSwap({
      chainId: body.chainId,
      tokenIn: getAddress(body.fromToken),
      tokenOut: getAddress(body.toToken),
      fee: bestFee,
      recipient: getAddress(agent.safeAddress),
      amountIn: amountInWei,
      amountOutMinimum,
    });

    // Wrap via AgentExecutor for on-chain fee collection (if deployed on this chain)
    const wrapped = executor.wrapSingle(body.chainId, txData);
    logger.info({
      routedViaExecutor: wrapped.routedViaExecutor,
      feeWei: wrapped.feeWei.toString(),
    }, 'Executor wrap');

    // Simulate before submitting
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: wrapped.to,
      data: wrapped.data,
      value: wrapped.value,
    });

    if (!sim.success) {
      return reply.code(422).send({
        error: `Simulation failed: ${sim.error}`,
        simulationId: sim.simulationId,
      });
    }

    // Calculate fee
    const feeCalc = feeService.calculateFee({
      grossAmountWei: amountInWei,
      tier: request.agentTier,
    });

    // Create transaction record
    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'SWAP',
        fromToken: body.fromToken,
        toToken: body.toToken,
        amountIn: body.amountIn,
        simulation: sim as any,
        metadata: {
          simulationId: body.simulationId,
          queuePayload: {
            to: wrapped.to,
            data: wrapped.data,
            value: wrapped.value.toString(),
            feeAmountWei: wrapped.routedViaExecutor
              ? wrapped.feeWei.toString()
              : feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: wrapped.routedViaExecutor,
          },
        },
      },
    });

    // Enqueue for processing — ONLY if it doesn't require manual approval
    if (!policyResult.requiresApproval) {
      await transactionQueue.add(
        'swap',
        {
          transactionId: tx.id,
          chainId: body.chainId,
          walletId: agent.walletId,
          from: getAddress(agent.safeAddress),
          to: wrapped.to,
          data: wrapped.data,
          value: wrapped.value.toString(),
          agentId: request.agentId,
          tier: request.agentTier,
          feeAmountWei: wrapped.routedViaExecutor
            ? wrapped.feeWei.toString()
            : feeCalc.feeAmountWei.toString(),
          feeUsd: '0',
          feeBps: feeCalc.feeBps,
          routedViaExecutor: wrapped.routedViaExecutor,
        },
        { priority: 1 },
      );
    } else {
      // Notify operator of pending approval
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: (agent as any).name || 'Unknown Agent', // Name not currently in agent partial select, using fallback
        transactionId: tx.id,
        message: `High value SWAP (${body.amountIn} ${body.fromToken?.slice(0, 6)}...) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({
      transactionId: tx.id,
      status: tx.status,
      simulationId: sim.simulationId,
      fee: {
        bps: feeCalc.feeBps,
        amountWei: feeCalc.feeAmountWei.toString(),
        feeWallet: feeCalc.feeWallet,
      },
    });
  });

  /**
   * POST /v1/transactions/transfer — transfer ETH or ERC-20 token.
   */
  fastify.post('/v1/transactions/transfer', async (request, reply) => {
    const body = transferSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const isEthTransfer = body.token.toUpperCase() === 'ETH';
    const transferDecimals = isEthTransfer ? 18 : await getTokenDecimals(body.token, body.chainId);

    let txData;
    if (isEthTransfer) {
      txData = builder.buildEthTransfer({ to: getAddress(body.to), amountEth: body.amount });
    } else {
      txData = builder.buildTokenTransfer({
        tokenAddress: getAddress(body.token),
        to: getAddress(body.to),
        amount: body.amount,
        decimals: transferDecimals,
      });
    }

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const transferValueUsd = isEthTransfer
      ? await weiToUsd(txData.value, body.chainId)
      : await tokenAmountToUsd(
          parseUnits(body.amount, transferDecimals),
          body.token,
          transferDecimals,
          body.chainId,
        );
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: isEthTransfer ? getAddress(body.to) : txData.to,
      ...(!isEthTransfer ? { tokenAddress: getAddress(body.token) } : {}),
      valueEth: isEthTransfer ? body.amount : '0',
      valueUsd: transferValueUsd,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: txData.value > 0n ? txData.value : 0n,
      tier: request.agentTier,
    });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'TRANSFER',
        fromToken: body.token,
        toToken: body.to,
        amountIn: body.amount,
        simulation: sim as any,
        metadata: {
          queuePayload: {
            to: txData.to,
            data: txData.data,
            value: txData.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });

    if (!policyResult.requiresApproval) {
      await transactionQueue.add('transfer', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: txData.to,
        data: txData.data,
        value: txData.value.toString(),
        agentId: request.agentId,
        tier: request.agentTier,
        feeAmountWei: feeCalc.feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: feeCalc.feeBps,
        routedViaExecutor: false,
      });
    } else {
      // Notify operator of pending approval
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: agent.name,
        transactionId: tx.id,
        message: `High value TRANSFER (${body.amount} ${body.token}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/deposit — supply asset to Aave V3.
   */
  fastify.post('/v1/transactions/deposit', async (request, reply) => {
    const body = depositSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const { getContracts } = await import('../../config/contracts.js');
    const contracts = getContracts(body.chainId);

    // First: approve Aave pool to spend tokens
    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = parseUnits(body.amount, decimals);

    // Get actual Aave pool address from address provider
    const publicClient = createChainPublicClient(body.chainId);

    const poolAddress = await publicClient.readContract({
      address: contracts.aavePoolAddressProvider,
      abi: [
        {
          name: 'getPool',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const,
      functionName: 'getPool',
    });

    const supplyTx = builder.buildAaveSupply({
      poolAddress: poolAddress as Address,
      asset: getAddress(body.asset),
      amount: amountWei,
      onBehalfOf: getAddress(agent.safeAddress),
    });

    const depositLastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const depositValueUsd = await tokenAmountToUsd(amountWei, body.asset, decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: supplyTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: depositValueUsd,
      ...(depositLastTxTimestamp !== undefined ? { lastTxTimestamp: depositLastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    // Simulate supply tx
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: supplyTx.to,
      data: supplyTx.data,
      value: supplyTx.value,
    });

    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei, tier: request.agentTier });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'DEPOSIT',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
        metadata: {
          queuePayload: {
            to: supplyTx.to,
            data: supplyTx.data,
            value: supplyTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });

    if (!policyResult.requiresApproval) {
      await transactionQueue.add('deposit', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: supplyTx.to,
        data: supplyTx.data,
        value: supplyTx.value.toString(),
        agentId: request.agentId,
        tier: request.agentTier,
        feeAmountWei: feeCalc.feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: feeCalc.feeBps,
        routedViaExecutor: false,
      });
    } else {
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: agent.name,
        transactionId: tx.id,
        message: `High value DEPOSIT (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/withdraw — withdraw asset from Aave V3.
   */
  fastify.post('/v1/transactions/withdraw', async (request, reply) => {
    const body = withdrawSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const { getContracts } = await import('../../config/contracts.js');

    const contracts = getContracts(body.chainId);
    const publicClient = createChainPublicClient(body.chainId);

    const poolAddress = await publicClient.readContract({
      address: contracts.aavePoolAddressProvider,
      abi: [
        {
          name: 'getPool',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const,
      functionName: 'getPool',
    });

    const decimals = body.amount === 'max' ? 18 : await getTokenDecimals(body.asset, body.chainId);
    const amountWei = body.amount === 'max' ? maxUint256 : parseUnits(body.amount, decimals);

    const withdrawTx = builder.buildAaveWithdraw({
      poolAddress: poolAddress as Address,
      asset: getAddress(body.asset),
      amount: amountWei,
      to: getAddress(agent.safeAddress),
    });

    const withdrawLastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    // For max-withdraw, we can't know the exact amount until on-chain; pass '0' to avoid blocking on unknown value
    const withdrawValueUsd = amountWei === maxUint256
      ? '0'
      : await tokenAmountToUsd(amountWei, body.asset, decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: withdrawTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: withdrawValueUsd,
      ...(withdrawLastTxTimestamp !== undefined ? { lastTxTimestamp: withdrawLastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: withdrawTx.to,
      data: withdrawTx.data,
      value: withdrawTx.value,
    });

    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei === maxUint256 ? 0n : amountWei, tier: request.agentTier });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'WITHDRAW',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
        metadata: {
          queuePayload: {
            to: withdrawTx.to,
            data: withdrawTx.data,
            value: withdrawTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });

    if (!policyResult.requiresApproval) {
      await transactionQueue.add('withdraw', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: withdrawTx.to,
        data: withdrawTx.data,
        value: withdrawTx.value.toString(),
        agentId: request.agentId,
        tier: request.agentTier,
        feeAmountWei: feeCalc.feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: feeCalc.feeBps,
        routedViaExecutor: false,
      });
    } else {
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: agent.name,
        transactionId: tx.id,
        message: `High value WITHDRAW (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/supply-compound
   * Supplies an asset to Compound V3 (Comet USDC market).
   */
  fastify.post('/v1/transactions/supply-compound', async (request, reply) => {
    const body = depositSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const contracts = getContracts(body.chainId);
    if (!contracts.compoundCometUsdc) {
      return reply.code(400).send({ error: `Compound V3 not configured for chain ${body.chainId}` });
    }

    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = parseUnits(body.amount, decimals);

    const supplyTx = builder.buildCompoundSupply({
      cometAddress: contracts.compoundCometUsdc,
      asset: getAddress(body.asset),
      amount: amountWei,
    });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const valueUsd = await tokenAmountToUsd(amountWei, body.asset, decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: supplyTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: supplyTx.to,
      data: supplyTx.data,
      value: supplyTx.value,
    });
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei, tier: request.agentTier });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'DEPOSIT',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
        metadata: {
          protocol: 'compound-v3',
          queuePayload: {
            to: supplyTx.to,
            data: supplyTx.data,
            value: supplyTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });

    if (!policyResult.requiresApproval) {
      await transactionQueue.add('compound-supply', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: supplyTx.to,
        data: supplyTx.data,
        value: supplyTx.value.toString(),
        agentId: request.agentId,
        tier: request.agentTier,
        feeAmountWei: feeCalc.feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: feeCalc.feeBps,
        routedViaExecutor: false,
      });
    } else {
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: agent.name,
        transactionId: tx.id,
        message: `Compound supply (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/withdraw-compound
   * Withdraws an asset from Compound V3 (Comet USDC market).
   */
  fastify.post('/v1/transactions/withdraw-compound', async (request, reply) => {
    const body = withdrawSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const contracts = getContracts(body.chainId);
    if (!contracts.compoundCometUsdc) {
      return reply.code(400).send({ error: `Compound V3 not configured for chain ${body.chainId}` });
    }

    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = body.amount === 'max' ? maxUint256 : parseUnits(body.amount, decimals);

    const withdrawTx = builder.buildCompoundWithdraw({
      cometAddress: contracts.compoundCometUsdc,
      asset: getAddress(body.asset),
      amount: amountWei,
    });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const valueUsd =
      body.amount === 'max'
        ? '0'
        : await tokenAmountToUsd(amountWei, body.asset, decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: withdrawTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: policyResult.reason });
    }

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: withdrawTx.to,
      data: withdrawTx.data,
      value: withdrawTx.value,
    });
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: 0n,
      tier: request.agentTier,
    });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'WITHDRAW',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
        metadata: {
          protocol: 'compound-v3',
          queuePayload: {
            to: withdrawTx.to,
            data: withdrawTx.data,
            value: withdrawTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });

    if (!policyResult.requiresApproval) {
      await transactionQueue.add('compound-withdraw', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: withdrawTx.to,
        data: withdrawTx.data,
        value: withdrawTx.value.toString(),
        agentId: request.agentId,
        tier: request.agentTier,
        feeAmountWei: feeCalc.feeAmountWei.toString(),
        feeUsd: '0',
        feeBps: feeCalc.feeBps,
        routedViaExecutor: false,
      });
    } else {
      await notificationService.notify({
        type: 'PENDING_APPROVAL',
        agentId: request.agentId,
        agentName: agent.name,
        transactionId: tx.id,
        message: `Compound withdraw (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/batch — execute multiple raw calldata actions atomically.
   *
   * Each action maps directly to AgentExecutor.Action: { to, value, data }.
   * Actions are validated individually via PolicyService, then encoded into a single
   * AgentExecutor.executeBatch call — atomic: all succeed or all revert.
   *
   * Body: { chainId, actions: [{ to, value, data }], idempotencyKey? }
   *   - to:    target contract address
   *   - value: ETH value in wei (as decimal string, e.g. "0" or "1000000000000000")
   *   - data:  hex-encoded calldata (e.g. "0x" for plain ETH transfers)
   */
  fastify.post('/v1/transactions/batch', async (request, reply) => {
    const batchSchema = z.object({
      chainId: z.number().default(1),
      idempotencyKey: z.string().optional(),
      actions: z.array(z.object({
        to:    z.string(),
        value: z.string().default('0'),
        token: z.string().default('0x0000000000000000000000000000000000000000'),
        data:  z.string().regex(/^0x[0-9a-fA-F]*$/).default('0x'),
      })).min(1).max(20),
    });

    const body = batchSchema.parse(request.body);
    const agent = await getAgent(request.agentId);
    if (!ensureChainAllowed(agent, body.chainId, reply)) return;

    // Idempotency check
    if (body.idempotencyKey) {
      const idempotent = await getIdempotentTransaction(request.agentId, body.idempotencyKey);
      if (idempotent.existing) return idempotent.existing;
      if (idempotent.conflictWithAnotherAgent) {
        return reply.code(409).send({ error: 'idempotencyKey is already in use by another agent' });
      }
    }

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const contracts = getContracts(body.chainId);
    if (!contracts.executor) {
      return reply.code(400).send({
        error: `AgentExecutor not deployed on chain ${body.chainId}. Deploy contracts first.`,
      });
    }

    // Validate each action individually via PolicyService before touching the chain
    for (let i = 0; i < body.actions.length; i++) {
      const action = body.actions[i]!;
      const valueWei = BigInt(action.value);
      const policyResult = await policyService.validateTransaction({
        agentId: request.agentId,
        targetContract: getAddress(action.to),
        valueEth: weiToEthDecimalString(valueWei),
        ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
      });
      if (!policyResult.allowed) {
        return reply.code(403).send({
          error: `Action at index ${i} blocked by policy: ${policyResult.reason}`,
          actionIndex: i,
        });
      }
    }

    const { encodeFunctionData } = await import('viem');

    // Build on-chain action array (matches AgentExecutor.Action struct)
    type OnChainAction = { target: Address; value: bigint; token: Address; data: `0x${string}` };
    const onChainActions: OnChainAction[] = body.actions.map(a => ({
      target: getAddress(a.to) as Address,
      value:  BigInt(a.value),
      token:  getAddress(a.token) as Address,
      data:   a.data as `0x${string}`,
    }));
    const totalValueWei = onChainActions.reduce((sum, a) => sum + a.value, 0n);

    // AgentExecutor.executeBatch ABI
    const EXECUTOR_ABI = [{
      name: 'executeBatch',
      type: 'function',
      stateMutability: 'payable',
      inputs: [{
        name: 'actions',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value',  type: 'uint256' },
          { name: 'token',  type: 'address' },
          { name: 'data',   type: 'bytes'   },
        ],
      }],
      outputs: [],
    }] as const;

    const batchCalldata = encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [onChainActions],
    });

    // Simulate the full batch against the executor contract
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: contracts.executor,
      data: batchCalldata,
      value: totalValueWei,
    });

    if (!sim.success) {
      return reply.code(422).send({
        error: `Batch simulation failed: ${sim.error}`,
        simulationId: sim.simulationId,
      });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: totalValueWei, tier: request.agentTier });

    const tx = await db.transaction.create({
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: 'QUEUED',
        type: 'BATCH',
        amountIn: totalValueWei.toString(),
        simulation: sim as any,
        metadata: { actionCount: body.actions.length, actions: body.actions },
      },
    });

    await transactionQueue.add('batch', {
      transactionId: tx.id,
      chainId: body.chainId,
      walletId: agent.walletId,
      from: getAddress(agent.safeAddress),
      to: contracts.executor,
      data: batchCalldata,
      value: totalValueWei.toString(),
      agentId: request.agentId,
      tier: request.agentTier,
      feeAmountWei: feeCalc.feeAmountWei.toString(),
      feeUsd: '0',
      feeBps: feeCalc.feeBps,
      routedViaExecutor: true,
    });

    return reply.code(202).send({
      transactionId: tx.id,
      status: 'QUEUED',
      actionCount: body.actions.length,
      simulationId: sim.simulationId,
      fee: {
        bps: feeCalc.feeBps,
        amountWei: feeCalc.feeAmountWei.toString(),
        feeWallet: feeCalc.feeWallet,
      },
    });
  });

  /**
   * GET /v1/transactions/:id — get single transaction status.
   */
  fastify.get<{ Params: { id: string } }>('/v1/transactions/:id', async (request, reply) => {
    const tx = await db.transaction.findFirst({
      where: { id: request.params.id, agentId: request.agentId },
    });
    if (!tx) return reply.code(404).send({ error: 'Transaction not found' });
    return tx;
  });

  /**
   * GET /v1/public/transactions/:id — public endpoint for the UI, no auth required but restricted view.
   */
  fastify.get<{ Params: { id: string } }>('/v1/public/transactions/:id', async (request, reply) => {
    const tx = await db.transaction.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        status: true,
        type: true,
        chainId: true,
        txHash: true,
        fromToken: true,
        toToken: true,
        amountIn: true,
        amountOut: true,
        error: true,
        simulation: true,
        createdAt: true,
        confirmedAt: true,
      },
    });

    if (!tx) return reply.code(404).send({ error: 'Transaction not found' });
    return tx;
  });

  /**
   * GET /v1/transactions — paginated transaction history.
   */
  fastify.get('/v1/transactions', async (request) => {
    const query = request.query as { page?: string; limit?: string; status?: string };
    const page = parseInt(query.page ?? '1');
    const limit = Math.min(parseInt(query.limit ?? '20'), 100);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      db.transaction.findMany({
        where: {
          agentId: request.agentId,
          ...(query.status && { status: query.status as any }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      db.transaction.count({ where: { agentId: request.agentId } }),
    ]);

    return { transactions, total, page, limit };
  });
}

async function getAgent(agentId: string) {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { name: true, safeAddress: true, walletId: true, chainIds: true },
  });
  if (!agent) throw new Error('Agent not found');
  return agent;
}

function ensureChainAllowed(
  agent: { chainIds: number[] },
  chainId: number,
  reply: FastifyReply,
): boolean {
  if (agent.chainIds.includes(chainId)) return true;
  reply.code(403).send({ error: `Chain ${chainId} is not enabled for this agent` });
  return false;
}

async function getIdempotentTransaction(agentId: string, idempotencyKey: string): Promise<{
  existing: Awaited<ReturnType<typeof db.transaction.findFirst>>;
  conflictWithAnotherAgent: boolean;
}> {
  const existingForAgent = await db.transaction.findUnique({
    where: {
      agentId_idempotencyKey: {
        agentId,
        idempotencyKey,
      },
    },
  });
  if (existingForAgent) return { existing: existingForAgent, conflictWithAnotherAgent: false };

  const existingForOtherAgent = await db.transaction.findFirst({
    where: { idempotencyKey },
    select: { id: true },
  });
  return {
    existing: null,
    conflictWithAnotherAgent: !!existingForOtherAgent,
  };
}

async function getLatestAgentTxTimestamp(agentId: string): Promise<number | undefined> {
  const latest = await db.transaction.findFirst({
    where: {
      agentId,
      status: { in: ['PENDING_APPROVAL', 'QUEUED', 'SUBMITTED', 'CONFIRMED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (!latest) return undefined;
  return Math.floor(latest.createdAt.getTime() / 1000);
}

function isNativeWeth(chainId: number, tokenAddress: string): boolean {
  return (NATIVE_WETH_BY_CHAIN[chainId] ?? '').toLowerCase() === tokenAddress.toLowerCase();
}

function weiToEthDecimalString(valueWei: bigint): string {
  if (valueWei === 0n) return '0';
  const whole = valueWei / 1_000_000_000_000_000_000n;
  const fraction = (valueWei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}


/**
 * Executes an internal transfer for A2A job payment.
 *
 * Called programmatically from jobs.ts when a Job transitions to COMPLETED.
 * Bypasses HTTP auth (requester's API key is not available in this context) but
 * still runs policy, simulation, fee calculation, and queueing exactly like
 * the public /v1/transactions/transfer endpoint.
 *
 * @param params.requesterId - Agent paying for the job
 * @param params.providerSafeAddress - Recipient address (provider's Safe)
 * @param params.amount - Amount in human units (e.g. "0.01")
 * @param params.token - "ETH" or a token contract address
 * @param params.chainId - Chain to execute on
 * @param params.jobId - Job ID for metadata tracking
 * @returns transactionId and final status
 */
export async function executeA2APayment(params: {
  requesterId: string;
  providerSafeAddress: string;
  amount: string;
  token: string;
  chainId: number;
  jobId: string;
}): Promise<{ transactionId: string; status: string }> {
  const requester = await db.agent.findUnique({
    where: { id: params.requesterId },
    select: {
      id: true,
      name: true,
      safeAddress: true,
      walletId: true,
      chainIds: true,
      active: true,
      tier: true,
    },
  });
  if (!requester) {
    throw new Error(`Requester agent ${params.requesterId} not found`);
  }
  if (!requester.active) {
    throw new Error(`Requester agent ${params.requesterId} is deactivated`);
  }
  if (!requester.chainIds.includes(params.chainId)) {
    throw new Error(`Requester does not support chainId ${params.chainId}`);
  }

  const tier = requester.tier;
  const withinLimit = await feeService.checkTxLimit(requester.id, tier);
  if (!withinLimit) {
    throw new Error('Requester has reached monthly transaction limit');
  }

  const isEthTransfer = params.token.toUpperCase() === 'ETH';
  const transferDecimals = isEthTransfer
    ? 18
    : await getTokenDecimals(params.token, params.chainId);

  const txData = isEthTransfer
    ? builder.buildEthTransfer({
        to: getAddress(params.providerSafeAddress),
        amountEth: params.amount,
      })
    : builder.buildTokenTransfer({
        tokenAddress: getAddress(params.token),
        to: getAddress(params.providerSafeAddress),
        amount: params.amount,
        decimals: transferDecimals,
      });

  const lastTxTimestamp = await getLatestAgentTxTimestamp(requester.id);
  const transferValueUsd = isEthTransfer
    ? await weiToUsd(txData.value, params.chainId)
    : await tokenAmountToUsd(
        parseUnits(params.amount, transferDecimals),
        params.token,
        transferDecimals,
        params.chainId,
      );

  const policyResult = await policyService.validateTransaction({
    agentId: requester.id,
    targetContract: isEthTransfer
      ? getAddress(params.providerSafeAddress)
      : txData.to,
    ...(!isEthTransfer ? { tokenAddress: getAddress(params.token) } : {}),
    valueEth: isEthTransfer ? params.amount : '0',
    valueUsd: transferValueUsd,
    ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
  });
  if (!policyResult.allowed) {
    throw new Error(`Policy check failed: ${policyResult.reason}`);
  }

  const sim = await simulator.simulate({
    chainId: params.chainId,
    from: getAddress(requester.safeAddress),
    to: txData.to,
    data: txData.data,
    value: txData.value,
  });
  if (!sim.success) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const feeCalc = feeService.calculateFee({
    grossAmountWei: txData.value > 0n ? txData.value : 0n,
    tier,
  });

  const tx = await db.transaction.create({
    data: {
      agentId: requester.id,
      chainId: params.chainId,
      status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
      type: 'TRANSFER',
      fromToken: params.token,
      toToken: params.providerSafeAddress,
      amountIn: params.amount,
      simulation: sim as any,
      metadata: {
        jobId: params.jobId,
        a2aPayment: true,
        queuePayload: {
          to: txData.to,
          data: txData.data,
          value: txData.value.toString(),
          feeAmountWei: feeCalc.feeAmountWei.toString(),
          feeBps: feeCalc.feeBps,
          routedViaExecutor: false,
        },
      },
    },
  });

  if (!policyResult.requiresApproval) {
    await transactionQueue.add('a2a-payment', {
      transactionId: tx.id,
      chainId: params.chainId,
      walletId: requester.walletId,
      from: getAddress(requester.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value.toString(),
      agentId: requester.id,
      tier,
      feeAmountWei: feeCalc.feeAmountWei.toString(),
      feeUsd: '0',
      feeBps: feeCalc.feeBps,
      routedViaExecutor: false,
    });
  } else {
    await notificationService.notify({
      type: 'PENDING_APPROVAL',
      agentId: requester.id,
      agentName: requester.name,
      transactionId: tx.id,
      message: `A2A payment for job ${params.jobId} (${params.amount} ${params.token}) requires approval.`,
    });
  }

  logger.info(
    { jobId: params.jobId, transactionId: tx.id, status: tx.status },
    'A2A payment queued',
  );

  return { transactionId: tx.id, status: tx.status };
}
