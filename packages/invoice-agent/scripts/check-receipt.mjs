// npm run receipt:check -- --receipt <file.json> --expect <expected.json> [--rpc <url>]
// Read-only: can I mark MY invoice paid with this receipt? No wallet, no key, nothing is sent.
// <expected.json> is YOUR record of the invoice (never copied from the receipt):
//   { "chainId": 44005, "vault": "0x…", "token": "0x…", "invoiceId": "…", "vendorId": "…", "payee": "0x…", "amountUnits": "1000000" }
// Exit code: 0 settle, 2 reject (divergent, not_paid, mismatch, invalid), 3 retry (pending, inconclusive).
import { readFileSync } from 'node:fs';
import { checkReceipt } from '../verify/receipt.js';
import { DEFAULTS, rpcClient } from '../verify/verify.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`cannot read ${what} ${path}: ${e.message}`);
    process.exit(2);
  }
};

const receiptPath = arg('receipt');
const expectPath = arg('expect');
if (!receiptPath || !expectPath) {
  console.error('usage: npm run receipt:check -- --receipt <file.json> --expect <expected.json> [--rpc <url>]');
  process.exit(2);
}
const rpcUrl = arg('rpc') ?? DEFAULTS.rpcUrl;
const result = await checkReceipt({ rpc: rpcClient(rpcUrl), receipt: readJson(receiptPath, 'receipt'), expected: readJson(expectPath, 'expected record') });
console.log(`${result.state.toUpperCase()} (decision: ${result.decision}) via ${rpcUrl}`);
console.log(result.answer);
for (const c of result.checks) console.log(`  ${c.ok ? 'ok ' : 'BAD'} ${c.what}`);
if (result.differences) for (const d of result.differences) console.log(`  differs: ${d.field}: expected ${d.expected}, ${d.chain !== undefined ? `chain ${d.chain}` : `receipt ${d.receipt}`}`);
process.exitCode = result.decision === 'settle' ? 0 : result.decision === 'retry' ? 3 : 2; // not process.exit(): see ap.mjs
