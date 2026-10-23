import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { getAddress, formatEther, formatUnits, isAddress, zeroAddress, type Address } from 'viem';
import { createChainPublicClient } from '../../config/chains.js';
import { readAavePoolOnChain } from '../../services/policy/max-withdrawal-proof.js';
import { sanitizeText } from '../errors/sanitize.js';

/**
 * S12: the Aave V3 spender is the Pool — the contract a supply calls and that
 * pulls the tokens — as `getPool()` of the chain's configured
 * PoolAddressesProvider reports it now: the source the Aave routes use for
 * their target (supply / withdraw) and D20 for the trusted withdraw target.
 * Never the provider itself (no Aave contract spends against it). A provider
 * that cannot be read or answers no address is a reason, never a silent 0.
 */
async function resolveAavePool(
  chainId: number,
  provider: string,
): Promise<{ ok: true; pool: Address } | { ok: false; reason: string; cause?: string }> {
  let providerAddress: Address;
  try {
    providerAddress = getAddress(provider);
  } catch {
    return { ok: false, reason: `the configured PoolAddressesProvider ${provider} on chain ${chainId} is not a valid address` };
  }
  const what = `getPool() on the configured Aave V3 PoolAddressesProvider ${providerAddress} (chain ${chainId})`;
  let pool: string;
  try {
    pool = await readAavePoolOnChain(chainId, providerAddress);
  } catch (err) {
    return { ok: false, reason: `${what} could not be read`, cause: err instanceof Error ? err.message : String(err) };
  }
  if (!isAddress(pool, { strict: false }) || pool.toLowerCase() === zeroAddress) {
    return { ok: false, reason: `${what} returned no Pool address` };
  }
  return { ok: true, pool: getAddress(pool) };
}

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
   *
   * Default spenders: the Uniswap V3 router and the Aave V3 Pool (S12: the
   * Pool from `getPool()` of the configured PoolAddressesProvider — before,
   * the provider itself was checked and the Aave allowance always read 0).
   * When that Pool cannot be resolved the request answers `502
   * AAVE_POOL_UNAVAILABLE` instead of omitting the Aave allowance.
   */
  fastify.get('/v1/wallet/allowances', async (request, reply) => {
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
    const spenders: string[] = query.spender ? [query.spender] : [contracts.uniswapV3Router];
    const provider = contracts.aavePoolAddressProvider;
    // No token to check, or no Aave on this chain (provider unset / zero): no Pool to resolve.
    if (!query.spender && tokens.length > 0 && provider && provider.toLowerCase() !== zeroAddress) {
      const aave = await resolveAavePool(chainId, provider);
      if (!aave.ok) {
        request.log.warn({ chainId, provider, cause: aave.cause ? sanitizeText(aave.cause) : undefined }, 'Aave V3 Pool unresolved');
        return reply.code(502).send({
          error: `The Aave V3 Pool could not be resolved: ${aave.reason}. Allowances are not reported without it.`,
          code: 'AAVE_POOL_UNAVAILABLE',
        });
      }
      spenders.push(aave.pool);
    }

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
