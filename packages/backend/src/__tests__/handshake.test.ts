/**
 * Unit tests — A2A handshake envelope (S6).
 *
 * The wallet signs only the EIP-712 envelope
 * `AgentFiHandshake(address agent,string message,uint64 issuedAt)` under the
 * domain `{ name: "AgentFi Handshake", version: "1" }`. Covers the envelope
 * helpers, the LocalWalletService signing path (what runs in CI / the dev
 * stack) with viem's recovery, a third-party check with `verifyTypedData`
 * from the JSON view, and the removal of every personal_sign path from the
 * wallet providers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAddress,
  hashTypedData,
  recoverAddress,
  recoverTypedDataAddress,
  verifyTypedData,
  type Address,
} from 'viem';
import { LocalWalletService, __clearLocalWallets } from '../services/wallet/local.service.js';
import { TurnkeyService } from '../services/wallet/turnkey.service.js';
import type { Eip712TypedData } from '../services/wallet/signer.js';
import {
  HANDSHAKE_DOMAIN,
  HANDSHAKE_PRIMARY_TYPE,
  HANDSHAKE_TYPES,
  buildHandshakeTypedData,
  handshakeDigest,
  handshakeTypedDataJson,
} from '../services/identity/handshake.js';

const ISSUED_AT = 1_791_417_600; // 2026-10-08T00:00:00Z

async function signEnvelope(svc: LocalWalletService, walletId: string, agent: Address, message: string, issuedAt = ISSUED_AT) {
  const typedData = buildHandshakeTypedData({ agent, message, issuedAt });
  return svc.signTypedData({ walletId, typedData: typedData as unknown as Eip712TypedData });
}

describe('handshake envelope', () => {
  it('is the versioned AgentFi EIP-712 type, nothing else', () => {
    expect(HANDSHAKE_DOMAIN).toEqual({ name: 'AgentFi Handshake', version: '1' });
    expect(HANDSHAKE_PRIMARY_TYPE).toBe('AgentFiHandshake');
    expect(HANDSHAKE_TYPES).toEqual({
      AgentFiHandshake: [
        { name: 'agent', type: 'address' },
        { name: 'message', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
      ],
    });
  });

  it('digest = hashTypedData of the envelope and changes with every field', () => {
    const agent = '0x1111111111111111111111111111111111111111';
    const base = { agent, message: 'hello', issuedAt: ISSUED_AT };
    const digest = handshakeDigest(base);

    expect(digest).toBe(hashTypedData(buildHandshakeTypedData(base)));
    expect(handshakeDigest({ ...base, message: 'hello!' })).not.toBe(digest);
    expect(handshakeDigest({ ...base, issuedAt: ISSUED_AT + 1 })).not.toBe(digest);
    expect(handshakeDigest({ ...base, agent: '0x2222222222222222222222222222222222222222' })).not.toBe(digest);
    // The address is normalised: case does not change the statement.
    expect(handshakeDigest({ ...base, agent: agent.toUpperCase().replace('0X', '0x') })).toBe(digest);
  });

  it('JSON view carries the same statement with issuedAt as a number', () => {
    const json = handshakeTypedDataJson({ agent: '0x1111111111111111111111111111111111111111', message: 'm', issuedAt: ISSUED_AT });
    expect(json).toEqual({
      domain: { name: 'AgentFi Handshake', version: '1' },
      types: { AgentFiHandshake: HANDSHAKE_TYPES.AgentFiHandshake },
      primaryType: 'AgentFiHandshake',
      message: { agent: '0x1111111111111111111111111111111111111111', message: 'm', issuedAt: ISSUED_AT },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('LocalWalletService signs the envelope (viem recovery)', () => {
  let svc: LocalWalletService;

  beforeEach(() => {
    __clearLocalWallets();
    svc = new LocalWalletService();
  });

  it('the signature recovers to the wallet over the envelope digest', async () => {
    const { walletId, address } = await svc.createWallet('alice');
    const message = 'I am alice and I authorize this handshake.';

    const { signature, address: returned } = await signEnvelope(svc, walletId, address, message);

    expect(returned).toBe(address);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
    const digest = handshakeDigest({ agent: address, message, issuedAt: ISSUED_AT });
    expect(getAddress(await recoverAddress({ hash: digest, signature }))).toBe(getAddress(address));
    expect(
      getAddress(await recoverTypedDataAddress({ ...buildHandshakeTypedData({ agent: address, message, issuedAt: ISSUED_AT }), signature })),
    ).toBe(getAddress(address));
  });

  it('a third party verifies it from the JSON view with verifyTypedData', async () => {
    const { walletId, address } = await svc.createWallet('alice');
    const { signature } = await signEnvelope(svc, walletId, address, 'deal: 10 USDC for a summary');
    const json = JSON.parse(
      JSON.stringify(handshakeTypedDataJson({ agent: address, message: 'deal: 10 USDC for a summary', issuedAt: ISSUED_AT })),
    );

    await expect(verifyTypedData({ ...json, address, signature })).resolves.toBe(true);
  });

  it('different wallets recover to different addresses', async () => {
    const alice = await svc.createWallet('alice');
    const bob = await svc.createWallet('bob');
    const a = await signEnvelope(svc, alice.walletId, alice.address, 'shared');
    const b = await signEnvelope(svc, bob.walletId, bob.address, 'shared');

    expect(getAddress(await recoverAddress({ hash: handshakeDigest({ agent: alice.address, message: 'shared', issuedAt: ISSUED_AT }), signature: a.signature }))).toBe(getAddress(alice.address));
    expect(getAddress(await recoverAddress({ hash: handshakeDigest({ agent: bob.address, message: 'shared', issuedAt: ISSUED_AT }), signature: b.signature }))).toBe(getAddress(bob.address));
  });

  it('a tampered message, issuedAt or agent does not recover to the signer', async () => {
    const { walletId, address } = await svc.createWallet('alice');
    const { signature } = await signEnvelope(svc, walletId, address, 'original message');

    for (const tampered of [
      { agent: address, message: 'tampered message', issuedAt: ISSUED_AT },
      { agent: address, message: 'original message', issuedAt: ISSUED_AT + 60 },
      { agent: '0x2222222222222222222222222222222222222222', message: 'original message', issuedAt: ISSUED_AT },
    ]) {
      const recovered = await recoverAddress({ hash: handshakeDigest(tampered), signature });
      expect(getAddress(recovered)).not.toBe(getAddress(address));
    }
  });

  it('throws for an unknown walletId', async () => {
    await expect(signEnvelope(svc, 'local-missing', '0x1111111111111111111111111111111111111111', 'hi')).rejects.toThrow(/not found/);
  });
});

describe('no wallet provider signs raw caller bytes (S6)', () => {
  it('neither LocalWalletService nor TurnkeyService exposes signMessage (personal_sign)', () => {
    expect('signMessage' in LocalWalletService.prototype).toBe(false);
    expect('signMessage' in TurnkeyService.prototype).toBe(false);
  });
});
