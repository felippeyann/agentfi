/**
 * Unit tests — LocalWalletService
 *
 * Validates the development-only wallet provider behaves like TurnkeyService
 * at the surface level, so the factory can swap them transparently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LocalWalletService,
  __clearLocalWallets,
  __localWalletCount,
} from '../services/wallet/local.service.js';
import {
  isAddress,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Hex,
} from 'viem';

describe('LocalWalletService', () => {
  let svc: LocalWalletService;

  beforeEach(() => {
    __clearLocalWallets();
    svc = new LocalWalletService();
  });

  describe('createWallet', () => {
    it('returns a valid checksummed Ethereum address', async () => {
      const { walletId, address } = await svc.createWallet('alice');

      expect(walletId).toMatch(/^local-[0-9a-f]{16}$/);
      expect(isAddress(address)).toBe(true);
      // checksummed = has at least one uppercase
      expect(address).toMatch(/[A-F]/);
    });

    it('produces distinct addresses across calls (randomness)', async () => {
      const a = await svc.createWallet('a');
      const b = await svc.createWallet('b');
      const c = await svc.createWallet('c');

      expect(a.address).not.toBe(b.address);
      expect(b.address).not.toBe(c.address);
      expect(a.walletId).not.toBe(b.walletId);
    });

    it('persists the wallet in the in-memory store', async () => {
      expect(__localWalletCount()).toBe(0);
      await svc.createWallet('alice');
      await svc.createWallet('bob');
      expect(__localWalletCount()).toBe(2);
    });
  });

  describe('getWalletAddress', () => {
    it('returns the same address as createWallet', async () => {
      const created = await svc.createWallet('alice');
      const fetched = await svc.getWalletAddress(created.walletId);
      expect(fetched).toBe(created.address);
    });

    it('throws for unknown walletId', async () => {
      await expect(svc.getWalletAddress('local-deadbeef')).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('signTransaction', () => {
    it('signs a legacy transaction and the signature recovers to the wallet address', async () => {
      const { walletId, address } = await svc.createWallet('alice');

      const unsignedTx = serializeTransaction({
        chainId: 1,
        nonce: 0,
        to: '0x000000000000000000000000000000000000dEaD',
        value: 0n,
        data: '0x',
        gas: 21_000n,
        gasPrice: 1_000_000_000n,
      });

      const signed = (await svc.signTransaction({
        walletId,
        unsignedTx,
        chainId: 1,
      })) as Hex;

      // Recover sender from the signed transaction — must equal the wallet address.
      // viem 2.x narrowed TransactionSerialized to a type-prefixed union; our
      // legacy-type serialization satisfies it at runtime but needs an explicit
      // cast to pass strict mode in the test.
      const recovered = await recoverTransactionAddress({
        serializedTransaction: signed as `0x02${string}`,
      });
      expect(recovered.toLowerCase()).toBe(address.toLowerCase());

      // Sanity: the signed tx parses back with the same `to`
      const parsed = parseTransaction(signed);
      expect(parsed.to?.toLowerCase()).toBe(
        '0x000000000000000000000000000000000000dead',
      );
    });

    it('throws for unknown walletId', async () => {
      await expect(
        svc.signTransaction({
          walletId: 'local-missing',
          unsignedTx: '0x',
          chainId: 1,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('listWallets', () => {
    it('returns every wallet created in this process', async () => {
      await svc.createWallet('alice');
      await svc.createWallet('bob');

      const list = await svc.listWallets();
      expect(list.length).toBe(2);
      expect(list[0]!.walletName).toMatch(/^agentfi-/);
    });
  });

  describe('healthCheck', () => {
    it('always returns true (no external deps)', async () => {
      expect(await svc.healthCheck()).toBe(true);
    });
  });
});
