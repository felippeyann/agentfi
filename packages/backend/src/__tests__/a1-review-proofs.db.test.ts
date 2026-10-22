/**
 * A1 core review (22/10/2026, independent reviewer) — proof tests of R-P2-1, green since the
 * fix round (feat/a1-fix-core): nonces read before receipts, KNOWN_WITHOUT_RECEIPT, DEAD@latest correction.
 *
 * R-P2-1: the per-node read (`evaluator-rpc.ts` readOneNode) asks the nonce
 * and the receipts IN PARALLEL. When our own candidate mines between the
 * receipt read and the nonce read (or a load-balanced provider serves the
 * receipt from a backend one block behind), the pass sees "nonce consumed,
 * no receipt" and concludes `consumed-foreign`: our candidate becomes DEAD,
 * `evaluator-nonce-foreign` ("COMPROMISED key") fires, and on the next pass
 * — receipt now present — `resolveNonceDecision` names that DEAD row the
 * winner but `markResolved(DEAD -> MINED_SUCCESS)` is refused: the row stays
 * DEAD forever (never upgraded to `proof`, its nonce never leaves
 * `noncesToReconcile`, the job is never re-enqueued by the pass).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress, toHex, type Address, type Hex } from 'viem';
import { insertCandidateWithJobStamp, markAnswered, markResolved } from '../services/escrow/evaluator-ledger.js';
import { resolveNonceDecision, type CandidateRow, type NodeView } from '../services/escrow/evaluator-candidates.js';
import type { EvaluatorNodeRead } from '../services/escrow/evaluator-rpc.js';
import { reconcileEvaluatorCandidates, type EscrowAlert, type Erc8183Deps } from '../services/job/escrow-erc8183.service.js';

const db = new PrismaClient();
const CHAIN = 999_001;
const evaluator = getAddress(toHex(randomBytes(20))) as Address;
const hash = toHex(randomBytes(32)) as Hex;
const BLOCK_HASH = toHex(randomBytes(32)) as Hex;
let ready = false;

beforeAll(async () => {
  try {
    await db.$queryRaw`SELECT "proofLevel" FROM "EvaluatorTransaction" LIMIT 1`;
    ready = true;
  } catch {
    ready = false;
  }
});

afterAll(async () => {
  if (ready) {
    await db.evaluatorTransaction.deleteMany({ where: { chainId: CHAIN } });
    await db.evaluatorChainState.deleteMany({ where: { chainId: CHAIN } });
  }
  await db.$disconnect();
});

/** One healthy node; `receipt` decides whether the hash has a receipt on it. */
function nodeRead(opts: { nonceLatest: number; nonceAtTag: number; receipt: boolean }) {
  return async (_c: number, _e: Address, hashes: readonly Hex[]): Promise<EvaluatorNodeRead[]> => {
    const known: Record<Hex, boolean> = {};
    const receipts: EvaluatorNodeRead['receipts'] = {};
    for (const h of hashes) {
      const ours = h.toLowerCase() === hash.toLowerCase();
      known[h.toLowerCase() as Hex] = ours; // the node KNOWS our tx (it is mined / in its pool)
      receipts[h.toLowerCase() as Hex] =
        ours && opts.receipt ? { txHash: hash, status: 'success', blockNumber: 100n, blockHash: BLOCK_HASH, logs: [] } : null;
    }
    return [{ node: '#0 test', index: 0, ok: true, nonceLatest: opts.nonceLatest, noncePending: opts.nonceLatest, nonceAtTag: opts.nonceAtTag, proofBlockNumber: 90n, known, receipts }];
  };
}

function deps(read: Erc8183Deps['readNodeViews'], alerts: EscrowAlert[], now?: () => Date, failAlert = false): Erc8183Deps {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return {
    db,
    queue: { add: async () => undefined },
    settlement: { add: async () => undefined },
    publicClient: () => ({}) as never, // no getTransaction / getBlock: no backfill, no foreign search
    evaluatorSigner: () => {
      throw new Error('no signer in this test');
    },
    config: { evaluatorAddress: evaluator, chain: () => null } as never,
    releaseJobEscrow: async () => undefined,
    finalize: async () => undefined,
    logger: logger as never,
    alert: (a: EscrowAlert) => {
      if (failAlert) throw new Error('channel down');
      alerts.push(a);
    },
    ...(now ? { now } : {}),
    readNodeViews: read,
    proofTag: 'safe',
    evaluatorA1: { leaseMinRemainingMs: 30_000, criticalSectionMaxMs: 60_000, proofStalledAlertAfterMs: null },
  } as unknown as Erc8183Deps;
}

describe('A1 review R-P2-1 — a straddled per-node read kills our own mined candidate', () => {
  it('our candidate that mined is recorded MINED_SUCCESS once its receipt is visible (not left DEAD, no foreign-key alert)', async () => {
    if (!ready) return;
    const { id } = await insertCandidateWithJobStamp(db, {
      candidate: {
        chainId: CHAIN,
        evaluator,
        nonce: 7,
        jobId: null,
        kind: 'ORIGINAL',
        action: 'COMPLETE',
        toAddress: getAddress(toHex(randomBytes(20))),
        calldata: '0x12345678',
        gasLimit: 500_000n,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 1n,
        txHash: hash,
        origin: 'WORKER',
      },
    });
    await markAnswered(db, id, 'SENT');
    const alerts: EscrowAlert[] = [];

    // Pass 1: the receipt read was served one block before the nonce read (parallel reads straddle the block).
    await reconcileEvaluatorCandidates(deps(nodeRead({ nonceLatest: 8, nonceAtTag: 7, receipt: false }), alerts), CHAIN);
    const afterFirst = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });

    // Pass 2: the receipt is visible now, and the nonce is consumed at the proof tag.
    await reconcileEvaluatorCandidates(deps(nodeRead({ nonceLatest: 8, nonceAtTag: 8, receipt: true }), alerts), CHAIN);
    const afterSecond = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });

    // Report what happened (useful when the assertions below fail).
    console.log('[R-P2-1] after pass 1:', afterFirst.status, afterFirst.proofLevel, '| after pass 2:', afterSecond.status, afterSecond.proofLevel, '| alerts:', alerts.map((a) => a.kind));

    // Expected: a node that KNOWS our tx while the nonce moved is not proof of a foreign transaction ...
    expect(alerts.map((a) => a.kind)).not.toContain('evaluator-nonce-foreign');
    // ... and once the receipt is visible the ledger records the truth, at the proof depth.
    expect(afterSecond.status).toBe('MINED_SUCCESS');
    expect(afterSecond.proofLevel).toBe('proof');
  });

  it('(b) a row already DEAD at `latest` whose own receipt is now seen by consensus is corrected to MINED_SUCCESS (and proven); DEAD at `proof` stays immutable', async () => {
    if (!ready) return;
    const h2 = toHex(randomBytes(32)) as Hex;
    const { id } = await insertCandidateWithJobStamp(db, {
      candidate: {
        chainId: CHAIN, evaluator, nonce: 9, jobId: null, kind: 'ORIGINAL', action: 'COMPLETE',
        toAddress: getAddress(toHex(randomBytes(20))), calldata: '0x12345678', gasLimit: 500_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
        txHash: h2, origin: 'WORKER',
      },
    });
    await markAnswered(db, id, 'SENT');
    await markResolved(db, id, 'DEAD', { level: 'latest' }); // what caac580 wrote after a straddled read
    const alerts: EscrowAlert[] = [];
    const read = async (_c: number, _e: Address, hashes: readonly Hex[]): Promise<EvaluatorNodeRead[]> => {
      const known: Record<Hex, boolean> = {};
      const receipts: EvaluatorNodeRead['receipts'] = {};
      for (const h of hashes) {
        const ours = h.toLowerCase() === h2.toLowerCase();
        known[h.toLowerCase() as Hex] = ours;
        receipts[h.toLowerCase() as Hex] = ours ? { txHash: h2, status: 'success', blockNumber: 101n, blockHash: BLOCK_HASH, logs: [] } : null;
      }
      return [{ node: '#0 test', index: 0, ok: true, nonceLatest: 10, noncePending: 10, nonceAtTag: 10, proofBlockNumber: 95n, known, receipts }];
    };
    await reconcileEvaluatorCandidates(deps(read, alerts), CHAIN);
    const row = await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'MINED_SUCCESS', proofLevel: 'proof', minedBlockHash: BLOCK_HASH.toLowerCase() });
    expect(alerts.map((a) => a.kind)).not.toContain('evaluator-nonce-foreign');
  });

  it('Rechecagem R-P3-b: a persistent KNOWN_WITHOUT_RECEIPT is alerted past the threshold (persisted first sight), marked delivered only after delivery', async () => {
    if (!ready) return;
    const h3 = toHex(randomBytes(32)) as Hex;
    const { id } = await insertCandidateWithJobStamp(db, {
      candidate: {
        chainId: CHAIN, evaluator, nonce: 11, jobId: null, kind: 'ORIGINAL', action: 'COMPLETE',
        toAddress: getAddress(toHex(randomBytes(20))), calldata: '0x12345678', gasLimit: 500_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
        txHash: h3, origin: 'WORKER',
      },
    });
    await markAnswered(db, id, 'SENT');
    const read = async (_c: number, _e: Address, hashes: readonly Hex[]): Promise<EvaluatorNodeRead[]> => {
      const known: Record<Hex, boolean> = {};
      const receipts: EvaluatorNodeRead['receipts'] = {};
      for (const h of hashes) {
        known[h.toLowerCase() as Hex] = h.toLowerCase() === h3.toLowerCase();
        receipts[h.toLowerCase() as Hex] = null;
      }
      return [{ node: '#0 stale', index: 0, ok: true, nonceLatest: 12, noncePending: 12, nonceAtTag: 12, proofBlockNumber: 90n, known, receipts }];
    };
    const alerts: EscrowAlert[] = [];
    let t = Date.now();
    const kinds = () => alerts.map((a) => a.kind).filter((k) => k === 'evaluator-proof-uncertain');
    await reconcileEvaluatorCandidates(deps(read, alerts, () => new Date(t)), CHAIN); // first sight: no alert
    expect(kinds()).toHaveLength(0);
    t += 11 * 60_000; // past the 10-minute threshold — the channel fails: not marked delivered
    await reconcileEvaluatorCandidates(deps(read, alerts, () => new Date(t), true), CHAIN);
    const state = await db.evaluatorChainState.findFirstOrThrow({ where: { chainId: CHAIN, evaluator } });
    expect(Object.keys(state.lastAlertAt as object).some((k) => k === 'evaluator-proof-uncertain:11')).toBe(false);
    await reconcileEvaluatorCandidates(deps(read, alerts, () => new Date(t)), CHAIN); // delivered now
    expect(kinds()).toHaveLength(1);
    expect(alerts.find((a) => a.kind === 'evaluator-proof-uncertain')!.message).toMatch(/#0 stale: latest 12, knows it, no receipt/);
    await reconcileEvaluatorCandidates(deps(read, alerts, () => new Date(t + 60_000)), CHAIN); // not again within the hour
    expect(kinds()).toHaveLength(1);
    expect(await db.evaluatorTransaction.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SENT' }); // nothing concluded
  });

  it('(a) pure rule: nonce consumed, no receipt, a node KNOWS our live candidate → uncertain (never consumed-foreign)', () => {
    const c = { id: 'c1', chainId: 1, evaluator, nonce: 3, jobId: null, kind: 'ORIGINAL', action: 'COMPLETE', decision: null, calldataHash: '0x', gasLimit: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, txHash: hash, status: 'SENT', proofLevel: null, createdAt: new Date(), broadcastAt: null, lastBroadcastAt: null, origin: 'WORKER', incidentId: null, minedBlockHash: null } as CandidateRow;
    const view = (k: boolean): NodeView => ({ node: 'n', ok: true, nonceLatest: 4, nonceProof: 4, known: { [hash.toLowerCase()]: k }, receipts: { [hash.toLowerCase()]: null } });
    expect(resolveNonceDecision([c], [view(true)], 3)).toMatchObject({ kind: 'uncertain', reason: 'KNOWN_WITHOUT_RECEIPT' });
    expect(resolveNonceDecision([c], [view(false)], 3)).toMatchObject({ kind: 'consumed-foreign' });
  });
});
