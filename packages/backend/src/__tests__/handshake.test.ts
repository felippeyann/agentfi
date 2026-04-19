/**
 * Unit tests — A2A handshake (sign + verify).
 *
 * Covers the LocalWalletService path end-to-end with viem's recovery,
 * since that's what runs in CI / dev stack. The Turnkey path lives
 * behind a live SDK call and is exercised in integration tests with
 * real credentials.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recoverMessageAddress, getAddress, type Hex } from 'viem';
import {
  LocalWalletService,
  __clearLocalWallets,
} from '../services/wallet/local.service.js';

describe('LocalWalletService.signMessage + viem recovery', () => {
  let svc: LocalWalletService;

  beforeEach(() => {
    __clearLocalWallets();
    svc = new LocalWalletService();
  });

  it('returns a signature whose EIP-191 recovery matches the signing address', async () => {
    const { walletId, address } = await svc.createWallet('alice');
    const message = 'I am alice and I authorize this handshake.';

    const { signature, address: returnedAddress } = await svc.signMessage({
      walletId,
      message,
    });

    expect(returnedAddress).toBe(address);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);

    const recovered = await recoverMessageAddress({
      message,
      signature: signature as Hex,
    });
    expect(getAddress(recovered)).toBe(getAddress(address));
  });

  it('recovers different addresses for different wallets', async () => {
    const alice = await svc.createWallet('alice');
    const bob = await svc.createWallet('bob');
    const msg = 'shared message';

    const aliceSig = await svc.signMessage({ walletId: alice.walletId, message: msg });
    const bobSig = await svc.signMessage({ walletId: bob.walletId, message: msg });

    const aliceRecovered = await recoverMessageAddress({
      message: msg,
      signature: aliceSig.signature,
    });
    const bobRecovered = await recoverMessageAddress({
      message: msg,
      signature: bobSig.signature,
    });

    expect(getAddress(aliceRecovered)).toBe(getAddress(alice.address));
    expect(getAddress(bobRecovered)).toBe(getAddress(bob.address));
    expect(getAddress(aliceRecovered)).not.toBe(getAddress(bobRecovered));
  });

  it('tampered message does not recover to the original signer', async () => {
    const { walletId, address } = await svc.createWallet('alice');
    const { signature } = await svc.signMessage({
      walletId,
      message: 'original message',
    });

    const recovered = await recoverMessageAddress({
      message: 'tampered message',
      signature,
    });
    expect(getAddress(recovered)).not.toBe(getAddress(address));
  });

  it('throws for unknown walletId', async () => {
    await expect(
      svc.signMessage({ walletId: 'local-missing', message: 'hi' }),
    ).rejects.toThrow(/not found/);
  });
});
