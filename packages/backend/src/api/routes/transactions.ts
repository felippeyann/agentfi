import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { getAddress, parseUnits, maxUint256, createPublicClient, http } from 'viem';
import { TransactionBuilder } from '../../services/transaction/builder.service.js';
import { SimulatorService } from '../../services/transaction/simulator.service.js';
import { ExecutorService } from '../../services/transaction/executor.service.js';
import { PolicyService } from '../../services/policy/policy.service.js';
import { FeeService } from '../../services/policy/fee.service.js';
import { transactionQueue, type TransactionJobData } from '../../queues/transaction.queue.js';
import { weiToUsd } from '../../services/transaction/price.service.js';
import { getContracts } from '../../config/contracts.js';
import { logger } from '../middleware/logger.js';
import type { Address } from 'viem';

const db = new PrismaClient();
const builder = new TransactionBuilder();
const simulator = new SimulatorService();
const executor = new ExecutorService();
const policyService = new PolicyService(db);
const feeService = new FeeService(db);

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

  const { createPublicClient, http } = await import('viem');
  const { getChain, RPC_URLS } = await import('../../config/chains.js');
  const client = createPublicClient({ chain: getChain(chainId), transport: http(RPC_URLS[chainId] ?? '') });

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
    const { getChain, RPC_URLS } = await import('../../config/chains.js');
    const quoterAddress = QUOTER_ADDRESSES[params.chainId];
    if (!quoterAddress) return 0n;

    const client = createPublicClient({
      chain: getChain(params.chainId),
      transport: http(RPC_URLS[params.chainId] ?? ''),
    });

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

const swapSchema = z.object({
  fromToken: z.string(),
  toToken: z.string(),
  amountIn: z.string(),
  chainId: z.number().default(1),
  slippageTolerance: z.number().min(0.01).max(50).default(0.5),
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
    const body = swapSchema.parse(request.body);
    const agent = await getAgent(request.agentId);

    const txData = builder.buildUniswapSwap({
      chainId: body.chainId,
      tokenIn: getAddress(body.fromToken),
      tokenOut: getAddress(body.toToken),
      fee: 3000,
      recipient: getAddress(agent.safeAddress),
      amountIn: parseUnits(body.amountIn, 18),
      amountOutMinimum: 0n,
    });

    const sim = await simulator.simulate({
      chainId: body.chainId,
      from: getAddress(agent.safeAddress),
      to: txData.to,
      data: txData.data,
      value: txData.value,
    });

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
    const body = swapSchema.parse(request.body);
    const agent = await getAgent(request.agentId);

    // Idempotency check
    if (body.idempotencyKey) {
      const existing = await db.transaction.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (existing) return existing;
    }

    // Check tx limit for tier
    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({
        error: `Monthly transaction limit reached for ${request.agentTier} tier. Upgrade to increase limits.`,
      });
    }

    const amountInWei = parseUnits(body.amountIn, 18);

    // Policy check — target is the Uniswap router, not the token address
    const swapContracts = getContracts(body.chainId);
    const valueUsd = await weiToUsd(amountInWei, body.chainId);
    const policyResult = await policyService.validateTransaction({
      agentId: request.agentId,
      targetContract: swapContracts.uniswapV3Router,
      tokenAddress: getAddress(body.fromToken),
      valueEth: body.amountIn,
      valueUsd,
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
        status: 'QUEUED',
        type: 'SWAP',
        fromToken: body.fromToken,
        toToken: body.toToken,
        amountIn: body.amountIn,
        simulation: sim as any,
      },
    });

    // Enqueue for processing — use wrapped tx so executor handles fee on-chain
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

    return reply.code(202).send({
      transactionId: tx.id,
      status: 'QUEUED',
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

    if (body.idempotencyKey) {
      const existing = await db.transaction.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (existing) return existing;
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    let txData;
    if (body.token.toUpperCase() === 'ETH') {
      txData = builder.buildEthTransfer({ to: getAddress(body.to), amountEth: body.amount });
    } else {
      txData = builder.buildTokenTransfer({
        tokenAddress: getAddress(body.token),
        to: getAddress(body.to),
        amount: body.amount,
        decimals: await getTokenDecimals(body.token, body.chainId),
      });
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
        status: 'QUEUED',
        type: 'TRANSFER',
        fromToken: body.token,
        toToken: body.to,
        amountIn: body.amount,
        simulation: sim as any,
      },
    });

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
    });

    return reply.code(202).send({ transactionId: tx.id, status: 'QUEUED' });
  });

  /**
   * POST /v1/transactions/deposit — supply asset to Aave V3.
   */
  fastify.post('/v1/transactions/deposit', async (request, reply) => {
    const body = depositSchema.parse(request.body);
    const agent = await getAgent(request.agentId);

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const { getContracts } = await import('../../config/contracts.js');
    const contracts = getContracts(body.chainId);

    // First: approve Aave pool to spend tokens
    const decimals = await getTokenDecimals(body.asset, body.chainId);
    const amountWei = parseUnits(body.amount, decimals);
    const approveTx = builder.buildApprove({
      tokenAddress: getAddress(body.asset),
      spender: contracts.aavePoolAddressProvider, // in practice, the pool address
      amount: amountWei,
    });

    const { createPublicClient, http } = await import('viem');
    const { getChain, RPC_URLS } = await import('../../config/chains.js');

    // Get actual Aave pool address from address provider
    const publicClient = createPublicClient({
      chain: getChain(body.chainId),
      transport: http(RPC_URLS[body.chainId] ?? ''),
    });

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
        status: 'QUEUED',
        type: 'DEPOSIT',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
      },
    });

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
    });

    return reply.code(202).send({ transactionId: tx.id, status: 'QUEUED' });
  });

  /**
   * POST /v1/transactions/withdraw — withdraw asset from Aave V3.
   */
  fastify.post('/v1/transactions/withdraw', async (request, reply) => {
    const body = withdrawSchema.parse(request.body);
    const agent = await getAgent(request.agentId);

    if (body.idempotencyKey) {
      const existing = await db.transaction.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
      });
      if (existing) return existing;
    }

    const withinLimit = await feeService.checkTxLimit(request.agentId, request.agentTier);
    if (!withinLimit) {
      return reply.code(429).send({ error: 'Monthly transaction limit reached' });
    }

    const { getContracts } = await import('../../config/contracts.js');
    const { createPublicClient, http, maxUint256 } = await import('viem');
    const { getChain, RPC_URLS } = await import('../../config/chains.js');

    const contracts = getContracts(body.chainId);
    const publicClient = createPublicClient({
      chain: getChain(body.chainId),
      transport: http(RPC_URLS[body.chainId] ?? ''),
    });

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
        status: 'QUEUED',
        type: 'WITHDRAW',
        fromToken: body.asset,
        amountIn: body.amount,
        simulation: sim as any,
      },
    });

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
    });

    return reply.code(202).send({ transactionId: tx.id, status: 'QUEUED' });
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
        data:  z.string().regex(/^0x[0-9a-fA-F]*$/).default('0x'),
      })).min(1).max(20),
    });

    const body = batchSchema.parse(request.body);
    const agent = await getAgent(request.agentId);

    // Idempotency check
    if (body.idempotencyKey) {
      const existing = await db.transaction.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
      if (existing) return existing;
    }

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
      // Convert wei → ETH string for policy comparison (precision adequate for limits check)
      const valueEth = valueWei === 0n ? '0' : (Number(valueWei) / 1e18).toFixed(9).replace(/\.?0+$/, '');
      const policyResult = await policyService.validateTransaction({
        agentId: request.agentId,
        targetContract: getAddress(action.to),
        valueEth,
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
    type OnChainAction = { target: Address; value: bigint; data: `0x${string}` };
    const onChainActions: OnChainAction[] = body.actions.map(a => ({
      target: getAddress(a.to) as Address,
      value:  BigInt(a.value),
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
    select: { safeAddress: true, walletId: true },
  });
  if (!agent) throw new Error('Agent not found');
  return agent;
}
