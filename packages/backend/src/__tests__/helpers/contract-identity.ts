/**
 * S9 investigation helper (tests only — the identity policy is an owner
 * decision, nothing in `src/` uses this yet).
 *
 * A Foundry artifact's `deployedBytecode` has every `immutable` slot zeroed
 * (`immutableReferences` lists their byte ranges); the code an address holds
 * on-chain has the constructor's values there. Masking those ranges on both
 * sides and comparing the rest says "this address runs exactly this build"
 * (same source, compiler and settings — the CBOR metadata trailer, which
 * carries the IPFS hash of the metadata incl. every source file's hash, is
 * part of the comparison). The immutable values themselves are then read
 * from the on-chain code at those ranges, not from views.
 */
import { keccak256, type Hex } from 'viem';
import type { FoundryArtifact } from './anvil-contracts.js';

/** Zeroes every immutable range of `code` (hex runtime bytecode). */
export function maskImmutables(code: Hex, refs: FoundryArtifact['immutableReferences']): Hex {
  const bytes = code.slice(2).split('');
  for (const ranges of Object.values(refs)) {
    for (const { start, length } of ranges) {
      for (let i = start * 2; i < (start + length) * 2 && i < bytes.length; i++) bytes[i] = '0';
    }
  }
  return `0x${bytes.join('')}` as Hex;
}

/** The 32-byte words found at each immutable's first reference in `code`. */
export function immutableValues(code: Hex, refs: FoundryArtifact['immutableReferences']): Hex[] {
  return Object.values(refs).map((ranges) => {
    const { start, length } = ranges[0]!;
    return `0x${code.slice(2 + start * 2, 2 + (start + length) * 2)}` as Hex;
  });
}

/** True when `onChain` is `artifact`'s runtime code with only the immutable slots filled in. */
export function runsArtifact(onChain: Hex | undefined, artifact: FoundryArtifact): boolean {
  if (!onChain || onChain === '0x') return false;
  if (onChain.length !== artifact.deployedBytecode.length) return false;
  return (
    keccak256(maskImmutables(onChain.toLowerCase() as Hex, artifact.immutableReferences)) ===
    keccak256(maskImmutables(artifact.deployedBytecode.toLowerCase() as Hex, artifact.immutableReferences))
  );
}

/** The CBOR metadata trailer (its length is the last two bytes, big-endian). */
export function cborTrailer(code: Hex): Hex {
  const body = code.slice(2);
  const len = parseInt(body.slice(-4), 16);
  return `0x${body.slice(-(len * 2 + 4))}` as Hex;
}
