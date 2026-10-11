/**
 * Unit tests — ReputationHook state for the trust report (task C3d,
 * `services/job/hook-state.ts`): canonicalAgentId(wallet) and
 * penalties(agentId) per minted identity, cached, failures reported as null.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { __clearHookStateCache, HOOK_STATE_CACHE_MS, readHookReputation, type HookStateDeps } from '../services/job/hook-state.js';

const HOOK = '0x000000000000000000000000000000000000400C' as Address;
const WALLET = '0x2222222222222222222222222222222222222222';

function deps(read: HookStateDeps['readContract'], now = { t: 1_000_000 }): HookStateDeps & { now: () => number } {
  return { hook: (chainId) => (chainId === 84532 ? HOOK : null), readContract: read, now: () => now.t };
}

beforeEach(() => __clearHookStateCache());

describe('readHookReputation', () => {
  it('reads penalties(agentId) and canonicalAgentId(wallet) for each minted identity on a chain with a hook', async () => {
    const read = vi.fn(async (_chainId: number, call: { functionName: string; args: readonly unknown[] }) =>
      call.functionName === 'penalties' ? 2n : 7n,
    );
    const views = await readHookReputation(deps(read as never), {
      identities: [
        { chainId: 84532, erc8004AgentId: '7' },
        { chainId: 84532, erc8004AgentId: null }, // minting in flight
        { chainId: 8453, erc8004AgentId: '9' }, // no hook configured there
      ],
      walletAddress: WALLET,
    });
    expect(views).toEqual([{ chainId: 84532, hook: HOOK, agentId: '7', canonicalAgentId: '7', penalties: '2' }]);
    expect(read).toHaveBeenCalledWith(84532, expect.objectContaining({ address: HOOK, functionName: 'penalties', args: [7n] }));
    expect(read).toHaveBeenCalledWith(84532, expect.objectContaining({ address: HOOK, functionName: 'canonicalAgentId', args: [WALLET] }));
  });

  it('reports a canonical id that differs from the minted one, and 0 as "none bound yet"', async () => {
    const differs = await readHookReputation(deps((async (_c: number, call: { functionName: string }) => (call.functionName === 'penalties' ? 0n : 3n)) as never), {
      identities: [{ chainId: 84532, erc8004AgentId: '7' }],
      walletAddress: WALLET,
    });
    expect(differs[0]).toMatchObject({ agentId: '7', canonicalAgentId: '3', penalties: '0' });

    __clearHookStateCache();
    const unbound = await readHookReputation(deps((async () => 0n) as never), { identities: [{ chainId: 84532, erc8004AgentId: '7' }], walletAddress: WALLET });
    expect(unbound[0]).toMatchObject({ canonicalAgentId: null, penalties: '0' });
  });

  it('caches for a minute (public endpoint: no RPC amplification); failed reads are null and not cached', async () => {
    const clock = { t: 1_000_000 };
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw new Error('rpc down');
      return 1n;
    });
    const d = deps(read as never, clock);
    const params = { identities: [{ chainId: 84532, erc8004AgentId: '7' }], walletAddress: WALLET };

    expect((await readHookReputation(d, params))[0]).toMatchObject({ canonicalAgentId: null, penalties: null });
    fail = false;
    expect((await readHookReputation(d, params))[0]).toMatchObject({ canonicalAgentId: '1', penalties: '1' });
    const calls = read.mock.calls.length;
    await readHookReputation(d, params);
    expect(read.mock.calls.length).toBe(calls);
    clock.t += HOOK_STATE_CACHE_MS + 1;
    await readHookReputation(d, params);
    expect(read.mock.calls.length).toBe(calls + 2);
  });
});
