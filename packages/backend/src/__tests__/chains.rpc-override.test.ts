/**
 * `RPC_URL_<chainId>` — per-chain primary RPC override (C5a).
 *
 * The override is read on every call and put in front of the existing
 * Alchemy → Infura → public candidates; blank counts as unset and other
 * chains are untouched. The fork E2E (`escrow-erc8183.fork.e2e.ts`) relies on
 * it to point the whole backend — submitter, monitor, evaluator signer,
 * escrow reads — at a local Anvil fork of Base Sepolia.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPrimaryRpcUrl,
  getRpcCandidates,
  getRpcOverride,
  getSecondaryRpcUrl,
  rpcOverrideEnvVar,
} from '../config/chains.js';

const FORK = 'http://127.0.0.1:8546';

describe('RPC_URL_<chainId> override', () => {
  const saved = process.env['RPC_URL_84532'];
  afterEach(() => {
    if (saved === undefined) delete process.env['RPC_URL_84532'];
    else process.env['RPC_URL_84532'] = saved;
  });

  it('names the variable per chain', () => {
    expect(rpcOverrideEnvVar(84532)).toBe('RPC_URL_84532');
    expect(rpcOverrideEnvVar(8453)).toBe('RPC_URL_8453');
  });

  it('is unset by default: the existing candidate order is unchanged', () => {
    const baseline = getRpcCandidates(84532, {});
    expect(getRpcOverride(84532, {})).toBeUndefined();
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline).toContain('https://sepolia.base.org');
    expect(baseline[baseline.length - 1]).toBe('https://sepolia.base.org');
  });

  it('becomes the primary candidate and keeps the existing ones as fallbacks', () => {
    const baseline = getRpcCandidates(84532, {});
    expect(getRpcCandidates(84532, { RPC_URL_84532: FORK })).toEqual([FORK, ...baseline]);
  });

  it('treats a blank or whitespace-only value as unset and trims a padded one', () => {
    const baseline = getRpcCandidates(84532, {});
    expect(getRpcCandidates(84532, { RPC_URL_84532: '' })).toEqual(baseline);
    expect(getRpcCandidates(84532, { RPC_URL_84532: '   ' })).toEqual(baseline);
    expect(getRpcOverride(84532, { RPC_URL_84532: `  ${FORK} ` })).toBe(FORK);
  });

  it('only affects its own chain', () => {
    expect(getRpcCandidates(8453, { RPC_URL_84532: FORK })).toEqual(getRpcCandidates(8453, {}));
    expect(getRpcCandidates(8453, { RPC_URL_8453: FORK })[0]).toBe(FORK);
  });

  it('is not listed twice when it equals a built-in candidate', () => {
    const candidates = getRpcCandidates(84532, { RPC_URL_84532: 'https://sepolia.base.org' });
    expect(candidates[0]).toBe('https://sepolia.base.org');
    expect(candidates.filter((url) => url === 'https://sepolia.base.org')).toHaveLength(1);
  });

  it('is read from process.env at call time by getPrimaryRpcUrl / getSecondaryRpcUrl', () => {
    delete process.env['RPC_URL_84532'];
    const baseline = getRpcCandidates(84532, {});
    expect(getPrimaryRpcUrl(84532)).toBe(baseline[0]);

    process.env['RPC_URL_84532'] = FORK;
    expect(getPrimaryRpcUrl(84532)).toBe(FORK);
    expect(getSecondaryRpcUrl(84532)).toBe(baseline[0]);
  });
});
