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
  // GMX V2 Synthetics addresses (Arbitrum-primary)
  gmxExchangeRouter?: Address | undefined;
  gmxRouter?: Address | undefined;
  gmxOrderVault?: Address | undefined;
  // Escrow v3 — on-chain custody for A2A job payments
  escrowModule?: Address | undefined;
  // ERC-8183 (C3) — `AgentJobEscrow` (USDC-only job escrow) and the optional
  // `ReputationHook` passed per job to `createJob(..., hook)`.
  agentJobEscrow?: Address | undefined;
  reputationHook?: Address | undefined;
  // ERC-8004 (R2) — Identity Registry the provider identities are minted in.
  identityRegistry?: Address | undefined;
}

/** `AGENT_JOB_ESCROW_ADDRESS_<chainId>` / `REPUTATION_HOOK_ADDRESS_<chainId>` as the deploy script prints them. */
function erc8183FromEnv(chainId: number): Pick<ChainContracts, 'agentJobEscrow' | 'reputationHook'> {
  return {
    agentJobEscrow: (process.env[`AGENT_JOB_ESCROW_ADDRESS_${chainId}`] as Address) || undefined,
    reputationHook: (process.env[`REPUTATION_HOOK_ADDRESS_${chainId}`] as Address) || undefined,
  };
}

/**
 * Official ERC-8004 Identity Registry deployments (CREATE2, UUPS proxies), the
 * same defaults `script/DeployEscrow.s.sol` wires into `ReputationHook`.
 * Verified 2026-10-07 — see docs/architecture/erc-8004-integration.md §2.
 */
export const DEFAULT_IDENTITY_REGISTRIES: Readonly<Record<number, Address>> = {
  8453: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  84532: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

/**
 * `IDENTITY_REGISTRY_ADDRESS_<chainId>` when set (blank counts as unset), else
 * the official default for the chain, else undefined (no identity step there).
 * Must be the registry the chain's `ReputationHook` was deployed with, or the
 * hook skips feedback with `agent-not-provider`.
 */
export function resolveIdentityRegistry(chainId: number, source: ContractEnvSource = process.env): Address | undefined {
  const override = source[`IDENTITY_REGISTRY_ADDRESS_${chainId}`];
  if (override) return override as Address;
  return DEFAULT_IDENTITY_REGISTRIES[chainId];
}

/** `process.env`-shaped lookup; injectable so the helpers below are unit-testable. */
export type ContractEnvSource = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// ABI versioning guard (October 2026)
// ---------------------------------------------------------------------------
// Declared BEFORE CONTRACT_ADDRESSES: the executor resolution below consults
// this list while the address table is being built.

export type LegacyContractKind = 'policyModule' | 'executor';

export interface LegacyContractAddress {
  chainId: number;
  contract: LegacyContractKind;
  address: Address;
}

/**
 * Deployments compiled from the pre-October-2026 `AgentExecutor.Action` struct
 * `(target, value, data)`. The current source — and the backend encoder in
 * `abi/AgentExecutor.abi.ts` — use `(target, value, token, data)`, so
 * `executeSingle`/`executeBatch` on these addresses have different selectors
 * and every transaction routed through them reverts. The policy module from
 * the same deployment is listed too: its own ABI did not change
 * (`validateTransaction` already took a token), but it is the pair the
 * legacy executor is bound to and Deploy.s.sol always ships a fresh pair.
 * Redeploy from `packages/contracts/src` and update the `*_ADDRESS_<chainId>`
 * env vars. See docs/operations/contract-deployment.md ("ABI versioning").
 */
export const LEGACY_CONTRACT_ADDRESSES: readonly LegacyContractAddress[] = [
  // Base Mainnet — maintainer deployment, 2026-03
  { chainId: 8453,  contract: 'policyModule', address: '0x03afE9c56331EE6A795C873a5e7E23308F6f6A6d' },
  { chainId: 8453,  contract: 'executor',     address: '0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3' },
  // Base Sepolia — former hard-coded testnet defaults
  { chainId: 84532, contract: 'policyModule', address: '0x771444Ff5483ef3A62b492a816Cb439e4f017203' },
  { chainId: 84532, contract: 'executor',     address: '0x1fE2A4e79899A9cB03bED301f978d2Ce2F91Fc5d' },
];

/** True when `address` is a known pre-October-2026 (old Action struct) deployment on `chainId`. */
export function isLegacyContractAddress(chainId: number, address: string): boolean {
  const needle = address.toLowerCase();
  return LEGACY_CONTRACT_ADDRESSES.some(
    (legacy) => legacy.chainId === chainId && legacy.address.toLowerCase() === needle,
  );
}

/** Name of the env var that configures `contract` on `chainId`. */
export function contractEnvVar(chainId: number, contract: LegacyContractKind): string {
  return contract === 'executor'
    ? `EXECUTOR_ADDRESS_${chainId}`
    : `POLICY_MODULE_ADDRESS_${chainId}`;
}

/** One-line operator-facing explanation of a legacy hit, shared by boot, preflight and the executor. */
export function describeLegacyContract(legacy: LegacyContractAddress): string {
  return (
    `${contractEnvVar(legacy.chainId, legacy.contract)}=${legacy.address} is a pre-October-2026 ` +
    'deployment compiled from the old AgentExecutor.Action struct (no token field). ' +
    (legacy.contract === 'executor'
      ? 'Transactions routed through this executor WILL revert. '
      : 'It is paired with a legacy executor. ') +
    'Redeploy from packages/contracts and update the env var — see ' +
    'docs/operations/contract-deployment.md ("ABI versioning").'
  );
}

/**
 * Resolves the executor to route through on `chainId`.
 *
 *  - not configured            → `{ address: null, legacy: null }`
 *  - configured, current ABI   → `{ address, legacy: null }`
 *  - configured, known legacy  → `{ address: null, legacy }` — treated as
 *    "not configured" so callers send transactions directly instead of
 *    through an executor whose selectors do not exist (every call reverts).
 *
 * `env.ts` refuses to boot `production`/`staging` with a legacy executor at
 * all; this helper is what keeps development usable with a warning.
 */
export function resolveExecutorAddress(
  chainId: number,
  source: ContractEnvSource = process.env,
): { address: Address | null; legacy: LegacyContractAddress | null } {
  const raw = source[contractEnvVar(chainId, 'executor')];
  if (!raw) return { address: null, legacy: null };
  const address = raw as Address;
  if (isLegacyContractAddress(chainId, address)) {
    return { address: null, legacy: { chainId, contract: 'executor', address } };
  }
  return { address, legacy: null };
}

/** `getContracts(chainId).executor` — undefined when unset OR a known legacy deployment. */
function executorFromEnv(chainId: number): Address | undefined {
  return resolveExecutorAddress(chainId).address ?? undefined;
}

export const CONTRACT_ADDRESSES: Record<number, ChainContracts> = {
  // Ethereum Mainnet
  1: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_1'] as Address) || undefined,
    executor: executorFromEnv(1),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_1'] as Address) || undefined,
    ...erc8183FromEnv(1),
    identityRegistry: resolveIdentityRegistry(1),
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
    compoundCometUsdc: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  },
  // Base
  8453: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_8453'] as Address) || undefined,
    executor: executorFromEnv(8453),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_8453'] as Address) || undefined,
    ...erc8183FromEnv(8453),
    identityRegistry: resolveIdentityRegistry(8453),
    uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B136CFc5b5e8b4e1b2f7',
    aavePoolAddressProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64B',
    compoundCometUsdc: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  },
  // Arbitrum One
  42161: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_42161'] as Address) || undefined,
    executor: executorFromEnv(42161),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_42161'] as Address) || undefined,
    ...erc8183FromEnv(42161),
    identityRegistry: resolveIdentityRegistry(42161),
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    compoundCometUsdc: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
    gmxExchangeRouter: '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
    gmxRouter: '0x7452c558d45f8006Ce12C56010796DCe2eB24afb',
    gmxOrderVault: '0x31eF83a530Fde1B38deDA89C0A6c72a85b35CDf6',
  },
  // Base Sepolia (testnet)
  // No hard-coded defaults: the former testnet pair (policy 0x771444Ff…7203,
  // executor 0x1fE2A4e7…Fc5d) was compiled from the pre-October-2026 Action
  // struct and is listed in LEGACY_CONTRACT_ADDRESSES above. Set the
  // *_ADDRESS_84532 env vars after redeploying — same contract as other chains.
  84532: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_84532'] as Address) || undefined,
    executor: executorFromEnv(84532),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_84532'] as Address) || undefined,
    ...erc8183FromEnv(84532),
    identityRegistry: resolveIdentityRegistry(84532),
    uniswapV3Router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    uniswapV3Quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
    aavePoolAddressProvider: '0x0000000000000000000000000000000000000000', // not deployed on testnet
  },
  // Polygon
  137: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_137'] as Address) || undefined,
    executor: executorFromEnv(137),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_137'] as Address) || undefined,
    ...erc8183FromEnv(137),
    identityRegistry: resolveIdentityRegistry(137),
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

/**
 * Scans the env-configured policyModule/executor addresses of every supported
 * chain and returns the ones that are known legacy deployments. Reads the raw
 * env (not `CONTRACT_ADDRESSES`, which already hides legacy executors) so the
 * boot FATAL / WARN can name what the operator actually configured.
 */
export function findLegacyContractConfig(
  source: ContractEnvSource = process.env,
): LegacyContractAddress[] {
  const hits: LegacyContractAddress[] = [];
  for (const chainIdStr of Object.keys(CONTRACT_ADDRESSES)) {
    const chainId = Number(chainIdStr);
    for (const contract of ['policyModule', 'executor'] as const) {
      const address = source[contractEnvVar(chainId, contract)];
      if (address && isLegacyContractAddress(chainId, address)) {
        hits.push({ chainId, contract, address: address as Address });
      }
    }
  }
  return hits;
}
