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
import { assertNodeChain, fundsSource, publicClientFor, receiptOf, transfersFrom, transfersIn, type ChainConfig, type TransferLog } from './chain.js';
import { describeRule, explorerTx, judgeFinality, ruleFor, type Finality } from './finality.js';
import { formatUnits6 } from './invoice.js';
import { Ledger, type PaymentRow } from './ledger.js';
import type { Mandate } from './mandate.js';
import { findSettledEvent, findSettlement, invoiceKeyOf, settledEventsIn, settlementOf, vendorIdOf, vendorKey, type SettledEvent, type SettlementRecord } from './vault.js';

/** What the vault itself says about an invoice (only when the mandate names a vault). */
export interface VaultCheck {
  address: string;
  /** settlementOf(invoiceId) */
  settlement: SettlementRecord;
  /** The InvoiceSettled event of this invoice in the receipt (or found by its key in the logs). */
  event?: SettledEvent;
  /** settlementOf, the event and the ledger/receipt agree (block, amount, payee, agent). */
  agrees: boolean;
  /** Plain-language differences, when they do not agree. */
  problems: string[];
}

/** `expect.settled`: a mined payment exists for it, so the vault must have settled it (otherwise "not settled" is just an answer). */
function checkVault(chain: ChainConfig, mandate: Mandate, invoiceId: string, s: SettlementRecord, ev: SettledEvent | undefined, expect: { settled: boolean; amount?: bigint; payTo?: string; blockNumber?: bigint }): VaultCheck {
  const problems: string[] = [];
  if (expect.settled && !s.settled) problems.push('settlementOf says NOT settled');
  if ((expect.settled || s.settled) && !ev) problems.push('no InvoiceSettled event for it');
  if (s.settled && ev && (s.blockNumber !== ev.blockNumber || s.amount !== ev.amount || s.agent !== ev.agent)) problems.push(`settlementOf (block ${s.blockNumber}, ${formatUnits6(s.amount)} tUSD8, agent ${s.agent}) ≠ the event (block ${ev.blockNumber}, ${formatUnits6(ev.amount)}, agent ${ev.agent})`);
  if (ev && ev.invoiceId !== invoiceId) problems.push(`the event is for "${ev.invoiceId}"`);
  if (ev && chain.vaultVendorId && (ev.vendor !== vendorKey(chain.vaultVendorId) || ev.invoiceKey !== invoiceKeyOf(invoiceId, chain.vaultVendorId))) {
    problems.push(`the event is for vendor "${vendorIdOf(ev.vendor)}", not "${chain.vaultVendorId}"`);
  }
  if (expect.amount !== undefined && s.settled && s.amount !== expect.amount) problems.push(`settled amount ${formatUnits6(s.amount)} ≠ the invoice's ${formatUnits6(expect.amount)} tUSD8`);
  if (expect.payTo && ev && ev.payTo.toLowerCase() !== expect.payTo.toLowerCase()) problems.push(`paid to ${ev.payTo}, the invoice says ${expect.payTo}`);
  if (expect.blockNumber !== undefined && s.settled && s.blockNumber !== expect.blockNumber) problems.push(`settled in block ${s.blockNumber}, the receipt says ${expect.blockNumber}`);
  if (s.settled && s.agent !== mandate.payer) problems.push(`settled by ${s.agent}, not this agent ${mandate.payer}`);
  return { address: chain.vault!, settlement: s, ...(ev ? { event: ev } : {}), agrees: problems.length === 0, problems };
}

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
  /** With a vault: settlementOf and the InvoiceSettled event, checked against the receipt. */
  vault?: VaultCheck;
}

/** The on-chain check behind `ops verify`. Reads only; RPC errors are thrown. */
export async function verifyInvoice(chain: ChainConfig, mandate: Mandate, ledger: Ledger, id: string): Promise<Verification | undefined> {
  const row = ledger.get(id);
  if (!row) return undefined;
  const source = fundsSource(chain, mandate.payer);
  const settlement = chain.vault ? await settlementOf(chain, id) : undefined;
  if (!row.tx_hash) {
    const allToPayee = await transfersFrom(chain, source, row.pay_to);
    const vault = settlement ? checkVault(chain, mandate, id, settlement, settlement.settled ? await findSettledEvent(chain, settlement.key, settlement.blockNumber) : undefined, { settled: false }) : undefined;
    return { row, receipt: null, match: [], allToPayee, unexplained: [], sameAsLedger: true, verified: false, notFinal: false, ...(vault ? { vault } : {}) };
  }
  const receipt = await receiptOf(chain, row.tx_hash as Hex);
  if (!receipt) {
    const vault = settlement ? checkVault(chain, mandate, id, settlement, settlement.settled ? await findSettledEvent(chain, settlement.key, settlement.blockNumber) : undefined, { settled: false }) : undefined;
    return { row, receipt: null, match: [], allToPayee: [], unexplained: [], sameAsLedger: true, verified: false, notFinal: false, ...(vault ? { vault } : {}) };
  }
  const block = await publicClientFor(chain).getBlock({ blockNumber: receipt.blockNumber });
  const match = transfersIn(chain, receipt).filter((t) => t.from === source && t.to === getAddress(row.pay_to) && t.value === BigInt(row.amount));
  const allToPayee = await transfersFrom(chain, source, row.pay_to);
  const vault = settlement
    ? checkVault(chain, mandate, id, settlement, settledEventsIn(chain, receipt).find((e) => e.invoiceId === id), { settled: receipt.status === 'success', amount: BigInt(row.amount), payTo: row.pay_to, blockNumber: receipt.blockNumber })
    : undefined;
  // The chain is the judge, not the agent's ledger: every transfer to this payee must belong to exactly one paid invoice.
  const known = new Set(ledger.all().filter((r) => r.pay_to.toLowerCase() === row.pay_to.toLowerCase() && r.tx_hash && r.status !== 'refused').map((r) => r.tx_hash!.toLowerCase()));
  const unexplained = allToPayee.filter((t) => !known.has(t.txHash.toLowerCase()));
  const sameAsLedger = !['confirmed', 'included'].includes(row.status) || (row.block_number === receipt.blockNumber.toString() && row.log_index === match[0]?.logIndex);
  const finality = await judgeFinality(chain, receipt);
  const onChainOk = receipt.status === 'success' && match.length === 1 && sameAsLedger && unexplained.length === 0 && (vault?.agrees ?? true);
  return {
    row, receipt, blockTime: new Date(Number(block.timestamp) * 1000).toISOString(), match, allToPayee, unexplained, sameAsLedger, finality,
    verified: onChainOk && finality.final, notFinal: onChainOk && !finality.final, ...(vault ? { vault } : {}),
  };
}

/** The vault's record as the inquiry reports it. */
function vaultPart(v: VaultCheck) {
  return {
    address: v.address,
    invoiceKey: v.settlement.key,
    settled: v.settlement.settled,
    ...(v.settlement.settled ? { amount: `${formatUnits6(v.settlement.amount)} tUSD8`, blockNumber: v.settlement.blockNumber.toString(), agent: v.settlement.agent } : {}),
    event: v.event ? { txHash: v.event.txHash, blockNumber: v.event.blockNumber.toString(), logIndex: v.event.logIndex, payTo: v.event.payTo } : null,
    agrees: v.agrees,
    ...(v.problems.length ? { problems: v.problems } : {}),
  };
}

/**
 * The answer from the vault alone, for an invoice this ledger has no transaction for (unknown to it, or refused by it):
 * the chain's settlementOf, the InvoiceSettled event found by its key, that transaction's Transfer and the confirmation
 * rule. "Was it paid?" no longer depends on the ledger being the right one.
 */
async function answerFromVault(chain: ChainConfig, mandate: Mandate, invoiceId: string, base: Omit<Inquiry, 'state' | 'answer' | 'next'>): Promise<Inquiry | undefined> {
  const s = await settlementOf(chain, invoiceId);
  if (!s.settled) return undefined;
  const ev = await findSettledEvent(chain, s.key, s.blockNumber);
  const receipt = ev ? await receiptOf(chain, ev.txHash) : null;
  const check = checkVault(chain, mandate, invoiceId, s, ev, { settled: true, ...(receipt ? { blockNumber: receipt.blockNumber } : {}) });
  const explorer = ev ? explorerTx(chain, ev.txHash) : undefined;
  const withVault = { ...base, vault: vaultPart(check), ...(explorer ? { explorer } : {}) };
  const source = fundsSource(chain, mandate.payer);
  const transfer = receipt && ev ? transfersIn(chain, receipt).filter((t) => t.from === source && t.to === ev.payTo && t.value === ev.amount) : [];
  if (!ev || !receipt || receipt.status !== 'success' || transfer.length !== 1 || !check.agrees) {
    return { ...withVault, state: 'mismatch', answer: `The vault says invoice ${invoiceId} is settled (block ${s.blockNumber}), but its evidence does not add up: ${[...check.problems, !receipt ? 'the settling transaction was not found' : '', receipt && transfer.length !== 1 ? `${transfer.length} matching Transfer logs in it` : ''].filter(Boolean).join('; ')}.`, next: `${DO_NOT_PAY} The operator inspects the vault and the transaction first.` };
  }
  const fin = await judgeFinality(chain, receipt);
  const chainPart = {
    txHash: ev.txHash, blockNumber: receipt.blockNumber.toString(), status: receipt.status,
    transfer: `${formatUnits6(ev.amount)} tUSD8 ${source} → ${ev.payTo} (log ${transfer[0]!.logIndex})`,
    confirmation: `${fin.detail}${fin.final ? ' → met' : ' → not met'}`, transfersToPayee: 1, unexplained: [],
  };
  const notInLedger = base.ledger ? `This agent's ledger has it as "${base.ledger.status}" without a transaction (a refusal by the vault, or another ledger paid it)` : "It is not in this agent's ledger (another or a lost ledger paid it)";
  if (!fin.final) {
    return { ...withVault, chain: chainPart, state: 'pending', answer: `Pending: the vault settled invoice ${invoiceId} in block ${receipt.blockNumber} (transaction ${ev.txHash}), NOT confirmed yet (${fin.detail}). ${notInLedger}.`, next: `${DO_NOT_PAY} Ask again later.` };
  }
  return {
    ...withVault, chain: chainPart, state: 'paid_verified',
    answer: `Paid and verified on-chain by the vault: ${formatUnits6(ev.amount)} tUSD8 to ${ev.payTo} in transaction ${ev.txHash}, block ${receipt.blockNumber}, confirmed under the rule ${base.network.confirmationRule}. ${notInLedger}; the vault refuses a second settlement.`,
    next: 'Nothing to pay. Anyone can check the transaction on-chain' + (explorer ? ` at ${explorer}.` : '.'),
    receipt: { invoiceId, chainId: chain.chainId, token: chain.token, from: source, to: ev.payTo, amount: formatUnits6(ev.amount), txHash: ev.txHash, blockNumber: receipt.blockNumber.toString(), logIndex: transfer[0]!.logIndex },
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
  network: { chainId: number; rpcUrl: string; token: string; confirmationRule: string; vault?: string };
  /** What the agent's ledger says (its last known state), when the invoice exists. */
  ledger?: { status: string; amount: string; payTo: string; txHash: string | null; blockNumber: string | null; reason: string | null };
  /** What the chain says, when it could be read. */
  chain?: { txHash: string; blockNumber: string; blockTime?: string; status: string; transfer: string | null; confirmation: string; transfersToPayee: number; unexplained: string[] };
  explorer?: string;
  /** The receipt, only when paid and verified. */
  receipt?: { invoiceId: string; chainId: number; token: string; from: string; to: string; amount: string; txHash: string; blockNumber: string; logIndex: number };
  error?: string;
  /** With a vault: what the vault says (settlementOf, the InvoiceSettled event) and whether it agrees. */
  vault?: ReturnType<typeof vaultPart> | { address: string; invoiceKey: string; settled: false };
}

const DO_NOT_PAY = 'Do NOT pay this invoice again, under this id or another.';

/**
 * Not in this ledger (or no ledger at all). Without a vault, only "this agent never paid it". With a vault, the chain
 * answers: settled (paid_verified / pending / mismatch, from the vault alone) or not settled by this vault.
 */
async function unknownToLedger(chain: ChainConfig, mandate: Mandate, invoiceId: string, network: Inquiry['network'], why: string): Promise<Inquiry> {
  const plain: Inquiry = { invoiceId, state: 'unknown_invoice', network, answer: `${why}: this agent never received or paid it.`, next: 'Check the invoice id exactly as written (case-sensitive). The agent paid nothing for it; whether anyone else did is not in this ledger.' };
  if (!chain.vault) return plain;
  try {
    await assertNodeChain(chain);
    const fromVault = await answerFromVault(chain, mandate, invoiceId, { invoiceId, network });
    if (fromVault) return fromVault;
    const s = await settlementOf(chain, invoiceId);
    // Not settled for this agent's vendor: was the same id settled for ANOTHER vendor this vault has had?
    const any = await findSettlement(chain, invoiceId);
    if (any.settled) {
      return {
        ...plain, vault: { address: chain.vault, invoiceKey: s.key, settled: false },
        answer: `${why}. The vault has no settlement of "${invoiceId}" for vendor "${chain.vaultVendorId}", but it HAS one under the same id for vendor "${any.vendorId}" (${formatUnits6(any.amount)} tUSD8, block ${any.blockNumber}).`,
        next: `${DO_NOT_PAY} Check which vendor this invoice belongs to: the vault keeps one settlement per (invoice id, vendor).`,
      };
    }
    return {
      ...plain, vault: { address: chain.vault, invoiceKey: s.key, settled: false },
      answer: `${why}, and the vault ${chain.vault} has NO settlement for it under any vendor it has had: it was not paid through this vault.`,
      next: 'Check the invoice id exactly as written (case-sensitive) and the vault address. A payment still in the mempool is not settled yet: if one was sent, ask again later before paying.',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    return { invoiceId, network, state: 'cannot_verify_now', error: msg.slice(0, 300), answer: `${why}, and the vault could not be read right now.`, next: `${DO_NOT_PAY} Ask again once the RPC answers: the vault knows whether it settled this invoice.` };
  }
}

export async function inquireInvoice(chain: ChainConfig, mandate: Mandate, ledgerPath: string, invoiceId: string): Promise<Inquiry> {
  const network = { chainId: chain.chainId, rpcUrl: chain.rpcUrl, token: chain.token, confirmationRule: describeRule(ruleFor(chain)), ...(chain.vault ? { vault: chain.vault } : {}) };
  if (!existsSync(ledgerPath)) {
    if (chain.vault) return unknownToLedger(chain, mandate, invoiceId, network, `There is no ledger at ${ledgerPath}, so invoice ${invoiceId} is not known to this agent's ledger`);
    return { invoiceId, state: 'unknown_invoice', network, answer: `There is no ledger at ${ledgerPath}, so invoice ${invoiceId} is not known to this agent.`, next: 'Check INVOICE_LEDGER points at the agent\'s ledger. An unknown invoice was never paid by THIS ledger; it says nothing about payments made elsewhere.' };
  }
  const ledger = new Ledger(ledgerPath, { readOnly: true });
  try {
    const row = ledger.get(invoiceId);
    if (!row) return await unknownToLedger(chain, mandate, invoiceId, network, `Invoice ${invoiceId} is not in this agent's ledger`);
    const led = { status: row.status, amount: `${formatUnits6(BigInt(row.amount))} tUSD8`, payTo: row.pay_to, txHash: row.tx_hash, blockNumber: row.block_number, reason: row.reason };
    const explorer = row.tx_hash ? explorerTx(chain, row.tx_hash) : undefined;
    const base = { invoiceId, network, ledger: led, ...(explorer ? { explorer } : {}) };
    // The ledger must belong to this chain, token and payer (as recorded when it was first used).
    const ctx = ledger.readContext();
    const want = { chainId: String(chain.chainId), token: chain.token.toLowerCase(), payer: mandate.payer.toLowerCase() };
    const wrong = ctx ? (Object.keys(want) as (keyof typeof want)[]).filter((k) => ctx[k] !== undefined && ctx[k] !== want[k]) : [];
    if (!ctx && row.tx_hash) {
      // A ledger that never recorded its chain, token and payer (older versions): its transactions
      // cannot be tied to this mandate, so no verdict, least of all "not paid".
      return { ...base, state: 'cannot_verify_now', error: 'the ledger has no recorded chain/token/payer context', answer: 'This ledger never recorded which chain, token and payer it was written for, so its transaction cannot be checked against this mandate.', next: `${DO_NOT_PAY} Check the original transaction ${explorer ?? row.tx_hash} by hand, or run the agent or \`ops status\` once on this ledger with the right mandate to record the context.` };
    }
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
    const source = fundsSource(chain, mandate.payer);
    const vaultInfo = v.vault ? { vault: vaultPart(v.vault) } : {};
    if (!row.tx_hash) {
      // Refused by THIS ledger, but the vault may have settled it (an earlier or other ledger, or "AlreadySettled").
      if (v.vault?.settlement.settled) {
        try {
          const fromVault = await answerFromVault(chain, mandate, invoiceId, base);
          if (fromVault) return fromVault;
        } catch (e) {
          const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
          return { ...base, ...vaultInfo, state: 'cannot_verify_now', error: msg.slice(0, 300), answer: `The vault says invoice ${invoiceId} is settled, but its transaction could not be read right now.`, next: `${DO_NOT_PAY} Ask again once the RPC answers.` };
        }
      }
      return { ...base, ...vaultInfo, state: 'not_paid', answer: `Invoice ${invoiceId} was NOT paid: it was refused (${row.rule ?? 'rule'}) and nothing was signed. ${row.reason ?? ''}`.trim(), next: row.what_to_do ?? 'A resubmission of the same invoice is judged again.' };
    }
    const chainPart = v.receipt
      ? {
          txHash: row.tx_hash, blockNumber: v.receipt.blockNumber.toString(), ...(v.blockTime ? { blockTime: v.blockTime } : {}), status: v.receipt.status,
          transfer: v.match[0] ? `${formatUnits6(v.match[0].value)} tUSD8 ${source} → ${row.pay_to} (log ${v.match[0].logIndex})` : null,
          confirmation: v.finality ? `${v.finality.detail}${v.finality.final ? ' → met' : ' → not met'}` : '',
          transfersToPayee: v.allToPayee.length, unexplained: v.unexplained.map((t) => t.txHash),
        }
      : undefined;
    const withChain = { ...base, ...(chainPart ? { chain: chainPart } : {}), ...vaultInfo };
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
        receipt: { invoiceId, chainId: chain.chainId, token: chain.token, from: source, to: row.pay_to, amount: formatUnits6(BigInt(row.amount)), txHash: row.tx_hash, blockNumber: v.receipt.blockNumber.toString(), logIndex: v.match[0]!.logIndex },
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
      answer: `The chain and the ledger disagree for ${invoiceId}: ${!v.sameAsLedger ? `the ledger says block ${row.block_number}, the chain says ${v.receipt.blockNumber}; ` : ''}${v.unexplained.length ? `${v.unexplained.length} transfer(s) to this payee are not matched to any invoice: ${v.unexplained.map((t) => t.txHash).join(', ')}; ` : ''}${v.match.length > 1 ? `the transaction carries ${v.match.length} matching transfers, expected exactly one; ` : ''}${v.vault && !v.vault.agrees ? `the vault: ${v.vault.problems.join(', ')}; ` : ''}`.replace(/; $/, ''),
      next: `${DO_NOT_PAY} The operator inspects the transactions above before anything else.`,
    };
  } finally {
    ledger.close();
  }
}
