/**
 * A1 — per-node reads of the evaluator key (`evaluator-rpc.ts`), with fake
 * node clients: every node reported in candidate order, a node with ANY
 * failed read reported as an error (sanitized, no RPC key), nothing
 * concluded across nodes; the proof-tag nonce at `safe` / `finalized` /
 * `latest − K`; "known" and receipts per hash; and the fee read
 * (`eth_feeHistory`, p90 of the per-block p90).
 * The same reads against real Anvil nodes: `evaluator-signer.anvil.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  readBaseFeeAndPriorityP90,
  readNodeViews,
  readNodeViewsFrom,
  sanitizeNodeError,
  type EvaluatorRpcClient,
  type EvaluatorRpcNode,
} from '../services/escrow/evaluator-rpc.js';

const EVALUATOR = '0x00000000000000000000000000000000000E7A11' as Address;
const H1 = `0x${'a1'.repeat(32)}` as Hex;
const H2 = `0x${'b2'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'cc'.repeat(32)}` as Hex;

function notFound(name: string): Error {
  return Object.assign(new Error(`${name}: not found`), { name });
}

/** A node at block 100 (safe 90, finalized 80): nonce 5 latest, 7 pending, 4 at or below 90. Knows H1 (mined), not H2. */
type FakeClient = Record<'getBlock' | 'getTransactionCount' | 'getTransaction' | 'getTransactionReceipt', ReturnType<typeof vi.fn>>;

function healthyClient(): FakeClient {
  return {
    getBlock: vi.fn(async ({ blockTag }: { blockTag: string }) => {
      const n = blockTag === 'latest' ? 100n : blockTag === 'safe' ? 90n : 80n;
      return { number: n, timestamp: 1_000n + n, hash: BLOCK_HASH };
    }),
    getTransactionCount: vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => {
      if (args.blockTag === 'latest') return 5;
      if (args.blockTag === 'pending') return 7;
      if (args.blockNumber !== undefined) return args.blockNumber > 90n ? 5 : 4;
      throw new Error('unexpected nonce read');
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      if (hash === H1) return { hash };
      throw notFound('TransactionNotFoundError');
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      if (hash === H1) return { transactionHash: H1, status: 'success', blockNumber: 95n, blockHash: BLOCK_HASH, logs: [{ topics: [] }] };
      throw notFound('TransactionReceiptNotFoundError');
    }),
  } as never;
}

describe('readNodeViewsFrom — per-node report, no conclusion across nodes', () => {
  it('reports each node: nonces at latest / pending / proof tag, block, safe head, known and receipt per hash', async () => {
    const views = await readNodeViewsFrom([{ label: '#0 a', client: healthyClient() as EvaluatorRpcClient }], EVALUATOR, [H1, H2], { proofTag: 'safe' });
    expect(views).toEqual([
      {
        node: '#0 a',
        index: 0,
        ok: true,
        nonceLatest: 5,
        noncePending: 7,
        nonceAtTag: 4,
        proofBlockNumber: 90n,
        known: { [H1]: true, [H2]: false },
        receipts: {
          [H1]: { txHash: H1, status: 'success', blockNumber: 95n, blockHash: BLOCK_HASH, logs: [{ topics: [] }] },
          [H2]: null,
        },
        blockNumber: 100n,
        blockTimestamp: 1_100n,
        blockHash: BLOCK_HASH,
        safeHead: { number: 90n, timestamp: 1_090n, hash: BLOCK_HASH },
      },
    ]);
  });

  it('proof tag finalized and latest − K read the nonce at that block', async () => {
    const client = healthyClient();
    const [fin] = await readNodeViewsFrom([{ label: 'n', client: client as EvaluatorRpcClient }], EVALUATOR, [], { proofTag: 'finalized' });
    expect(fin).toMatchObject({ ok: true, proofBlockNumber: 80n, nonceAtTag: 4 });
    const [k] = await readNodeViewsFrom([{ label: 'n', client: client as EvaluatorRpcClient }], EVALUATOR, [], { proofTag: 5n });
    expect(k).toMatchObject({ ok: true, proofBlockNumber: 95n, nonceAtTag: 5 });
    const [deep] = await readNodeViewsFrom([{ label: 'n', client: client as EvaluatorRpcClient }], EVALUATOR, [], { proofTag: 500n });
    expect(deep).toMatchObject({ ok: true, proofBlockNumber: 0n });
    const [latest] = await readNodeViewsFrom([{ label: 'n', client: client as EvaluatorRpcClient }], EVALUATOR, [], { proofTag: 'latest' });
    expect(latest).toMatchObject({ ok: true, proofBlockNumber: 100n, nonceAtTag: 5 });
  });

  it('a node with any failed read is ok:false with a sanitized error; the others are still reported, in order', async () => {
    const url = 'https://base-sepolia.g.alchemy.com/v2/sk_live_SECRETKEY987654321';
    const broken = healthyClient();
    broken.getTransaction.mockRejectedValue(new Error(`HTTP request failed.\nURL: ${url}\nStatus: 429`));
    const nodes: EvaluatorRpcNode[] = [
      { label: '#0 good', client: healthyClient() as EvaluatorRpcClient },
      { label: '#1 broken', client: broken as EvaluatorRpcClient, redact: [url] },
    ];
    const views = await readNodeViewsFrom(nodes, EVALUATOR, [H2], { proofTag: 'safe' });
    expect(views.map((v) => [v.node, v.ok])).toEqual([
      ['#0 good', true],
      ['#1 broken', false],
    ]);
    expect(views[1]).toEqual({ node: '#1 broken', index: 1, ok: false, error: expect.stringMatching(/HTTP request failed/) });
    expect(views[1]!.error).not.toMatch(/SECRETKEY|alchemy\.com\/v2/);
  });

  it('a node whose receipt says mined counts as knowing the hash; hashes are keyed lower-cased and de-duplicated', async () => {
    const client = healthyClient();
    client.getTransaction.mockRejectedValue(notFound('TransactionNotFoundError'));
    const upper = H1.toUpperCase().replace('0X', '0x') as Hex;
    const [view] = await readNodeViewsFrom([{ label: 'n', client: client as EvaluatorRpcClient }], EVALUATOR, [upper, H1], { proofTag: 'latest' });
    expect(view!.known).toEqual({ [H1]: true });
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
  });

  it('readNodeViews builds one node per URL with host-only labels (no key in the label)', async () => {
    const views = await readNodeViews(84532, EVALUATOR, [], {
      proofTag: 'latest',
      // Local, unreachable URLs only: no test reaches a public RPC (the key-in-path shape is what matters).
      urls: ['http://127.0.0.1:1/', 'http://127.0.0.1:2/v2/sk_live_SECRETKEY987654321'],
    });
    expect(views.map((v) => v.node)).toEqual(['#0 127.0.0.1:1', '#1 127.0.0.1:2']);
    expect(views[0]!.ok).toBe(false); // nothing listens on port 1
    expect(views[1]!.ok).toBe(false); // nor on port 2
    expect(JSON.stringify(views)).not.toMatch(/SECRETKEY/);
  }, 30_000);

  it('sanitizeNodeError strips the node URL even when no env secret matches it', () => {
    const url = 'https://rpc.example-provider.io/key/abcdef0123456789';
    expect(sanitizeNodeError(new Error(`request to ${url} failed`), [url])).toBe('request to [rpc-url] failed');
  });
});

describe('readBaseFeeAndPriorityP90 — eth_feeHistory', () => {
  it('returns the latest block base fee, the projected next one and the p90 of the per-block p90 priority fees', async () => {
    const rewards = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 100n].map((r) => [r]);
    const client = {
      getFeeHistory: vi.fn(async () => ({ oldestBlock: 91n, baseFeePerGas: [...Array(10).keys()].map((i) => BigInt(10 + i)).concat([42n]), reward: rewards, gasUsedRatio: [] })),
    };
    const read = await readBaseFeeAndPriorityP90(84532, 10, { client: client as never });
    expect(client.getFeeHistory).toHaveBeenCalledWith({ blockCount: 10, blockTag: 'latest', rewardPercentiles: [90] });
    expect(read).toEqual({ baseFee: 19n, nextBaseFee: 42n, priorityP90: 9n, perBlockP90: rewards.map((r) => r[0]), oldestBlock: 91n, blocks: 10 });
  });

  it('never guesses: a node error or an empty history throws (sanitized)', async () => {
    const failing = { getFeeHistory: vi.fn(async () => Promise.reject(new Error('fetch failed https://x.alchemy.com/v2/sk_live_SECRETKEY987654321'))) };
    await expect(readBaseFeeAndPriorityP90(84532, 20, { client: failing as never })).rejects.toThrow(/eth_feeHistory failed/);
    await expect(readBaseFeeAndPriorityP90(84532, 20, { client: failing as never })).rejects.not.toThrow(/SECRETKEY/);
    const empty = { getFeeHistory: vi.fn(async () => ({ oldestBlock: 0n, baseFeePerGas: [1n], reward: [], gasUsedRatio: [] })) };
    await expect(readBaseFeeAndPriorityP90(84532, 20, { client: empty as never })).rejects.toThrow(/no blocks/);
    await expect(readBaseFeeAndPriorityP90(84532, 0, { client: empty as never })).rejects.toThrow(RangeError);
  });
});
