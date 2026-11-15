/**
 * In-memory `ChainEvidenceReader` for reconciliation tests: the test decides
 * what "the chain" says about each EIP-3009 authorization. It records every
 * read so a test can show which evidence a verdict rested on. The real
 * reader (`viemEvidenceReader`) is exercised against FiatToken on a Base
 * Sepolia fork by `src/scripts/demo/x402-spend-demo.ts`.
 */
import type { Address, Hex } from 'viem';
import type { ChainEvidenceReader, ChainHead, TokenTransfer } from '../../services/payments/resource-payment-reconciliation.js';

interface AuthorizationOnChain {
  kind: 'used' | 'canceled';
  txHash: Hex;
  blockNumber: bigint;
  transfers: TokenTransfer[];
}

export interface FakeChain extends ChainEvidenceReader {
  head_: ChainHead;
  chainId_: number;
  /** Two fakes with different `fork_` disagree on every block hash (a fork / another network). */
  fork_: string;
  /** When set, only authorizationState reads fail (head still answers): a partial failure. */
  failState_: string | null;
  reads: string[];
  /** The authorization was executed in a tx with the given transfers (default: payer → payTo of amount). */
  use(row: { payer: string | null; authorizationNonce: string | null; payTo: string; amount: string }, transfers?: TokenTransfer[]): Hex;
  cancel(row: { payer: string | null; authorizationNonce: string | null }): Hex;
  /** Sets the judged head's timestamp (unix seconds). */
  at(timestampSeconds: number): void;
  failReads(message: string | null): void;
}

const key = (authorizer: string, nonce: string) => `${authorizer.toLowerCase()}:${nonce.toLowerCase()}`;

export function fakeChain(chainId = 84532): FakeChain {
  const state = new Map<string, AuthorizationOnChain>();
  const txTransfers = new Map<string, TokenTransfer[]>();
  let txSeq = 0;
  let failure: string | null = null;
  const guard = () => {
    if (failure) throw new Error(failure);
  };
  const chain: FakeChain = {
    head_: { number: 1_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) },
    chainId_: chainId,
    fork_: 'b',
    failState_: null,
    reads: [],
    async chainId() {
      guard();
      return chain.chainId_;
    },
    async head() {
      guard();
      chain.reads.push('head');
      return chain.head_;
    },
    async authorizationUsed(_token: Address, authorizer: Address, nonce: Hex) {
      guard();
      if (chain.failState_) throw new Error(chain.failState_);
      chain.reads.push(`authorizationState:${nonce}`);
      return state.has(key(authorizer, nonce));
    },
    async findAuthorizationEvent(kind, _token, authorizer, nonce) {
      guard();
      chain.reads.push(`logs:${kind}:${nonce}`);
      const entry = state.get(key(authorizer, nonce));
      return entry && entry.kind === kind ? { txHash: entry.txHash, blockNumber: entry.blockNumber } : null;
    },
    async transfersInTx(_token, txHash) {
      guard();
      chain.reads.push(`receipt:${txHash}`);
      return txTransfers.get(txHash) ?? [];
    },
    async blockAtOrAfter() {
      guard();
      return 0n;
    },
    async blockHash(n) {
      guard();
      chain.reads.push(`blockHash:${n}`);
      return `0x${(chain.fork_ + n.toString(16)).padStart(64, '0')}` as Hex;
    },
    use(row, transfers) {
      if (!row.payer || !row.authorizationNonce) throw new Error('row has no payer / nonce');
      txSeq++;
      const txHash = `0x${txSeq.toString(16).padStart(64, 'a')}` as Hex;
      const list = transfers ?? [{ from: row.payer, to: row.payTo, value: BigInt(row.amount) }];
      state.set(key(row.payer, row.authorizationNonce), { kind: 'used', txHash, blockNumber: chain.head_.number, transfers: list });
      txTransfers.set(txHash, list);
      return txHash;
    },
    cancel(row) {
      if (!row.payer || !row.authorizationNonce) throw new Error('row has no payer / nonce');
      txSeq++;
      const txHash = `0x${txSeq.toString(16).padStart(64, 'c')}` as Hex;
      state.set(key(row.payer, row.authorizationNonce), { kind: 'canceled', txHash, blockNumber: chain.head_.number, transfers: [] });
      return txHash;
    },
    at(timestampSeconds) {
      chain.head_ = { number: chain.head_.number + 1n, timestamp: BigInt(timestampSeconds) };
    },
    failReads(message) {
      failure = message;
    },
  };
  return chain;
}
