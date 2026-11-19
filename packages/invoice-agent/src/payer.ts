/**
 * The agent's payment decision for one invoice. Order of operations, and why:
 *
 *   1. Same invoice id already in the ledger?  Answer from the ledger (and the chain): the same
 *      receipt, the same refusal, or the pending state. NEVER sign again for that id.
 *   2. New invoice: judge it against the operator's mandate (vendor, payee, per-invoice and daily
 *      limits). A refusal is recorded with its reason; nothing is signed.
 *   3. Sign the transfer locally, RECORD it (raw bytes, hash, nonce) and only then broadcast it.
 *   4. Wait for the receipt and check the Transfer log (payer → payTo, exact amount) before calling
 *      it paid.
 *
 * A crash between 3 and 4 is the "lost response": the money may have moved, the caller saw nothing.
 * On the next submission of the same invoice, step 1 runs `reconcile`, which looks for the recorded
 * hash on-chain: mined → the receipt (no second payment); in the node's mempool → PENDING (no second
 * payment, wait); unknown to the node and its nonce still unused → rebroadcast the SAME signed bytes
 * (same hash: it can be mined at most once); nonce used by something else → needs the operator.
 */
import type { Hex } from 'viem';
import { broadcast, isKnownToNode, nonces, receiptOf, signTransfer, transfersIn, type ChainConfig } from './chain.js';
import { formatUnits6, invoiceHash, toBaseUnits, type Invoice } from './invoice.js';
import { OPEN_STATUSES, type Ledger, type PaymentRow } from './ledger.js';
import { judgeInvoice, type Mandate } from './mandate.js';

export type FailPoint = 'after-sign' | 'after-broadcast';

/** Thrown at a configured fail point: the process is meant to die here without answering. */
export class FailPointError extends Error {
  constructor(public point: FailPoint) {
    super(`simulated crash at ${point}`);
  }
}

export interface Receipt {
  invoiceId: string;
  invoiceHash: string;
  chainId: number;
  token: string;
  from: string;
  to: string;
  amount: string;
  amountUnits: string;
  txHash: string;
  blockNumber: string;
  logIndex: number;
}

export type Outcome =
  /** Paid now. */
  | { outcome: 'paid'; receipt: Receipt }
  /** Already paid earlier: the original receipt, nothing new was sent. */
  | { outcome: 'replayed'; receipt: Receipt }
  /** Was paid (or sent) before a crash; found on-chain now: the original receipt, nothing new was signed. */
  | { outcome: 'recovered'; receipt: Receipt; note: string }
  /** Sent, not confirmed yet: do NOT pay again. */
  | { outcome: 'pending'; invoiceId: string; txHash: string; note: string; next: string }
  | { outcome: 'refused'; invoiceId: string; rule: string; reason: string; whatToDo: string }
  /** Same invoice id, different content: refused, the original stands. */
  | { outcome: 'conflict'; invoiceId: string; reason: string }
  /** Mined but reverted: no tokens moved for it, the operator decides. */
  | { outcome: 'failed'; invoiceId: string; txHash: string | null; reason: string; next: string }
  /** The payer's nonce is used but this transaction was not found: money may or may not have moved. Do NOT pay again. */
  | { outcome: 'unresolved'; invoiceId: string; txHash: string; reason: string; next: string };

export interface PayerOptions {
  ledger: Ledger;
  chain: ChainConfig;
  mandate: Mandate;
  /** The agent's key. Absent in the operator CLI: reconcile never signs. */
  payerKey?: Hex;
  failAt?: FailPoint;
  /** How long to wait for a receipt before answering PENDING (ms). */
  receiptTimeoutMs?: number;
}

/**
 * Assumes exclusive use of its ledger: the agent process takes the ledger lock
 * (`acquireInstanceLock`) before creating one. Two payers on one ledger are not supported (they could
 * exceed the daily limit); the duplicate-signature check below is a last line of defence for the same
 * invoice id, not a substitute for the lock.
 */
export class InvoicePayer {
  private queue: Promise<unknown> = Promise.resolve();
  private failAt: FailPoint | undefined;

  constructor(private o: PayerOptions) {
    this.failAt = o.failAt;
    // Receipts are rebuilt from the ledger row plus this context: refuse a ledger written for another one.
    o.ledger.bindContext({ chainId: o.chain.chainId, token: o.chain.token, payer: o.mandate.payer });
  }

  /** Invoices are handled one at a time (one nonce sequence, one ledger). */
  submit(inv: Invoice): Promise<Outcome> {
    const run = this.queue.then(() => this.handle(inv));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(inv: Invoice): Promise<Outcome> {
    const { ledger } = this.o;
    const hash = invoiceHash(inv);
    const existing = ledger.get(inv.id);
    if (existing) {
      ledger.event(inv.id, 'resubmitted', { sameContent: existing.invoice_hash === hash });
      if (existing.invoice_hash !== hash) {
        return {
          outcome: 'conflict',
          invoiceId: inv.id,
          reason: `Invoice ${inv.id} was already received with different content (payee or amount). The first one stands; this one is not paid.`,
        };
      }
      if (existing.status !== 'refused') return this.answerFor(await this.reconcile(existing), true);
      // A refused invoice signed nothing: judge it again under today's mandate and limits.
      const again = judgeInvoice(this.o.mandate, inv, ledger.committedToday());
      if (!again.allowed) {
        ledger.update(inv.id, { rule: again.rule, reason: again.reason, what_to_do: again.whatToDo });
        return { outcome: 'refused', invoiceId: inv.id, rule: again.rule, reason: again.reason, whatToDo: again.whatToDo };
      }
      ledger.deleteRefused(inv.id);
      ledger.event(inv.id, 'refusal-lifted', {});
    }

    // Before taking a new nonce, settle what is still open (a signed-but-unsent row holds a nonce too).
    // A row that cannot be settled right now (RPC down, a rebroadcast refused) does not block new invoices:
    // its nonce is still skipped by nextNonce, and it is retried on its next resubmission or reconcile.
    for (const row of ledger.all()) {
      if (!OPEN_STATUSES.includes(row.status)) continue;
      try {
        await this.reconcile(row);
      } catch (e) {
        ledger.event(row.invoice_id, 'reconcile-error', { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      }
    }

    const verdict = judgeInvoice(this.o.mandate, inv, ledger.committedToday());
    const amount = toBaseUnits(inv.amount);
    const base = { invoice_id: inv.id, invoice_hash: hash, vendor_id: inv.vendorId, pay_to: inv.payTo, amount: amount.toString() };
    if (!verdict.allowed) {
      ledger.insert({ ...base, status: 'refused', rule: verdict.rule, reason: verdict.reason, what_to_do: verdict.whatToDo, nonce: null, raw_tx: null, tx_hash: null, block_number: null, log_index: null });
      ledger.event(inv.id, 'refused', { rule: verdict.rule });
      return { outcome: 'refused', invoiceId: inv.id, rule: verdict.rule, reason: verdict.reason, whatToDo: verdict.whatToDo };
    }

    if (!this.o.payerKey) throw new Error('no payer key: this process cannot pay');
    const nonce = await this.nextNonce();
    const signed = await signTransfer(this.o.chain, this.o.payerKey, inv.payTo, amount, nonce);
    // Write-ahead: the signed transaction is on disk before it can reach the chain. If the id is
    // already taken (another writer got there first), these signed bytes are discarded, never sent.
    const inserted = ledger.insert({ ...base, status: 'signed', rule: null, reason: null, what_to_do: null, nonce, raw_tx: signed.raw, tx_hash: signed.hash, block_number: null, log_index: null });
    if (!inserted) {
      ledger.event(inv.id, 'discarded-duplicate-signature', { txHash: signed.hash });
      return this.answerFor(await this.reconcile(ledger.get(inv.id)!), true);
    }
    ledger.event(inv.id, 'signed', { txHash: signed.hash, nonce });
    this.maybeFail('after-sign');

    let stage = 'broadcasting it';
    try {
      const sent = await broadcast(this.o.chain, signed.raw);
      ledger.update(inv.id, { status: 'broadcast' });
      ledger.event(inv.id, 'broadcast', { result: sent });
      this.maybeFail('after-broadcast');
      stage = 'waiting for its receipt';
      const row = await this.reconcile(ledger.get(inv.id)!, { wait: true });
      return this.answerFor(row, false);
    } catch (e) {
      if (e instanceof FailPointError) throw e;
      // The signed transaction may have reached the chain: never answer as if nothing happened.
      const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      ledger.event(inv.id, 'rpc-error-after-sign', { stage, txHash: signed.hash, error: msg });
      return {
        outcome: 'pending',
        invoiceId: inv.id,
        txHash: signed.hash,
        note: `The payment was signed and may already be on-chain, but reading the chain failed while ${stage} (${msg}). Do NOT pay this invoice again, under this id or another.`,
        next: 'Resubmit this same invoice id (it is reconciled, never paid twice) or run `npm run ops -- reconcile` once the RPC answers.',
      };
    }
  }

  /**
   * Brings a row's status up to what the chain says, without ever signing anything new.
   * Exported through `ops reconcile` for the operator.
   */
  async reconcile(row: PaymentRow, opts: { wait?: boolean } = {}): Promise<PaymentRow> {
    const { ledger, chain } = this.o;
    if (!OPEN_STATUSES.includes(row.status)) return row;
    const hash = row.tx_hash as Hex;
    // Nonce first, then the receipt: a payment mined in between is then seen by the receipt read.
    // Any RPC failure is thrown (the row stays as it is); only the node's explicit "not found" counts.
    const { latest } = await nonces(chain, this.o.mandate.payer);
    let receipt = await receiptOf(chain, hash);
    if (!receipt && !(await isKnownToNode(chain, hash))) {
      if (latest > (row.nonce ?? -1)) {
        // Our nonce is used, but the node does not know our transaction. Either another transaction took
        // the nonce (then nothing moved for this invoice) or this node has not indexed ours. We cannot tell:
        // the row stays OPEN and is checked again every time.
        if (row.status !== 'stuck') {
          ledger.update(row.invoice_id, {
            status: 'stuck',
            reason: `The payer's nonce ${row.nonce} is used on-chain, but transaction ${hash} was not found by this node. Either another transaction used the nonce (then no money moved for this invoice) or the node has not indexed this one yet.`,
            what_to_do: `Do NOT pay this invoice again. Operator: look up the payer's transaction with nonce ${row.nonce} in an explorer; run reconcile again later.`,
          });
          ledger.event(row.invoice_id, 'stuck', { txHash: hash, nonce: row.nonce, latest });
        }
        return ledger.get(row.invoice_id)!;
      }
      // Never reached the node (crash before broadcast, or dropped): send the SAME bytes again.
      const sent = await broadcast(chain, row.raw_tx as Hex);
      ledger.update(row.invoice_id, { status: 'broadcast' });
      ledger.event(row.invoice_id, 'rebroadcast-same-bytes', { txHash: hash, result: sent });
    }
    if (!receipt) receipt = await this.waitForReceipt(hash, opts.wait ? (this.o.receiptTimeoutMs ?? 15_000) : 1_500);
    if (!receipt) return ledger.get(row.invoice_id)!;

    if (receipt.status !== 'success') {
      ledger.update(row.invoice_id, { status: 'reverted', reason: `Transaction ${hash} was mined but reverted: no tokens moved.`, what_to_do: 'Operator: check the payer balance and the token, then decide on a new invoice id.' });
      ledger.event(row.invoice_id, 'reverted', { txHash: hash });
      return ledger.get(row.invoice_id)!;
    }
    const match = transfersIn(chain, receipt).find(
      (t) => t.from === this.o.mandate.payer && t.to.toLowerCase() === row.pay_to.toLowerCase() && t.value === BigInt(row.amount),
    );
    if (!match) {
      ledger.update(row.invoice_id, { status: 'reverted', reason: `Transaction ${hash} succeeded but has no Transfer of ${row.amount} units to ${row.pay_to}.`, what_to_do: 'Operator: inspect the transaction.' });
      ledger.event(row.invoice_id, 'no-matching-transfer', { txHash: hash });
      return ledger.get(row.invoice_id)!;
    }
    ledger.update(row.invoice_id, { status: 'confirmed', block_number: match.blockNumber.toString(), log_index: match.logIndex });
    ledger.event(row.invoice_id, 'confirmed', { txHash: hash, block: match.blockNumber.toString(), logIndex: match.logIndex });
    return ledger.get(row.invoice_id)!;
  }

  private answerFor(row: PaymentRow, isResubmission: boolean): Outcome {
    switch (row.status) {
      case 'confirmed': {
        const receipt = this.receiptOf(row);
        if (!isResubmission) return { outcome: 'paid', receipt };
        const events = this.o.ledger.events(row.invoice_id).map((e) => e.event);
        // Confirmed during THIS resubmission (it was open before): a recovery, not a plain replay.
        const since = events.lastIndexOf('resubmitted');
        const confirmedNow = events.lastIndexOf('confirmed') > since;
        if (!confirmedNow) return { outcome: 'replayed', receipt };
        const resent = events.lastIndexOf('rebroadcast-same-bytes') > since;
        return {
          outcome: 'recovered',
          receipt,
          note: resent
            ? 'The payment had been signed and recorded but never reached the chain; the SAME signed transaction (same hash) was sent now. Nothing new was signed.'
            : 'The payment had been sent before the previous answer was lost; it was found on-chain. Nothing new was signed or sent.',
        };
      }
      case 'refused':
        return { outcome: 'refused', invoiceId: row.invoice_id, rule: row.rule ?? '', reason: row.reason ?? '', whatToDo: row.what_to_do ?? '' };
      case 'stuck':
        return { outcome: 'unresolved', invoiceId: row.invoice_id, txHash: row.tx_hash!, reason: row.reason ?? '', next: row.what_to_do ?? '' };
      case 'signed':
      case 'broadcast':
        return {
          outcome: 'pending',
          invoiceId: row.invoice_id,
          txHash: row.tx_hash!,
          note: `Payment ${row.tx_hash} was sent and is not confirmed yet. It is NOT sent again.`,
          next: `Resubmit the same invoice later, or run: npm run ops -- reconcile ${row.invoice_id}`,
        };
      case 'reverted':
        return { outcome: 'failed', invoiceId: row.invoice_id, txHash: row.tx_hash, reason: row.reason ?? '', next: row.what_to_do ?? '' };
    }
  }

  receiptOf(row: PaymentRow): Receipt {
    return {
      invoiceId: row.invoice_id,
      invoiceHash: row.invoice_hash,
      chainId: this.o.chain.chainId,
      token: this.o.chain.token,
      from: this.o.mandate.payer,
      to: row.pay_to,
      amount: formatUnits6(BigInt(row.amount)),
      amountUnits: row.amount,
      txHash: row.tx_hash!,
      blockNumber: row.block_number!,
      logIndex: row.log_index!,
    };
  }

  private async nextNonce(): Promise<number> {
    const { pending } = await nonces(this.o.chain, this.o.mandate.payer);
    const open = this.o.ledger.all().filter((r) => OPEN_STATUSES.includes(r.status) && r.nonce !== null);
    return Math.max(pending, ...open.map((r) => r.nonce! + 1));
  }

  private async waitForReceipt(hash: Hex, timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await receiptOf(this.o.chain, hash);
      if (r || Date.now() >= until) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  private maybeFail(point: FailPoint): void {
    if (this.failAt === point) {
      this.failAt = undefined;
      throw new FailPointError(point);
    }
  }
}
