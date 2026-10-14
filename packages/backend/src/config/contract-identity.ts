/**
 * S9 (owner decision 2026-10-14, "bytecode of the repo build"): a configured
 * address is OUR contract only if the runtime code it holds is, byte for byte,
 * the runtime code of this repository's Foundry build — with only the
 * immutable slots the compiler declares (`immutableReferences`) masked.
 *
 * Views are not identity: a lookalike can answer every view our contract has
 * (reproduced on Anvil, `contract-identity.*.anvil.ts`). The build is compiled
 * without metadata (`foundry.toml`: bytecode_hash = "none", cbor_metadata =
 * false), so the code depends only on the source logic and the compiler
 * settings; the expected code is generated from the artifacts
 * (`scripts/gen-contract-code.mjs` → `abi/contract-code.generated.ts`, CI
 * fails on drift). Consequences, by design:
 *  - an EOA, a foreign contract, a lookalike, a proxy (our contracts are not
 *    upgradeable) and a legacy / different build all fail;
 *  - only addresses deployed from this build pass — a later contract change
 *    means rebuilding, regenerating and redeploying.
 *
 * After the code matches, the immutables are trustworthy through the views of
 * that same code; the bindings (executor ↔ module, fee wallet, operator, hook
 * ↔ escrow…) are compared by the checks that call this module.
 *
 * Pure: no env, no I/O.
 */
import type { Hex } from 'viem';
import {
  EXPECTED_CONTRACT_CODE,
  EXPECTED_CONTRACT_CODE_VERSION,
  type ExpectedContractCode,
  type VerifiedContractName,
} from '../abi/contract-code.generated.js';

export { EXPECTED_CONTRACT_CODE_VERSION, type VerifiedContractName };

/** `code` (0x-hex) with every byte of the given ranges set to zero. */
export function maskImmutables(code: string, immutables: ExpectedContractCode['immutables']): string {
  const hex = code.slice(2).toLowerCase().split('');
  for (const { start, length } of immutables) {
    for (let i = start * 2; i < (start + length) * 2 && i < hex.length; i++) hex[i] = '0';
  }
  return `0x${hex.join('')}`;
}

/**
 * Null when `onChain` (what `eth_getCode` returned for the address) is this
 * build's `name`; otherwise a short operator-facing reason. Definitive: an
 * answer from the chain, never a transport problem.
 */
export function codeIdentityProblem(name: VerifiedContractName, onChain: Hex | string | null | undefined): string | null {
  const expected = EXPECTED_CONTRACT_CODE[name];
  if (!onChain || onChain === '0x') {
    return `no code at the address (an EOA, a typo or the wrong chain) — expected this build's ${name}`;
  }
  if (!/^0x[0-9a-fA-F]*$/.test(onChain)) return `eth_getCode returned something that is not hex — expected this build's ${name}`;
  const bytes = (onChain.length - 2) / 2;
  const expectedBytes = (expected.runtime.length - 2) / 2;
  if (bytes !== expectedBytes) {
    return (
      `its runtime code is ${bytes} bytes, this build's ${name} is ${expectedBytes} bytes ` +
      '(another contract, a proxy, a lookalike, or a legacy / different build)'
    );
  }
  if (maskImmutables(onChain, expected.immutables) !== maskImmutables(expected.runtime, expected.immutables)) {
    return `its runtime code is not this build's ${name} (another contract, a lookalike, or a legacy / different build of the same size)`;
  }
  return null;
}
