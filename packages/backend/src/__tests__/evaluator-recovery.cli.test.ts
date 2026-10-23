/**
 * C3g-A1 recovery script — argument rules (no DB, no chain). The behaviour against the ledger and a chain is
 * covered by `evaluator-a1.db.test.ts` (block 3) and `evaluator-recovery.anvil.ts` (block 3).
 */
import { describe, expect, it } from 'vitest';
import { parseRecoveryArgs } from '../scripts/evaluator-recovery.js';

describe('evaluator:recover arguments', () => {
  it('dry-run by default: only --chain', () => {
    expect(parseRecoveryArgs(['--chain', '84532'])).toMatchObject({ chainId: 84532, execute: null, nonces: null });
  });

  it('--execute needs a nonce, --operator and --note', () => {
    expect(() => parseRecoveryArgs(['--chain', '84532', '--execute', 'speed-up'])).toThrow(/--nonce/);
    expect(() => parseRecoveryArgs(['--chain', '84532', '--execute', 'speed-up', '--nonce', '3'])).toThrow(/--operator/);
    expect(() => parseRecoveryArgs(['--chain', '84532', '--execute', 'speed-up', '--nonce', '3', '--operator', 'o'])).toThrow(/--note/);
    expect(parseRecoveryArgs(['--chain', '84532', '--execute', 'speed-up', '--nonce', '3', '--operator', 'o', '--note', 'n'])).toMatchObject({ execute: 'speed-up', nonces: [3] });
  });

  it('a range is for speed-up only; N..M expands head first', () => {
    expect(parseRecoveryArgs(['--chain', '1', '--execute', 'speed-up', '--nonces', '4..6', '--operator', 'o', '--note', 'n'])).toMatchObject({ nonces: [4, 5, 6], range: true });
    expect(() => parseRecoveryArgs(['--chain', '1', '--execute', 'cancel', '--nonces', '4..6', '--operator', 'o', '--note', 'n'])).toThrow(/speed-up only/);
    expect(() => parseRecoveryArgs(['--chain', '1', '--execute', 'speed-up', '--nonces', '6..4', '--operator', 'o', '--note', 'n'])).toThrow(/N\.\.M/);
  });

  it('unknown operations / arguments and a missing chain are refused', () => {
    expect(() => parseRecoveryArgs(['--chain', '1', '--execute', 'replace'])).toThrow(/speed-up \| cancel \| rebroadcast/);
    expect(() => parseRecoveryArgs(['--chain', '1', '--force'])).toThrow(/unknown argument/);
    expect(() => parseRecoveryArgs([])).toThrow(/--chain/);
  });

  it('--acknowledge-foreign accumulates (lower-cased)', () => {
    expect(parseRecoveryArgs(['--chain', '1', '--acknowledge-foreign', '0xABC', '--acknowledge-foreign', 'nonce:4']).acknowledgeForeign).toEqual(['0xabc', 'nonce:4']);
  });
});
