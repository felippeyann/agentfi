/**
 * In-memory double of the A1 evaluator candidate ledger (`EvaluatorLedgerPort`)
 * for the orchestrator's UNIT suite, whose Prisma client is a mock (no
 * interactive transactions, no A1 tables). The real ledger is exercised by
 * `evaluator-ledger.db.test.ts` and, through the orchestrator, by the DB
 * suites. Kept deliberately small: the rules that matter to the orchestrator
 * (record before send, conditional job stamp with rollback, nonce occupancy,
 * monotonic status, persisted clocks) — not the SCRIPT budget rules.
 */
import { keccak256, getAddress, type Hex } from 'viem';
import type { EvaluatorLedgerPort, LedgerCandidate } from '../../services/job/escrow-evaluator-a1.js';
import type { EvaluatorChainStateView } from '../../services/escrow/evaluator-ledger.js';
import { SettlementSupersededError } from '../../services/job/escrow-errors.js';

const LIVE = new Set(['SIGNED', 'SENT', 'SEND_UNCONFIRMED']);

export interface InMemoryLedger extends EvaluatorLedgerPort {
  rows: LedgerCandidate[];
  states: Map<string, EvaluatorChainStateView>;
}

/**
 * `stampJob` performs the job's conditional write (the mocked `db.job.updateMany`);
 * a count of 0 rolls the candidate back (`SettlementSupersededError`).
 */
export function inMemoryEvaluatorLedger(stampJob: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>): InMemoryLedger {
  const rows: LedgerCandidate[] = [];
  const states = new Map<string, EvaluatorChainStateView>();
  let seq = 0;
  const stateOf = (chainId: number, evaluator: string): EvaluatorChainStateView => {
    const key = `${chainId}:${getAddress(evaluator)}`;
    let s = states.get(key);
    if (!s) {
      s = { chainId, evaluator: getAddress(evaluator), stuckSince: null, stuckNonce: null, sendLostSince: null, sendLostNonce: null, lastAlertAt: {}, safeHeadBlock: null, safeHeadSeenAt: null, rpcFailures: {}, updatedAt: new Date() };
      states.set(key, s);
    }
    return s;
  };
  const byId = (id: string) => rows.find((r) => r.id === id);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return {
    rows,
    states,
    async insertCandidateWithJobStamp({ candidate: c, job }) {
      const txHash = c.txHash.toLowerCase();
      const existing = rows.find((r) => r.chainId === c.chainId && r.txHash === txHash);
      if (!existing) {
        if (c.kind === 'ORIGINAL' && rows.some((r) => r.chainId === c.chainId && same(r.evaluator, c.evaluator) && r.nonce === c.nonce && LIVE.has(r.status))) {
          throw new Error(`NONCE_OCCUPIED: nonce ${c.nonce}`);
        }
      }
      const row: LedgerCandidate = existing ?? {
        id: `etx_${++seq}`,
        chainId: c.chainId,
        evaluator: getAddress(c.evaluator),
        nonce: c.nonce,
        jobId: c.jobId,
        kind: c.kind,
        action: c.action,
        decision: c.decision ?? null,
        reasonHex: c.reasonHex ?? null,
        replacesId: c.replacesId ?? null,
        toAddress: getAddress(c.toAddress),
        valueWei: c.valueWei ?? 0n,
        calldata: c.calldata.toLowerCase(),
        calldataHash: keccak256(c.calldata.toLowerCase() as Hex),
        gasLimit: c.gasLimit,
        maxFeePerGas: c.maxFeePerGas,
        maxPriorityFeePerGas: c.maxPriorityFeePerGas,
        txHash,
        rawTx: c.rawTx ?? null,
        status: 'SIGNED',
        proofLevel: null,
        createdAt: new Date(),
        broadcastAt: null,
        lastBroadcastAt: null,
        answeredAt: null,
        resolvedAt: null,
        origin: c.origin,
        operator: c.operator ?? null,
        note: c.note ?? null,
        incidentId: c.incidentId ?? null,
        sendError: null,
        minedBlockNumber: null,
        minedBlockHash: null,
      };
      if (!existing) rows.push(row);
      if (job) {
        const res = await stampJob({
          where: { id: job.id, settleTxHash: job.expectedSettleTxHash, ...(job.expectedOnChainStatus !== undefined ? { onChainStatus: job.expectedOnChainStatus } : {}) },
          data: { ...(job.setSettleTxHash ? { settleTxHash: txHash } : {}), ...(job.stampAttempt ? { settleAttemptAt: new Date() } : {}) },
        });
        if (!res || res.count === 0) {
          if (!existing) rows.splice(rows.indexOf(row), 1);
          throw new SettlementSupersededError(job.id);
        }
      }
      return { id: row.id, inserted: !existing };
    },
    async markBroadcast(id) {
      const r = byId(id);
      if (!r || !LIVE.has(r.status)) return false;
      const now = new Date();
      r.broadcastAt ??= now;
      r.lastBroadcastAt = now;
      return true;
    },
    async markAnswered(id, outcome, sendError) {
      const r = byId(id);
      if (!r) return false;
      const allowed = outcome === 'SENT' ? ['SIGNED', 'SEND_UNCONFIRMED'] : ['SIGNED'];
      if (!allowed.includes(r.status)) return false;
      r.status = outcome === 'UNCERTAIN' ? 'SIGNED' : outcome;
      r.answeredAt = new Date();
      if (sendError) r.sendError = sendError;
      return true;
    },
    async markResolved(id, to, proof) {
      const r = byId(id);
      if (!r) return false;
      if (LIVE.has(r.status)) {
        r.status = to;
        r.proofLevel = proof.level;
        r.resolvedAt = new Date();
        if (to !== 'DEAD') {
          r.minedBlockNumber = proof.blockNumber ?? null;
          r.minedBlockHash = proof.blockHash?.toLowerCase() ?? null;
        }
        return true;
      }
      if (r.status === to && r.proofLevel === 'latest' && proof.level === 'proof') {
        r.proofLevel = 'proof';
        return true;
      }
      return false;
    },
    async revertForReorg(id) {
      const r = byId(id);
      if (!r || LIVE.has(r.status) || r.proofLevel !== 'latest') return false;
      r.status = r.status !== 'DEAD' || r.broadcastAt || r.answeredAt ? 'SENT' : 'SIGNED';
      r.proofLevel = null;
      r.minedBlockHash = null;
      r.minedBlockNumber = null;
      return true;
    },
    async candidatesForJob(jobId) {
      return rows.filter((r) => r.jobId === jobId);
    },
    async candidatesAtNonce(chainId, evaluator, nonce) {
      return rows.filter((r) => r.chainId === chainId && same(r.evaluator, evaluator) && r.nonce === nonce);
    },
    async liveNonces(chainId, evaluator) {
      return [...new Set(rows.filter((r) => r.chainId === chainId && same(r.evaluator, evaluator) && LIVE.has(r.status) && r.nonce !== null).map((r) => r.nonce!))].sort((a, b) => a - b);
    },
    async liveCandidates(chainId, evaluator) {
      return rows.filter((r) => r.chainId === chainId && same(r.evaluator, evaluator) && LIVE.has(r.status));
    },
    async noncesToReconcile(chainId, evaluator) {
      return [...new Set(rows.filter((r) => r.chainId === chainId && same(r.evaluator, evaluator) && r.nonce !== null && (LIVE.has(r.status) || r.proofLevel === 'latest')).map((r) => r.nonce!))].sort((a, b) => a - b);
    },
    async liveLegacyWithoutNonce(chainId, evaluator) {
      return rows.filter((r) => r.chainId === chainId && same(r.evaluator, evaluator) && r.nonce === null && LIVE.has(r.status));
    },
    async chainsWithLiveCandidates(evaluator) {
      return [...new Set(rows.filter((r) => same(r.evaluator, evaluator) && LIVE.has(r.status)).map((r) => r.chainId))];
    },
    async recordExternalCandidate() {
      throw new Error('in-memory ledger: recordExternalCandidate not modelled');
    },
    async backfillLegacyCandidate() {
      throw new Error('in-memory ledger: backfillLegacyCandidate not modelled');
    },
    async readChainState(chainId, evaluator) {
      return stateOf(chainId, evaluator);
    },
    async observeHeadClock(chainId, evaluator, clock, nonce, at = new Date()) {
      const s = stateOf(chainId, evaluator);
      const sinceKey = clock === 'stuck' ? 'stuckSince' : 'sendLostSince';
      const nonceKey = clock === 'stuck' ? 'stuckNonce' : 'sendLostNonce';
      if (nonce === null) {
        s[sinceKey] = null;
        s[nonceKey] = null;
        return null;
      }
      if (s[nonceKey] !== nonce || !s[sinceKey]) s[sinceKey] = at;
      s[nonceKey] = nonce;
      return s[sinceKey];
    },
    async recordAlertDelivered(chainId, evaluator, kind, at = new Date()) {
      stateOf(chainId, evaluator).lastAlertAt[kind] = at;
    },
    async recordNodeRead(chainId, evaluator, node, ok) {
      const s = stateOf(chainId, evaluator);
      s.rpcFailures[node] = ok ? 0 : (s.rpcFailures[node] ?? 0) + 1;
      return s.rpcFailures[node]!;
    },
    async observeSafeHead(chainId, evaluator, block, at = new Date()) {
      const s = stateOf(chainId, evaluator);
      if (s.safeHeadBlock === null || s.safeHeadBlock < block) {
        s.safeHeadBlock = block;
        s.safeHeadSeenAt = at;
        return { advanced: true, seenAt: at };
      }
      return { advanced: false, seenAt: s.safeHeadSeenAt! };
    },
  };
}
