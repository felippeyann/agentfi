import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { getAddress, formatEther, formatUnits } from 'viem';
import { createChainPublicClient } from '../../config/chains.js';

// ERC-20 ABI for balance + allowance queries
const ERC20_READ_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// Common tokens to always check balances for
const COMMON_TOKENS: Record<number, Array<{ address: string; symbol: string; decimals: number }>> =
  {
    1: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
      { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
      { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    ],
    8453: [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    ],
  };

export async function walletRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/wallet/address — returns Safe and EOA addresses.
   */
  fastify.get('/v1/wallet/address', async (request) => {
    const agent = await db.agent.findUnique({
      where: { id: request.agentId },
      select: { safeAddress: true, walletId: true, chainIds: true },
    });
    if (!agent) throw new Error('Agent not found');

    return {
      safeAddress: agent.safeAddress,
      walletId: agent.walletId,
      networks: agent.chainIds,
    };
  });

  /**
   * GET /v1/wallet/balance — ETH + ERC-20 balances across chains.
   */
  fastify.get('/v1/wallet/balance', async (request) => {
    const query = request.query as { chainId?: string };
    const agent = await db.agent.findUnique({
      where: { id: request.agentId },
      select: { safeAddress: true, chainIds: true },
    });
    if (!agent) throw new Error('Agent not found');

    const chainIds = query.chainId
      ? [parseInt(query.chainId)]
      : agent.chainIds;

    const balances = await Promise.all(
      chainIds.map(async (chainId) => {
        const client = createChainPublicClient(chainId);
        const address = getAddress(agent.safeAddress);
        const ethBalance = await client.getBalance({ address });
        const tokens = COMMON_TOKENS[chainId] ?? [];

        const tokenBalances = await Promise.all(
          tokens.map(async (token) => {
            const balance = await client.readContract({
              address: getAddress(token.address),
              abi: ERC20_READ_ABI,
              functionName: 'balanceOf',
              args: [address],
            });
            return {
              address: token.address,
              symbol: token.symbol,
              balance: balance.toString(),
              balanceFormatted: formatUnits(balance, token.decimals),
              decimals: token.decimals,
            };
          }),
        );

        return {
          chainId,
          eth: {
            balance: ethBalance.toString(),
            balanceFormatted: formatEther(ethBalance),
          },
          tokens: tokenBalances.filter((t) => t.balance !== '0'),
        };
      }),
    );

    return { address: agent.safeAddress, balances };
  });

  /**
   * GET /v1/wallet/allowances — active ERC-20 allowances.
   */
  fastify.get('/v1/wallet/allowances', async (request) => {
    const query = request.query as { chainId?: string; spender?: string };
    const agent = await db.agent.findUnique({
      where: { id: request.agentId },
      select: { safeAddress: true, chainIds: true },
    });
    if (!agent) throw new Error('Agent not found');

    const chainId = parseInt(query.chainId ?? '1');
    const client = createChainPublicClient(chainId);
    const address = getAddress(agent.safeAddress);
    const tokens = COMMON_TOKENS[chainId] ?? [];

    // Default spenders to check
    const { getContracts } = await import('../../config/contracts.js');
    const contracts = getContracts(chainId);
    const spenders = query.spender
      ? [query.spender]
      : [contracts.uniswapV3Router, contracts.aavePoolAddressProvider];

    const allowances = await Promise.all(
      tokens.flatMap((token) =>
        spenders.map(async (spender) => {
          const allowance = await client.readContract({
            address: getAddress(token.address),
            abi: ERC20_READ_ABI,
            functionName: 'allowance',
            args: [address, getAddress(spender)],
          });
          return {
            token: token.address,
            symbol: token.symbol,
            spender,
            allowance: allowance.toString(),
            allowanceFormatted: formatUnits(allowance, token.decimals),
          };
        }),
      ),
    );

    return allowances.filter((a) => a.allowance !== '0');
  });
}
