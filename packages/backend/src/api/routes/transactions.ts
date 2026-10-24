import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma, type Transaction } from '@prisma/client';
import { getAddress, isAddress, parseUnits, maxUint256, zeroAddress } from 'viem';
import { db } from '../../db/client.js';
import { TransactionBuilder } from '../../services/transaction/builder.service.js';
import { SimulatorService } from '../../services/transaction/simulator.service.js';
import {
  assertSimulationUsable,
  ensureSimulationUsable,
} from '../../services/transaction/simulation-guard.js';
import { ExecutorService, executorBatchValue, executorChargedFee } from '../../services/transaction/executor.service.js';
import { AGENT_EXECUTOR_ABI } from '../../abi/AgentExecutor.abi.js';
import { PolicyService, type PolicyValidationResult } from '../../services/policy/policy.service.js';
import { createTransactionWithVolume, settleVolumeAfterFailure } from '../../services/policy/daily-volume.js';
import { FeeService } from '../../services/policy/fee.service.js';
import { transactionQueue } from '../../queues/transaction.queue.js';
import { transactionJobId } from '../../queues/transaction-job-id.js';
import {
  countedUsd,
  priceNativeSpend,
  priceSourceOf,
  priceTokenSpend,
  sumSpendPricings,
  unknownAmountSpend,
  type SpendPricing,
} from '../../services/policy/spend-pricing.js';
import { classifyBatchCalldata } from '../../services/policy/batch-calldata.js';
import { MAX_AMOUNT_UNPRICED, maxWithdrawalPricing } from '../../services/policy/max-withdrawal-proof.js';
import { judgeOutflowCap } from '../../services/policy/outflow-cap.js';
import { getWalletService } from '../../services/wallet/index.js';
import { parsePolicyDecimal } from '../../services/policy/policy-numbers.js';
import { getKnownTokenDecimals } from '../../services/transaction/token-registry.js';
import { cacheSimulation, getSimulation } from '../../services/transaction/simulation-cache.js';
import { getContracts, UNISWAP_V3_QUOTER_V2 } from '../../config/contracts.js';
import { createChainPublicClient } from '../../config/chains.js';
import { logger } from '../middleware/logger.js';
import { refuseUnverifiedContracts } from '../contracts-gate.js';
import { sanitizeContextFromEnv, sanitizeErrorFields, type SanitizeContext } from '../errors/sanitize.js';
import { notificationService } from '../../services/notification.service.js';
import type { Address } from 'viem';
const builder = new TransactionBuilder();
const simulator = new SimulatorService();
const executor = new ExecutorService(logger);
const policyService = new PolicyService(db);
const feeService = new FeeService(db);

const NATIVE_WETH_BY_CHAIN: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  8453: '0x4200000000000000000000000000000000000006',
  84532: '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
};

const ERC20_DECIMALS_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

/**
 * Resolves token decimals: static map first, then on-chain lookup.
 */
async function getTokenDecimals(address: string, chainId: number): Promise<number> {
  const checksummed = getAddress(address);
  const knownDecimals = getKnownTokenDecimals(checksummed, chainId);
  if (knownDecimals !== undefined) return knownDecimals;

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

/**
 * Gets expected amountOut from Uniswap QuoterV2 (`UNISWAP_V3_QUOTER_V2`, with
 * its sources, in config/contracts.ts — S7: the Base entry here was a wrong
 * address that viem refused, so every Base swap fell back to 0).
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
    const quoterAddress = UNISWAP_V3_QUOTER_V2[params.chainId];
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

/**
 * An address as viem's strict `isAddress` reads it: all-lowercase, or mixed
 * case with a valid EIP-55 checksum. `getAddress` alone is not enough: it
 * checks the hex shape only and re-checksums a mixed-case address whose
 * checksum is wrong (a typo) instead of refusing it (review of #181).
 */
const STRICT_ADDRESS_MESSAGE = 'must be a 0x-prefixed 20-byte address, all-lowercase or with a valid EIP-55 checksum';
const isStrictAddress = (value: string) => isAddress(value, { strict: true });

const transferSchema = z.object({
  // "ETH" (the chain's native asset, any case) or an ERC-20 contract address.
  token: z.string().refine((value) => value.toUpperCase() === 'ETH' || isStrictAddress(value), {
    message:
      'must be "ETH" or an ERC-20 contract address (all-lowercase or with a valid EIP-55 checksum); symbols are not resolved',
  }),
  to: z.string().refine(isStrictAddress, { message: STRICT_ADDRESS_MESSAGE }),
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

const erc4626DepositSchema = z.object({
  vault: z.string(), // vault contract address
  asset: z.string(), // underlying token address (for decimals lookup + USD pricing)
  amount: z.string(),
  chainId: z.number().default(1),
  idempotencyKey: z.string().optional(),
});

const erc4626WithdrawSchema = z.object({
  vault: z.string(),
  asset: z.string(),
  amount: z.string(), // "max" or decimal amount
  chainId: z.number().default(1),
  idempotencyKey: z.string().optional(),
});

const swapCurveSchema = z.object({
  pool: z.string(),                                   // Curve pool address
  fromTokenIndex: z.number().int().min(0).max(7),     // int128 in pool
  toTokenIndex: z.number().int().min(0).max(7),
  fromTokenAddress: z.string(),                       // for decimals + policy
  toTokenAddress: z.string(),                         // for metadata
  amountIn: z.string(),
  minAmountOut: z.string(),
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

    // A mock result must never be cached as a usable simulation in production.
    if (!ensureSimulationUsable(sim, reply)) return;

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

    // Policy check — target is the Uniswap router, not the token address.
    // Q9: the input is the spend — WETH priced as the native asset (as
    // before), any other ERC-20 input priced as that token (was: counted 0).
    const swapContracts = getContracts(body.chainId);
    const pricing = isNativeInput
      ? await priceNativeSpend(amountInWei, body.chainId)
      : await priceTokenSpend(amountInWei, getAddress(body.fromToken), amountInDecimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: swapContracts.uniswapV3Router,
      tokenAddress: getAddress(body.fromToken),
      valueEth: isNativeInput ? body.amountIn : '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6: the swap input leaves the wallet
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

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
    // S9: the executor receives this transaction's value — only once it is verified.
    if (wrapped.routedViaExecutor && refuseUnverifiedContracts(reply, body.chainId, 'a swap routed through the AgentExecutor')) return;

    // Simulate before submitting
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: wrapped.to,
      data: wrapped.data,
      value: wrapped.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
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
    // A6e(2): routed through the executor, the swap is charged F = the
    // executor's 30 bps on every tier (`wrapSingle`), and that is what is
    // reported and recorded. Not routed (an ERC-20 input, or no executor on
    // the chain), nothing is collected on-chain and the tier schedule is
    // reported as before (no FeeEvent is written for it).
    const chargedFee = wrapped.routedViaExecutor
      ? executorChargedFee(wrapped.feeWei)
      : { feeBps: feeCalc.feeBps, feeAmountWei: feeCalc.feeAmountWei };

    // Create transaction record
    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
            feeAmountWei: chargedFee.feeAmountWei.toString(),
            feeBps: chargedFee.feeBps,
            routedViaExecutor: wrapped.routedViaExecutor,
          },
        },
      },
    });
    if (!tx) return;

    // Enqueue for processing — ONLY if it doesn't require manual approval
    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 
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
          feeAmountWei: chargedFee.feeAmountWei.toString(),
          feeUsd: '0',
          feeBps: chargedFee.feeBps,
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
        bps: chargedFee.feeBps,
        amountWei: chargedFee.feeAmountWei.toString(),
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
    const pricing = isEthTransfer
      ? await priceNativeSpend(txData.value, body.chainId)
      : await priceTokenSpend(parseUnits(body.amount, transferDecimals), getAddress(body.token), transferDecimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: isEthTransfer ? getAddress(body.to) : txData.to,
      // Q8: `to` receives the value, native or ERC-20 (before Q8 an ERC-20
      // transfer's recipient was never checked — only the token contract).
      recipient: getAddress(body.to),
      ...(!isEthTransfer ? { tokenAddress: getAddress(body.token) } : {}),
      valueEth: isEthTransfer ? body.amount : '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: txData.value > 0n ? txData.value : 0n,
      tier: request.agentTier,
    });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'transfer', {
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

    // No approval is sent here: this route queues only Pool.supply. The
    // Pool's ERC-20 allowance must already exist — given by an earlier batch
    // or from outside AgentFi; GET /v1/wallet/allowances reports it (spender:
    // the Aave V3 Pool, S12). Without it the supply simulation fails (422).
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
    const pricing = await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: supplyTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6: a deposit leaves the wallet
      ...(depositLastTxTimestamp !== undefined ? { lastTxTimestamp: depositLastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    // Simulate supply tx
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: supplyTx.to,
      data: supplyTx.data,
      value: supplyTx.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'deposit', {
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
    // Q9: a max-withdraw's amount is unknown until it executes — it is never
    // counted as 0. §5-7: it is outside the outflow count only when the built
    // calldata PROVES it returns everything to the sender from the trusted
    // pool (`max-withdrawal-proof.ts`); otherwise unpriced (refused while a
    // daily limit applies).
    const maxWithdrawal = amountWei === maxUint256
      ? await maxWithdrawalPricing({ chainId: body.chainId, agentWallet: getAddress(agent.safeAddress), signer: await signingAddressOf(agent.walletId), tx: withdrawTx })
      : null;
    const pricing = maxWithdrawal
      ? maxWithdrawal.pricing
      : await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: withdrawTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      ...(withdrawLastTxTimestamp !== undefined ? { lastTxTimestamp: withdrawLastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: withdrawTx.to,
      data: withdrawTx.data,
      value: withdrawTx.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei === maxUint256 ? 0n : amountWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
          ...(maxWithdrawal?.exemption ? { volumeExemption: { ...maxWithdrawal.exemption } } : {}),
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'withdraw', {
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
    const pricing = await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: supplyTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: supplyTx.to,
      data: supplyTx.data,
      value: supplyTx.value,
    });
    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'compound-supply', {
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
    // §5-7: outside the outflow count only on proof (see the Aave route).
    const maxWithdrawal =
      body.amount === 'max'
        ? await maxWithdrawalPricing({ chainId: body.chainId, agentWallet: getAddress(agent.safeAddress), signer: await signingAddressOf(agent.walletId), tx: withdrawTx })
        : null;
    const pricing = maxWithdrawal
      ? maxWithdrawal.pricing
      : await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: withdrawTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: withdrawTx.to,
      data: withdrawTx.data,
      value: withdrawTx.value,
    });
    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: 0n,
      tier: request.agentTier,
    });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
          ...(maxWithdrawal?.exemption ? { volumeExemption: { ...maxWithdrawal.exemption } } : {}),
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'compound-withdraw', {
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
   * POST /v1/transactions/deposit-erc4626
   * Deposits an asset into any ERC-4626 compliant vault.
   * Vault address is supplied by the caller (not from config) so any
   * compliant vault (Yearn, Morpho, Beefy, etc.) can be used.
   */
  fastify.post('/v1/transactions/deposit-erc4626', async (request, reply) => {
    const body = erc4626DepositSchema.parse(request.body);
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

    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = parseUnits(body.amount, decimals);

    const depositTx = builder.buildErc4626Deposit({
      vaultAddress: getAddress(body.vault),
      assetAmount: amountWei,
      receiver: getAddress(agent.safeAddress),
      asset: getAddress(body.asset),
    });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const pricing = await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: depositTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: depositTx.to,
      data: depositTx.data,
      value: depositTx.value,
    });
    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: amountWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
          protocol: 'erc4626',
          vaultAddress: body.vault,
          queuePayload: {
            to: depositTx.to,
            data: depositTx.data,
            value: depositTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'erc4626-deposit', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: depositTx.to,
        data: depositTx.data,
        value: depositTx.value.toString(),
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
        message: `ERC-4626 deposit (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/withdraw-erc4626
   * Withdraws assets from any ERC-4626 compliant vault.
   */
  fastify.post('/v1/transactions/withdraw-erc4626', async (request, reply) => {
    const body = erc4626WithdrawSchema.parse(request.body);
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

    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = body.amount === 'max' ? maxUint256 : parseUnits(body.amount, decimals);

    const withdrawTx = builder.buildErc4626Withdraw({
      vaultAddress: getAddress(body.vault),
      assetAmount: amountWei,
      receiver: getAddress(agent.safeAddress),
      owner: getAddress(agent.safeAddress),
      asset: getAddress(body.asset),
    });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    // §5-7: never exempt. The vault is chosen by the agent, not a trusted
    // protocol contract: its code, called by the agent's wallet, could pull
    // any allowance the wallet ever gave it — no calldata proves otherwise.
    const pricing =
      body.amount === 'max'
        ? unknownAmountSpend(`${MAX_AMOUNT_UNPRICED} (an ERC-4626 vault chosen by the agent is not a trusted protocol contract)`)
        : await priceTokenSpend(amountWei, getAddress(body.asset), decimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: withdrawTx.to,
      tokenAddress: getAddress(body.asset),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: withdrawTx.to,
      data: withdrawTx.data,
      value: withdrawTx.value,
    });
    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}` });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: 0n,
      tier: request.agentTier,
    });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
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
          protocol: 'erc4626',
          vaultAddress: body.vault,
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'erc4626-withdraw', {
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
        message: `ERC-4626 withdraw (${body.amount} ${body.asset.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/swap-curve
   * Swaps between two assets on a Curve StableSwap pool.
   *
   * The caller supplies the pool address and token indices. Assumes the
   * fromToken has already been approved to the pool. If approval is missing,
   * the simulation step fails with a clear message.
   */
  fastify.post('/v1/transactions/swap-curve', async (request, reply) => {
    const body = swapCurveSchema.parse(request.body);
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

    const fromDecimals = await getTokenDecimals(body.fromTokenAddress, body.chainId);
    const toDecimals = await getTokenDecimals(body.toTokenAddress, body.chainId);
    const amountInWei = parseUnits(body.amountIn, fromDecimals);
    const minAmountOutWei = parseUnits(body.minAmountOut, toDecimals);

    const swapTx = builder.buildCurveSwap({
      poolAddress: getAddress(body.pool),
      i: BigInt(body.fromTokenIndex),
      j: BigInt(body.toTokenIndex),
      amountIn: amountInWei,
      minAmountOut: minAmountOutWei,
      tokenIn: getAddress(body.fromTokenAddress),
    });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const pricing = await priceTokenSpend(amountInWei, getAddress(body.fromTokenAddress), fromDecimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: swapTx.to,
      tokenAddress: getAddress(body.fromTokenAddress),
      valueEth: '0',
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6: the swap input leaves the wallet
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: swapTx.to,
      data: swapTx.data,
      value: swapTx.value,
    });
    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({
        error: `Simulation failed: ${sim.error}. Verify pool exists, indices are correct, and fromToken is approved to the pool.`,
      });
    }

    const feeCalc = feeService.calculateFee({
      grossAmountWei: amountInWei,
      tier: request.agentTier,
    });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'SWAP',
        fromToken: body.fromTokenAddress,
        toToken: body.toTokenAddress,
        amountIn: body.amountIn,
        simulation: sim as any,
        metadata: {
          protocol: 'curve',
          poolAddress: body.pool,
          tokenIndices: { from: body.fromTokenIndex, to: body.toTokenIndex },
          queuePayload: {
            to: swapTx.to,
            data: swapTx.data,
            value: swapTx.value.toString(),
            feeAmountWei: feeCalc.feeAmountWei.toString(),
            feeBps: feeCalc.feeBps,
            routedViaExecutor: false,
          },
        },
      },
    });
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'curve-swap', {
        transactionId: tx.id,
        chainId: body.chainId,
        walletId: agent.walletId,
        from: getAddress(agent.safeAddress),
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value.toString(),
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
        message: `Curve swap (${body.amountIn} ${body.fromTokenAddress.slice(0, 10)}) exceeds auto-approval threshold.`,
      });
    }

    return reply.code(202).send({ transactionId: tx.id, status: tx.status });
  });

  /**
   * POST /v1/transactions/batch — execute multiple raw calldata actions atomically.
   *
   * Each action maps directly to AgentExecutor.Action: { to, value, token, data }.
   * Actions are validated individually via PolicyService, then encoded into a single
   * AgentExecutor.executeBatch call — atomic: all succeed or all revert.
   *
   * Body: { chainId, actions: [{ to, value, token?, data }], idempotencyKey? }
   *   - to:    target contract address — checked against `allowedContracts`,
   *            which is the BINDING policy control for raw calldata; when the
   *            action carries native value, also against `allowedRecipients`
   *            (Q8: it receives that value)
   *   - value: ETH value in wei (as decimal string, e.g. "0" or "1000000000000000")
   *   - token: CALLER-DECLARED ERC-20 the action moves. The backend does not
   *            decode `data` to discover which token a call really touches;
   *            both the off-chain `allowedTokens` whitelist and the on-chain
   *            policy module check the declared value. Zero address (default)
   *            means pure ETH / no token. When the agent has a non-empty token
   *            whitelist, every action with non-empty `data` MUST declare a
   *            token — otherwise 400.
   *   - data:  hex-encoded calldata (e.g. "0x" for plain ETH transfers)
   *
   * msg.value = Σ value + the executor fee, floor(Σ value × 30 / 10 000) on
   * the sum (A6d); that total is what the outflow cap and the daily volume count.
   */
  // -----------------------------------------------------------------------
  // GMX V2 Perpetuals — open position (MarketIncrease order)
  // -----------------------------------------------------------------------

  const gmxOpenSchema = z.object({
    market: z.string().describe('GMX market token address or label like "ETH/USD"'),
    collateralToken: z.string().describe('Collateral token address (e.g. WETH, USDC)'),
    sizeDeltaUsd: z.string().describe('Position size in USD with 30 decimals (GMX precision)'),
    collateralAmount: z.string().describe('Collateral amount in human-readable units'),
    acceptablePrice: z.string().describe('Max acceptable price in USD with 30 decimals (for longs) or min price (for shorts)'),
    isLong: z.boolean().describe('true for long, false for short'),
    chainId: z.number().default(42161).describe('Chain ID. Default: 42161 (Arbitrum One).'),
    idempotencyKey: z.string().optional(),
  });

  fastify.post('/v1/transactions/gmx-open', async (request, reply) => {
    const body = gmxOpenSchema.parse(request.body);
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
      return reply.code(429).send({ error: `Monthly transaction limit reached for ${request.agentTier} tier.` });
    }

    const contracts = getContracts(body.chainId);
    if (!contracts.gmxExchangeRouter || !contracts.gmxOrderVault) {
      return reply.code(400).send({ error: `GMX V2 not available on chain ${body.chainId}` });
    }

    // Resolve market address from label if needed
    const { gmxService } = await import('../../services/defi/gmx.service.js');
    let marketAddress: Address;
    if (body.market.startsWith('0x')) {
      marketAddress = getAddress(body.market);
    } else {
      const resolved = gmxService.resolveMarket(body.market);
      if (!resolved) return reply.code(400).send({ error: `Unknown GMX market: ${body.market}` });
      marketAddress = resolved;
    }

    const collateralDecimals = await getTokenDecimals(body.collateralToken, body.chainId);
    const collateralAmountRaw = parseUnits(body.collateralAmount, collateralDecimals);

    // Get execution fee
    const { executionFeeWei } = await gmxService.getExecutionFee({ chainId: body.chainId, orderType: 'increase' });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    // Q9 (A6b): the collateral is the spend (was: valueUsd "0", never
    // counted). The keeper execution fee is native gas-like value checked by
    // maxValuePerTxEth and not counted against the daily volume (unchanged).
    const pricing = await priceTokenSpend(collateralAmountRaw, getAddress(body.collateralToken), collateralDecimals, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: contracts.gmxExchangeRouter,
      tokenAddress: getAddress(body.collateralToken),
      valueEth: weiToEthDecimalString(executionFeeWei),
      valueUsd: countedUsd(pricing),
      pricing,
      outflow: true, // §5-6: the collateral leaves the wallet (the keeper fee stays under maxValuePerTxEth)
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const txData = builder.buildGmxCreateOrder({
      exchangeRouter: contracts.gmxExchangeRouter,
      orderVault: contracts.gmxOrderVault,
      market: marketAddress,
      initialCollateralToken: getAddress(body.collateralToken),
      sizeDeltaUsd: BigInt(body.sizeDeltaUsd),
      initialCollateralDeltaAmount: collateralAmountRaw,
      acceptablePrice: BigInt(body.acceptablePrice),
      executionFee: executionFeeWei,
      isLong: body.isLong,
      orderType: 'MarketIncrease',
      receiver: getAddress(agent.safeAddress),
    });

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}`, simulationId: sim.simulationId });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: executionFeeWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'GMX_OPEN',
        fromToken: body.collateralToken,
        amountIn: body.collateralAmount,
        simulation: sim as any,
        metadata: {
          market: marketAddress,
          sizeDeltaUsd: body.sizeDeltaUsd,
          isLong: body.isLong,
          acceptablePrice: body.acceptablePrice,
          executionFee: executionFeeWei.toString(),
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'gmx-open', {
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
      }, { priority: 1 });
    }

    return reply.code(202).send({
      transactionId: tx.id,
      status: tx.status,
      simulationId: sim.simulationId,
      market: marketAddress,
      fee: { bps: feeCalc.feeBps, amountWei: feeCalc.feeAmountWei.toString(), feeWallet: feeCalc.feeWallet },
    });
  });

  // -----------------------------------------------------------------------
  // GMX V2 Perpetuals — close position (MarketDecrease order)
  // -----------------------------------------------------------------------

  const gmxCloseSchema = z.object({
    market: z.string().describe('GMX market token address or label like "ETH/USD"'),
    collateralToken: z.string().describe('Collateral token address of the existing position'),
    sizeDeltaUsd: z.string().describe('Size to close in USD with 30 decimals. Use full position size for complete close.'),
    acceptablePrice: z.string().describe('Min acceptable price in USD with 30 decimals (for longs) or max price (for shorts)'),
    isLong: z.boolean().describe('true if closing a long, false if closing a short'),
    chainId: z.number().default(42161).describe('Chain ID. Default: 42161 (Arbitrum One).'),
    idempotencyKey: z.string().optional(),
  });

  fastify.post('/v1/transactions/gmx-close', async (request, reply) => {
    const body = gmxCloseSchema.parse(request.body);
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
      return reply.code(429).send({ error: `Monthly transaction limit reached for ${request.agentTier} tier.` });
    }

    const contracts = getContracts(body.chainId);
    if (!contracts.gmxExchangeRouter || !contracts.gmxOrderVault) {
      return reply.code(400).send({ error: `GMX V2 not available on chain ${body.chainId}` });
    }

    const { gmxService } = await import('../../services/defi/gmx.service.js');
    let marketAddress: Address;
    if (body.market.startsWith('0x')) {
      marketAddress = getAddress(body.market);
    } else {
      const resolved = gmxService.resolveMarket(body.market);
      if (!resolved) return reply.code(400).send({ error: `Unknown GMX market: ${body.market}` });
      marketAddress = resolved;
    }

    const { executionFeeWei } = await gmxService.getExecutionFee({ chainId: body.chainId, orderType: 'decrease' });

    const lastTxTimestamp = await getLatestAgentTxTimestamp(request.agentId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: contracts.gmxExchangeRouter,
      tokenAddress: getAddress(body.collateralToken),
      valueEth: weiToEthDecimalString(executionFeeWei),
      // Q9: a close reduces a position (value comes back to the agent); it
      // counts nothing, as before. Documented in api-reference.
      valueUsd: '0',
      ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    });
    if (!policyResult.allowed) return sendPolicyRefusal(reply, policyResult);

    const txData = builder.buildGmxCreateOrder({
      exchangeRouter: contracts.gmxExchangeRouter,
      orderVault: contracts.gmxOrderVault,
      market: marketAddress,
      initialCollateralToken: getAddress(body.collateralToken),
      sizeDeltaUsd: BigInt(body.sizeDeltaUsd),
      initialCollateralDeltaAmount: 0n,
      acceptablePrice: BigInt(body.acceptablePrice),
      executionFee: executionFeeWei,
      isLong: body.isLong,
      orderType: 'MarketDecrease',
      receiver: getAddress(agent.safeAddress),
    });

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({ error: `Simulation failed: ${sim.error}`, simulationId: sim.simulationId });
    }

    const feeCalc = feeService.calculateFee({ grossAmountWei: executionFeeWei, tier: request.agentTier });

    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing: { status: 'zero' },
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'GMX_CLOSE',
        fromToken: body.collateralToken,
        simulation: sim as any,
        metadata: {
          market: marketAddress,
          sizeDeltaUsd: body.sizeDeltaUsd,
          isLong: body.isLong,
          acceptablePrice: body.acceptablePrice,
          executionFee: executionFeeWei.toString(),
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
    if (!tx) return;

    if (!policyResult.requiresApproval) {
      await enqueueOrFail(tx.id, 'gmx-close', {
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
      }, { priority: 1 });
    }

    return reply.code(202).send({
      transactionId: tx.id,
      status: tx.status,
      simulationId: sim.simulationId,
      market: marketAddress,
      fee: { bps: feeCalc.feeBps, amountWei: feeCalc.feeAmountWei.toString(), feeWallet: feeCalc.feeWallet },
    });
  });

  // -----------------------------------------------------------------------
  // Batch Execution via AgentExecutor
  // -----------------------------------------------------------------------

  fastify.post('/v1/transactions/batch', async (request, reply) => {
    const batchSchema = z.object({
      chainId: z.number().default(1),
      idempotencyKey: z.string().optional(),
      actions: z.array(z.object({
        to:    z.string(),
        value: z.string().default('0'),
        // Caller-declared ERC-20 (see route doc comment); zero address = none.
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(zeroAddress),
        data:  z.string().regex(/^0x[0-9a-fA-F]*$/).default('0x'),
      })).min(1).max(20),
    });

    const parsedBody = batchSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsedBody.error.errors });
    }
    const body = parsedBody.data;
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

    // S8: an agent never calls its policy module through the executor. The
    // admin calls (setPolicy, whitelists, pause / resume) revert Unauthorized
    // there (the executor is msg.sender), and validateTransaction — no caller
    // check — would only restart a wallet's on-chain cooldown (another
    // agent's included). The on-chain policy is synced by the operator.
    const moduleIndex = contracts.policyModule
      ? body.actions.findIndex((a) => a.to.toLowerCase() === contracts.policyModule!.toLowerCase())
      : -1;
    if (moduleIndex >= 0) {
      return reply.code(403).send({
        error:
          `Action at index ${moduleIndex} targets the AgentPolicyModule. Agents cannot call it through the executor; the operator ` +
          'syncs the on-chain policy from the stored one.',
        code: 'POLICY_MODULE_TARGET',
        actionIndex: moduleIndex,
      });
    }
    // The off-chain token whitelist can only be applied to what the caller
    // declares (the backend does not decode raw calldata), so an agent that
    // HAS a whitelist must declare a token on every action carrying calldata.
    const policy = await policyService.getPolicy(request.agentId);
    const hasTokenWhitelist = (policy?.allowedTokens.length ?? 0) > 0;

    // Validate each action individually via PolicyService before touching the chain
    for (let i = 0; i < body.actions.length; i++) {
      const action = body.actions[i]!;
      const valueWei = BigInt(action.value);
      const declaredToken =
        action.token.toLowerCase() === zeroAddress ? undefined : getAddress(action.token);
      const hasCalldata = action.data.length > 2; // anything beyond "0x"
      if (hasTokenWhitelist && hasCalldata && !declaredToken) {
        return reply.code(400).send({
          error: 'token is required for this action because the agent has a token whitelist',
          actionIndex: i,
        });
      }
      const policyResult = await policyService.validateTransaction({
        agentId: request.agentId,
        targetContract: getAddress(action.to),
        // Q8: an action carrying native value pays its `to`. Value an action
        // moves through calldata is not decoded (unchanged).
        ...(valueWei > 0n ? { recipient: getAddress(action.to) } : {}),
        ...(declaredToken ? { tokenAddress: declaredToken } : {}),
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

    // Q9 (owner decision "only authorised contracts", 2026-10-14): while a
    // daily limit applies, every action carrying calldata is accounted for or
    // explicitly authorised (services/policy/batch-calldata.ts), and the
    // whole batch is priced — native value (A6) plus recognised ERC-20
    // transfers — before anything is simulated or reserved.
    // §5-6: the batch is ONE ordinary outflow for `maxOutflowPerTxUsd` — its
    // native value plus its recognised ERC-20 transfers — so whenever the
    // agent has a policy the calldata is classified and priced too (a
    // non-canonical transfer, which a cap cannot see, is refused; decoded
    // transfers meet allowedRecipients / allowedTokens). Only the
    // "authorised contracts" rule for other calldata stays daily-limit-only.
    const dailyLimited = Boolean(policy?.active) && (parsePolicyDecimal(policy?.maxDailyVolumeUsd) ?? 0) > 0;
    // A6d: `AgentExecutor.executeBatch` requires msg.value >= ΣV + F, with
    // F = floor(ΣV × feeBps / 10 000) on the SUM of the action values
    // (`InsufficientValueForFee` otherwise; before A6d the route sent ΣV, so
    // any batch with ≥ 334 wei of native value reverted at simulation). F is
    // `executorBatchValue` on FEE_BPS — the executor's immutable
    // feeBps(), verified by S9 before anything is routed through it — never
    // the tier schedule (feeService.calculateFee: PRO 15 / ENTERPRISE 5 bps
    // would underpay and revert). One computation with the admin batch (S14).
    const {
      actionsValueWei,
      feeWei: executorFeeWei,
      msgValueWei,
    } = executorBatchValue(body.actions.map((a) => BigInt(a.value)));
    // The batch's native outflow is what leaves the wallet: ΣV + F (plan row
    // A6d: the fee is counted). The same pricing feeds the outflow cap (D17)
    // and the DailyVolume reservation (D15 / A6) below.
    const components: Array<{ pricing: SpendPricing; actionIndex?: number }> = [
      { pricing: await priceNativeSpend(msgValueWei, body.chainId) },
    ];
    if (policy) {
      for (let i = 0; i < body.actions.length; i++) {
        const action = body.actions[i]!;
        const call = classifyBatchCalldata(action);
        if (call.kind === 'none') continue;
        if (call.kind === 'non-canonical-erc20') {
          // G1 review P3-4: refused whatever allowedContracts says — a token
          // decodes it leniently and moves the amount, so it cannot be "other"
          // (uncounted, recipient unchecked).
          return reply.code(403).send({
            error:
              `Action at index ${i} blocked by policy: its calldata uses the ERC-20 ${call.fn} selector (${call.selector}) but is ` +
              'not its canonical ABI encoding (trailing bytes, dirty padding or a truncated payload), so its amount and recipient ' +
              'cannot be checked. Send the exact encoding.',
            code: 'NON_CANONICAL_ERC20_CALL',
            rule: 'nonCanonicalErc20Call',
            actionIndex: i,
            selector: call.selector,
          });
        }
        if (call.kind === 'erc20-transfer') {
          if (policy.allowedRecipients.length > 0 && !inList(policy.allowedRecipients, call.to)) {
            return reply.code(403).send({
              error: `Action at index ${i} blocked by policy: Recipient ${call.to} of the ERC-20 ${call.fn} is not in the agent's allowed recipients whitelist`,
              actionIndex: i,
              rule: 'allowedRecipients',
            });
          }
          if (policy.allowedTokens.length > 0 && !inList(policy.allowedTokens, call.token)) {
            return reply.code(403).send({
              error: `Action at index ${i} blocked by policy: Token ${call.token} is not in the agent's allowed tokens whitelist`,
              actionIndex: i,
              rule: 'allowedTokens',
            });
          }
          let decimals: number;
          try {
            decimals = await getTokenDecimals(call.token, body.chainId);
          } catch {
            components.push({ pricing: unknownAmountSpend(`The decimals of token ${call.token} could not be read`), actionIndex: i });
            continue;
          }
          components.push({ pricing: await priceTokenSpend(call.amount, call.token, decimals, body.chainId), actionIndex: i });
          continue;
        }
        // Anything else (approve, an unknown selector…): uncounted, so while a
        // daily limit applies it needs the operator's explicit authorisation
        // of the target. It moves no value the backend can see (no outflow cap).
        if (dailyLimited && !(policy.allowedContracts.length > 0 && inList(policy.allowedContracts, action.to))) {
          return reply.code(403).send({
            error:
              `Action at index ${i} calls ${action.to} (selector ${call.selector}) with calldata the backend cannot count ` +
              'against the daily volume limit. Only ERC-20 transfer / transferFrom calldata is counted; any other call ' +
              'needs its target listed in allowedContracts by the operator.',
            code: 'UNACCOUNTED_CALL',
            rule: 'unaccountedCall',
            actionIndex: i,
            selector: call.selector,
          });
        }
      }
    }
    const pricing = sumSpendPricings(components.map((c) => c.pricing));
    if (dailyLimited && pricing.status === 'unpriced') {
      const culprit = components.find((c) => c.pricing.status === 'unpriced');
      return reply.code(503).send({
        error:
          `${pricing.reason}. The daily volume limit of ${policy?.maxDailyVolumeUsd} USD cannot be checked, ` +
          'so the batch is refused (it would otherwise count as 0).',
        code: 'PRICE_UNAVAILABLE',
        ...(culprit?.actionIndex !== undefined ? { actionIndex: culprit.actionIndex } : {}),
      });
    }
    // §5-6: the whole batch against maxOutflowPerTxUsd (NULL → 403
    // USD_CAP_NOT_CONFIGURED; unpriced → 503; above → 403), before anything
    // is simulated or reserved.
    const outflowCap = judgeOutflowCap(policy, pricing);
    if (!outflowCap.allowed) {
      const culprit = components.find((c) => c.pricing.status === 'unpriced');
      return sendPolicyRefusal(
        reply,
        { allowed: false, code: outflowCap.code, rule: outflowCap.rule, reason: outflowCap.reason, ...(outflowCap.limit !== undefined ? { limit: outflowCap.limit } : {}) },
        outflowCap.code === 'PRICE_UNAVAILABLE' && culprit?.actionIndex !== undefined ? { actionIndex: culprit.actionIndex } : {},
      );
    }

    // S9: the batch runs through (and sends its value to) the executor. Order
    // (same as the swap route): the cheap deterministic refusals above —
    // validation, policy 403, UNACCOUNTED_CALL, PRICE_UNAVAILABLE — answer
    // first; then the identity gate; nothing is simulated, reserved or
    // signed before it.
    if (refuseUnverifiedContracts(reply, body.chainId, 'a batch routed through the AgentExecutor')) return;

    const { encodeFunctionData } = await import('viem');

    // Build on-chain action array (matches AgentExecutor.Action struct)
    type OnChainAction = { target: Address; value: bigint; token: Address; data: `0x${string}` };
    const onChainActions: OnChainAction[] = body.actions.map(a => ({
      target: getAddress(a.to) as Address,
      value:  BigInt(a.value),
      token:  getAddress(a.token) as Address,
      data:   a.data as `0x${string}`,
    }));

    // AgentExecutor.executeBatch — ABI generated from the Solidity source
    // (packages/backend/src/abi/AgentExecutor.abi.ts, `npm run abi:executor`).
    const batchCalldata = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [onChainActions],
    });

    // Simulate the full batch against the executor contract — with the value
    // it will be sent with (ΣV + F, A6d); the job and queuePayload carry the same.
    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: contracts.executor,
      data: batchCalldata,
      value: msgValueWei,
    });

    if (!ensureSimulationUsable(sim, reply)) return;
    if (!sim.success) {
      return reply.code(422).send({
        error: `Batch simulation failed: ${sim.error}`,
        simulationId: sim.simulationId,
      });
    }

    // A6e(2): the response and the recorded fee are what the executor charges
    // (F at its 30 bps, on every tier) — never the tier schedule, which is
    // not applied on-chain. `calculateFee` only supplies the fee wallet.
    const chargedFee = executorChargedFee(executorFeeWei);
    const feeCalc = feeService.calculateFee({ grossAmountWei: actionsValueWei, tier: request.agentTier });

    // The batch's daily-volume spend: its native value with the executor fee
    // (A6, A6d) plus, while a daily limit applies, its recognised ERC-20
    // transfers (Q9) — priced above. Its source is `synthetic` when any
    // component is.
    const tx = await createWithVolumeReservation(reply, {
      agentId: request.agentId,
      pricing,
      data: {
        agentId: request.agentId,
        idempotencyKey: body.idempotencyKey ?? null,
        chainId: body.chainId,
        status: 'QUEUED',
        type: 'BATCH',
        // The value the actions move (unchanged meaning); the fee is queuePayload.feeAmountWei.
        amountIn: actionsValueWei.toString(),
        simulation: sim as any,
        metadata: {
          actionCount: body.actions.length,
          actions: body.actions,
          // A6b: what the stranded-QUEUED sweep re-enqueues and the re-poll accounts from.
          queuePayload: {
            to: contracts.executor,
            data: batchCalldata,
            value: msgValueWei.toString(),
            feeAmountWei: chargedFee.feeAmountWei.toString(),
            feeBps: chargedFee.feeBps,
            routedViaExecutor: true,
          },
        },
      },
    });
    if (!tx) return;

    await enqueueOrFail(tx.id, 'batch', {
      transactionId: tx.id,
      chainId: body.chainId,
      walletId: agent.walletId,
      from: getAddress(agent.safeAddress),
      to: contracts.executor,
      data: batchCalldata,
      value: msgValueWei.toString(),
      agentId: request.agentId,
      tier: request.agentTier,
      feeAmountWei: chargedFee.feeAmountWei.toString(),
      feeUsd: '0',
      feeBps: chargedFee.feeBps,
      routedViaExecutor: true,
    });

    return reply.code(202).send({
      transactionId: tx.id,
      status: 'QUEUED',
      actionCount: body.actions.length,
      simulationId: sim.simulationId,
      fee: {
        bps: chargedFee.feeBps,
        amountWei: chargedFee.feeAmountWei.toString(),
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
    return toTransactionResponse(tx);
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
    return toTransactionResponse(tx);
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

    const ctx = sanitizeContextFromEnv();
    return { transactions: transactions.map((tx) => toTransactionResponse(tx, ctx)), total, page, limit };
  });
}

/**
 * API view of a Transaction row (S5). `error` and `simulation.error` were
 * written from worker / simulator error text — a viem broadcast error carries
 * the RPC URL with the provider key in its path — so every error-text field
 * is sanitized on the way out (the public `/v1/public/transactions/:id` too).
 * Everything else is returned as stored; the DB keeps the full text.
 */
function toTransactionResponse<T>(tx: T, ctx: SanitizeContext = sanitizeContextFromEnv()): T {
  return sanitizeErrorFields(withoutVolumeBookkeeping(tx), {}, ctx);
}

/** A6 reservation bookkeeping is internal to the backend; agents never see it. */
const VOLUME_BOOKKEEPING_FIELDS = [
  'volumeReservedUsd',
  'volumeReservedDate',
  'volumeState',
  'broadcastAttemptedAt',
  'broadcastAttempts',
  'broadcastTxHash',
] as const;

function withoutVolumeBookkeeping<T>(tx: T): T {
  if (!tx || typeof tx !== 'object') return tx;
  const copy = { ...(tx as Record<string, unknown>) };
  for (const field of VOLUME_BOOKKEEPING_FIELDS) delete copy[field];
  return copy as T;
}

/**
 * #180 review: the address that signs the agent's transactions — the wallet
 * provider's address for `walletId`, the EVM `msg.sender` (in Safe mode the
 * Safe's owner EOA, not `safeAddress`). Null when it cannot be resolved (the
 * caller then grants nothing that depends on it).
 */
async function signingAddressOf(walletId: string): Promise<string | null> {
  try {
    return await getWalletService().getWalletAddress(walletId);
  } catch (err) {
    logger.warn({ walletId, err: (err as Error)?.message ?? String(err) }, 'Could not resolve the signing address of a wallet');
    return null;
  }
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
  // An idempotent replay answers with the stored row — same view as GET /v1/transactions/:id.
  if (existingForAgent) return { existing: toTransactionResponse(existingForAgent), conflictWithAnotherAgent: false };

  const existingForOtherAgent = await db.transaction.findFirst({
    where: { idempotencyKey },
    select: { id: true },
  });
  return {
    existing: null,
    conflictWithAnotherAgent: !!existingForOtherAgent,
  };
}

/**
 * Creates the Transaction row together with its DailyVolume reservation (A6,
 * `createTransactionWithVolume`): one database transaction, with the binding
 * daily-limit check under the agent lock. Sends the reply and returns null
 * when the limit refuses (403, the policy's wording), when native value could
 * not be priced while a daily limit applies (503, fail closed), or when a
 * concurrent request with the same idempotencyKey created the row first (its
 * row is the answer, as for a replay — and nothing was reserved twice).
 */
async function createWithVolumeReservation(
  reply: FastifyReply,
  params: {
    agentId: string;
    /** Q9: the spend's pricing; its counted USD is reserved with its price source. */
    pricing: SpendPricing;
    data: Prisma.TransactionUncheckedCreateInput;
  },
): Promise<Transaction | null> {
  const { pricing, ...rest } = params;
  try {
    const created = await createTransactionWithVolume(db, {
      ...rest,
      valueUsd: countedUsd(pricing),
      priceSource: priceSourceOf(pricing),
      ...(pricing.status === 'unpriced' ? { unpricedReason: pricing.reason } : {}),
    });
    if (!created.ok) {
      if (created.code === 'PRICE_UNAVAILABLE') {
        reply.code(503).send({ error: created.reason, code: 'PRICE_UNAVAILABLE' });
      } else {
        reply.code(403).send({ error: created.reason });
      }
      return null;
    }
    if (created.replayed) {
      reply.send(toTransactionResponse(created.transaction));
      return null;
    }
    return created.transaction;
  } catch (err) {
    const key = params.data.idempotencyKey;
    if (key && isIdempotencyKeyConflict(err)) {
      const idempotent = await getIdempotentTransaction(params.agentId, key);
      if (idempotent.existing) {
        reply.send(idempotent.existing);
        return null;
      }
    }
    throw err;
  }
}

/**
 * Enqueues a created transaction. When the queue refuses (Redis down, quota),
 * the row would sit QUEUED forever with its DailyVolume reservation and no
 * job to run it (A6 review): it is marked FAILED — only while still QUEUED
 * without a hash and without a broadcast stamp — and its reservation settled
 * (released: nothing was broadcast), then the error propagates to the caller.
 * Its idempotencyKey is cleared so the client can retry with the same key.
 *
 * A6b: the job id is the row's (`transactionJobId`), so a crash between the
 * row and the job is repaired by the stranded-QUEUED sweep without ever adding
 * a second job; and a refusal that in fact reached Redis (a timeout after the
 * write) is a job a worker may already have stamped — that row is left to it.
 */
async function enqueueOrFail(
  transactionId: string,
  name: string,
  data: Parameters<typeof transactionQueue.add>[1],
  opts?: Parameters<typeof transactionQueue.add>[2],
): Promise<void> {
  try {
    await transactionQueue.add(name, data, { jobId: transactionJobId(transactionId), ...opts });
  } catch (err) {
    const error = `enqueue failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 500);
    try {
      const failed = await db.transaction.updateMany({
        where: { id: transactionId, status: 'QUEUED', txHash: null, broadcastAttemptedAt: null },
        data: { status: 'FAILED', error, idempotencyKey: null },
      });
      if (failed.count > 0) await settleVolumeAfterFailure(db, transactionId);
    } catch (unwindErr) {
      logger.error(
        { transactionId, err: (unwindErr as Error)?.message ?? String(unwindErr) },
        'Enqueue failed AND the transaction could not be marked FAILED — the volume sweep repairs the reservation',
      );
    }
    throw err;
  }
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes('idempotencyKey') : String(target ?? '').includes('idempotencyKey');
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

/**
 * A policy refusal from `validateTransaction`: 503 `PRICE_UNAVAILABLE` when the
 * spend could not be priced while a daily limit applies (Q9), 403 otherwise.
 */
function sendPolicyRefusal(reply: FastifyReply, result: PolicyValidationResult, extra: Record<string, unknown> = {}) {
  const detail = {
    ...(result.rule ? { rule: result.rule } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...extra,
  };
  if (result.code === 'PRICE_UNAVAILABLE') {
    return reply.code(503).send({ error: result.reason, code: 'PRICE_UNAVAILABLE', ...detail });
  }
  // §5-6: USD_CAP_NOT_CONFIGURED (no maxOutflowPerTxUsd) and POLICY_VIOLATION
  // (rule maxOutflowPerTxUsd) carry their code; other refusals stay { error }.
  if (result.code) return reply.code(403).send({ error: result.reason, code: result.code, ...detail });
  return reply.code(403).send({ error: result.reason, ...detail });
}

function inList(list: readonly string[], address: string): boolean {
  const target = address.toLowerCase();
  return list.some((entry) => entry.trim().toLowerCase() === target);
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
  /**
   * Issue #74: deterministic idempotency key. When supplied, this function
   * short-circuits to the existing Transaction row if one already exists
   * with this intentId — no policy/sim work, no new broadcast. Lets the
   * recovery worker (#73) and any manual re-trigger re-invoke this safely
   * without double-spending.
   *
   * Convention: `a2a-payment:<jobId>` for A2A flows. Globally unique on
   * the Transaction table.
   */
  intentId?: string;
}): Promise<{ transactionId: string; status: string }> {
  // Idempotency short-circuit. Cheap one-row indexed lookup before we do any
  // expensive policy/sim/oracle work or hit the chain.
  if (params.intentId) {
    const existing = await db.transaction.findUnique({
      where: { intentId: params.intentId },
      select: { id: true, status: true },
    });
    if (existing) {
      logger.info(
        {
          intentId: params.intentId,
          jobId: params.jobId,
          transactionId: existing.id,
          status: existing.status,
        },
        'A2A payment short-circuited by intentId — returning existing tx',
      );
      return { transactionId: existing.id, status: existing.status };
    }
  }

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

  // No USD value for the daily limit here: the reward was priced (Q9: with a
  // trusted price, or refused while a daily limit applies) and counted by the
  // Job at creation. §5-6: the payment is an ordinary outflow — priced now and
  // judged against maxOutflowPerTxUsd (the binding check; job creation
  // already refused a reward the cap could not take).
  const outflowPricing = isEthTransfer
    ? await priceNativeSpend(txData.value, params.chainId)
    : await priceTokenSpend(parseUnits(params.amount, transferDecimals), getAddress(params.token), transferDecimals, params.chainId);
  const policyResult = await policyService.validateTransaction({
    agentId: requester.id,
    targetContract: isEthTransfer
      ? getAddress(params.providerSafeAddress)
      : txData.to,
    // Q8: the provider receives the reward (native or ERC-20).
    recipient: getAddress(params.providerSafeAddress),
    ...(!isEthTransfer ? { tokenAddress: getAddress(params.token) } : {}),
    valueEth: isEthTransfer ? params.amount : '0',
    pricing: outflowPricing,
    outflow: true,
    ...(lastTxTimestamp !== undefined ? { lastTxTimestamp } : {}),
    // A6: the Job reserved the reward in DailyVolume at creation
    // (reserveJobEscrow) and gives it back on failure (releaseJobEscrow); the
    // payment row reserves nothing and is not judged against the limit twice.
    dailyVolumeAccounted: true,
  });
  if (!policyResult.allowed) {
    throw new Error(`Policy check failed: ${policyResult.code ? `${policyResult.code}: ` : ''}${policyResult.reason}`);
  }

  const sim = await simulator.simulate({
    chainId: params.chainId,
    from: getAddress(requester.safeAddress),
    to: txData.to,
    data: txData.data,
    value: txData.value,
  });
  // No HTTP reply in this context — throws SimulationUnavailableError (503),
  // which jobs.ts records as the PAYMENT_FAILED reason.
  assertSimulationUsable(sim);
  if (!sim.success) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const feeCalc = feeService.calculateFee({
    grossAmountWei: txData.value > 0n ? txData.value : 0n,
    tier,
  });

  let tx;
  try {
    tx = await db.transaction.create({
      data: {
        agentId: requester.id,
        chainId: params.chainId,
        status: policyResult.requiresApproval ? 'PENDING_APPROVAL' : 'QUEUED',
        type: 'TRANSFER',
        fromToken: params.token,
        toToken: params.providerSafeAddress,
        amountIn: params.amount,
        ...(params.intentId ? { intentId: params.intentId } : {}),
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
  } catch (err) {
    // Concurrency race: another caller (e.g. duplicate recovery worker tick)
    // inserted a Transaction with the same intentId between our short-circuit
    // check and this insert. The unique index is the source of truth — fall
    // back to returning the row that won.
    if (
      params.intentId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      Array.isArray((err.meta as { target?: string[] } | undefined)?.target) &&
      ((err.meta as { target?: string[] }).target ?? []).includes('intentId')
    ) {
      const existing = await db.transaction.findUnique({
        where: { intentId: params.intentId },
        select: { id: true, status: true },
      });
      if (existing) {
        logger.warn(
          {
            intentId: params.intentId,
            jobId: params.jobId,
            transactionId: existing.id,
          },
          'A2A payment race resolved by intentId unique constraint — returning row that won',
        );
        return { transactionId: existing.id, status: existing.status };
      }
    }
    throw err;
  }

  if (!policyResult.requiresApproval) {
    await enqueueOrFail(tx.id, 'a2a-payment', {
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
