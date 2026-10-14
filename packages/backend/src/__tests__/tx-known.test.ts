/**
 * Unit tests — G1 review P3-1: "is this transaction known?" asks every RPC
 * node (`services/transaction/tx-known.ts`), with fake clients. Strict
 * semantics (lead review of #176): true as soon as one node knows the hash,
 * false only when EVERY node answered "not found", otherwise a throw.
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

  it('one node knows it while another errors → true', async () => {
    expect(await isTransactionKnownToAny([down(), knows()], HASH)).toBe(true);
    expect(await isTransactionKnownToAny([down(), knows(), notFound()], HASH)).toBe(true);
  });

  it('resolves true as soon as one node knows it — a hanging node is not waited for (the A6b check runs inside the wallet lane)', async () => {
    const hanging: TxLookupClient = { getTransaction: vi.fn(() => new Promise<never>(() => undefined)) };
    expect(await isTransactionKnownToAny([hanging, knows()], HASH)).toBe(true);
  });

  it('all nodes answered "not found" → false', async () => {
    expect(await isTransactionKnownToAny([notFound(), notFound(), notFound()], HASH)).toBe(false);
    expect(await isTransactionKnownToAny([notFound()], HASH)).toBe(false);
  });

  it('one node "not found" plus one erroring → throws: the erroring node may be the one that accepted it', async () => {
    const err = await isTransactionKnownToAny([notFound(), down()], HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionLookupUnavailableError);
    expect(err).toMatchObject({ nodes: 2, erroredNodes: 1 });
    await expect(isTransactionKnownToAny([down(), notFound(), notFound()], HASH)).rejects.toBeInstanceOf(TransactionLookupUnavailableError);
  });

  it('a client that throws synchronously counts as an errored node (→ throws next to a "not found")', async () => {
    const broken: TxLookupClient = {
      getTransaction: vi.fn(() => {
        throw new Error('bad client');
      }) as never,
    };
    await expect(isTransactionKnownToAny([broken, notFound()], HASH)).rejects.toBeInstanceOf(TransactionLookupUnavailableError);
  });

  it('a "not found" wrapped as the cause of another error still counts as an answer', async () => {
    const wrapped: TxLookupClient = {
      getTransaction: vi.fn(async () => {
        throw Object.assign(new Error('wrapped'), { cause: new TransactionNotFoundError({ hash: HASH }) });
      }),
    };
    expect(await isTransactionKnownToAny([wrapped], HASH)).toBe(false);
  });

  it('every node errored → throws; the message never carries a node URL', async () => {
    const err = await isTransactionKnownToAny([down(), down('socket hang up')], HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionLookupUnavailableError);
    expect(err).toMatchObject({ nodes: 2, erroredNodes: 2 });
    expect((err as Error).message).toContain(HASH);
    expect((err as Error).message).not.toMatch(/alchemy|SECRET-KEY/);
    expect((err as { cause?: Error }).cause?.message).toMatch(/HTTP request failed/);
    await expect(isTransactionKnownToAny([], HASH)).rejects.toBeInstanceOf(TransactionLookupUnavailableError);
  });
});
