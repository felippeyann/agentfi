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
 * Re-checked on-chain 2026-10-14 (S7): `name()` = "AgentIdentity" on both.
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

/**
 * Official ERC-8004 Reputation Registry deployments — the defaults
 * `script/DeployEscrow.s.sol` wires into `ReputationHook`
 * (docs/architecture/erc-8004-integration.md §1). The backend never writes to
 * it (the hook does); C3d's boot check compares it with `hook.reputationRegistry()`.
 * Re-checked on-chain 2026-10-14 (S7): `getIdentityRegistry()` = the chain's
 * default identity registry above.
 */
export const DEFAULT_REPUTATION_REGISTRIES: Readonly<Record<number, Address>> = {
  8453: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  84532: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};

/** `REPUTATION_REGISTRY_ADDRESS_<chainId>` when set (blank counts as unset), else the official default, else undefined. */
export function resolveReputationRegistry(chainId: number, source: ContractEnvSource = process.env): Address | undefined {
  const override = source[`REPUTATION_REGISTRY_ADDRESS_${chainId}`];
  if (override) return override as Address;
  return DEFAULT_REPUTATION_REGISTRIES[chainId];
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
 * Source: the maintainer's own deployments (no third-party record); code
 * present at each address on 2026-10-14 (S7 check).
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

// ---------------------------------------------------------------------------
// Third-party deployments (S7, verified 2026-10-14)
// ---------------------------------------------------------------------------
// Every hard-coded address below comes from the protocol's own deployment
// record, pinned to a commit, and was checked on-chain with read-only
// JSON-RPC (eth_getCode plus a view that binds it to its protocol, e.g. the
// provider's getPool(), the quoter's factory(), a GMX contract's roleStore()).
// `__tests__/contracts.addresses.test.ts` keeps them EIP-55 and pins the S7
// corrections; `__tests__/contracts.addresses.fork.test.ts` re-runs the
// identity checks on mainnet forks.
//
// Sources:
//   [AAVE] aave-dao/aave-address-book@6463b76862f4e2ea79764a02e0f1971c3fedb7fe
//          src/AaveV3{Ethereum,Base,Arbitrum,Polygon}.sol POOL_ADDRESSES_PROVIDER
//   [UNI]  Uniswap/docs@1c7597d73be0e9a3a4e44aa75b8fb212b40ea136
//          content/protocols/v3/deployments/v3-{ethereum,base,arbitrum,polygon}-deployments.mdx
//          (docs.uniswap.org; the Base page lists Base and Base Sepolia)
//   [COMP] compound-finance/comet@f766f51583c23acc33b2a7824654ef2029a96804
//          deployments/{mainnet,base,arbitrum,polygon}/usdc/roots.json "comet"
//   [GMX]  gmx-io/gmx-synthetics@a85ea3491c19c93bb4b5a002d9b358fb769b7849
//          deployments/arbitrum/{Router,OrderVault}.json, and the live UI config
//          gmx-io/gmx-interface@8974a1f3d0bdebdf28945a169d745f88b6e7fa72
//          sdk/src/configs/contracts.ts (SyntheticsRouter, OrderVault)
//
// S7: four entries were not casing slips but wrong addresses with NO code on
// their chain — Base aavePoolAddressProvider (…ad64B, official …ad64D), Base
// uniswapV3Quoter (…B136CFc5…, official QuoterV2 …B871ab26…), Arbitrum
// gmxRouter (…8006Ce12…, official …afC8c83d…) and gmxOrderVault (…deDA89C0…,
// official …EE9A1809…). viem refused them (invalid EIP-55), so those paths
// answered 500; correcting only the casing would have targeted empty
// addresses.

/**
 * Uniswap V3 QuoterV2 per chain — what the swap route quotes with
 * (`quoteExactInputSingle`); without a quote it builds the swap with
 * `amountOutMinimum = 0`. [UNI] "QuoterV2" rows. Base used a second wrong
 * address (…B136aa68…, no code) until S7, so every Base swap had no slippage
 * floor; Base Sepolia had no entry until the #183 review follow-up, so every
 * swap on the C5 chain had none either.
 */
export const UNISWAP_V3_QUOTER_V2: Readonly<Record<number, Address>> = {
  1: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  8453: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  42161: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  137: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  // [UNI] v3-base-deployments.mdx, "Base Sepolia Address" column (same
  // contract as uniswapV3Quoter for 84532 below). Read-only JSON-RPC to
  // https://sepolia.base.org on 2026-10-14 (block ≈48,121,370): 8,273 bytes
  // of code; factory() = UniswapV3Factory 0x4752ba5D…C372aD24 and WETH9() =
  // 0x4200…0006, both as on that page; it quotes WETH → USDC at 500 / 3000 /
  // 10000.
  84532: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
};

export const CONTRACT_ADDRESSES: Record<number, ChainContracts> = {
  // Ethereum Mainnet
  1: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_1'] as Address) || undefined,
    executor: executorFromEnv(1),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_1'] as Address) || undefined,
    ...erc8183FromEnv(1),
    identityRegistry: resolveIdentityRegistry(1),
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // [UNI] SwapRouter (V1 ABI, with deadline)
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6', // [UNI] Quoter (V1); not read by the routes
    aavePoolAddressProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e', // [AAVE] AaveV3Ethereum
    compoundCometUsdc: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', // [COMP] mainnet/usdc
  },
  // Base
  8453: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_8453'] as Address) || undefined,
    executor: executorFromEnv(8453),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_8453'] as Address) || undefined,
    ...erc8183FromEnv(8453),
    identityRegistry: resolveIdentityRegistry(8453),
    uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481', // [UNI] SwapRouter02
    // S7: was 0x3d4e44eb1374240ce5f1b136cfc5b5e8b4e1b2f7 (no code). [UNI] Base
    // QuoterV2; on-chain factory() = UniswapV3Factory 0x33128a8f…6FDfD.
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    // S7: was 0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64b (no code). [AAVE]
    // AaveV3Base; on-chain getPool() = 0xA238Dd80…98d1c5 (AaveV3Base.POOL),
    // whose ADDRESSES_PROVIDER() is this address; getMarketId() "Aave V3 BASE Market".
    aavePoolAddressProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
    compoundCometUsdc: '0xb125E6687d4313864e53df431d5425969c15Eb2F', // [COMP] base/usdc
  },
  // Arbitrum One
  42161: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_42161'] as Address) || undefined,
    executor: executorFromEnv(42161),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_42161'] as Address) || undefined,
    ...erc8183FromEnv(42161),
    identityRegistry: resolveIdentityRegistry(42161),
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // [UNI] SwapRouter (V1 ABI, with deadline)
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6', // [UNI] Quoter (V1); not read by the routes
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', // [AAVE] AaveV3Arbitrum
    compoundCometUsdc: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', // [COMP] arbitrum/usdc
    // A 2023 GMX ExchangeRouter, superseded: on 2026-10-14 it holds neither
    // CONTROLLER nor ROUTER_PLUGIN in GMX's RoleStore, so its sendTokens /
    // createOrder revert (GMX orders fail closed at simulation). The live one
    // ([GMX] interface config) is 0x7dE39FF2e232A2203196788d37e234cF8F1b83f1,
    // with a newer CreateOrderParams than builder.service.ts encodes — an
    // integration update, not an address fix (S7 PR, open question).
    gmxExchangeRouter: '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
    // S7: was 0x7452c558d45f8006ce12c56010796dce2eb24afb (no code). [GMX]
    // Router.json / SyntheticsRouter; on-chain roleStore() = GMX RoleStore
    // 0x3c3d99FD…5e6e72, and the ExchangeRouter above reports it as router().
    gmxRouter: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
    // S7: was 0x31ef83a530fde1b38deda89c0a6c72a85b35cdf6 (no code). [GMX]
    // OrderVault.json; on-chain roleStore() = GMX RoleStore, dataStore() =
    // GMX DataStore 0xFD70de6b…b992d8.
    gmxOrderVault: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
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
    uniswapV3Router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4', // [UNI] Base Sepolia SwapRouter02
    uniswapV3Quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27', // [UNI] Base Sepolia QuoterV2
    aavePoolAddressProvider: '0x0000000000000000000000000000000000000000', // not deployed on testnet
  },
  // Polygon
  137: {
    policyModule: (process.env['POLICY_MODULE_ADDRESS_137'] as Address) || undefined,
    executor: executorFromEnv(137),
    escrowModule: (process.env['ESCROW_MODULE_ADDRESS_137'] as Address) || undefined,
    ...erc8183FromEnv(137),
    identityRegistry: resolveIdentityRegistry(137),
    uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // [UNI] SwapRouter (V1 ABI, with deadline)
    uniswapV3Quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6', // [UNI] Quoter (V1); not read by the routes
    aavePoolAddressProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', // [AAVE] AaveV3Polygon
    compoundCometUsdc: '0xF25212E676D1F7F89Cd72fFEe66158f541246445', // [COMP] polygon/usdc
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
