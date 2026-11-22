/**
 * "Was invoice X paid?" — the operator's question, answered from the ledger AND the chain, read-only.
 *
 * `verifyInvoice` is the check `ops verify` has always made (receipt by hash, the exact Transfer log,
 * the confirmation rule, the block against the ledger, every transfer to that payee matched to an
 * invoice); `ops verify` prints it, the MCP tool returns it. `inquireInvoice` turns it into one of a
 * few plain states and never hides uncertainty:
 *
 *   paid_verified       the transfer is on-chain, matches, and meets the confirmation rule
 *   pending             a transaction exists for it but is not confirmed yet (or not in a block yet)
 *   not_paid            refused by the mandate or the gas ceiling: nothing was signed
 *   failed              mined but reverted, or no matching Transfer: no tokens moved for it
 *   unresolved          the payer's nonce was used without this transaction being found: needs the operator
 *   mismatch            the chain and the ledger disagree (another block, an unexplained transfer)
 *   unknown_invoice     the ledger has no such invoice id
 *   cannot_verify_now   the chain could not be read: last known ledger state, and what to check first
 *
 * Nothing here writes: no ledger update, no context binding, no lock, no signing, no sending.
 */
import { existsSync } from 'node:fs';
import { getAddress, type Hex, type TransactionReceipt } from 'viem';
import { assertNodeChain, publicClientFor, receiptOf, transfersFrom, transfersIn, type ChainConfig, type TransferLog } from './chain.js';
import { describeRule, explorerTx, judgeFinality, ruleFor, type Finality } from './finality.js';
import { formatUnits6 } from './invoice.js';
import { Ledger, type PaymentRow } from './ledger.js';
import type { Mandate } from './mandate.js';

export interface Verification {
  row: PaymentRow;
  receipt: TransactionReceipt | null;
  blockTime?: string;
  match: TransferLog[];
  allToPayee: TransferLog[];
  unexplained: TransferLog[];
  sameAsLedger: boolean;
  finality?: Finality;
  verified: boolean;
  notFinal: boolean;
}

/** The on-chain check behind `ops verify`. Reads only; RPC errors are thrown. */
export async function verifyInvoice(chain: ChainConfig, mandate: Mandate, ledger: Ledger, id: string): Promise<Verification | undefined> {
  const row = ledger.get(id);
  if (!row) return undefined;
  if (!row.tx_hash) {
    const allToPayee = await transfersFrom(chain, mandate.payer, row.pay_to);
    return { row, receipt: null, match: [], allToPayee, unexplained: [], sameAsLedger: true, verified: false, notFinal: false };
  }
  const receipt = await receiptOf(chain, row.tx_hash as Hex);
  if (!receipt) return { row, receipt: null, match: [], allToPayee: [], unexplained: [], sameAsLedger: true, verified: false, notFinal: false };
  const block = await publicClientFor(chain).getBlock({ blockNumber: receipt.blockNumber });
  const match = transfersIn(chain, receipt).filter((t) => t.from === mandate.payer && t.to === getAddress(row.pay_to) && t.value === BigInt(row.amount));
  const allToPayee = await transfersFrom(chain, mandate.payer, row.pay_to);
  // The chain is the judge, not the agent's ledger: every transfer to this payee must belong to exactly one paid invoice.
  const known = new Set(ledger.all().filter((r) => r.pay_to.toLowerCase() === row.pay_to.toLowerCase() && r.tx_hash && r.status !== 'refused').map((r) => r.tx_hash!.toLowerCase()));
  const unexplained = allToPayee.filter((t) => !known.has(t.txHash.toLowerCase()));
  const sameAsLedger = !['confirmed', 'included'].includes(row.status) || (row.block_number === receipt.blockNumber.toString() && row.log_index === match[0]?.logIndex);
  const finality = await judgeFinality(chain, receipt);
  const onChainOk = receipt.status === 'success' && match.length === 1 && sameAsLedger && unexplained.length === 0;
  return {
    row, receipt, blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), match, allToPayee, unexplained, sameAsLedger, finality,
    verified: onChainOk && finality.final, notFinal: onChainOk && !finality.final,
  };
}

export type InquiryState = 'paid_verified' | 'pending' | 'not_paid' | 'failed' | 'unresolved' | 'mismatch' | 'unknown_invoice' | 'cannot_verify_now';

export interface Inquiry {
  invoiceId: string;
  state: InquiryState;
  /** One plain sentence for the operator. */
  answer: string;
  /** What to do next (always says when NOT to pay again). */
  next: string;
  network: { chainId: number; rpcUrl: string; token: string; confirmationRule: string };
  /** What the agent's ledger says (its last known state), when the invoice exists. */
  ledger?: { status: string; amount: string; payTo: string; txHash: string | null; blockNumber: string | null; reason: string | null };
  /** What the chain says, when it could be read. */
  chain?: { txHash: string; blockNumber: string; blockTime?: string; status: string; transfer: string | null; confirmation: string; transfersToPayee: number; unexplained: string[] };
  explorer?: string;
  /** The receipt, only when paid and verified. */
  receipt?: { invoiceId: string; chainId: number; token: string; from: string; to: string; amount: string; txHash: string; blockNumber: string; logIndex: number };
  error?: string;
}

const DO_NOT_PAY = 'Do NOT pay this invoice again, under this id or another.';

export async function inquireInvoice(chain: ChainConfig, mandate: Mandate, ledgerPath: string, invoiceId: string): Promise<Inquiry> {
  const network = { chainId: chain.chainId, rpcUrl: chain.rpcUrl, token: chain.token, confirmationRule: describeRule(ruleFor(chain)) };
  if (!existsSync(ledgerPath)) {
    return { invoiceId, state: 'unknown_invoice', network, answer: `There is no ledger at ${ledgerPath}, so invoice ${invoiceId} is not known to this agent.`, next: 'Check INVOICE_LEDGER points at the agent\'s ledger. An unknown invoice was never paid by THIS ledger; it says nothing about payments made elsewhere.' };
  }
  const ledger = new Ledger(ledgerPath, { readOnly: true });
  try {
    const row = ledger.get(invoiceId);
    if (!row) {
      return { invoiceId, state: 'unknown_invoice', network, answer: `Invoice ${invoiceId} is not in this agent's ledger: this agent never received or paid it.`, next: 'Check the invoice id exactly as written (case-sensitive). The agent paid nothing for it; whether anyone else did is not in this ledger.' };
    }
    const led = { status: row.status, amount: `${formatUnits6(BigInt(row.amount))} tUSD8`, payTo: row.pay_to, txHash: row.tx_hash, blockNumber: row.block_number, reason: row.reason };
    const explorer = row.tx_hash ? explorerTx(chain, row.tx_hash) : undefined;
    const base = { invoiceId, network, ledger: led, ...(explorer ? { explorer } : {}) };
    // The ledger must belong to this chain, token and payer (as recorded when it was first used).
    const ctx = ledger.readContext();
    const want = { chainId: String(chain.chainId), token: chain.token.toLowerCase(), payer: mandate.payer.toLowerCase() };
    const wrong = ctx ? (Object.keys(want) as (keyof typeof want)[]).filter((k) => ctx[k] !== undefined && ctx[k] !== want[k]) : [];
    if (wrong.length) {
      return { ...base, state: 'cannot_verify_now', error: `ledger context ${wrong.map((k) => `${k} ${ctx![k]}`).join(', ')} ≠ mandate ${wrong.map((k) => `${k} ${want[k]}`).join(', ')}`, answer: 'This ledger was written for another chain, token or payer than the mandate: its answer cannot be checked against this chain.', next: `${DO_NOT_PAY} Point INVOICE_MANDATE and INVOICE_LEDGER at the same agent.` };
    }
    let v: Verification;
    try {
      await assertNodeChain(chain); // a node serving another chain is "cannot verify", never an answer
      v = (await verifyInvoice(chain, mandate, ledger, invoiceId))!;
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      return {
        ...base,
        state: 'cannot_verify_now',
        error: msg.slice(0, 300),
        answer: `Could not read the chain right now, so this cannot be verified. The ledger's last known state is "${row.status}"${row.tx_hash ? ` with transaction ${row.tx_hash}` : ' (nothing was signed)'}.`,
        next: row.tx_hash
          ? `${DO_NOT_PAY} First check the original transaction ${explorer ?? row.tx_hash} in an explorer or ask again once the RPC answers; only the original transaction can settle this invoice.`
          : 'Ask again once the RPC answers. Nothing was signed for this invoice.',
      };
    }
    if (!row.tx_hash) {
      return { ...base, state: 'not_paid', answer: `Invoice ${invoiceId} was NOT paid: it was refused (${row.rule ?? 'rule'}) and nothing was signed. ${row.reason ?? ''}`.trim(), next: row.what_to_do ?? 'A resubmission of the same invoice is judged again.' };
    }
    const chainPart = v.receipt
      ? {
          txHash: row.tx_hash, blockNumber: v.receipt.blockNumber.toString(), ...(v.blockTime ? { blockTime: v.blockTime } : {}), status: v.receipt.status,
          transfer: v.match[0] ? `${formatUnits6(v.match[0].value)} tUSD8 ${mandate.payer} → ${row.pay_to} (log ${v.match[0].logIndex})` : null,
          confirmation: v.finality ? `${v.finality.detail}${v.finality.final ? ' → met' : ' → not met'}` : '',
          transfersToPayee: v.allToPayee.length, unexplained: v.unexplained.map((t) => t.txHash),
        }
      : undefined;
    const withChain = { ...base, ...(chainPart ? { chain: chainPart } : {}) };
    if (row.status === 'stuck') {
      return { ...withChain, state: 'unresolved', answer: `Unresolved: ${row.reason}`, next: `${DO_NOT_PAY} ${row.what_to_do ?? ''}`.trim() };
    }
    if (!v.receipt) {
      return { ...withChain, state: 'pending', answer: `Pending: transaction ${row.tx_hash} was signed and recorded (ledger: ${row.status}) but is not in a block on chain ${chain.chainId}.`, next: `${DO_NOT_PAY} Ask again later; the operator can run \`npm run ops -- reconcile ${invoiceId}\`.` };
    }
    if (v.verified) {
      return {
        ...withChain, state: 'paid_verified',
        answer: `Paid and verified: ${formatUnits6(BigInt(row.amount))} tUSD8 to ${row.pay_to} in transaction ${row.tx_hash}, block ${v.receipt.blockNumber}, confirmed under the rule ${network.confirmationRule}; it is the only transfer to this payee not explained by another invoice.`,
        next: 'Nothing to pay. Anyone can check the transaction on-chain' + (explorer ? ` at ${explorer}.` : '.'),
        receipt: { invoiceId, chainId: chain.chainId, token: chain.token, from: mandate.payer, to: row.pay_to, amount: formatUnits6(BigInt(row.amount)), txHash: row.tx_hash, blockNumber: v.receipt.blockNumber.toString(), logIndex: v.match[0]!.logIndex },
      };
    }
    if (v.notFinal) {
      return { ...withChain, state: 'pending', answer: `Pending: transaction ${row.tx_hash} is in block ${v.receipt.blockNumber} with the right transfer, but NOT confirmed yet (${v.finality!.detail}). Do not treat it as paid yet.`, next: `${DO_NOT_PAY} Ask again later.` };
    }
    if (v.receipt.status !== 'success' || v.match.length === 0) {
      return { ...withChain, state: 'failed', answer: `Not paid: transaction ${row.tx_hash} ${v.receipt.status !== 'success' ? 'was mined but reverted' : 'has no matching Transfer'}; no tokens moved for this invoice.`, next: 'The operator decides; a new payment needs a new decision (a new invoice id).' };
    }
    return {
      ...withChain, state: 'mismatch',
      answer: `The chain and the ledger disagree for ${invoiceId}: ${!v.sameAsLedger ? `the ledger says block ${row.block_number}, the chain says ${v.receipt.blockNumber}; ` : ''}${v.unexplained.length ? `${v.unexplained.length} transfer(s) to this payee are not matched to any invoice: ${v.unexplained.map((t) => t.txHash).join(', ')}` : ''}`.replace(/; $/, ''),
      next: `${DO_NOT_PAY} The operator inspects the transactions above before anything else.`,
    };
  } finally {
    ledger.close();
  }
}
