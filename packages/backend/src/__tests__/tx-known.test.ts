/**
 * Unit tests — G1 review P3-1: "is this transaction known?" asks every RPC
 * node (`services/transaction/tx-known.ts`), with fake clients.
 */
import { describe, expect, it, vi } from 'vitest';
import { TransactionNotFoundError, type Hex } from 'viem';
import { isTransactionKnownToAny, TransactionLookupUnavailableError, type TxLookupClient } from '../services/transaction/tx-known.js';

const HASH = `0x${'ab'.repeat(32)}` as Hex;

const knows = (): TxLookupClient => ({ getTransaction: vi.fn(async () => ({ hash: HASH }) as never) });
const notFound = (): TxLookupClient => ({
  getTransaction: vi.fn(async () => {
    throw new TransactionNotFoundError({ hash: HASH });
  }),
});
const down = (message = 'HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/SECRET-KEY'): TxLookupClient => ({
  getTransaction: vi.fn(async () => {
    throw new Error(message);
  }),
});

describe('isTransactionKnownToAny', () => {
  it('asks every node: the primary answers "not found", the secondary knows it → true', async () => {
    const primary = notFound();
    const secondary = knows();
    expect(await isTransactionKnownToAny([primary, secondary], HASH)).toBe(true);
    expect(primary.getTransaction).toHaveBeenCalledWith({ hash: HASH });
    expect(secondary.getTransaction).toHaveBeenCalledWith({ hash: HASH });
  });

  it('true when any node knows it, even if others errored', async () => {
    expect(await isTransactionKnownToAny([down(), knows(), notFound()], HASH)).toBe(true);
  });

  it('false when every node answered "not found"', async () => {
    expect(await isTransactionKnownToAny([notFound(), notFound(), notFound()], HASH)).toBe(false);
  });

  it('false when some nodes answered "not found" and the others errored (the ones that answered did not see it)', async () => {
    expect(await isTransactionKnownToAny([down(), notFound()], HASH)).toBe(false);
  });

  it('a "not found" wrapped as the cause of another error still counts as an answer', async () => {
    const wrapped: TxLookupClient = {
      getTransaction: vi.fn(async () => {
        throw Object.assign(new Error('wrapped'), { cause: new TransactionNotFoundError({ hash: HASH }) });
      }),
    };
    expect(await isTransactionKnownToAny([wrapped], HASH)).toBe(false);
  });

  it('throws TransactionLookupUnavailableError only when every node errored — its message never carries a node URL', async () => {
    const err = await isTransactionKnownToAny([down(), down('socket hang up')], HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionLookupUnavailableError);
    expect((err as Error).message).toContain(HASH);
    expect((err as Error).message).not.toMatch(/alchemy|SECRET-KEY/);
    expect((err as { cause?: Error }).cause?.message).toMatch(/HTTP request failed/);
    await expect(isTransactionKnownToAny([], HASH)).rejects.toBeInstanceOf(TransactionLookupUnavailableError);
  });
});
