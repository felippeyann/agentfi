/**
 * EnsService — gives each agent a persistent on-chain identity via ENS.
 *
 * VISION.md calls for agents to carry an economic identity that other
 * dApps, explorers, and peer agents can reference. An ENS subdomain
 * (e.g., "alice.agentfi.eth") under a parent domain the operator owns
 * is the simplest way to achieve that without requiring each agent to
 * register its own root domain.
 *
 * This service is a no-op unless the operator has configured:
 *   - ENS_PARENT_DOMAIN            e.g. "agentfi.eth"
 *   - ENS_CONTROLLER_PRIVATE_KEY   the wallet that owns the parent node
 *   - ENS_CHAIN_ID                 defaults to 1 (mainnet)
 *   - ENS_PUBLIC_RESOLVER          optional override for the resolver
 *
 * When unconfigured, `registerSubdomain()` returns null so agent
 * registration still succeeds — ENS is optional identity, not a hard
 * dependency.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  namehash,
  toBytes,
  toHex,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getChain, getPrimaryRpcUrl } from '../../config/chains.js';
import { logger } from '../../api/middleware/logger.js';

// ENS Registry (same address on every supported network).
const ENS_REGISTRY: Address = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1E';

// Public Resolver — per-network, but mainnet's is the canonical default.
// Operators on other chains should set ENS_PUBLIC_RESOLVER explicitly.
const DEFAULT_PUBLIC_RESOLVER: Record<number, Address> = {
  1: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
  11155111: '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD', // Sepolia
};

const ENS_REGISTRY_ABI = [
  {
    name: 'setSubnodeRecord',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'label', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'ttl', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const PUBLIC_RESOLVER_ABI = [
  {
    name: 'setAddr',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'a', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export interface EnsConfig {
  parentDomain: string;
  controllerPrivateKey: Hex;
  chainId: number;
  publicResolver: Address;
}

/**
 * Parse configuration from environment. Returns null if the feature isn't
 * set up — callers must treat null as "ENS disabled, proceed without it".
 */
export function readEnsConfig(): EnsConfig | null {
  const parentDomain = process.env['ENS_PARENT_DOMAIN'];
  const rawKey = process.env['ENS_CONTROLLER_PRIVATE_KEY'];
  if (!parentDomain || !rawKey) return null;

  const chainId = parseInt(process.env['ENS_CHAIN_ID'] ?? '1', 10);
  const controllerPrivateKey = (
    rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`
  ) as Hex;
  const resolverOverride = process.env['ENS_PUBLIC_RESOLVER'] as
    | Address
    | undefined;
  const publicResolver =
    resolverOverride ?? DEFAULT_PUBLIC_RESOLVER[chainId];

  if (!publicResolver) {
    logger.warn(
      { chainId },
      'ENS_PUBLIC_RESOLVER not set and no default known for this chain — ENS disabled',
    );
    return null;
  }

  return { parentDomain, controllerPrivateKey, chainId, publicResolver };
}

/**
 * Normalise a free-form agent name into a DNS label:
 *   - lowercase
 *   - strip disallowed characters (keep a-z, 0-9, and "-")
 *   - collapse consecutive dashes, trim leading/trailing dashes
 *   - must be 3-63 chars to be a valid DNS label
 *
 * Returns null if nothing usable remains (e.g., name was "🤖🤖").
 */
export function normalizeEnsLabel(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length < 3 || slug.length > 63) return null;
  return slug;
}

/**
 * Build a subdomain candidate of the form `<label>.<parent>` and, if
 * needed, a deterministic disambiguation suffix from the agent id so
 * two agents with similar names don't collide.
 */
export function buildSubdomainCandidate(params: {
  name: string;
  agentId: string;
  parentDomain: string;
}): { label: string; fullName: string } | null {
  const base = normalizeEnsLabel(params.name);
  if (!base) return null;
  // Short id suffix keeps the name readable while guaranteeing uniqueness
  // across agents whose names slugify to the same value.
  const idSuffix = params.agentId.slice(-6).toLowerCase();
  const label = `${base}-${idSuffix}`.slice(0, 63);
  return { label, fullName: `${label}.${params.parentDomain}` };
}

export interface RegisterResult {
  fullName: string;
  label: string;
  txHash: Hex;
}

export class EnsService {
  private readonly config: EnsConfig | null;
  private readonly publicClient: PublicClient | null;
  private readonly walletClient: WalletClient | null;
  private readonly controllerAddress: Address | null;

  constructor(config: EnsConfig | null = readEnsConfig()) {
    this.config = config;

    if (!config) {
      this.publicClient = null;
      this.walletClient = null;
      this.controllerAddress = null;
      return;
    }

    const chain = getChain(config.chainId);
    const transport = http(getPrimaryRpcUrl(config.chainId));
    const account = privateKeyToAccount(config.controllerPrivateKey);

    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account, chain, transport });
    this.controllerAddress = account.address;
  }

  /** True when the operator has configured ENS and the service can act. */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Register a subdomain pointing to the agent's address.
   *
   * Returns null (and logs) on any failure — ENS is optional, so the
   * caller must not abort agent registration if this fails.
   */
  async registerSubdomain(params: {
    name: string;
    agentId: string;
    targetAddress: string;
  }): Promise<RegisterResult | null> {
    if (!this.config || !this.walletClient || !this.controllerAddress) {
      return null;
    }

    const candidate = buildSubdomainCandidate({
      name: params.name,
      agentId: params.agentId,
      parentDomain: this.config.parentDomain,
    });

    if (!candidate) {
      logger.warn(
        { agentId: params.agentId, name: params.name },
        'ENS: agent name did not yield a valid DNS label — skipping',
      );
      return null;
    }

    let target: Address;
    try {
      target = getAddress(params.targetAddress);
    } catch {
      logger.warn(
        { agentId: params.agentId, targetAddress: params.targetAddress },
        'ENS: target is not a valid address — skipping',
      );
      return null;
    }

    const parentNode = namehash(this.config.parentDomain);
    const labelHash = keccak256(toBytes(candidate.label));
    const subnode = namehash(candidate.fullName);

    try {
      // 1. Claim the subnode and point it at the public resolver, still
      //    owned by the controller so we can write the addr record.
      const subnodeTxHash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        chain: this.walletClient.chain!,
        address: ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: 'setSubnodeRecord',
        args: [
          parentNode,
          labelHash,
          this.controllerAddress,
          this.config.publicResolver,
          0n,
        ],
      });
      if (this.publicClient) {
        await this.publicClient.waitForTransactionReceipt({
          hash: subnodeTxHash,
        });
      }

      // 2. Point the resolver at the agent's Safe address.
      const setAddrTxHash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        chain: this.walletClient.chain!,
        address: this.config.publicResolver,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'setAddr',
        args: [subnode, target],
      });
      if (this.publicClient) {
        await this.publicClient.waitForTransactionReceipt({
          hash: setAddrTxHash,
        });
      }

      logger.info(
        {
          agentId: params.agentId,
          ensName: candidate.fullName,
          txHash: setAddrTxHash,
        },
        'ENS subdomain registered',
      );

      return {
        fullName: candidate.fullName,
        label: candidate.label,
        txHash: setAddrTxHash,
      };
    } catch (err) {
      logger.warn(
        {
          err,
          agentId: params.agentId,
          ensName: candidate.fullName,
        },
        'ENS subdomain registration failed — agent will have no ensName',
      );
      return null;
    }
  }

  /**
   * Exposed for tests and diagnostics — compute the namehash we would
   * use for a given subdomain without touching the chain.
   */
  static computeSubnode(parentDomain: string, label: string): Hex {
    return namehash(`${label}.${parentDomain}`);
  }

  /** Exposed for tests — stable label-hash used in setSubnodeRecord. */
  static computeLabelHash(label: string): Hex {
    return toHex(keccak256(toBytes(label)));
  }
}
