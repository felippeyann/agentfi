/**
 * A6 — the real `SubmitterService` awaits `onBeforeBroadcast` after signing
 * and before the first network send, with the locally computed hash, and a
 * throwing hook aborts the submit with nothing broadcast.
 *
 * The transaction processor passes `markBroadcastAttempt` as the hook; the
 * DailyVolume settlement then knows whether a failed transaction may still be
 * mined (daily-volume.db.test.ts covers the settlement on Postgres). Chain and
 * wallet are the in-memory fakes of `helpers/fake-escrow-chain.ts`.
 */
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, keccak256, type Address, type Hex } from 'viem';
import { SubmitterService } from '../services/transaction/submitter.service.js';
import { InMemoryLaneLock, InMemoryNonceStore } from '../services/transaction/wallet-lane.js';
import { FakeEscrowChain, FakeWallets, SIM_USDC } from './helpers/fake-escrow-chain.js';

const SPENDER = getAddress('0x00000000000000000000000000000000000e5c20');

function approveCall(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [spender, amount],
  });
}

function setup() {
  const chain = new FakeEscrowChain();
  const wallets = new FakeWallets();
  const from = getAddress(wallets.create('w1'));
  const events: string[] = [];
  const signed: Hex[] = [];
  const wallet = {
    async signTransaction(params: { walletId: string; unsignedTx: string; chainId: number }) {
      const tx = (await wallets.signTransaction(params)) as Hex;
      events.push('sign');
      signed.push(tx);
      return tx;
    },
  };
  const client = {
    ...chain.rpcClient,
    sendRawTransaction: async (args: { serializedTransaction: Hex }) => {
      events.push('send');
      return chain.rpcClient.sendRawTransaction(args);
    },
  };
  const submitter = new SubmitterService({
    wallet,
    lane: new InMemoryLaneLock(),
    nonces: new InMemoryNonceStore(),
    client: () => client as never,
  });
  const params = { chainId: 84532, walletId: 'w1', from, to: SIM_USDC, data: approveCall(SPENDER, 1n), value: 0n };
  return { chain, events, signed, submitter, params };
}

describe('SubmitterService.onBeforeBroadcast (A6 broadcast stamp)', () => {
  it('is awaited after signing and before the first send, with the hash of the signed transaction', async () => {
    const { chain, events, signed, submitter, params } = setup();
    const stamped: Hex[] = [];
    const result = await submitter.submit({
      ...params,
      onBeforeBroadcast: async (hash) => {
        await new Promise((r) => setTimeout(r, 10)); // a slow DB write still runs before the send
        events.push('stamp');
        stamped.push(hash);
      },
    });
    expect(events).toEqual(['sign', 'stamp', 'send']);
    expect(stamped).toEqual([keccak256(signed[0]!)]);
    expect(result.txHash).toBe(stamped[0]);
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('a throwing hook aborts the submit: nothing is sent and the error propagates', async () => {
    const { chain, events, submitter, params } = setup();
    await expect(
      submitter.submit({
        ...params,
        onBeforeBroadcast: async () => {
          throw new Error('Transaction tx-1 is no longer QUEUED without a hash — not broadcasting');
        },
      }),
    ).rejects.toThrow(/not broadcasting/);
    expect(events).toEqual(['sign']);
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('a send that throws on both RPCs after the stamp: the stamp stays, the error propagates (outcome unknown to the caller)', async () => {
    const { params } = setup();
    const sends: string[] = [];
    const failing = new SubmitterService({
      wallet: { signTransaction: async () => '0x02c0ffee' },
      client: (_chainId, useFallback) =>
        ({
          estimateGas: async () => 21_000n,
          getTransactionCount: async () => 0,
          getGasPrice: async () => 1n,
          getChainId: async () => 84532,
          sendRawTransaction: async () => {
            sends.push(useFallback ? 'fallback' : 'primary');
            throw new Error('timeout');
          },
          getTransaction: async () => {
            throw new Error('not found');
          },
        }) as never,
    });
    let stamps = 0;
    await expect(failing.submit({ ...params, onBeforeBroadcast: async () => void stamps++ })).rejects.toThrow('timeout');
    expect(stamps).toBe(1);
    expect(sends).toEqual(['primary', 'fallback']);
  });
});
