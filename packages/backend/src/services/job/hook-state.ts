/**
 * ReputationHook state of an agent, for the public trust report (task C3d).
 *
 * The hook keeps two facts per provider that the registry summary alone does
 * not show:
 *  - `canonicalAgentId(provider)`: the ERC-8004 id every settlement of the
 *    provider address is rated under (first verified bind wins) — it can
 *    differ from the id the backend minted if the address ever bound another;
 *  - `penalties(agentId)`: negative verdicts the Reputation Registry did not
 *    record (e.g. the provider approved the hook to dodge them). While non-zero
 *    the hook writes no positive entry for the id; consumers should read it
 *    next to `getSummary` (erc-8004-integration.md §4).
 *
 * Two view calls per identity, cached for a minute per (chain, hook, id,
 * address): the trust report is public, so it must not turn into an RPC
 * amplifier. A failed read reports null for that field, never an error.
 */

import { getAddress, type Address } from 'viem';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';

export interface HookStateDeps {
  /** `REPUTATION_HOOK_ADDRESS_<chainId>`, or null when the chain has none. */
  hook(chainId: number): Address | null;
  readContract(chainId: number, params: { address: Address; abi: typeof REPUTATION_HOOK_ABI; functionName: 'penalties' | 'canonicalAgentId'; args: readonly unknown[] }): Promise<unknown>;
  now?: () => number;
}

export interface HookReputationView {
  chainId: number;
  hook: Address;
  /** The ERC-8004 id the backend minted for the agent on this chain. */
  agentId: string;
  /** `canonicalAgentId(agent wallet)`: the id the hook rates this wallet under (null: none bound yet / unreadable). */
  canonicalAgentId: string | null;
  /** `penalties(agentId)`: unrecorded negative verdicts (null: unreadable). */
  penalties: string | null;
}

export const HOOK_STATE_CACHE_MS = 60_000;
const cache = new Map<string, { at: number; view: HookReputationView }>();

/** Testing hook. */
export function __clearHookStateCache(): void {
  cache.clear();
}

async function readUint(deps: HookStateDeps, chainId: number, params: Parameters<HookStateDeps['readContract']>[1]): Promise<bigint | null> {
  try {
    return BigInt((await deps.readContract(chainId, params)) as bigint);
  } catch {
    return null;
  }
}

export async function readHookReputation(
  deps: HookStateDeps,
  params: { identities: ReadonlyArray<{ chainId: number; erc8004AgentId: string | null }>; walletAddress: string },
): Promise<HookReputationView[]> {
  const now = deps.now?.() ?? Date.now();
  const wallet = getAddress(params.walletAddress);
  const views: HookReputationView[] = [];
  for (const identity of params.identities) {
    if (!identity.erc8004AgentId) continue;
    const hook = deps.hook(identity.chainId);
    if (!hook) continue;
    const key = `${identity.chainId}:${hook.toLowerCase()}:${identity.erc8004AgentId}:${wallet.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && now - cached.at < HOOK_STATE_CACHE_MS) {
      views.push(cached.view);
      continue;
    }
    const [penalties, canonical] = await Promise.all([
      readUint(deps, identity.chainId, { address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'penalties', args: [BigInt(identity.erc8004AgentId)] }),
      readUint(deps, identity.chainId, { address: hook, abi: REPUTATION_HOOK_ABI, functionName: 'canonicalAgentId', args: [wallet] }),
    ]);
    const view: HookReputationView = {
      chainId: identity.chainId,
      hook,
      agentId: identity.erc8004AgentId,
      canonicalAgentId: canonical !== null && canonical > 0n ? canonical.toString() : null,
      penalties: penalties !== null ? penalties.toString() : null,
    };
    if (penalties !== null && canonical !== null) cache.set(key, { at: now, view });
    views.push(view);
  }
  return views;
}
