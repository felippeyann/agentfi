/**
 * On-chain reconciliation of x402 resource payments (first x402 delivery,
 * 2026-11-15; the "P5 reconciliation" TODO of `resource-payment.service.ts`
 * and docs/architecture/x402-payments.md §10).
 *
 * The pay-resource ledger never guesses: after a signed EIP-3009
 * authorization left the process, a lost response (`unknown`), a refusal
 * (`refused`) or even a "settled" report from the server is only the
 * server's word. This module asks the USDC contract itself and moves a row
 * only on proof:
 *
 *   proof                                            → transition
 *   ────────────────────────────────────────────────   ─────────────────────────────
 *   authorizationState(payer, nonce) = true AND an      unknown / pending / refused /
 *   AuthorizationUsed(payer, nonce) log whose tx        settled  →  settled +
 *   carries Transfer(payer → payTo, amount)             chainVerifiedAt
 *   authorizationState = false at a block whose         unknown / pending / refused /
 *   timestamp is ≥ validBefore + margin (FiatToken      settled  →  expired
 *   requires block.timestamp < validBefore, so it can   (not counted any more)
 *   never execute again)
 *   authorizationState = true AND an                     → expired (cancelled)
 *   AuthorizationCanceled(payer, nonce) log
 *   `reserved` older than `staleAfterMs` with no         reserved → failed_before_signing
 *   authorization recorded: the payload is only sent     (`markPending` is conditional on
 *   after `markPending` stored the nonce, so nothing     `reserved`, so a slow attempt can
 *   left the process                                     no longer send)
 *
 * Everything else is reported, never written: an authorization still live
 * and unused (`wait` until validBefore — the budget stays held), a used
 * authorization whose transfer does not match the row (`mismatch`), Permit2
 * or legacy rows without payer / nonce (`manual`), attempts younger than
 * `staleAfterMs` (`in-flight`). A transition is a conditional update on the
 * row's id, status and updatedAt, so it cannot overwrite a concurrent change.
 *
 * Evidence comes from ONE explicit RPC per chain at a non-reorgable head
 * (`finalized` by default; `latest − n` only by choice) — never the multi-provider fallback: mixing a local fork with the real
 * network (or two nodes at different heads) could "prove" an unused nonce.
 */

import type { Prisma, PrismaClient, ResourcePayment, ResourcePaymentStatus } from '@prisma/client';
import {
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export const USDC_EIP3009_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** Attempts younger than this are left alone (the paid request has a 30 s per-phase timeout). */
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

/** How far before `reservedAt` the log search starts (clock skew between this host and the chain). */
const SEARCH_MARGIN_SECONDS = 3600n;

const EIP3009_NONCE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ── Chain evidence ───────────────────────────────────────────────────────────

export interface ChainHead {
  number: bigint;
  timestamp: bigint;
}

export interface AuthorizationEvent {
  txHash: Hex;
  blockNumber: bigint;
}

export interface TokenTransfer {
  from: string;
  to: string;
  value: bigint;
}

/** What reconciliation reads from a chain. One instance = one RPC = one consistent view. */
export interface ChainEvidenceReader {
  chainId(): Promise<number>;
  /** The block verdicts are judged at: `latest − confirmations`. */
  head(): Promise<ChainHead>;
  authorizationUsed(token: Address, authorizer: Address, nonce: Hex, atBlock: bigint): Promise<boolean>;
  findAuthorizationEvent(
    kind: 'used' | 'canceled',
    token: Address,
    authorizer: Address,
    nonce: Hex,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<AuthorizationEvent | null>;
  /** USDC `Transfer` logs emitted by `token` in `txHash` (successful receipts only). */
  transfersInTx(token: Address, txHash: Hex): Promise<TokenTransfer[]>;
  /** Lowest block number ≤ `head.number` whose timestamp is ≥ `timestamp` (or `head.number`). */
  blockAtOrAfter(timestamp: bigint, head: ChainHead): Promise<bigint>;
}

/** Max blocks per `eth_getLogs` call (public RPCs cap the range). */
const LOG_CHUNK = 2000n;
/** Smallest range that is still split when the node refuses a getLogs range. */
const MIN_LOG_SPLIT = 8n;

/**
 * Which block verdicts are judged at: a block tag the node only moves past
 * once the block cannot reorg (`finalized`, `safe`), or `latest − n`.
 * `latest − 0` is only for a local chain or fork (the CLI requires a flag).
 */
export type HeadSelector = { tag: 'finalized' | 'safe' } | { confirmations: number };

export function viemEvidenceReader(client: PublicClient, head: HeadSelector = { tag: 'finalized' }): ChainEvidenceReader {
  if ('confirmations' in head && (!Number.isInteger(head.confirmations) || head.confirmations < 0)) {
    throw new Error('confirmations must be a non-negative integer');
  }
  return {
    async chainId() {
      return client.getChainId();
    },
    async head() {
      if ('tag' in head) {
        const block = await client.getBlock({ blockTag: head.tag });
        if (block.number === null) throw new Error(`no ${head.tag} block`);
        return { number: block.number, timestamp: block.timestamp };
      }
      const latest = await client.getBlockNumber();
      const depth = BigInt(head.confirmations);
      const number = latest > depth ? latest - depth : 0n;
      const block = await client.getBlock({ blockNumber: number });
      return { number, timestamp: block.timestamp };
    },
    async authorizationUsed(token, authorizer, nonce, atBlock) {
      return (await client.readContract({
        address: token,
        abi: USDC_EIP3009_ABI,
        functionName: 'authorizationState',
        args: [authorizer, nonce],
        blockNumber: atBlock,
      })) as boolean;
    },
    async findAuthorizationEvent(kind, token, authorizer, nonce, fromBlock, toBlock) {
      const event = USDC_EIP3009_ABI.find(
        (item) => item.type === 'event' && item.name === (kind === 'used' ? 'AuthorizationUsed' : 'AuthorizationCanceled'),
      );
      if (!event || event.type !== 'event') throw new Error('ABI event missing');
      // Newest first (payments are recent), and a range the node refuses is
      // split in halves down to MIN_LOG_SPLIT blocks before giving up:
      // public RPCs cap ranges, and a fork refuses ranges across its fork block.
      const search = async (start: bigint, end: bigint): Promise<AuthorizationEvent | null> => {
        try {
          const logs = await client.getLogs({ address: token, event, args: { authorizer, nonce }, fromBlock: start, toBlock: end });
          const log = logs[0];
          return log?.transactionHash && log.blockNumber !== null
            ? { txHash: log.transactionHash, blockNumber: log.blockNumber }
            : null;
        } catch (error) {
          if (end - start < MIN_LOG_SPLIT) throw error;
          const mid = start + (end - start) / 2n;
          return (await search(mid + 1n, end)) ?? (await search(start, mid));
        }
      };
      for (let end = toBlock; end >= fromBlock; end -= LOG_CHUNK) {
        const start = end - LOG_CHUNK + 1n > fromBlock ? end - LOG_CHUNK + 1n : fromBlock;
        const hit = await search(start, end);
        if (hit) return hit;
        if (start === fromBlock) break;
      }
      return null;
    },
    async transfersInTx(token, txHash) {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') return [];
      const own = receipt.logs.filter((log) => log.address.toLowerCase() === token.toLowerCase());
      return parseEventLogs({ abi: USDC_EIP3009_ABI, eventName: 'Transfer', logs: own }).map((log) => ({
        from: log.args.from,
        to: log.args.to,
        value: log.args.value,
      }));
    },
    async blockAtOrAfter(timestamp, head) {
      if (head.timestamp < timestamp) return head.number;
      // Bracket backwards from the head with growing steps, so only recent
      // blocks are read (pruned nodes and forks do not serve old history),
      // then binary-search inside the bracket.
      let hi = head.number;
      let lo = hi;
      for (let step = 256n; ; step *= 2n) {
        const candidate = hi > step ? hi - step : 0n;
        const block = await client.getBlock({ blockNumber: candidate });
        if (block.timestamp < timestamp || candidate === 0n) {
          lo = candidate;
          break;
        }
        hi = candidate;
      }
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const block = await client.getBlock({ blockNumber: mid });
        if (block.timestamp >= timestamp) hi = mid;
        else lo = mid + 1n;
      }
      return lo;
    },
  };
}

/** A reader over exactly one RPC URL (no provider fallback — see the header). */
export function readerForRpcUrl(rpcUrl: string, head: HeadSelector = { tag: 'finalized' }): ChainEvidenceReader {
  return viemEvidenceReader(createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) }) as PublicClient, head);
}

// ── Verdicts ─────────────────────────────────────────────────────────────────

export type ReconcileVerdict =
  | { kind: 'confirmed'; txHash: Hex; blockNumber: bigint; note: string }
  | { kind: 'expired'; reason: 'lapsed-unused' | 'cancelled'; atBlock: bigint; txHash?: Hex; note: string }
  | { kind: 'release-unsigned'; note: string }
  | { kind: 'wait'; until: Date; note: string }
  | { kind: 'in-flight'; note: string }
  | { kind: 'mismatch'; txHash: Hex; note: string }
  | { kind: 'manual'; note: string }
  | { kind: 'nothing'; note: string };

export interface ReconcileOptions {
  now?: Date;
  staleAfterMs?: number;
  /**
   * `expired` needs the judged head to be at least this many seconds past
   * validBefore (default 60): on top of a non-reorgable head, it keeps a
   * block produced right at the boundary from deciding alone.
   */
  expiryMarginSeconds?: number;
}

/** Default margin past validBefore before `expired` (see `ReconcileOptions`). */
export const DEFAULT_EXPIRY_MARGIN_SECONDS = 60;

type RowForReconcile = Pick<
  ResourcePayment,
  | 'id'
  | 'attemptId'
  | 'status'
  | 'network'
  | 'asset'
  | 'amount'
  | 'payTo'
  | 'payer'
  | 'authorizationMethod'
  | 'authorizationNonce'
  | 'authorizationValidBefore'
  | 'reservedAt'
  | 'updatedAt'
  | 'chainVerifiedAt'
  | 'settlementTxHash'
>;

/** `eip155:84532` → 84532; null for anything else. */
export function chainIdOfNetwork(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : null;
}

/** Rows a reconciliation pass needs to look at (everything not already proven or terminal). */
export function reconcilableWhere(): Prisma.ResourcePaymentWhereInput {
  return {
    OR: [
      { status: { in: ['reserved', 'pending', 'unknown', 'refused'] } },
      { status: 'settled', chainVerifiedAt: null },
    ],
  };
}

const STATUSES_NEEDING_CHAIN: ReadonlySet<ResourcePaymentStatus> = new Set(['pending', 'unknown', 'refused', 'settled']);

/**
 * Decides what the evidence says about one row. Reads the chain, writes nothing.
 * `reader` must be the reader of the row's chain (the caller checks `chainId`).
 */
export async function examineRow(
  row: RowForReconcile,
  reader: ChainEvidenceReader,
  options: ReconcileOptions = {},
): Promise<ReconcileVerdict> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  if (row.status === 'failed_before_signing' || row.status === 'expired') {
    return { kind: 'nothing', note: `${row.status}: terminal, nothing to reconcile` };
  }
  if (row.status === 'settled' && row.chainVerifiedAt) {
    return { kind: 'nothing', note: 'settled and already proven on-chain' };
  }

  if (row.status === 'reserved') {
    if (row.authorizationNonce) {
      return { kind: 'manual', note: 'reserved row carries an authorization nonce (unexpected): check by hand' };
    }
    if (now.getTime() - row.reservedAt.getTime() < staleAfterMs) {
      return { kind: 'in-flight', note: 'reserved recently: an attempt may still be running' };
    }
    return {
      kind: 'release-unsigned',
      note: `reserved since ${row.reservedAt.toISOString()} with no authorization recorded: nothing was sent (the payload only leaves after the nonce is stored); reservation released`,
    };
  }

  if (row.status === 'pending' && now.getTime() - row.updatedAt.getTime() < staleAfterMs) {
    return { kind: 'in-flight', note: 'pending recently: the paid request may still be in flight' };
  }
  if (!STATUSES_NEEDING_CHAIN.has(row.status)) {
    return { kind: 'manual', note: `status ${row.status} not handled` };
  }

  // Never inferred from the nonce shape: a Permit2 row judged against the
  // USDC contract would look "unused" and lapse while its transfer happened.
  const method = row.authorizationMethod;
  if (method !== 'eip3009') {
    return {
      kind: 'manual',
      note: method === 'permit2'
        ? 'Permit2 authorization: on-chain reconciliation not implemented — check the Permit2 nonce bitmap by hand'
        : 'no authorization method recorded: check by hand',
    };
  }
  if (!row.authorizationNonce || !EIP3009_NONCE.test(row.authorizationNonce)) {
    return { kind: 'manual', note: 'no EIP-3009 nonce recorded: check by hand' };
  }
  if (!row.payer || !ADDRESS.test(row.payer)) {
    return { kind: 'manual', note: 'no payer recorded (row written before migration 0027): check by hand' };
  }
  if (!ADDRESS.test(row.asset) || !ADDRESS.test(row.payTo) || !/^\d+$/.test(row.amount)) {
    return { kind: 'manual', note: 'row asset / payTo / amount unreadable: check by hand' };
  }
  if (!row.authorizationValidBefore) {
    return { kind: 'manual', note: 'no validBefore recorded: check by hand' };
  }

  const token = row.asset as Address;
  const payer = row.payer as Address;
  const nonce = row.authorizationNonce as Hex;
  const validBefore = BigInt(Math.floor(row.authorizationValidBefore.getTime() / 1000));

  const head = await reader.head();
  const used = await reader.authorizationUsed(token, payer, nonce, head.number);

  if (used) {
    const since = BigInt(Math.floor(row.reservedAt.getTime() / 1000)) - SEARCH_MARGIN_SECONDS;
    const fromBlock = await reader.blockAtOrAfter(since > 0n ? since : 0n, head);
    const usedEvent = await reader.findAuthorizationEvent('used', token, payer, nonce, fromBlock, head.number);
    if (usedEvent) {
      const transfers = await reader.transfersInTx(token, usedEvent.txHash);
      const matches = transfers.some(
        (t) =>
          t.from.toLowerCase() === payer.toLowerCase() &&
          t.to.toLowerCase() === row.payTo.toLowerCase() &&
          t.value === BigInt(row.amount),
      );
      if (!matches) {
        return {
          kind: 'mismatch',
          txHash: usedEvent.txHash,
          note: `authorization used in ${usedEvent.txHash} but no Transfer ${payer} → ${row.payTo} of ${row.amount} in that tx: check by hand`,
        };
      }
      const reported =
        row.settlementTxHash && row.settlementTxHash.toLowerCase() !== usedEvent.txHash.toLowerCase()
          ? ` (server had reported ${row.settlementTxHash})`
          : '';
      return {
        kind: 'confirmed',
        txHash: usedEvent.txHash,
        blockNumber: usedEvent.blockNumber,
        note: `transfer proven on-chain in ${usedEvent.txHash}, block ${usedEvent.blockNumber} (was ${row.status})${reported}`,
      };
    }
    const canceled = await reader.findAuthorizationEvent('canceled', token, payer, nonce, fromBlock, head.number);
    if (canceled) {
      return {
        kind: 'expired',
        reason: 'cancelled',
        atBlock: canceled.blockNumber,
        txHash: canceled.txHash,
        note: `authorization cancelled on-chain in ${canceled.txHash} (was ${row.status}); no transfer`,
      };
    }
    return {
      kind: 'manual',
      note: `authorizationState is used but no AuthorizationUsed / AuthorizationCanceled log found from block ${fromBlock}: check by hand`,
    };
  }

  const margin = BigInt(options.expiryMarginSeconds ?? DEFAULT_EXPIRY_MARGIN_SECONDS);
  if (head.timestamp >= validBefore + margin) {
    return {
      kind: 'expired',
      reason: 'lapsed-unused',
      atBlock: head.number,
      note: `authorization unused at block ${head.number} (timestamp ${head.timestamp} ≥ validBefore ${validBefore} + ${margin} s): it can never move money (was ${row.status})`,
    };
  }
  return {
    kind: 'wait',
    until: row.authorizationValidBefore,
    note: `authorization unused at block ${head.number}; judged expired only once a non-reorgable head is ${margin} s past validBefore ${row.authorizationValidBefore.toISOString()}: the amount stays held`,
  };
}

// ── Applying verdicts ────────────────────────────────────────────────────────

export interface ReconcileResult {
  row: RowForReconcile & { jobId: string; paymentId: string };
  verdict: ReconcileVerdict;
  /** True when the row was written (only for transitions, with `apply`). */
  applied: boolean;
  /** The row changed under us between read and write: nothing written. */
  raced?: boolean;
}

/** The write a transition verdict implies; null for report-only verdicts. */
function transition(row: RowForReconcile, verdict: ReconcileVerdict, now: Date): Prisma.ResourcePaymentUpdateManyMutationInput | null {
  switch (verdict.kind) {
    case 'confirmed':
      return {
        status: 'settled',
        attemptId: null,
        settlementTxHash: verdict.txHash,
        chainVerifiedAt: now,
        reconciledAt: now,
        reconcileNote: verdict.note,
      };
    case 'expired':
      return { status: 'expired', attemptId: null, reconciledAt: now, reconcileNote: verdict.note };
    case 'release-unsigned':
      return {
        status: 'failed_before_signing',
        attemptId: null,
        reconciledAt: now,
        reconcileNote: verdict.note,
        error: `Abandoned ${row.status} reservation released by reconciliation (nothing was signed and sent)`,
      };
    default:
      return null;
  }
}

export interface ReconcilePassOptions extends ReconcileOptions {
  /** Restrict to rows of these jobs / agents. */
  jobId?: string;
  agentId?: string;
  /** Write transitions. Default false: dry-run. */
  apply?: boolean;
  /** One reader per chain id; rows of a chain without a reader are reported `manual`. */
  readers: Map<number, ChainEvidenceReader>;
}

/**
 * One reconciliation pass over every row that is not proven or terminal.
 * Dry-run unless `apply`. Never signs, sends or retries anything.
 */
export async function reconcileResourcePayments(
  db: Pick<PrismaClient, 'resourcePayment'>,
  options: ReconcilePassOptions,
): Promise<ReconcileResult[]> {
  const where: Prisma.ResourcePaymentWhereInput = {
    ...reconcilableWhere(),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  };
  const rows = await db.resourcePayment.findMany({ where, orderBy: { reservedAt: 'asc' } });
  const verifiedChains = new Map<number, boolean>();
  const results: ReconcileResult[] = [];

  for (const row of rows) {
    const now = options.now ?? new Date();
    let verdict: ReconcileVerdict;
    const chainId = chainIdOfNetwork(row.network);
    const reader = chainId === null ? undefined : options.readers.get(chainId);
    if (row.status !== 'reserved' && !reader) {
      verdict = { kind: 'manual', note: `no RPC configured for ${row.network}` };
    } else {
      try {
        if (reader && chainId !== null && !verifiedChains.has(chainId)) {
          verifiedChains.set(chainId, (await reader.chainId()) === chainId);
        }
        if (reader && chainId !== null && verifiedChains.get(chainId) === false) {
          verdict = { kind: 'manual', note: `the RPC for ${row.network} answers a different chain id: refusing to judge` };
        } else {
          verdict = await examineRow(row, reader ?? NO_READER, {
            now,
            ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
            ...(options.expiryMarginSeconds !== undefined ? { expiryMarginSeconds: options.expiryMarginSeconds } : {}),
          });
        }
      } catch (error) {
        verdict = { kind: 'manual', note: `chain read failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
      }
    }

    const data = transition(row, verdict, now);
    let applied = false;
    let raced = false;
    if (options.apply && data) {
      const { count } = await db.resourcePayment.updateMany({
        where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
        data,
      });
      applied = count === 1;
      raced = count !== 1;
    }
    results.push({ row, verdict, applied, ...(raced ? { raced } : {}) });
  }
  return results;
}

/** Placeholder for `reserved` rows, which never need the chain. */
const NO_READER: ChainEvidenceReader = {
  chainId: () => Promise.reject(new Error('no reader')),
  head: () => Promise.reject(new Error('no reader')),
  authorizationUsed: () => Promise.reject(new Error('no reader')),
  findAuthorizationEvent: () => Promise.reject(new Error('no reader')),
  transfersInTx: () => Promise.reject(new Error('no reader')),
  blockAtOrAfter: () => Promise.reject(new Error('no reader')),
};

// ── Operator resolution (no chain proof available) ──────────────────────────

export interface ManualResolution {
  jobId: string;
  paymentId: string;
  /** `expired`: the operator attests the authorization cannot move money; `settled`: it moved, in `txHash`. */
  outcome: 'expired' | 'settled';
  txHash?: string;
  /** Who decided, and why — stored on the row (`reconcileNote`). Both required. */
  operator: string;
  note: string;
  apply: boolean;
  now?: Date;
}

/** Statuses an operator may resolve by hand: the ones reconciliation can leave `manual` forever. */
const MANUALLY_RESOLVABLE: ReadonlySet<ResourcePaymentStatus> = new Set(['unknown', 'pending', 'refused']);

/**
 * The exit for rows reconciliation cannot judge (Permit2, rows written before
 * migration 0027 without payer / method, persistent RPC failures). It is an
 * operator ATTESTATION, not proof: `chainVerifiedAt` stays null (a manual
 * `settled` is shown as "reported"), the note records who and why, and the
 * write is conditional on the row not having changed. Dry-run unless `apply`.
 */
export async function resolveManually(
  db: Pick<PrismaClient, 'resourcePayment'>,
  input: ManualResolution,
): Promise<{ ok: boolean; message: string; row?: ResourcePayment }> {
  const operator = input.operator.trim();
  const note = input.note.trim();
  if (!operator || !note) return { ok: false, message: '--operator and --note are required' };
  if (input.outcome === 'settled' && !(input.txHash && /^0x[0-9a-fA-F]{64}$/.test(input.txHash))) {
    return { ok: false, message: '--as settled needs --tx <the settlement transaction hash>' };
  }
  const row = await db.resourcePayment.findUnique({
    where: { jobId_paymentId: { jobId: input.jobId, paymentId: input.paymentId } },
  });
  if (!row) return { ok: false, message: 'no such payment on this job' };
  if (!MANUALLY_RESOLVABLE.has(row.status)) {
    return { ok: false, message: `status ${row.status} is not resolved by hand (only unknown, pending, refused)`, row };
  }
  const now = input.now ?? new Date();
  const reconcileNote = `MANUAL ${input.outcome} by ${operator} at ${now.toISOString()} (was ${row.status}): ${note}`.slice(0, 1000);
  if (!input.apply) return { ok: true, message: `would write: ${reconcileNote}`, row };
  const { count } = await db.resourcePayment.updateMany({
    where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
    data: {
      status: input.outcome,
      attemptId: null,
      reconciledAt: now,
      reconcileNote,
      ...(input.outcome === 'settled' ? { settlementTxHash: input.txHash! } : {}),
    },
  });
  if (count !== 1) return { ok: false, message: 'the row changed meanwhile; nothing written — rerun', row };
  return { ok: true, message: `written: ${reconcileNote}`, row: (await db.resourcePayment.findUnique({ where: { id: row.id } }))! };
}
