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
import { formatEther } from 'viem';
import { broadcast, fundsSource, GasCeilingError, isKnownToNode, nonces, receiptOf, signTransfer, transfersIn, type ChainConfig } from './chain.js';
import { explainVaultRefusal, invoiceKeyOf, settledEventsIn, VaultRefusalError, vendorKey } from './vault.js';
import { describeRule, explorerTx, judgeFinality, ruleFor } from './finality.js';
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
  /** The confirmation rule this receipt satisfied (finality.ts). */
  confirmation: string;
  /** `<explorer>/tx/<hash>`, when the chain has a known explorer: anyone can check it there. */
  explorer?: string;
  /** Paid through the operator's vault (`from` is then the vault) by this agent key. */
  vault?: string;
  agent?: string;
}

export type Outcome =
  /** Paid now. */
  | { outcome: 'paid'; receipt: Receipt }
  /** Already paid earlier: the original receipt, nothing new was sent. */
  | { outcome: 'replayed'; receipt: Receipt }
  /** Was paid (or sent) before a crash; found on-chain now: the original receipt, nothing new was signed. */
  | { outcome: 'recovered'; receipt: Receipt; note: string }
  /**
   * Sent, not confirmed yet: do NOT pay again. `stage`: `sent` (no receipt seen) or `included` (mined,
   * the block does not satisfy the confirmation rule yet, or it changed).
   */
  | { outcome: 'pending'; invoiceId: string; txHash: string; stage: 'sent' | 'included'; blockNumber?: string; note: string; next: string; explorer?: string }
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
      if (existing.status !== 'refused') {
        try {
          return this.answerFor(await this.reconcile(existing), true);
        } catch (e) {
          if (!existing.tx_hash) throw e;
          // The chain could not be read: answer from the ledger, keep the uncertainty, never pay again.
          const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
          ledger.event(inv.id, 'reconcile-error', { error: msg.slice(0, 300) });
          return {
            outcome: 'pending',
            invoiceId: inv.id,
            txHash: existing.tx_hash,
            stage: existing.status === 'included' || existing.status === 'confirmed' ? 'included' : 'sent',
            ...(existing.block_number ? { blockNumber: existing.block_number } : {}),
            ...this.explorerOf(existing.tx_hash),
            note: `Could not read the chain, or the node refused the recorded transaction, right now (${msg}). Last known state of ${existing.tx_hash}: ${existing.status}. Do NOT pay this invoice again, under this id or another.`,
            next: 'Resubmit this same invoice id once the RPC answers, or run `npm run ops -- reconcile`.',
          };
        }
      }
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
    let signed;
    try {
      signed = await signTransfer(this.o.chain, this.o.payerKey, inv.payTo, amount, nonce, inv.id);
    } catch (e) {
      if (e instanceof VaultRefusalError) {
        // The vault's own rules refused it at the gas estimate: nothing signed, nothing sent, no nonce used.
        const r = explainVaultRefusal(e, inv);
        ledger.insert({ ...base, status: 'refused', rule: r.rule, reason: r.reason, what_to_do: r.whatToDo, nonce: null, raw_tx: null, tx_hash: null, block_number: null, log_index: null });
        ledger.event(inv.id, 'refused-by-vault', { error: e.errorName, args: e.args.map(String) });
        return { outcome: 'refused', invoiceId: inv.id, rule: r.rule, reason: r.reason, whatToDo: r.whatToDo };
      }
      if (!(e instanceof GasCeilingError)) throw e;
      // Refused BEFORE signing: nothing signed, nothing sent, no nonce used. Recorded as a refusal (no tx
      // hash, no raw bytes), so it is never read as sent or pending; a resubmission is judged again.
      const ceiling = formatEther(e.ceilingWei), max = formatEther(e.maxCostWei);
      const reason = `Paying would authorize up to ${max} ${this.gasSymbol()} of gas (gas ${e.gas} × max fee ${e.maxFeePerGas} wei = ${e.maxCostWei} wei), above the operator's ceiling of ${ceiling} ${this.gasSymbol()} (${e.ceilingWei} wei) per transaction. Nothing was signed or sent.`;
      const whatToDo = 'Resubmit the same invoice later, when fees are lower (it is judged again), or the operator raises INVOICE_MAX_GAS_COST.';
      ledger.insert({ ...base, status: 'refused', rule: 'maxGasCost', reason, what_to_do: whatToDo, nonce: null, raw_tx: null, tx_hash: null, block_number: null, log_index: null });
      ledger.event(inv.id, 'refused-gas-ceiling', { maxCostWei: e.maxCostWei.toString(), ceilingWei: e.ceilingWei.toString(), gas: e.gas.toString(), maxFeePerGas: e.maxFeePerGas.toString() });
      return { outcome: 'refused', invoiceId: inv.id, rule: 'maxGasCost', reason, whatToDo };
    }
    // Write-ahead: the signed transaction is on disk before it can reach the chain. If the id is
    // already taken (another writer got there first), these signed bytes are discarded, never sent.
    const inserted = ledger.insert({ ...base, status: 'signed', rule: null, reason: null, what_to_do: null, nonce, raw_tx: signed.raw, tx_hash: signed.hash, block_number: null, log_index: null });
    if (!inserted) {
      ledger.event(inv.id, 'discarded-duplicate-signature', { txHash: signed.hash });
      return this.answerFor(await this.reconcile(ledger.get(inv.id)!), true);
    }
    ledger.event(inv.id, 'signed', { txHash: signed.hash, nonce, maxGasCostWei: signed.maxCostWei.toString(), ceilingWei: this.o.chain.maxGasCostWei?.toString() ?? null, maxFeePerGas: signed.maxFeePerGas.toString(), maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(), suggestedPriorityFeePerGas: signed.suggestedPriorityFeePerGas.toString(), priorityFeeCapWei: this.o.chain.maxPriorityFeeWei?.toString() ?? null });
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
        stage: 'sent',
        ...this.explorerOf(signed.hash),
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
    // Under depth:N (an operational rule, not finality) a confirmation can be undone by a deeper reorg:
    // a confirmed row is checked again every time and withdrawn if its block is no longer canonical.
    if (row.status === 'confirmed' && row.tx_hash && ruleFor(chain).kind === 'depth') {
      const r = await receiptOf(chain, row.tx_hash as Hex);
      const still = r !== null && r.blockNumber.toString() === row.block_number && (await judgeFinality(chain, r)).canonical;
      if (still) return row;
      ledger.update(row.invoice_id, {
        status: 'broadcast', block_number: null, log_index: null,
        reason: `The block ${row.block_number} that confirmed ${row.tx_hash} is no longer canonical (reorg deeper than the depth rule): confirmation withdrawn, checked again.`,
      });
      ledger.event(row.invoice_id, 'confirmation-withdrawn', { txHash: row.tx_hash, block: row.block_number });
      row = ledger.get(row.invoice_id)!;
    }
    if (!OPEN_STATUSES.includes(row.status)) return row;
    const hash = row.tx_hash as Hex;
    // Nonce first, then the receipt: a payment mined in between is then seen by the receipt read.
    // Any RPC failure is thrown (the row stays as it is); only the node's explicit "not found" counts.
    const { latest } = await nonces(chain, this.o.mandate.payer);
    let receipt = await receiptOf(chain, hash);
    if (!receipt && row.status === 'included') {
      // It was seen in a block, and that block is no longer canonical (reorg): back to "sent", block forgotten.
      ledger.update(row.invoice_id, { status: 'broadcast', block_number: null, log_index: null });
      ledger.event(row.invoice_id, 'left-canonical-chain', { txHash: hash, block: row.block_number });
    }
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
    const source = fundsSource(chain, this.o.mandate.payer);
    const match = transfersIn(chain, receipt).find(
      (t) => t.from === source && t.to.toLowerCase() === row.pay_to.toLowerCase() && t.value === BigInt(row.amount),
    );
    // Through a vault, the vault's own record must say the same: InvoiceSettled for THIS invoice, payee and amount, under
    // the vendor the agent judged it for (its vendor topic and its key, keccak256(invoiceId, vendor)).
    const settledOk = !chain.vault || settledEventsIn(chain, receipt).some(
      (s) => s.invoiceId === row.invoice_id && s.payTo.toLowerCase() === row.pay_to.toLowerCase() && s.amount === BigInt(row.amount)
        && s.vendor === vendorKey(chain.vaultVendorId!) && s.invoiceKey === invoiceKeyOf(row.invoice_id, chain.vaultVendorId!),
    );
    if (!match || !settledOk) {
      ledger.update(row.invoice_id, { status: 'reverted', reason: `Transaction ${hash} succeeded but has no ${!match ? `Transfer of ${row.amount} units from ${source} to ${row.pay_to}` : `InvoiceSettled event for ${row.invoice_id}`}.`, what_to_do: 'Operator: inspect the transaction.' });
      ledger.event(row.invoice_id, 'no-matching-transfer', { txHash: hash });
      return ledger.get(row.invoice_id)!;
    }
    // Mined and matching: confirmed only when the block satisfies the rule and is still canonical.
    const fin = await judgeFinality(chain, receipt);
    const block = match.blockNumber.toString();
    if (!fin.final) {
      const prev = ledger.get(row.invoice_id)!;
      ledger.update(row.invoice_id, { status: 'included', block_number: block, log_index: match.logIndex, reason: fin.detail });
      if (prev.status !== 'included' || prev.block_number !== block) {
        ledger.event(row.invoice_id, 'included', { txHash: hash, block, blockHash: receipt.blockHash, canonical: fin.canonical, rule: describeRule(ruleFor(chain)) });
      }
      return ledger.get(row.invoice_id)!;
    }
    ledger.update(row.invoice_id, { status: 'confirmed', block_number: block, log_index: match.logIndex, reason: null });
    ledger.event(row.invoice_id, 'confirmed', { txHash: hash, block, blockHash: receipt.blockHash, logIndex: match.logIndex, rule: describeRule(ruleFor(chain)), detail: fin.detail });
    return ledger.get(row.invoice_id)!;
  }

  private gasSymbol(): string {
    return this.o.chain.chainId === 44005 ? 'tQDAY' : 'ETH';
  }

  private confirmedRule(invoiceId: string): string | undefined {
    const ev = this.o.ledger.events(invoiceId).filter((e) => e.event === 'confirmed').pop();
    return ev?.detail ? (JSON.parse(ev.detail) as { rule?: string }).rule : undefined;
  }

  private explorerOf(hash: string): { explorer?: string } {
    const url = explorerTx(this.o.chain, hash);
    return url ? { explorer: url } : {};
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
          stage: 'sent',
          ...this.explorerOf(row.tx_hash!),
          note: `Payment ${row.tx_hash} was sent and is not in a block yet. It is NOT sent again.`,
          next: `Resubmit the same invoice later, or run: npm run ops -- reconcile ${row.invoice_id}. If it stays unmined, stop: do not pay this invoice under another id; check the payer's transactions in the explorer.`,
        };
      case 'included':
        return {
          outcome: 'pending',
          invoiceId: row.invoice_id,
          txHash: row.tx_hash!,
          stage: 'included',
          blockNumber: row.block_number!,
          ...this.explorerOf(row.tx_hash!),
          note: `Payment ${row.tx_hash} is in a block but NOT confirmed under the rule ${describeRule(ruleFor(this.o.chain))}: ${row.reason}. Do not treat the invoice as paid yet; it is NOT sent again.`,
          next: `Ask again later (resubmit the same invoice, or: npm run ops -- reconcile ${row.invoice_id}, then ops verify ${row.invoice_id}).`,
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
      from: fundsSource(this.o.chain, this.o.mandate.payer),
      to: row.pay_to,
      ...(this.o.chain.vault ? { vault: this.o.chain.vault, agent: this.o.mandate.payer } : {}),
      amount: formatUnits6(BigInt(row.amount)),
      amountUnits: row.amount,
      txHash: row.tx_hash!,
      blockNumber: row.block_number!,
      logIndex: row.log_index!,
      // The rule this payment was actually confirmed under (recorded in the ledger), not today's setting.
      confirmation: this.confirmedRule(row.invoice_id) ?? describeRule(ruleFor(this.o.chain)),
      ...this.explorerOf(row.tx_hash!),
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
