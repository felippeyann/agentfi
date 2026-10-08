/**
 * A2A handshake envelope (S6).
 *
 * Before S6, `POST /v1/agents/me/sign-handshake` signed `hashMessage(message)`
 * (EIP-191 personal_sign) for any agent-chosen string. A string whose UTF-8
 * bytes ARE a 32-byte digest (every byte < 0x80, reachable by grinding the
 * free fields of a Safe transaction, ~2^32 keccak) then produced exactly
 * Safe's `eth_sign` owner signature over that digest (v + 4): in Safe mode the
 * agent key is the 1/1 owner, so the agent could sign a Safe transaction
 * itself and bypass `AgentPolicyModule`. The same oracle produced EIP-1271
 * signatures for the Safe through its fallback handler.
 *
 * Now the wallet only ever signs this fixed, versioned EIP-712 envelope:
 *
 *   domain      { name: "AgentFi Handshake", version: "1" }
 *   primaryType AgentFiHandshake(address agent,string message,uint64 issuedAt)
 *
 * digest = keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(handshake)).
 * The agent chooses only `message`, which enters the digest as
 * keccak256(message) inside hashStruct; `agent` (the signing address) and
 * `issuedAt` (unix seconds) are set by the backend. No agent-controlled byte
 * is ever signed raw, and the digest's preimage starts with 0x1901 and this
 * domain separator, so it can equal neither
 *   - a Safe transaction hash (0x1901 ‖ Safe's chainId/verifyingContract
 *     domain ‖ SafeTx struct — the v = 27/28 owner signature),
 *   - Safe's eth_sign hash (0x19 "Ethereum Signed Message:\n32" ‖ hash — the
 *     v > 30 owner signature),
 *   - a Safe EIP-1271 message hash (0x1901 ‖ Safe domain ‖ SafeMessage struct),
 *   - nor any other EIP-712 payload (permits, ERC-3009, Permit2, orders),
 * without a keccak256 second preimage.
 *
 * Verification (`POST /v1/agents/verify-handshake`) rebuilds the same envelope
 * from `{ message, issuedAt, address }` and checks the signature over its
 * digest: ECDSA recovery for an EOA, EIP-1271 `isValidSignature(digest, sig)`
 * for a contract account (a Safe whose owners signed the envelope).
 */

import { getAddress, hashTypedData, type Address, type Hex } from 'viem';

/** EIP-712 domain of every AgentFi handshake. Bump `version` for any change to the type. */
export const HANDSHAKE_DOMAIN = { name: 'AgentFi Handshake', version: '1' } as const;

export const HANDSHAKE_PRIMARY_TYPE = 'AgentFiHandshake' as const;

/** EIP-712 types (viem / ethers style: `EIP712Domain` is derived from the domain). */
export const HANDSHAKE_TYPES = {
  AgentFiHandshake: [
    { name: 'agent', type: 'address' },
    { name: 'message', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

/** Longest `message` the routes accept (characters). */
export const HANDSHAKE_MESSAGE_MAX_LENGTH = 4096;

export interface HandshakeFields {
  /** Address the handshake is signed for: the signing EOA, or a contract account verified through EIP-1271. */
  agent: Address | string;
  /** Agent-chosen statement (agreement text, nonce, peer challenge…). */
  message: string;
  /** Unix seconds at signing, set by the backend. */
  issuedAt: number;
}

/** The typed data as viem hashes / signs it (`issuedAt` as a bigint). */
export function buildHandshakeTypedData(fields: HandshakeFields) {
  return {
    domain: HANDSHAKE_DOMAIN,
    types: HANDSHAKE_TYPES,
    primaryType: HANDSHAKE_PRIMARY_TYPE,
    message: {
      agent: getAddress(fields.agent),
      message: fields.message,
      issuedAt: BigInt(fields.issuedAt),
    },
  } as const;
}

/** EIP-712 digest of the envelope — the only 32 bytes a handshake signature is ever made over. */
export function handshakeDigest(fields: HandshakeFields): Hex {
  return hashTypedData(buildHandshakeTypedData(fields));
}

/**
 * JSON view of the envelope returned by `sign-handshake`, so a peer can check
 * the signature with any EIP-712 library (`verifyTypedData` in viem / ethers)
 * without calling AgentFi. `issuedAt` is a plain number (seconds fit in 2^53).
 */
export function handshakeTypedDataJson(fields: HandshakeFields) {
  return {
    domain: { ...HANDSHAKE_DOMAIN },
    types: { AgentFiHandshake: HANDSHAKE_TYPES.AgentFiHandshake.map((field) => ({ ...field })) },
    primaryType: HANDSHAKE_PRIMARY_TYPE,
    message: { agent: getAddress(fields.agent), message: fields.message, issuedAt: fields.issuedAt },
  };
}
