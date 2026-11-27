// npm run receipt:fetch -- --vault <0x…> --invoice <id> [--vendor <id>] [--rpc <url>] [--chain <id>] [--out <file.json>]
// The same receipt the verification page's "Download receipt (JSON)" button gives, built from a read-only check of the
// chain (verify.js). Refuses unless the invoice is paid_verified. No wallet, no key, nothing is sent.
// Defaults: the public Aevum Testnet RPC and chain 44005.
import { writeFileSync } from 'node:fs';
import { buildReceipt } from '../verify/receipt.js';
import { DEFAULTS, rpcClient, verifyInvoice } from '../verify/verify.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const vault = arg('vault');
const invoiceId = arg('invoice');
if (!vault || !invoiceId) {
  console.error('usage: npm run receipt:fetch -- --vault <0x…> --invoice <id> [--vendor <id>] [--rpc <url>] [--chain <id>] [--out <file.json>]');
  process.exit(2);
}
const rpcUrl = arg('rpc') ?? DEFAULTS.rpcUrl;
const chainId = Number(arg('chain') ?? DEFAULTS.chainId);
const vendorId = arg('vendor');
const v = await verifyInvoice({ rpc: rpcClient(rpcUrl), vault, invoiceId, chainId, explorerUrl: chainId === DEFAULTS.chainId ? DEFAULTS.explorerUrl : undefined, ...(vendorId ? { vendorId } : {}) });
if (v.state !== 'paid_verified') {
  console.error(`${v.state}: ${v.answer}`);
  process.exitCode = v.state === 'cannot_verify_now' || v.state === 'pending' ? 3 : 2; // not process.exit(): see ap.mjs
} else {
  const json = JSON.stringify(buildReceipt(v, { rpcUrl }), null, 2) + '
';
  const out = arg('out');
  if (out) {
    writeFileSync(out, json);
    console.error(`receipt for ${invoiceId} written to ${out}`);
  } else {
    process.stdout.write(json);
  }
}
