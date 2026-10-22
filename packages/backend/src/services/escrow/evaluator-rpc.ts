/**
 * A1: per-node chain reads for the evaluator key (spec C3g-A1 §4.2, §5.2,
 * §8.3; R2-P1-2, R2-P1-3, R2-P2-2, R2-P3-10).
 *
 * Every RPC candidate of the chain (`getRpcCandidates`, the same list
 * `tx-known.ts` asks one by one: the `RPC_URL_<chainId>` override, Alchemy,
 * Infura, the public RPC) gets its own plain client — never viem's `fallback`
 * transport, which hides which node answered — and is asked, in parallel:
 *  - the current block (number, timestamp, hash) and the `safe` head;
 *  - the evaluator's nonce at `latest`, at `pending` and at the proof tag
 *    (`safe`, `finalized`, or `latest − K` given as a bigint K);
 *  - for each hash: whether the node knows it (`eth_getTransactionByHash`)
 *    and its receipt (hash, status, block number and hash, logs) or null.
 *
 * REPORT ONLY. Nothing is concluded across nodes here: the strict rule (any
 * node in error ⇒ "uncertain", nothing by majority, R2-P3-10) is the pure
 * module's (`evaluator-candidates.ts`, front F1). A node is `ok: false` as
 * soon as ANY of its reads failed (a partial view would read as an answer),
 * with the error sanitized: viem messages embed the RPC URL, and Alchemy /
 * Infura keys travel in its path. Node labels carry only the host name.
 */

import { createPublicClient, http, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { sanitizeText } from '../../api/errors/sanitize.js';
import { createChainPublicClient, getChain, getRpcCandidates } from '../../config/chains.js';
import { TX_LOOKUP_RETRY_COUNT, TX_LOOKUP_TIMEOUT_MS } from '../transaction/tx-known.js';

/** Depth of the proof (D-g): a block tag, or a bigint K meaning `latest − K`. */
export type EvaluatorProofTag = 'latest' | 'safe' | 'finalized' | bigint;

export interface EvaluatorReceiptRead {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  logs: Log[];
}

/**
 * One node's answers. When `ok` is false only `node`, `index` and `error` are
 * set. `nonceAtTag` is the nonce at the proof tag (F1's `nonceProof`).
 */
export interface EvaluatorNodeRead {
  /** Stable, secret-free label: `#<index> <host>`. */
  node: string;
  /** Position in the chain's candidate list. */
  index: number;
  ok: boolean;
  error?: string;
  nonceLatest?: number;
  noncePending?: number;
  nonceAtTag?: number;
  /** The block the proof-tag nonce was read at (the tag's block, or `latest − K`). */
  proofBlockNumber?: bigint;
  /** Keyed by the LOWER-CASED hash. */
  known?: Record<Hex, boolean>;
  /** Keyed by the LOWER-CASED hash; null = no receipt on this node. */
  receipts?: Record<Hex, EvaluatorReceiptRead | null>;
  blockNumber?: bigint;
  blockTimestamp?: bigint;
  blockHash?: Hex;
  safeHead?: { number: bigint; timestamp: bigint; hash: Hex };
}

/** What a node client must answer (a viem PublicClient; a fake in unit tests). */
export type EvaluatorRpcClient = Pick<
  PublicClient,
  'getBlock' | 'getTransactionCount' | 'getTransaction' | 'getTransactionReceipt'
>;

export interface EvaluatorRpcNode {
  label: string;
  client: EvaluatorRpcClient;
  /** Exact strings to cut from this node's error messages before sanitizing (its URL). */
  redact?: readonly string[];
}

function hostLabel(url: string, index: number): string {
  let host = 'unparsable-url';
  try {
    host = new URL(url).host || host;
  } catch {
    // keep the placeholder: the URL itself is never shown
  }
  return `#${index} ${sanitizeText(host, undefined, { keepNetworkLocations: true })}`;
}

function errorName(err: unknown, name: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { name?: string }).name === name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A node error as one secret-free line. */
export function sanitizeNodeError(err: unknown, redact: readonly string[] = []): string {
  const e = err as { shortMessage?: unknown; details?: unknown; message?: unknown };
  const parts = [e?.shortMessage, e?.details].filter((t): t is string => typeof t === 'string' && t.length > 0);
  let text = parts.length > 0 ? parts.join(': ') : typeof e?.message === 'string' ? e.message : String(err);
  for (const secret of redact) if (secret) text = text.split(secret).join('[rpc-url]');
  return sanitizeText(text.replace(/\s+/g, ' ')) || 'unknown error';
}

function tagBlock(tag: EvaluatorProofTag): 'latest' | 'safe' | 'finalized' | null {
  return typeof tag === 'bigint' ? null : tag;
}

async function readOneNode(
  node: EvaluatorRpcNode,
  index: number,
  evaluator: Address,
  hashes: readonly Hex[],
  proofTag: EvaluatorProofTag,
): Promise<EvaluatorNodeRead> {
  const { client } = node;
  try {
    if (typeof proofTag === 'bigint' && proofTag < 0n) throw new Error('proofTag latest-K needs K >= 0');
    const [latest, safe] = await Promise.all([client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'safe' })]);
    if (latest.number === null || latest.hash === null || safe.number === null || safe.hash === null) {
      throw new Error('node returned a pending block for a mined tag');
    }
    const tag = tagBlock(proofTag);
    let proofBlockNumber: bigint;
    let nonceAtTagRead: Promise<number>;
    if (tag === null) {
      const k = proofTag as bigint;
      proofBlockNumber = latest.number > k ? latest.number - k : 0n;
      nonceAtTagRead = client.getTransactionCount({ address: evaluator, blockNumber: proofBlockNumber });
    } else if (tag === 'latest') {
      proofBlockNumber = latest.number;
      nonceAtTagRead = client.getTransactionCount({ address: evaluator, blockTag: 'latest' });
    } else if (tag === 'safe') {
      proofBlockNumber = safe.number;
      nonceAtTagRead = client.getTransactionCount({ address: evaluator, blockNumber: safe.number });
    } else {
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      if (finalized.number === null) throw new Error('node returned no finalized block number');
      proofBlockNumber = finalized.number;
      nonceAtTagRead = client.getTransactionCount({ address: evaluator, blockNumber: finalized.number });
    }
    const [nonceLatest, noncePending, nonceAtTag, perHash] = await Promise.all([
      client.getTransactionCount({ address: evaluator, blockTag: 'latest' }),
      client.getTransactionCount({ address: evaluator, blockTag: 'pending' }),
      nonceAtTagRead,
      Promise.all(
        hashes.map(async (hash) => {
          const [known, receipt] = await Promise.all([
            client.getTransaction({ hash }).then(
              () => true,
              (err: unknown) => {
                if (errorName(err, 'TransactionNotFoundError')) return false;
                throw err;
              },
            ),
            client.getTransactionReceipt({ hash }).then(
              (r): EvaluatorReceiptRead => ({
                txHash: r.transactionHash,
                status: r.status,
                blockNumber: r.blockNumber,
                blockHash: r.blockHash,
                logs: r.logs,
              }),
              (err: unknown) => {
                if (errorName(err, 'TransactionReceiptNotFoundError')) return null;
                throw err;
              },
            ),
          ]);
          // A receipt is a mined tx: a node that returns one knows the hash, whatever the lookup said.
          return { hash, known: known || receipt !== null, receipt };
        }),
      ),
    ]);
    const known: Record<Hex, boolean> = {};
    const receipts: Record<Hex, EvaluatorReceiptRead | null> = {};
    for (const entry of perHash) {
      known[entry.hash] = entry.known;
      receipts[entry.hash] = entry.receipt;
    }
    return {
      node: node.label,
      index,
      ok: true,
      nonceLatest,
      noncePending,
      nonceAtTag,
      proofBlockNumber,
      known,
      receipts,
      blockNumber: latest.number,
      blockTimestamp: latest.timestamp,
      blockHash: latest.hash,
      safeHead: { number: safe.number, timestamp: safe.timestamp, hash: safe.hash },
    };
  } catch (err) {
    return { node: node.label, index, ok: false, error: sanitizeNodeError(err, node.redact) };
  }
}

/** `readNodeViews` over explicit nodes (unit tests, and callers with their own clients). Never throws. */
export async function readNodeViewsFrom(
  nodes: readonly EvaluatorRpcNode[],
  evaluator: Address,
  hashes: readonly Hex[],
  opts: { proofTag: EvaluatorProofTag },
): Promise<EvaluatorNodeRead[]> {
  const unique = [...new Set(hashes.map((h) => h.toLowerCase() as Hex))];
  return Promise.all(nodes.map((node, index) => readOneNode(node, index, evaluator, unique, opts.proofTag)));
}

const nodeCache = new Map<number, { urls: string; nodes: EvaluatorRpcNode[] }>();

/** One plain client per RPC URL (no fallback), bounded like `tx-known.ts`. Memoized per chain and URL list. */
export function evaluatorRpcNodes(chainId: number, urls: readonly string[] = getRpcCandidates(chainId)): EvaluatorRpcNode[] {
  const key = urls.join('\n');
  const cached = nodeCache.get(chainId);
  if (cached && cached.urls === key) return cached.nodes;
  const chain = getChain(chainId);
  const nodes = urls.map((url, index) => ({
    label: hostLabel(url, index),
    client: createPublicClient({ chain, transport: http(url, { timeout: TX_LOOKUP_TIMEOUT_MS, retryCount: TX_LOOKUP_RETRY_COUNT }) }) as EvaluatorRpcClient,
    redact: [url],
  }));
  nodeCache.set(chainId, { urls: key, nodes });
  return nodes;
}

/**
 * Per-node reads across every RPC candidate of `chainId` (or `opts.urls`,
 * for hermetic tests). One entry per node, in candidate order; a node in
 * error is reported (`ok: false`), never dropped. Never throws.
 */
export function readNodeViews(
  chainId: number,
  evaluator: Address,
  hashes: readonly Hex[],
  opts: { proofTag: EvaluatorProofTag; urls?: readonly string[] },
): Promise<EvaluatorNodeRead[]> {
  return readNodeViewsFrom(evaluatorRpcNodes(chainId, opts.urls), evaluator, hashes, opts);
}

// ── Fees (plan P7) ─────────────────────────────────────────────────────────

export interface EvaluatorFeeRead {
  /** Base fee of the latest block (P5's "baseFee(último bloco)"). */
  baseFee: bigint;
  /** Base fee the node projects for the next block. */
  nextBaseFee: bigint;
  /** 90th percentile (nearest rank) of the per-block 90th-percentile priority fees over the window. */
  priorityP90: bigint;
  /** Per-block 90th-percentile priority fees, oldest first. */
  perBlockP90: bigint[];
  oldestBlock: bigint;
  blocks: number;
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: readonly bigint[], pct: number): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.max(1, Math.ceil((pct / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/**
 * `eth_feeHistory(blocks, latest, [90])` on the chain's read client (or an
 * injected one). Throws on a node error or an empty history: fees are
 * never guessed.
 */
export async function readBaseFeeAndPriorityP90(
  chainId: number,
  blocks: number,
  opts: { client?: Pick<PublicClient, 'getFeeHistory'> } = {},
): Promise<EvaluatorFeeRead> {
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 1024) throw new RangeError('readBaseFeeAndPriorityP90: blocks must be 1..1024');
  const client = opts.client ?? createChainPublicClient(chainId);
  let history: Awaited<ReturnType<PublicClient['getFeeHistory']>>;
  try {
    history = await client.getFeeHistory({ blockCount: blocks, blockTag: 'latest', rewardPercentiles: [90] });
  } catch (err) {
    throw new Error(`eth_feeHistory failed on chain ${chainId}: ${sanitizeNodeError(err)}`);
  }
  const baseFees = history.baseFeePerGas;
  if (baseFees.length < 2) throw new Error(`eth_feeHistory on chain ${chainId} returned no blocks`);
  const perBlockP90 = (history.reward ?? []).map((row) => row[0] ?? 0n);
  if (perBlockP90.length === 0) throw new Error(`eth_feeHistory on chain ${chainId} returned no priority-fee percentiles`);
  return {
    baseFee: baseFees[baseFees.length - 2]!,
    nextBaseFee: baseFees[baseFees.length - 1]!,
    priorityP90: percentile(perBlockP90, 90),
    perBlockP90,
    oldestBlock: history.oldestBlock,
    blocks: perBlockP90.length,
  };
}
