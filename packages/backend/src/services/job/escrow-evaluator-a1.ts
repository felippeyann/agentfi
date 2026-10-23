/**
 * C3g-A1 — the orchestrator's view of the evaluator candidate ledger and of
 * the per-node chain reads (spec `2026-10-21-spec-c3g-a1.md`, R2 prevails).
 *
 *  - `EvaluatorLedgerPort`: the ledger functions the orchestrator calls,
 *    bound to one database. Production binds `services/escrow/evaluator-ledger.ts`
 *    on Prisma (`prismaEvaluatorLedger`), the ONLY writer of the A1 tables;
 *    unit tests with a mocked Prisma inject an in-memory double.
 *  - `toNodeViews`: the F2 per-node reads (`EvaluatorNodeRead`) as the F1 pure
 *    rules see them (`NodeView`; `nonceProof` = the nonce at the proof tag).
 *  - `singleClientNodeReads`: a ONE-node read over the orchestrator's read
 *    client — the test-double fallback (the runtime always wires the real
 *    per-node reader, `readNodeViews` over every RPC candidate of the chain).
 */
import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import * as ledger from '../escrow/evaluator-ledger.js';
import type { CandidateAction, NodeView, ReceiptView } from '../escrow/evaluator-candidates.js';
import type { EvaluatorNodeRead, EvaluatorReceiptRead } from '../escrow/evaluator-rpc.js';

export type LedgerCandidate = ledger.LedgerCandidate;
export type NewCandidate = ledger.NewCandidate;
export type JobStampInput = ledger.JobStampInput;
export type EvaluatorChainStateView = ledger.EvaluatorChainStateView;

/** The ledger operations the orchestrator uses (one database bound). */
export interface EvaluatorLedgerPort {
  insertCandidateWithJobStamp(input: { candidate: NewCandidate; job?: JobStampInput }): Promise<{ id: string; inserted: boolean }>;
  markBroadcast(id: string): Promise<boolean>;
  markAnswered(id: string, outcome: 'SENT' | 'SEND_UNCONFIRMED' | 'UNCERTAIN', sendError?: string | null): Promise<boolean>;
  markResolved(id: string, to: 'MINED_SUCCESS' | 'MINED_REVERTED' | 'DEAD', proof: { level: 'latest' | 'proof'; blockNumber?: bigint; blockHash?: string }): Promise<boolean>;
  revertForReorg(id: string): Promise<boolean>;
  candidatesForJob(jobId: string): Promise<LedgerCandidate[]>;
  candidatesAtNonce(chainId: number, evaluator: string, nonce: number): Promise<LedgerCandidate[]>;
  liveNonces(chainId: number, evaluator: string): Promise<number[]>;
  liveCandidates(chainId: number, evaluator: string): Promise<LedgerCandidate[]>;
  /** Nonces with a row still to watch: a live candidate, or a resolution proven only at `latest` (reorg window). Ascending. */
  noncesToReconcile(chainId: number, evaluator: string): Promise<number[]>;
  /** Live rows without a nonce (LEGACY / BACKFILL, P3-1). */
  liveLegacyWithoutNonce(chainId: number, evaluator: string): Promise<LedgerCandidate[]>;
  /** Chains with a live candidate of `evaluator` (the sweep visits them even without a live job). */
  chainsWithLiveCandidates(evaluator: string): Promise<number[]>;
  recordExternalCandidate(input: Parameters<typeof ledger.recordExternalCandidate>[1]): Promise<{ id: string; inserted: boolean }>;
  backfillLegacyCandidate(input: Parameters<typeof ledger.backfillLegacyCandidate>[1]): Promise<{ id: string; inserted: boolean; upgraded: boolean }>;
  readChainState(chainId: number, evaluator: string): Promise<EvaluatorChainStateView | null>;
  observeHeadClock(chainId: number, evaluator: string, clock: 'stuck' | 'sendLost', nonce: number | null, at?: Date): Promise<Date | null>;
  recordAlertDelivered(chainId: number, evaluator: string, kind: string, at?: Date): Promise<void>;
  recordNodeRead(chainId: number, evaluator: string, node: string, ok: boolean, at?: Date): Promise<number>;
  observeSafeHead(chainId: number, evaluator: string, block: bigint, at?: Date): Promise<{ advanced: boolean; seenAt: Date }>;
}

const LIVE = ['SIGNED', 'SENT', 'SEND_UNCONFIRMED'];

/** The production ledger: `evaluator-ledger.ts` on Prisma (plus the read-only queries the reconciliation pass needs). */
export function prismaEvaluatorLedger(db: PrismaClient): EvaluatorLedgerPort {
  return {
    insertCandidateWithJobStamp: (input) => ledger.insertCandidateWithJobStamp(db, input),
    markBroadcast: (id) => ledger.markBroadcast(db, id),
    markAnswered: (id, outcome, sendError) => ledger.markAnswered(db, id, outcome, sendError),
    markResolved: (id, to, proof) => ledger.markResolved(db, id, to, proof),
    revertForReorg: (id) => ledger.revertForReorg(db, id),
    candidatesForJob: (jobId) => ledger.candidatesForJob(db, jobId),
    candidatesAtNonce: (chainId, evaluator, nonce) => ledger.candidatesAtNonce(db, chainId, evaluator, nonce),
    liveNonces: (chainId, evaluator) => ledger.liveNonces(db, chainId, evaluator),
    liveCandidates: (chainId, evaluator) => ledger.liveCandidates(db, chainId, evaluator),
    async noncesToReconcile(chainId, evaluator) {
      const rows = await db.evaluatorTransaction.findMany({
        where: {
          chainId,
          evaluator: ledger.normAddress(evaluator),
          nonce: { not: null },
          OR: [{ status: { in: LIVE } }, { proofLevel: 'latest' }],
        },
        distinct: ['nonce'],
        select: { nonce: true },
        orderBy: { nonce: 'asc' },
      });
      return rows.map((r) => r.nonce!);
    },
    async liveLegacyWithoutNonce(chainId, evaluator) {
      const rows = await db.evaluatorTransaction.findMany({
        where: { chainId, evaluator: ledger.normAddress(evaluator), nonce: null, status: { in: LIVE } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(ledger.toCandidate);
    },
    async chainsWithLiveCandidates(evaluator) {
      const rows = await db.evaluatorTransaction.findMany({
        where: { evaluator: ledger.normAddress(evaluator), status: { in: LIVE } },
        distinct: ['chainId'],
        select: { chainId: true },
      });
      return rows.map((r) => r.chainId);
    },
    recordExternalCandidate: (input) => ledger.recordExternalCandidate(db, input),
    backfillLegacyCandidate: (input) => ledger.backfillLegacyCandidate(db, input),
    readChainState: (chainId, evaluator) => ledger.readChainState(db, chainId, evaluator),
    observeHeadClock: (chainId, evaluator, clock, nonce, at) => ledger.observeHeadClock(db, chainId, evaluator, clock, nonce, at),
    recordAlertDelivered: (chainId, evaluator, kind, at) => ledger.recordAlertDelivered(db, chainId, evaluator, kind, at),
    recordNodeRead: (chainId, evaluator, node, ok, at) => ledger.recordNodeRead(db, chainId, evaluator, node, ok, at),
    observeSafeHead: (chainId, evaluator, block, at) => ledger.observeSafeHead(db, chainId, evaluator, block, at),
  };
}

/** Per-node reads of the evaluator key and of `hashes` (F2 `readNodeViews`, proof tag bound by the runtime). */
export type EvaluatorNodeReader = (chainId: number, evaluator: Address, hashes: readonly Hex[]) => Promise<EvaluatorNodeRead[]>;

function receiptView(r: EvaluatorReceiptRead): ReceiptView {
  // `logsForJob` is informational here: the financial outcome is read from the
  // job's OWN terminal event by the existing path (parseSettlementReceipt with
  // the on-chain job id, reconcileTerminal), never from these flags.
  return { txHash: r.txHash, status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, logsForJob: { completed: false, rejected: false, expired: false } };
}

/** F2 reads → F1 views (`nonceProof` = the nonce at the proof tag; receipts keyed by lower-cased hash). */
export function toNodeViews(reads: readonly EvaluatorNodeRead[]): NodeView[] {
  return reads.map((r) => {
    if (!r.ok) return { node: r.node, ok: false };
    const receipts: Record<string, ReceiptView | null> = {};
    for (const [hash, receipt] of Object.entries(r.receipts ?? {})) receipts[hash.toLowerCase()] = receipt ? receiptView(receipt) : null;
    const known: Record<string, boolean> = {};
    for (const [hash, k] of Object.entries(r.known ?? {})) known[hash.toLowerCase()] = k;
    return {
      node: r.node,
      ok: true,
      ...(r.nonceLatest !== undefined ? { nonceLatest: r.nonceLatest } : {}),
      ...(r.nonceAtTag !== undefined ? { nonceProof: r.nonceAtTag, nonceAtTag: r.nonceAtTag } : {}),
      known,
      receipts,
    };
  });
}

/** What the single-client fallback needs from the orchestrator's read client. */
export interface SingleNodeClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ transactionHash?: Hex; status: 'success' | 'reverted'; blockNumber?: bigint; blockHash?: Hex; logs?: unknown[] }>;
  getTransaction?(args: { hash: Hex }): Promise<unknown>;
  getTransactionCount?(args: { address: Address; blockTag?: 'latest' | 'pending' }): Promise<number>;
}

function namedError(err: unknown, name: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { name?: string }).name === name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * ONE node: the orchestrator's read client. Test-double fallback only — the
 * proof nonce is the `latest` one (Anvil-like), and a client without
 * `getTransactionCount` / `getTransaction` gives an incomplete view, which
 * every rule reads as "uncertain" (fail closed).
 */
export async function singleClientNodeReads(client: SingleNodeClient, evaluator: Address, hashes: readonly Hex[]): Promise<EvaluatorNodeRead[]> {
  const node = '#0 read-client';
  try {
    if (!client.getTransactionCount || !client.getTransaction) return [{ node, index: 0, ok: false, error: 'the read client cannot tell nonces / known transactions' }];
    const [nonceLatest, noncePending] = await Promise.all([
      client.getTransactionCount({ address: evaluator, blockTag: 'latest' }),
      client.getTransactionCount({ address: evaluator, blockTag: 'pending' }),
    ]);
    const known: Record<Hex, boolean> = {};
    const receipts: Record<Hex, EvaluatorReceiptRead | null> = {};
    for (const raw of new Set(hashes.map((h) => h.toLowerCase() as Hex))) {
      let receipt: EvaluatorReceiptRead | null = null;
      try {
        const r = await client.getTransactionReceipt({ hash: raw });
        if (!r.blockHash || r.blockNumber === undefined) throw new Error('receipt without a block');
        receipt = { txHash: (r.transactionHash ?? raw) as Hex, status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, logs: (r.logs ?? []) as never };
      } catch (err) {
        if (!namedError(err, 'TransactionReceiptNotFoundError')) throw err;
      }
      let isKnown = receipt !== null;
      if (!isKnown) {
        try {
          await client.getTransaction({ hash: raw });
          isKnown = true;
        } catch (err) {
          if (!namedError(err, 'TransactionNotFoundError')) throw err;
        }
      }
      known[raw] = isKnown;
      receipts[raw] = receipt;
    }
    return [{ node, index: 0, ok: true, nonceLatest, noncePending, nonceAtTag: nonceLatest, known, receipts }];
  } catch (err) {
    return [{ node, index: 0, ok: false, error: (err as Error)?.message ?? String(err) }];
  }
}

/** The candidate action / decision recorded for an evaluator call (spec §2.3). */
export interface CandidateIntent {
  action: CandidateAction;
  /** pay | refund | quality-rejected | payout-blocked | cancelled | provider-failed | expiry */
  decision: string;
  reasonHex: Hex | null;
}
