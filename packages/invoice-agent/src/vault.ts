/**
 * The on-chain vault (contracts/src/InvoiceMandate.sol), used when the operator's mandate names one
 * (`mandate.vault`). The agent then pays with `vault.payInvoice(invoiceId, amount)` instead of
 * `token.transfer(payTo, amount)`: the money leaves the VAULT (funded by the operator), the agent key only
 * signs and pays gas, and the chain itself refuses a second settlement of the same invoice
 * (`AlreadySettled`), whatever the ledger says.
 *
 * Everything here reads; nothing signs.
 */
import { BaseError, decodeErrorResult, encodeAbiParameters, getAddress, hexToString, keccak256, parseEventLogs, stringToHex, type Hex, type TransactionReceipt } from 'viem';
import { publicClientFor, scanPages, type ChainConfig } from './chain.js';
import { INVOICE_MANDATE_ABI } from './generated/invoice-mandate.js';
import { formatUnits6, type Invoice } from './invoice.js';
import type { Mandate } from './mandate.js';

export const VAULT_ABI = INVOICE_MANDATE_ABI;

/** The vendor id as the vault stores it: its ASCII bytes, left-aligned in a bytes32 ("acme" → 0x61636d65…00). */
export function vendorKey(vendorId: string): Hex {
  if (!/^[\x21-\x7e]{1,32}$/.test(vendorId)) throw new Error(`vendor id ${JSON.stringify(vendorId)} must be 1-32 printable ASCII characters to be named in the vault`);
  return stringToHex(vendorId, { size: 32 });
}

export function vendorIdOf(key: Hex): string {
  return hexToString(key, { size: 32 }).replace(/\0+$/, '');
}

export interface OnChainMandate {
  vault: string;
  token: string;
  operator: string;
  agent: string;
  expiresAt: bigint;
  paused: boolean;
  payTo: string;
  maxPerInvoice: bigint;
  maxPerDay: bigint;
  vendor: Hex;
  vendorId: string;
  balance: bigint;
}

export async function readVault(cfg: ChainConfig): Promise<OnChainMandate> {
  const client = publicClientFor(cfg);
  const address = getAddress(cfg.vault!);
  const read = <T>(functionName: 'token' | 'operator' | 'mandate') => client.readContract({ address, abi: VAULT_ABI, functionName }) as Promise<T>;
  const [token, operator, m] = await Promise.all([read<string>('token'), read<string>('operator'), read<readonly [string, number, boolean, string, number, number, Hex]>('mandate')]);
  const balance = (await client.readContract({ address: getAddress(token), abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'balanceOf', args: [address] })) as bigint;
  return {
    vault: address, token: getAddress(token), operator: getAddress(operator), agent: getAddress(m[0]), expiresAt: BigInt(m[1]), paused: m[2],
    payTo: getAddress(m[3]), maxPerInvoice: BigInt(m[4]), maxPerDay: BigInt(m[5]), vendor: m[6], vendorId: vendorIdOf(m[6]), balance,
  };
}

/**
 * The agent's mandate file and the vault must name the same token, agent, vendor and payee: otherwise the agent would
 * judge invoices against rules the chain does not enforce (or the reverse). Returns the differences (empty: they agree).
 * The limits and the expiry are reported, not required to match: the chain enforces its own, and refuses above them.
 */
export function compareMandates(off: Mandate, on: OnChainMandate): { mismatches: string[]; notes: string[] } {
  const mismatches: string[] = [];
  if (on.token !== getAddress(off.token)) mismatches.push(`token: the vault holds ${on.token}, the mandate says ${off.token}`);
  if (on.agent !== getAddress(off.payer)) mismatches.push(on.agent === '0x0000000000000000000000000000000000000000' ? 'agent: the vault has no agent (revoked or never set)' : `agent: the vault's agent is ${on.agent}, the mandate's payer is ${off.payer}`);
  if (on.payTo !== getAddress(off.vendor.address)) mismatches.push(`payTo: the vault pays ${on.payTo}, the mandate registers ${off.vendor.address}`);
  if (on.vendor !== vendorKey(off.vendor.id)) mismatches.push(`vendor: the vault names "${on.vendorId}", the mandate "${off.vendor.id}"`);
  const notes = [
    `on-chain limits: ≤ ${formatUnits6(on.maxPerInvoice)} tUSD8 per invoice, ≤ ${formatUnits6(on.maxPerDay)} per UTC day, until ${new Date(Number(on.expiresAt) * 1000).toISOString()}${on.paused ? ', PAUSED' : ''}; vault balance ${formatUnits6(on.balance)} tUSD8`,
  ];
  return { mismatches, notes };
}

/** Throws when the mandate file and the vault disagree (the agent refuses to start). */
export async function assertVaultMatches(cfg: ChainConfig, off: Mandate): Promise<OnChainMandate> {
  const on = await readVault(cfg);
  const { mismatches } = compareMandates(off, on);
  if (mismatches.length) throw new Error(`the mandate and the vault ${cfg.vault} disagree: ${mismatches.join('; ')}`);
  return on;
}

export interface SettlementRecord {
  settled: boolean;
  amount: bigint;
  blockNumber: bigint;
  agent: string;
  key: Hex;
}

/** The vault's idempotency key: keccak256(abi.encode(invoiceId, vendor)). */
export function invoiceKeyOf(invoiceId: string, vendorId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], [invoiceId, vendorKey(vendorId)]));
}

/**
 * `settlementOf(invoiceId, vendor)`: "was it paid?" straight from the chain, for the vendor the agent pays
 * (`cfg.vaultVendorId`, or `vendorId`). Never the vault's "current" vendor: a vendor change must not hide a payment.
 */
export async function settlementOf(cfg: ChainConfig, invoiceId: string, vendorId = cfg.vaultVendorId): Promise<SettlementRecord> {
  if (!vendorId) throw new Error('settlementOf needs the vendor id');
  const [settled, amount, blockNumber, agent, key] = (await publicClientFor(cfg).readContract({
    address: getAddress(cfg.vault!), abi: VAULT_ABI, functionName: 'settlementOf', args: [invoiceId, vendorKey(vendorId)],
  })) as readonly [boolean, bigint, bigint, string, Hex];
  return { settled, amount, blockNumber, agent: getAddress(agent), key };
}

/** `findSettlement(invoiceId)`: the id looked up for EVERY vendor the vault has had (newest first). */
export async function findSettlement(cfg: ChainConfig, invoiceId: string): Promise<SettlementRecord & { vendor: Hex; vendorId: string }> {
  const [settled, vendor, amount, blockNumber, agent, key] = (await publicClientFor(cfg).readContract({
    address: getAddress(cfg.vault!), abi: VAULT_ABI, functionName: 'findSettlement', args: [invoiceId],
  })) as readonly [boolean, Hex, bigint, bigint, string, Hex];
  return { settled, vendor, vendorId: settled ? vendorIdOf(vendor) : '', amount, blockNumber, agent: getAddress(agent), key };
}

export interface SettledEvent {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  invoiceKey: Hex;
  invoiceId: string;
  vendor: Hex;
  payTo: string;
  amount: bigint;
  agent: string;
}

function toSettled(l: { transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null; args: { invoiceKey?: Hex; invoiceId?: string; vendor?: Hex; payTo?: string; amount?: bigint; agent?: string } }): SettledEvent {
  return {
    txHash: l.transactionHash!, blockNumber: l.blockNumber!, logIndex: l.logIndex!, invoiceKey: l.args.invoiceKey!, invoiceId: l.args.invoiceId!,
    vendor: l.args.vendor!, payTo: getAddress(l.args.payTo!), amount: l.args.amount!, agent: getAddress(l.args.agent!),
  };
}

/** The vault's InvoiceSettled events in a receipt. */
export function settledEventsIn(cfg: ChainConfig, receipt: TransactionReceipt): SettledEvent[] {
  const logs = receipt.logs.filter((l) => getAddress(l.address) === getAddress(cfg.vault!));
  return parseEventLogs({ abi: VAULT_ABI, eventName: 'InvoiceSettled', logs }).map(toSettled);
}

/** The InvoiceSettled event with this key (its indexed topic), searched from the newest page back to `cfg.logsFromBlock`. */
export async function findSettledEvent(cfg: ChainConfig, key: Hex, atBlock?: bigint): Promise<SettledEvent | undefined> {
  const client = publicClientFor(cfg);
  const address = getAddress(cfg.vault!);
  const from = cfg.logsFromBlock ?? 0n;
  if (atBlock !== undefined) {
    const logs = await client.getContractEvents({ address, abi: VAULT_ABI, eventName: 'InvoiceSettled', args: { invoiceKey: key }, fromBlock: atBlock, toBlock: atBlock });
    return logs[0] ? toSettled(logs[0] as never) : undefined;
  }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const found = await scanPages('the InvoiceSettled event', from, head, (start, end) => client.getContractEvents({ address, abi: VAULT_ABI, eventName: 'InvoiceSettled', args: { invoiceKey: key }, fromBlock: start, toBlock: end }), { newestFirst: true, stopAt: (got) => got.length > 0 });
  return found.length ? toSettled(found[found.length - 1] as never) : undefined;
}

/** Every InvoiceSettled event of the vault since `cfg.logsFromBlock` (the operator's independent count), oldest first. */
export async function settledEventsSince(cfg: ChainConfig): Promise<SettledEvent[]> {
  const client = publicClientFor(cfg);
  const address = getAddress(cfg.vault!);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const logs = await scanPages(`the vault's InvoiceSettled events`, cfg.logsFromBlock ?? 0n, head, (start, end) => client.getContractEvents({ address, abi: VAULT_ABI, eventName: 'InvoiceSettled', fromBlock: start, toBlock: end }));
  return logs.map((l) => toSettled(l as never));
}

/** A vault custom error decoded from a failed call or gas estimate, or undefined when it is not one. */
export function vaultErrorOf(e: unknown): { name: string; args: readonly unknown[] } | undefined {
  if (!(e instanceof BaseError)) return undefined;
  let data: Hex | undefined;
  e.walk((c) => {
    const d = (c as { data?: unknown }).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) data = d as Hex;
    else if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') data = (d as { data: Hex }).data;
    return false;
  });
  if (!data) {
    const m = /(0x[0-9a-fA-F]{8,})/.exec((e as BaseError).details ?? '');
    if (m) data = m[1] as Hex;
  }
  if (!data) return undefined;
  try {
    const r = decodeErrorResult({ abi: VAULT_ABI, data });
    return { name: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return undefined;
  }
}

/** Thrown BEFORE signing when the vault would revert the payment (its gas estimate reverts): nothing was signed or sent. */
export class VaultRefusalError extends Error {
  constructor(public errorName: string, public args: readonly unknown[]) {
    super(`the vault refuses this payment (${errorName}): not signed, not sent`);
  }
}

/** The refusal in plain language, with what to do. */
export function explainVaultRefusal(e: VaultRefusalError, inv: Invoice): { rule: string; reason: string; whatToDo: string } {
  const a = e.args;
  const units = (v: unknown) => formatUnits6(BigInt(v as bigint));
  switch (e.errorName) {
    case 'AlreadySettled':
      return {
        rule: 'vault:AlreadySettled',
        reason: `The vault has ALREADY settled invoice ${inv.id} for this vendor (block ${a[1]}, key ${a[0]}): the chain refuses a second settlement. This agent's ledger did not know it (a new or different ledger?).`,
        whatToDo: `Do NOT pay this invoice again, under this id or another. Check it with: npm run ops -- ask ${inv.id} (it reads settlementOf on the vault).`,
      };
    case 'MandatePaused':
      return { rule: 'vault:MandatePaused', reason: 'The operator has paused the vault: it pays nothing until unpaused.', whatToDo: 'Ask the operator; resubmit the same invoice once the vault is unpaused (it is judged again).' };
    case 'NotAgent':
      return { rule: 'vault:NotAgent', reason: "This agent's key is not the vault's agent (revoked, or another key was named).", whatToDo: 'Ask the operator to name this agent in the vault (setMandate) or to use the agent it names.' };
    case 'MandateChanged':
      return {
        rule: 'vault:MandateChanged',
        reason: `The vault's mandate now names vendor "${vendorIdOf(a[0] as Hex)}" paid at ${String(a[1])}; this agent judged the invoice for vendor "${inv.vendorId}" paid at ${inv.payTo}. The vault refuses to pay a vendor the agent did not judge.`,
        whatToDo: "The operator changed the on-chain mandate: update the agent's mandate file to match the vault (the agent refuses to start while they differ), then resubmit.",
      };
    case 'MandateExpired':
      return { rule: 'vault:MandateExpired', reason: 'The on-chain mandate has expired.', whatToDo: 'Ask the operator to renew it (setMandate with a new expiry).' };
    case 'AboveInvoiceCap':
      return { rule: 'vault:AboveInvoiceCap', reason: `The vault caps one invoice at ${units(a[1])} tUSD8; this one is ${units(a[0])}.`, whatToDo: 'Ask the operator to raise the on-chain cap; the agent will not pay part of it.' };
    case 'AboveDailyLimit':
      return { rule: 'vault:AboveDailyLimit', reason: `The vault's daily limit is ${units(a[2])} tUSD8 and ${units(a[0])} was already paid today (UTC); this invoice is ${units(a[1])}.`, whatToDo: 'Resubmit the same invoice on another UTC day (it is judged again), or ask the operator to raise the limit.' };
    default:
      return { rule: `vault:${e.errorName}`, reason: `The vault refuses this payment (${e.errorName}${a.length ? ` ${a.map(String).join(', ')}` : ''}). Nothing was signed.`, whatToDo: 'Ask the operator (the vault balance, the mandate on-chain).' };
  }
}
