/**
 * S8 — on-chain policy sync: what the module SHOULD hold, what it holds, and
 * the calls that move it there. Pure: no env, no DB, no clock, no I/O (the
 * chain reader is a parameter).
 *
 * Authority (what `AgentPolicyModule` already defines, nothing widened):
 * `setPolicy` / `updateContractWhitelist` / `updateTokenWhitelist` /
 * `emergencyPause` / `resume` accept only the module's immutable `operator`
 * or `msg.sender == safe`. `AgentExecutor.executeBatch` calls every action
 * with the EXECUTOR as `msg.sender`, so a module call sent through it can
 * never succeed (reproduced on Anvil, `policy-sync.contracts.anvil.ts`). In
 * EOA mode — every agent provisioned without a Safe, `safeAddress` = the
 * agent's own EOA — "the safe" is that EOA: the sync is a plain transaction
 * from the agent's wallet to the module (`msg.sender == safe`), built only
 * from the policy stored in the DB and triggered only by the admin credential
 * (`POST /admin/agents/:id/policy/sync`). The executor never becomes an
 * operator, the agent's API key gains no new call, and nothing free-form is
 * signed.
 *
 * Mapping (DB → module):
 *   maxValuePerTxEth      → maxValuePerTx (wei; "0" and > 18 decimals are not representable)
 *   cooldownSeconds       → cooldownBetweenTx
 *   agent.active && policy.active → active
 *   expiresAt             → policyExpiresAt (unix seconds, 0 = none)
 *   allowedContracts      → contract whitelist (add AND remove; empty = unrestricted on both sides)
 *   allowedTokens         → token whitelist (same)
 * Off-chain only (no slot in the module): maxValuePerTxUsd, allowedRecipients,
 * maxDailyVolumeUsd, maxValueForAutoApprovalEth.
 *
 * Whitelists are mappings without enumeration. Membership is read per
 * candidate address (the DB list plus every address an earlier sync of this
 * agent sent); `numAllowedContracts` / `numAllowedTokens` reveal entries the
 * backend cannot name (written out of band, e.g. with the operator key): they
 * are reported, never guessed.
 */
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from 'viem';
import { AGENT_POLICY_MODULE_ABI_FULL } from '../../abi/AgentPolicyModule.abi.js';
import { POLICY_DECIMAL_PATTERN } from './policy-numbers.js';

export const POLICY_MODULE_ABI = AGENT_POLICY_MODULE_ABI_FULL;

/** Fields of the DB policy that have no slot in `AgentPolicyModule` (enforced by the backend only). */
export const OFF_CHAIN_ONLY_POLICY_FIELDS = [
  'maxValuePerTxUsd',
  'allowedRecipients',
  'maxDailyVolumeUsd',
  'maxValueForAutoApprovalEth',
] as const;

export type PolicySyncCallName = 'setPolicy' | 'emergencyPause' | 'resume' | 'updateContractWhitelist' | 'updateTokenWhitelist';

/** What the module should hold for `safe`, derived from the DB. */
export interface DesiredOnChainPolicy {
  safe: Address;
  maxValuePerTxWei: bigint;
  cooldownSeconds: bigint;
  active: boolean;
  /** Unix seconds; 0 = no expiry. */
  expiresAt: bigint;
  /** Checksummed, de-duplicated (case-insensitive), DB order kept. */
  allowedContracts: Address[];
  allowedTokens: Address[];
}

/** The slice of the DB the desired policy is derived from. */
export interface DbPolicyInput {
  safeAddress: string;
  agentActive: boolean;
  policy: {
    maxValuePerTxEth: string;
    cooldownSeconds: number;
    active: boolean;
    expiresAt: Date | null;
    allowedContracts: string[];
    allowedTokens: string[];
  };
}

export type DesiredPolicyResult = { ok: true; desired: DesiredOnChainPolicy } | { ok: false; problems: string[] };

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function normalizeList(field: string, raw: string[], problems: string[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !ADDRESS_PATTERN.test(entry)) {
      problems.push(`${field} entry ${JSON.stringify(entry)} is not an address`);
      continue;
    }
    const lower = entry.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    // getAddress on the lowercase form: a stored mixed-case entry with a bad
    // EIP-55 checksum still names the same 20 bytes.
    out.push(getAddress(lower));
  }
  return out;
}

/** ETH decimal string → wei, exactly (no rounding), or null. */
export function ethDecimalToWei(raw: string): bigint | null {
  if (!POLICY_DECIMAL_PATTERN.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.') as [string, string?];
  if (fraction.length > 18) return null;
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0');
}

/**
 * The module policy the DB asks for, or why the module cannot hold it. Never
 * rounds or substitutes: a value the module cannot represent is refused.
 */
export function desiredOnChainPolicy(input: DbPolicyInput): DesiredPolicyResult {
  const problems: string[] = [];
  if (!ADDRESS_PATTERN.test(input.safeAddress)) problems.push(`safeAddress ${JSON.stringify(input.safeAddress)} is not an address`);

  const wei = ethDecimalToWei(input.policy.maxValuePerTxEth);
  if (wei === null) {
    problems.push(
      `maxValuePerTxEth ${JSON.stringify(input.policy.maxValuePerTxEth)} is not a plain decimal with at most 18 decimals ` +
        '(AgentPolicyModule stores wei)',
    );
  } else if (wei === 0n) {
    problems.push(
      'maxValuePerTxEth "0" (no native value at all) cannot be stored: AgentPolicyModule.setPolicy reverts InvalidPolicy for 0. ' +
        'The backend keeps enforcing it off-chain; it is not rounded up to 1 wei.',
    );
  }
  const cooldown = input.policy.cooldownSeconds;
  if (!Number.isSafeInteger(cooldown) || cooldown < 0) problems.push(`cooldownSeconds ${cooldown} is not a non-negative integer`);

  const allowedContracts = normalizeList('allowedContracts', input.policy.allowedContracts, problems);
  const allowedTokens = normalizeList('allowedTokens', input.policy.allowedTokens, problems);
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    desired: {
      safe: getAddress(input.safeAddress.toLowerCase()),
      maxValuePerTxWei: wei!,
      cooldownSeconds: BigInt(cooldown),
      active: input.agentActive && input.policy.active,
      expiresAt: input.policy.expiresAt ? BigInt(Math.floor(input.policy.expiresAt.getTime() / 1000)) : 0n,
      allowedContracts,
      allowedTokens,
    },
  };
}

/** Raw whitelist membership (not the module's "empty list = everything allowed" view). */
export interface WhitelistReading {
  /** `numAllowed*`; null when no policy exists (getPolicy reverts — the count is not readable). */
  count: bigint | null;
  /** Lowercase address → whitelisted on-chain. */
  members: Map<string, boolean>;
}

export interface OnChainPolicyReading {
  hasPolicy: boolean;
  /** Null when `hasPolicy` is false. */
  core: { maxValuePerTxWei: bigint; cooldownSeconds: bigint; active: boolean; expiresAt: bigint } | null;
  contracts: WhitelistReading;
  tokens: WhitelistReading;
}

/** `readContract` of one chain (a viem public client satisfies it). */
export type PolicyModuleReader = (params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => Promise<unknown>;

/**
 * An address no sync ever whitelists (the zero address is refused upstream),
 * read to tell "count 0" (the module answers true for every target) from
 * "count > 0" while no policy exists and the count is not readable.
 */
const PROBE: Address = '0x0000000000000000000000000000000000000000';

/**
 * Reads the module's policy for `safe` and the raw membership of each
 * candidate. Errors propagate (the caller classifies transport vs answer).
 */
export async function readOnChainPolicy(
  read: PolicyModuleReader,
  module: Address,
  safe: Address,
  candidates: { contracts: readonly Address[]; tokens: readonly Address[] },
): Promise<OnChainPolicyReading> {
  const abi = POLICY_MODULE_ABI as unknown as Abi;
  const call = (functionName: string, args: readonly unknown[]) => read({ address: module, abi, functionName, args });

  const hasPolicy = (await call('hasPolicy', [safe])) as boolean;
  let core: OnChainPolicyReading['core'] = null;
  let contractCount: bigint | null = null;
  let tokenCount: bigint | null = null;
  if (hasPolicy) {
    const p = (await call('getPolicy', [safe])) as {
      maxValuePerTx: bigint;
      cooldownBetweenTx: bigint;
      active: boolean;
      policyExpiresAt: bigint;
      numAllowedContracts: bigint;
      numAllowedTokens: bigint;
    };
    core = { maxValuePerTxWei: p.maxValuePerTx, cooldownSeconds: p.cooldownBetweenTx, active: p.active, expiresAt: p.policyExpiresAt };
    contractCount = p.numAllowedContracts;
    tokenCount = p.numAllowedTokens;
  }

  async function members(fn: 'isContractAllowed' | 'isTokenAllowed', count: bigint | null, list: readonly Address[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (list.length === 0) return out;
    // The view answers true for EVERY address while the list is empty.
    const empty = count !== null ? count === 0n : ((await call(fn, [safe, PROBE])) as boolean);
    for (const address of list) {
      out.set(address.toLowerCase(), empty ? false : ((await call(fn, [safe, address])) as boolean));
    }
    return out;
  }

  return {
    hasPolicy,
    core,
    contracts: { count: contractCount, members: await members('isContractAllowed', contractCount, candidates.contracts) },
    tokens: { count: tokenCount, members: await members('isTokenAllowed', tokenCount, candidates.tokens) },
  };
}

/** One module call the sync sends; `params` is JSON-safe (bigints as decimal strings) for `metadata.policySync`. */
export interface PolicySyncCall {
  name: PolicySyncCallName;
  data: Hex;
  params:
    | { maxValuePerTxWei: string; cooldownSeconds: string; active: boolean; expiresAt: string }
    | { addresses: Address[]; allowed: boolean[] }
    | Record<string, never>;
}

export interface PolicySyncPlan {
  calls: PolicySyncCall[];
  /** Human-readable DB ≠ chain differences (empty = in sync). */
  differences: string[];
  /** Whitelisted on-chain but not nameable by the backend (count − known members). Never removed automatically. */
  unknownExtras: { contracts: bigint; tokens: bigint };
}

export function encodeSetPolicy(desired: DesiredOnChainPolicy): PolicySyncCall {
  return {
    name: 'setPolicy',
    data: encodeFunctionData({
      abi: POLICY_MODULE_ABI,
      functionName: 'setPolicy',
      args: [
        desired.safe,
        { maxValuePerTx: desired.maxValuePerTxWei, cooldownBetweenTx: desired.cooldownSeconds, active: desired.active },
        desired.expiresAt,
      ],
    }),
    params: {
      maxValuePerTxWei: desired.maxValuePerTxWei.toString(),
      cooldownSeconds: desired.cooldownSeconds.toString(),
      active: desired.active,
      expiresAt: desired.expiresAt.toString(),
    },
  };
}

function encodeFlag(name: 'emergencyPause' | 'resume', safe: Address): PolicySyncCall {
  return { name, data: encodeFunctionData({ abi: POLICY_MODULE_ABI, functionName: name, args: [safe] }), params: {} };
}

function encodeWhitelist(name: 'updateContractWhitelist' | 'updateTokenWhitelist', safe: Address, addresses: Address[], allowed: boolean[]): PolicySyncCall {
  return {
    name,
    data: encodeFunctionData({ abi: POLICY_MODULE_ABI, functionName: name, args: [safe, addresses, allowed] }),
    params: { addresses, allowed },
  };
}

function planWhitelist(
  kind: 'contract' | 'token',
  desiredList: readonly Address[],
  history: readonly Address[],
  reading: WhitelistReading,
  differences: string[],
): { addresses: Address[]; allowed: boolean[]; unknownExtra: bigint } {
  const wanted = new Set(desiredList.map((a) => a.toLowerCase()));
  const addresses: Address[] = [];
  const allowed: boolean[] = [];
  for (const address of desiredList) {
    if (reading.members.get(address.toLowerCase()) !== true) {
      addresses.push(address);
      allowed.push(true);
      differences.push(`${kind} ${address} is in the DB allowlist but not whitelisted on-chain`);
    }
  }
  const seen = new Set<string>();
  for (const address of history) {
    const lower = address.toLowerCase();
    if (wanted.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    if (reading.members.get(lower) === true) {
      addresses.push(address);
      allowed.push(false);
      differences.push(`${kind} ${address} is whitelisted on-chain but not in the DB allowlist`);
    }
  }
  const known = [...reading.members.values()].filter(Boolean).length;
  const unknownExtra = reading.count !== null && reading.count > BigInt(known) ? reading.count - BigInt(known) : 0n;
  if (unknownExtra > 0n) {
    differences.push(
      `${unknownExtra} ${kind}(s) whitelisted on-chain that the backend cannot name (written out of band); the sync cannot remove them — ` +
        'use the operator key (module.operator()) to clear them',
    );
  }
  return { addresses, allowed, unknownExtra };
}

/**
 * The calls that make the module hold `desired`. `history` = addresses an
 * earlier sync of this agent sent (candidates for removal). `reading` must
 * have been taken with candidates ⊇ desired lists ∪ history.
 */
export function planPolicySync(
  desired: DesiredOnChainPolicy,
  reading: OnChainPolicyReading,
  history: { contracts: readonly Address[]; tokens: readonly Address[] } = { contracts: [], tokens: [] },
): PolicySyncPlan {
  const calls: PolicySyncCall[] = [];
  const differences: string[] = [];

  if (!reading.hasPolicy || !reading.core) {
    differences.push('no policy on-chain for this wallet (the executor applies no restriction to it)');
    calls.push(encodeSetPolicy(desired));
  } else {
    const c = reading.core;
    const coreDiffers: string[] = [];
    if (c.maxValuePerTxWei !== desired.maxValuePerTxWei) {
      coreDiffers.push(`maxValuePerTx: DB ${desired.maxValuePerTxWei} wei, on-chain ${c.maxValuePerTxWei} wei`);
    }
    if (c.cooldownSeconds !== desired.cooldownSeconds) {
      coreDiffers.push(`cooldown: DB ${desired.cooldownSeconds} s, on-chain ${c.cooldownSeconds} s`);
    }
    if (c.expiresAt !== desired.expiresAt) {
      coreDiffers.push(`expiry: DB ${desired.expiresAt}, on-chain ${c.expiresAt} (unix seconds, 0 = none)`);
    }
    const activeDiffers = c.active !== desired.active;
    if (activeDiffers) coreDiffers.push(`active: DB ${desired.active}, on-chain ${c.active}`);
    differences.push(...coreDiffers);
    if (coreDiffers.length > (activeDiffers ? 1 : 0)) {
      calls.push(encodeSetPolicy(desired));
    } else if (activeDiffers) {
      // Only the kill-switch flag differs: the module's own pause / resume.
      calls.push(encodeFlag(desired.active ? 'resume' : 'emergencyPause', desired.safe));
    }
  }

  const contracts = planWhitelist('contract', desired.allowedContracts, history.contracts, reading.contracts, differences);
  if (contracts.addresses.length > 0) {
    calls.push(encodeWhitelist('updateContractWhitelist', desired.safe, contracts.addresses, contracts.allowed));
  }
  const tokens = planWhitelist('token', desired.allowedTokens, history.tokens, reading.tokens, differences);
  if (tokens.addresses.length > 0) {
    calls.push(encodeWhitelist('updateTokenWhitelist', desired.safe, tokens.addresses, tokens.allowed));
  }

  return { calls, differences, unknownExtras: { contracts: contracts.unknownExtra, tokens: tokens.unknownExtra } };
}

/** `Transaction.metadata.policySync` of a sync row (written by the sync service, read by the pre-submit guard). */
export interface PolicySyncMetadata {
  call: PolicySyncCallName;
  module: Address;
  safe: Address;
  params: PolicySyncCall['params'];
}

/**
 * Re-checked by the pre-submit guard right before signing: does this queued
 * call still move the module TOWARDS the policy stored now? Null when it does,
 * otherwise why it is superseded (the DB changed after the sync was queued).
 */
export function supersededReason(meta: PolicySyncMetadata, desired: DesiredOnChainPolicy): string | null {
  if (meta.safe.toLowerCase() !== desired.safe.toLowerCase()) {
    return `queued for wallet ${meta.safe}, the agent's wallet is now ${desired.safe}`;
  }
  switch (meta.call) {
    case 'setPolicy': {
      const p = meta.params as { maxValuePerTxWei?: string; cooldownSeconds?: string; active?: boolean; expiresAt?: string };
      const now = encodeSetPolicy(desired).params as Record<string, unknown>;
      const same =
        p.maxValuePerTxWei === now['maxValuePerTxWei'] &&
        p.cooldownSeconds === now['cooldownSeconds'] &&
        p.active === now['active'] &&
        p.expiresAt === now['expiresAt'];
      return same ? null : 'the DB policy changed after this setPolicy was queued';
    }
    case 'emergencyPause':
      return desired.active ? 'the DB policy is active again; an on-chain pause would contradict it' : null;
    case 'resume':
      return desired.active ? null : 'the DB policy is paused now; an on-chain resume would contradict it';
    case 'updateContractWhitelist':
    case 'updateTokenWhitelist': {
      const { addresses = [], allowed = [] } = meta.params as { addresses?: string[]; allowed?: boolean[] };
      const list = new Set((meta.call === 'updateContractWhitelist' ? desired.allowedContracts : desired.allowedTokens).map((a) => a.toLowerCase()));
      for (let i = 0; i < addresses.length; i++) {
        const inDb = list.has(String(addresses[i]).toLowerCase());
        if (allowed[i] !== inDb) {
          return `the DB allowlist changed after this ${meta.call} was queued (${addresses[i]} is ${inDb ? 'now' : 'no longer'} in it)`;
        }
      }
      return null;
    }
    default:
      return `unknown policy-sync call ${JSON.stringify((meta as { call?: unknown }).call)}`;
  }
}

/** The PolicySyncMetadata of a Transaction row's metadata, or null when the row is not a sync. */
export function policySyncMetadataOf(metadata: unknown): PolicySyncMetadata | null {
  const raw = (metadata as { policySync?: unknown } | null)?.policySync as Partial<PolicySyncMetadata> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.call !== 'string' || typeof raw.module !== 'string' || typeof raw.safe !== 'string') {
    return null;
  }
  return raw as PolicySyncMetadata;
}

/** Addresses earlier syncs sent (candidates for removal), from the rows' metadata. */
export function syncHistory(rows: ReadonlyArray<{ metadata: unknown }>): { contracts: Address[]; tokens: Address[] } {
  const contracts = new Map<string, Address>();
  const tokens = new Map<string, Address>();
  for (const row of rows) {
    const meta = policySyncMetadataOf(row.metadata);
    if (!meta || (meta.call !== 'updateContractWhitelist' && meta.call !== 'updateTokenWhitelist')) continue;
    const target = meta.call === 'updateContractWhitelist' ? contracts : tokens;
    for (const address of (meta.params as { addresses?: unknown[] }).addresses ?? []) {
      if (typeof address === 'string' && ADDRESS_PATTERN.test(address)) target.set(address.toLowerCase(), getAddress(address.toLowerCase()));
    }
  }
  return { contracts: [...contracts.values()], tokens: [...tokens.values()] };
}
