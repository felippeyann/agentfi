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
 * Alchemy, Infura, the public RPC) gets its own client and is asked. Strict
 * semantics (lead review of #176):
 *  - any node knows the hash (pending or mined) → true, at once;
 *  - EVERY node answered "not found" → false;
 *  - otherwise — no node knows it and at least one errored → throws
 *    `TransactionLookupUnavailableError`: the node that errored may be
 *    exactly the one that accepted the transaction, so "unknown" cannot be
 *    concluded. Every caller treats the throw as "uncertain": the A6b
 *    adoption check aborts before sending, the re-poll counts an error and
 *    retries next tick (never drops), the evaluator's pending check refuses
 *    (`SettlementStillPendingError`), and a failed evaluator send keeps its
 *    hash and stamp.
 *
 * Accepted liveness trade-off: a candidate that is permanently broken (a bad
 * key, a decommissioned endpoint) keeps those questions uncertain — the rows
 * are logged and retried, never guessed — until it answers again or is
 * removed from the configuration (`RPC_URL_<chainId>`, `ALCHEMY_API_KEY`,
 * `INFURA_API_KEY`; see docs/operations/production-deploy.md).
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

/**
 * Thrown when no node knows the transaction and at least one node could not
 * be asked (it errored): known or not cannot be told.
 */
export class TransactionLookupUnavailableError extends Error {
  constructor(
    readonly txHash: Hex,
    readonly nodes: number,
    readonly erroredNodes: number,
    options?: { cause?: unknown },
  ) {
    // The node errors are kept as `cause` only: viem messages embed the RPC
    // URL, which carries the provider key in its path.
    super(
      `Cannot tell whether transaction ${txHash} is known: no RPC node knows it and ${erroredNodes} of ${nodes} node(s) could not be asked (errored)`,
      options,
    );
    this.name = 'TransactionLookupUnavailableError';
  }
}

/**
 * Asks every client, in parallel, whether it knows `hash`. Resolves true as
 * soon as one does (without waiting for slower nodes); false only when every
 * node answered "not found"; otherwise (no node knows it, at least one
 * errored) throws `TransactionLookupUnavailableError`.
 */
export function isTransactionKnownToAny(clients: readonly TxLookupClient[], hash: Hex): Promise<boolean> {
  if (clients.length === 0) return Promise.reject(new TransactionLookupUnavailableError(hash, 0, 0));
  return new Promise<boolean>((resolve, reject) => {
    let pending = clients.length;
    let errored = 0;
    let firstError: unknown;
    let settled = false;
    const done = () => {
      if (settled || --pending > 0) return;
      settled = true;
      if (errored === 0) resolve(false);
      else reject(new TransactionLookupUnavailableError(hash, clients.length, errored, { cause: firstError }));
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
          if (!isNotFound(err)) {
            errored++;
            firstError ??= err;
          }
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
 * default (10 s × 4 tries). A node that times out counts as errored.
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
