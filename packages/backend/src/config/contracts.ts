import type { Address } from 'viem';

interface ChainContracts {
  policyModule?: Address | undefined;
  executor?: Address | undefined;
  // Uniswap V3 addresses
  uniswapV3Router: Address;
  uniswapV3Quoter: Address;
  // Aave V3 addresses
  aavePoolAddressProvider: Address;
}

export const CONTRACT_ADDRESSES: Record<number, ChainContracts> = {
  // Ethereum Mainnet
  1: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_1'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_1'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
  },
  // Base
  8453: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_8453'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_8453'] as Address) || undefined,
    uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B136CFc5b5e8b4e1b2f7',
    aavePoolAddressProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64B',
  },
  // Arbitrum One
  42161: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_42161'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_42161'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  },
  // Polygon
  137: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_137'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_137'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  },
};

export function getContracts(chainId: number): ChainContracts {
  const contracts = CONTRACT_ADDRESSES[chainId];
  if (!contracts) throw new Error(`No contract addresses for chain ${chainId}`);
  return contracts;
}
