import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 checksum casing of a 0x-prefixed 20-byte hex address. */
export function toChecksumAddress(address: string): string {
  const hex = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  }
  return out;
}

/**
 * The backend's address rule — viem `isAddress(x, { strict: true })`, which
 * the transfer route's schema applies: a 0x-prefixed 20-byte hex string that
 * is all-lowercase (no checksum), or mixed case with a valid EIP-55 checksum.
 * A mixed-case address whose checksum does not match is what a typo in a
 * checksummed address looks like: refused, never re-checksummed. (An
 * all-uppercase body is refused too, as viem strict does.) Pinned to viem by
 * `packages/backend/src/__tests__/mcp.address.sync.test.ts`; the hash is
 * `@noble/hashes` keccak_256, the one viem itself uses.
 */
export function isStrictAddress(value: string): boolean {
  if (!HEX_ADDRESS.test(value)) return false;
  if (value.toLowerCase() === value) return true;
  return toChecksumAddress(value) === value;
}

/** Zod schema for an address a payment goes to (same rule as the backend's transfer route). */
export function addressSchema(description: string) {
  return z
    .string()
    .regex(HEX_ADDRESS, 'must be a 0x-prefixed 20-byte hex address')
    .refine((value) => !HEX_ADDRESS.test(value) || isStrictAddress(value), {
      message:
        'has an invalid EIP-55 checksum (mixed case that does not match — a typo?): pass the address exactly as ' +
        'published (e.g. the safeAddress from search_agents), or all-lowercase',
    })
    .describe(description);
}
