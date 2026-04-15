import type { Address } from 'viem';

interface ChainContracts {
  policyModule?: Address | undefined;
  executor?: Address | undefined;
  // Uniswap V3 addresses
  uniswapV3Router: Address;
  uniswapV3Quoter: Address;
  // Aave V3 addresses
  aavePoolAddressProvider: Address;
  // Compound V3 (Comet) USDC market address. One per chain.
  compoundCometUsdc?: Address | undefined;
}

export const CONTRACT_ADDRESSES: Record<number, ChainContracts> = {
  // Ethereum Mainnet
  1: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_1'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_1'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
    compoundCometUsdc: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  },
  // Base
  8453: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_8453'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_8453'] as Address) || undefined,
    uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B136CFc5b5e8b4e1b2f7',
    aavePoolAddressProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64B',
    compoundCometUsdc: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  },
  // Arbitrum One
  42161: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_42161'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_42161'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    compoundCometUsdc: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
  },
  // Base Sepolia (testnet)
  84532: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_84532'] as Address) || '0x771444Ff5483ef3A62b492a816Cb439e4f017203',
    executor: (process.env['EXECUTOR_ADDRESS_84532'] as Address) || '0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d',
    uniswapV3Router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    uniswapV3Quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
    aavePoolAddressProvider: '0x0000000000000000000000000000000000000000', // not deployed on testnet
  },
  // Polygon
  137: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_137'] as Address) || undefined,
    executor: (process.env['EXECUTOR_ADDRESS_137'] as Address) || undefined,
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    compoundCometUsdc: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
  },
};

export function getContracts(chainId: number): ChainContracts {
  const contracts = CONTRACT_ADDRESSES[chainId];
  if (!contracts) throw new Error(`No contract addresses for chain ${chainId}`);
  return contracts;
}
