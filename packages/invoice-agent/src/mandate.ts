/**
 * The operator's mandate: which vendor the agent may pay, to which address, in which token, up to
 * how much per invoice and per day. Written by the operator (`ops mandate`), read by the agent;
 * the agent cannot change it.
 *
 * The limit check REUSES AgentFi's spend-policy evaluator (`evaluateUsdcSpend`,
 * packages/backend/src/services/policy/usdc-spend-policy.ts, written before the challenge): the
 * mandate is mapped to an AgentFi policy row (per-payment cap, daily limit, allowed recipient,
 * allowed token). tUSD8 has 6 decimals like USDC, so its base units are the evaluator's
 * micro-USD (1 tUSD8 counted as 1 USD, a demo convention). What is new here: the vendor identity
 * check, the mapping, and the plain-language refusals.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { evaluateUsdcSpend, type UsdcSpendPolicy } from '../../backend/src/services/policy/usdc-spend-policy.js';
import { formatUnits6, toBaseUnits, type Invoice } from './invoice.js';

export interface Mandate {
  /** Chain the payments happen on (the demo: a local Anvil). */
  chainId: number;
  /** The token contract (the demo: LocalTestUSD8, NOT QDay's tUSD8). */
  token: string;
  /** The agent's paying address. */
  payer: string;
  vendor: { id: string; name: string; address: string };
  /** Most the agent may pay on ONE invoice, in tUSD8 ("10"). */
  maxPerInvoice: string;
  /** Most the agent may pay in one UTC day, in tUSD8. */
  maxPerDay: string;
  /** ISO time after which the mandate no longer authorizes anything (null: no expiry). */
  expiresAt: string | null;
  approvedBy: string;
  approvedAt: string;
}

const PLAIN_AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;

/**
 * Refuses a mandate that would silently weaken the authorization: the reused evaluator treats a
 * limit that is not a plain decimal (e.g. "1e1") as no limit, and an invalid date never expires.
 * Applied when the mandate is written and every time it is read.
 */
export function validateMandate(m: Mandate): Mandate {
  const bad = (what: string): never => {
    throw new Error(`invalid mandate: ${what}`);
  };
  if (!Number.isSafeInteger(m.chainId) || m.chainId <= 0) bad(`chainId ${JSON.stringify(m.chainId)} is not a positive integer`);
  for (const k of ['maxPerInvoice', 'maxPerDay'] as const) {
    const v = m[k];
    if (typeof v !== 'string' || !PLAIN_AMOUNT.test(v)) bad(`${k} ${JSON.stringify(v)} must be a plain decimal amount of tUSD8 such as "10" or "2.5" (at most 6 decimals)`);
    if (!/[1-9]/.test(v)) bad(`${k} must be above 0`);
  }
  if (m.expiresAt !== null && (typeof m.expiresAt !== 'string' || Number.isNaN(Date.parse(m.expiresAt)))) bad(`expiresAt ${JSON.stringify(m.expiresAt)} is not a valid date (use an ISO time, or null for no expiry)`);
  if (!m.vendor || typeof m.vendor.id !== 'string' || m.vendor.id === '') bad('vendor.id is missing');
  if (typeof m.approvedBy !== 'string' || m.approvedBy === '') bad('approvedBy is missing');
  const addr = (what: string, a: string) => {
    try {
      return getAddress(a);
    } catch {
      return bad(`${what} ${JSON.stringify(a)} is not an address`);
    }
  };
  return { ...m, token: addr('token', m.token), payer: addr('payer', m.payer), vendor: { ...m.vendor, address: addr('vendor.address', m.vendor.address) } };
}

export function loadMandate(path: string): Mandate {
  return validateMandate(JSON.parse(readFileSync(path, 'utf8')) as Mandate);
}

export function saveMandate(path: string, m: Mandate): void {
  writeFileSync(path, JSON.stringify(validateMandate(m), null, 2) + '\n');
}

/** The mandate as an AgentFi policy row, for `evaluateUsdcSpend`. */
export function mandateAsPolicy(m: Mandate): UsdcSpendPolicy {
  return {
    active: true,
    expiresAt: m.expiresAt ? new Date(m.expiresAt) : null,
    maxValuePerTxUsd: m.maxPerInvoice,
    maxDailyVolumeUsd: m.maxPerDay,
    allowedTokens: [m.token],
    allowedRecipients: [m.vendor.address],
  };
}

export type Verdict =
  | { allowed: true }
  | { allowed: false; rule: string; reason: string; whatToDo: string };

/**
 * Judges one invoice against the mandate. `spentTodayUnits` is what the agent already committed
 * today (confirmed or in flight), in token base units.
 */
export function judgeInvoice(m: Mandate, inv: Invoice, spentTodayUnits: bigint, now = new Date()): Verdict {
  if (inv.vendorId !== m.vendor.id) {
    return {
      allowed: false,
      rule: 'vendor',
      reason: `The invoice is from vendor "${inv.vendorId}", but the operator's mandate only covers "${m.vendor.id}" (${m.vendor.name}).`,
      whatToDo: 'Ask the operator to approve this vendor before the agent pays it.',
    };
  }
  const amount = toBaseUnits(inv.amount);
  const v = evaluateUsdcSpend(mandateAsPolicy(m), { amount, token: m.token, recipient: inv.payTo, spentTodayMicroUsd: spentTodayUnits, now });
  if (v.allowed) return { allowed: true };
  switch (v.rule) {
    case 'allowedRecipients':
      return {
        allowed: false,
        rule: 'payTo',
        reason: `The invoice asks to be paid to ${inv.payTo}, which is not ${m.vendor.name}'s registered address ${m.vendor.address}. A changed bank detail is the classic invoice fraud.`,
        whatToDo: `Confirm the new address with ${m.vendor.name} through a channel you already trust; only the operator can change the mandate.`,
      };
    case 'maxValuePerTxUsd':
      return {
        allowed: false,
        rule: 'maxPerInvoice',
        reason: `The invoice is for ${formatUnits6(amount)} tUSD8, above the ${m.maxPerInvoice} tUSD8 per invoice the operator approved.`,
        whatToDo: 'Ask the operator to raise the limit, then resubmit the same invoice (it is judged again); the agent will not pay part of it.',
      };
    case 'maxDailyVolume':
      return {
        allowed: false,
        rule: 'maxPerDay',
        reason: `Paying ${formatUnits6(amount)} tUSD8 would exceed the ${m.maxPerDay} tUSD8 per day the operator approved (already committed today: ${formatUnits6(spentTodayUnits)}).`,
        whatToDo: 'Resubmit the same invoice on another day (it is judged again), or ask the operator to raise the daily limit.',
      };
    case 'policyExpired':
      return { allowed: false, rule: 'expired', reason: `The operator's mandate expired at ${m.expiresAt}.`, whatToDo: 'Ask the operator to renew the mandate.' };
    default:
      return { allowed: false, rule: v.rule, reason: v.reason, whatToDo: 'Ask the operator.' };
  }
}
