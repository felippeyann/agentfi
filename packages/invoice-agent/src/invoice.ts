/**
 * An invoice as the agent receives it, and the two things derived from it: its amount in token base
 * units (tUSD8 has 6 decimals) and a hash of its payable content. The invoice id is the
 * idempotency key: the same id is paid at most once. The same id with different content is a
 * conflict, never a second payment.
 */
import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'viem';

export const TOKEN_DECIMALS = 6;

export interface Invoice {
  /** Vendor's invoice number: the idempotency key. */
  id: string;
  /** Who issued it, as the operator's mandate names vendors. */
  vendorId: string;
  /** Where the vendor asks to be paid. */
  payTo: string;
  /** Decimal amount in tUSD8, at most 6 decimals ("8", "8.50"). */
  amount: string;
  currency: 'tUSD8';
  description?: string;
}

export class InvoiceError extends Error {}

/** "8.5" → 8500000n. Refuses anything that is not a plain positive decimal with ≤ 6 decimals. */
export function toBaseUnits(amount: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new InvoiceError(`amount ${JSON.stringify(amount)} is not a plain decimal with at most 6 decimals`);
  const [whole, fraction = ''] = amount.split('.');
  const units = BigInt(whole! + fraction.padEnd(TOKEN_DECIMALS, '0'));
  if (units === 0n) throw new InvoiceError('amount must be greater than zero');
  return units;
}

/** 8500000n → "8.5". */
export function formatUnits6(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Validates the shape of an incoming invoice (anything else is refused before it reaches the mandate). */
export function parseInvoice(raw: unknown): Invoice {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof o[k] !== 'string' || (o[k] as string).trim() === '') throw new InvoiceError(`invoice field "${k}" is missing`);
    return (o[k] as string).trim();
  };
  const id = str('id');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new InvoiceError('invoice id must be 1-64 characters of letters, digits, ".", "_" or "-"');
  const payTo = str('payTo');
  if (!isAddress(payTo, { strict: false })) throw new InvoiceError(`payTo ${JSON.stringify(payTo)} is not an address`);
  if (o['currency'] !== 'tUSD8') throw new InvoiceError(`currency must be "tUSD8", got ${JSON.stringify(o['currency'])}`);
  const amount = str('amount');
  toBaseUnits(amount);
  return {
    id,
    vendorId: str('vendorId'),
    payTo: getAddress(payTo),
    amount,
    currency: 'tUSD8',
    ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
  };
}

/** SHA-256 of the payable content (id, vendor, payee, amount in base units, currency): what "the same invoice" means. */
export function invoiceHash(inv: Invoice): string {
  const canonical = JSON.stringify([inv.id, inv.vendorId, inv.payTo.toLowerCase(), toBaseUnits(inv.amount).toString(), inv.currency]);
  return '0x' + createHash('sha256').update(canonical).digest('hex');
}
