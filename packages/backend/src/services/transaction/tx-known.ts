/**
 * "Does any RPC node know this transaction?" — asked of EVERY candidate (G1
 * review P3-1).
 *
 * The chain's read client (`createChainPublicClient`) is a viem `fallback`
 * transport: it moves to the next node only when one errors. A `null` from
 * `eth_getTransactionByHash` is a valid answer, so a transaction only the
 * secondary node accepted (the primary never saw the broadcast, or is behind
 * a load balancer) read as "unknown" through it. Every caller of this
 * question acts on "unknown": the A6b adoption check signs a new attempt with
 * the next nonce (a second transfer), the re-poll declares the transaction
 * dropped (and the escrow orchestrator unwinds from it), and the evaluator
 * signs a second settlement.
 *
 * Here each candidate (`getRpcCandidates`: the `RPC_URL_<chainId>` override,
 * Alchemy, Infura, the public RPC) gets its own client and is asked:
 *  - any node knows the hash (pending or mined) → true;
 *  - otherwise, at least one node answered "not found" → false (the nodes
 *    that errored cannot be asked; the ones that answered did not see it);
 *  - every node errored → throws (the caller treats it as "cannot tell":
 *    abort the attempt, retry later — never "unknown").
 */

import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { getChain, getRpcCandidates } from '../../config/chains.js';

export type TxLookupClient = Pick<PublicClient, 'getTransaction'>;

/** viem raises `TransactionNotFoundError` for a `null` answer; a wrapper may carry it as a cause. */
function isNotFound(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { name?: string }).name === 'TransactionNotFoundError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Thrown when no RPC node answered (every candidate errored): known or not cannot be told. */
export class TransactionLookupUnavailableError extends Error {
  constructor(
    readonly txHash: Hex,
    readonly nodes: number,
    options?: { cause?: unknown },
  ) {
    // The node errors are kept as `cause` only: viem messages embed the RPC
    // URL, which carries the provider key in its path.
    super(`No RPC node could be asked whether transaction ${txHash} is known (${nodes} node(s), every one errored)`, options);
    this.name = 'TransactionLookupUnavailableError';
  }
}

/**
 * Asks every client, in parallel, whether it knows `hash`. Resolves true as
 * soon as one does (without waiting for slower nodes); false when none does
 * and at least one answered — that needs every node's answer; throws
 * `TransactionLookupUnavailableError` when every one errored.
 */
export function isTransactionKnownToAny(clients: readonly TxLookupClient[], hash: Hex): Promise<boolean> {
  if (clients.length === 0) return Promise.reject(new TransactionLookupUnavailableError(hash, 0));
  return new Promise<boolean>((resolve, reject) => {
    let pending = clients.length;
    let answered = false;
    let firstError: unknown;
    let settled = false;
    const done = () => {
      if (settled || --pending > 0) return;
      settled = true;
      if (answered) resolve(false);
      else reject(new TransactionLookupUnavailableError(hash, clients.length, { cause: firstError }));
    };
    for (const client of clients) {
      Promise.resolve()
        .then(() => client.getTransaction({ hash }))
        .then(
        () => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
        },
        (err: unknown) => {
          if (isNotFound(err)) answered = true;
          else firstError ??= err;
          done();
        },
      );
    }
  });
}

/**
 * Per-node bound of a lookup: the A6b adoption check runs inside the wallet's
 * broadcast lane (a Redis lock with a TTL), and a "not known" answer has to
 * wait for every node — so a hanging node must not hold the lane for viem's
 * default (10 s × 4 tries).
 */
export const TX_LOOKUP_TIMEOUT_MS = 8_000;
export const TX_LOOKUP_RETRY_COUNT = 1;

const candidateClients = new Map<number, { urls: string; clients: TxLookupClient[] }>();

/** One plain client per RPC candidate of the chain (no fallback transport), memoized per candidate list. */
export function rpcCandidateClients(chainId: number): TxLookupClient[] {
  const urls = getRpcCandidates(chainId);
  const key = urls.join('\n');
  const cached = candidateClients.get(chainId);
  if (cached && cached.urls === key) return cached.clients;
  const chain = getChain(chainId);
  const clients = urls.map((url) =>
    createPublicClient({ chain, transport: http(url, { timeout: TX_LOOKUP_TIMEOUT_MS, retryCount: TX_LOOKUP_RETRY_COUNT }) }),
  );
  candidateClients.set(chainId, { urls: key, clients });
  return clients;
}

/** `isTransactionKnownToAny` over every RPC candidate of `chainId`. */
export function isTransactionKnownOnAnyRpc(chainId: number, hash: Hex): Promise<boolean> {
  return isTransactionKnownToAny(rpcCandidateClients(chainId), hash);
}
