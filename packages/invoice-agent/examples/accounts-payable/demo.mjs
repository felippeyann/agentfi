// npm run ap:demo: the accounts-payable example end to end, each step a SEPARATE process (a restart between steps).
// The positive case is the real public payment of invoice QDAY-2026-11-24-001 on QDay Aevum Testnet, checked
// read-only against the public RPC. The negative cases are local copies of the receipt and a simulated outage.
// Nothing is signed or sent. State: examples/accounts-payable/.state (and .state-concurrency), recreated each run.
// If the public RPC does not answer (a real outage, not the simulated one), the demo stops with exit 3: run it again.
//
// Environment: AP_RPC overrides the RPC, AP_BOOKS the books, AP_RECEIPT the receipt file, AP_DEMO_DIR where the two
// state directories go (the tests run the same demo against a local chain).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.AP_DEMO_DIR ?? HERE;
const STATE = join(BASE, '.state');
const STATE2 = join(BASE, '.state-concurrency');
const RECEIPT = process.env.AP_RECEIPT ?? join(HERE, 'receipts', 'QDAY-2026-11-24-001.json');
const COPIES = join(BASE, '.state-copies');

/** Runs `node ap.mjs …` as its own process; resolves with its exit code and parsed RESULT line. */
function ap(args, env = {}, state = STATE) {
  return new Promise((done) => {
    // No backoff in the demo (AP_RETRY_BASE_S=0): `retry` re-checks at once. The attempt cap is the example's default
    // unless a step sets it.
    const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', join(HERE, 'ap.mjs'), ...args], { env: { ...process.env, AP_RETRY_BASE_S: '0', AP_STATE: state, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      done({ code, result: line ? JSON.parse(line.slice(7)) : undefined, err: err.trim(), pid: p.pid });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpcGaveUp() {
  console.error('\nThe RPC did not answer after several tries: nothing is concluded (the delivery stays in the inbox). Run the demo again later.');
  process.exit(3);
}
/** A step that needs the RPC: exit 3 (left in the inbox) is a real outage, not the demo's; try `retry` a few times. */
async function withRpc(first, state = STATE) {
  let r = first;
  for (let i = 0; r.code === 3 && i < 3; i++) {
    await sleep(3000);
    const again = await ap(['retry'], {}, state);
    r = { ...again, result: again.result?.results?.[0] ?? again.result };
  }
  if (r.code === 3) rpcGaveUp();
  return r;
}

const failures = [];
let n = 0;
function step(title, r, expect) {
  n++;
  const got = r.result ?? { outcome: 'error', answer: r.err };
  const okay = expect(r);
  console.log(`\n${n}. ${title}`);
  console.log(`   process ${r.pid}, exit ${r.code}: ${got.outcome}${got.state ? ` (${got.state})` : ''}`);
  if (got.answer) console.log(`   ${got.answer}`);
  for (const x of got.results ?? []) console.log(`   ${x.ref}: ${x.outcome} (${x.state}). ${x.answer}`);
  console.log(`   ${okay ? 'as expected' : 'NOT AS EXPECTED'}`);
  if (!okay) failures.push(title);
  return got;
}
const status = async (state = STATE) => (await ap(['status'], {}, state)).result;

for (const d of [STATE, STATE2, COPIES]) rmSync(d, { recursive: true, force: true });
console.log('Accounts-payable example: can this system mark its own invoice paid from a receipt?');
console.log(`Receipt: ${RECEIPT}`);
console.log(`Books (the system's own expected data): ${process.env.AP_BOOKS ?? join(HERE, 'books.json')}`);
console.log(`RPC: ${process.env.AP_RPC ?? 'https://rpc-test.qday.info (public, read-only)'}`);

const init = await ap(['init']);
if (init.code !== 0) {
  console.error(init.err);
  process.exit(1);
}

// Local copies for the negative cases (the original file is never modified).
mkdirSync(COPIES, { recursive: true });
const original = JSON.parse(readFileSync(RECEIPT, 'utf8'));
const copy = (name, edit) => {
  const r = structuredClone(original);
  edit(r);
  const f = join(COPIES, name);
  writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
  return f;
};
const otherVault = copy('other-vault.json', (r) => {
  r.vault = '0x000000000000000000000000000000000000dEaD';
  r.invoice.id = 'QDAY-2026-11-24-002';
});
const forged = copy('forged-invoice-id.json', (r) => {
  r.invoice.id = 'QDAY-2026-11-24-002';
});
const otherBlock = copy('forged-other-block.json', (r) => {
  r.invoice.id = 'QDAY-2026-11-24-002';
  r.payment.blockNumber += 1;
});
const futureBlock = copy('forged-future-block.json', (r) => {
  r.invoice.id = 'QDAY-2026-11-24-002';
  r.payment.txHash = '0x' + 'f00d'.repeat(16);
  r.payment.blockNumber = 999_999_999;
});

step('The network is down when the receipt arrives (simulated outage)', await ap(['deliver', 'AP-2026-0001', RECEIPT], { AP_RPC_DOWN: '1' }),
  (r) => r.code === 3 && r.result?.outcome === 'queued' && r.result.state === 'inconclusive');
const during = await status();
console.log(`   Marks during the outage: ${during.settlements} (expected 0); deliveries waiting in the inbox: ${during.inbox.length}.`);
if (during.settlements !== 0 || during.inbox.length !== 1) failures.push('outage: expected 0 marks and 1 delivery in the inbox');

let retried = await ap(['retry']);
for (let i = 0; retried.code === 3 && i < 3; i++) {
  await sleep(3000);
  retried = await ap(['retry']);
}
if (retried.code === 3) rpcGaveUp();
step('The network is back: retry the delivery in the inbox (first and only mark)', retried,
  (r) => r.code === 0 && r.result?.results?.length === 1 && r.result.results[0].outcome === 'settled');

step('Restart, then the same receipt is delivered again (answered from the books)', await ap(['deliver', 'AP-2026-0001', RECEIPT]),
  (r) => r.code === 0 && r.result?.outcome === 'already_settled');

step('The valid receipt of invoice -001 delivered for invoice AP-2026-0002 (-002)', await ap(['deliver', 'AP-2026-0002', RECEIPT]),
  (r) => r.code === 2 && r.result?.state === 'divergent' && r.result.differences?.some((d) => d.field === 'invoice.id'));

step('A copy that claims another vault (and invoice -002)', await ap(['deliver', 'AP-2026-0002', otherVault]),
  (r) => r.code === 2 && r.result?.state === 'divergent' && r.result.differences?.some((d) => d.field === 'vault'));

step('A copy edited to claim invoice -002: its transaction exists, in the declared block, but settled -001', await withRpc(await ap(['deliver', 'AP-2026-0002', forged])),
  (r) => r.code === 2 && r.result?.state === 'not_paid');

step('A copy claiming -002 and another block: the node knows the transaction, in its real block (proven divergence)', await withRpc(await ap(['deliver', 'AP-2026-0002', otherBlock])),
  (r) => r.code === 2 && r.result?.state === 'mismatch');

// A transaction the node does not know, in a block the chain has not reached: one source cannot tell this from a node
// that is behind. No verdict, no mark, no reject: the invoice stays open, and the retry policy (cap: 2 here) parks it.
const fut1 = step('A copy claiming -002 with an unknown transaction in a future block (check 1 of 2)', await ap(['deliver', 'AP-2026-0002', futureBlock], { AP_MAX_ATTEMPTS: '2' }),
  (r) => r.code === 3 && r.result?.state === 'inconclusive' && r.result.uncertainty === 'node_behind_or_receipt_invalid');
if (fut1.outcome === 'queued' && !fut1.uncertainty) rpcGaveUp();
step('retry: still no evidence, so the delivery is parked for review (check 2 of 2)', await ap(['retry'], { AP_MAX_ATTEMPTS: '2' }),
  (r) => r.code === 4 && r.result?.results?.[0]?.outcome === 'needs_review');
step('retry again: a parked delivery is not checked again automatically', await ap(['retry'], { AP_MAX_ATTEMPTS: '2' }),
  (r) => r.code === 0 && r.result?.count === 0);

const end = await status();
const parked = end.inbox.filter((q) => q.parked);
console.log(`\n   Marks in the ledger: ${end.settlements} (expected 1); inbox: ${end.inbox.length} delivery, parked for review (expected 1); AP-2026-0002: ${end.invoices['AP-2026-0002']?.status} (expected open)`);
if (end.settlements !== 1 || end.inbox.length !== 1 || parked.length !== 1 || end.invoices['AP-2026-0002']?.status !== 'open') failures.push(`expected 1 mark, 1 parked delivery and AP-2026-0002 open; found ${end.settlements}, ${parked.length}, ${end.invoices['AP-2026-0002']?.status}`);

// Two processes deliver the same receipt at the same time, on a fresh state.
await ap(['init'], {}, STATE2);
const [a, b] = await Promise.all([ap(['deliver', 'AP-2026-0001', RECEIPT], {}, STATE2), ap(['deliver', 'AP-2026-0001', RECEIPT], {}, STATE2)]);
n++;
console.log(`\n${n}. Two processes deliver the same receipt at the same time (fresh state)`);
console.log(`   process ${a.pid}: ${a.result?.outcome}; process ${b.pid}: ${b.result?.outcome}`);
if (a.code === 3 || b.code === 3) {
  let again = await ap(['retry'], {}, STATE2);
  for (let i = 0; again.code === 3 && i < 3; i++) {
    await sleep(3000);
    again = await ap(['retry'], {}, STATE2);
  }
  if (again.code === 3) rpcGaveUp();
  console.log(`   (the RPC did not answer one of them; retry: ${again.result?.results?.map((x) => x.outcome).join(', ')})`);
}
const s2 = await status(STATE2);
console.log(`   Marks in that ledger: ${s2.settlements}, "settled" events: ${s2.settledEvents} (expected 1 and 1)`);
const concOk = s2.settlements === 1 && s2.settledEvents === 1 && s2.inbox.length === 0 && [a, b].every((x) => ['settled', 'already_settled', 'queued'].includes(x.result?.outcome));
console.log(`   ${concOk ? 'as expected' : 'NOT AS EXPECTED'}`);
if (!concOk) failures.push('concurrent deliveries');

console.log(`\nFinal books (${join(STATE, 'ap.sqlite')}):`);
for (const [ref, v] of Object.entries(end.invoices)) console.log(`   ${ref}: ${v.status}${v.txHash ? ` (tx ${v.txHash}, block ${v.blockNumber})` : ''}`);
console.log('   Audit log: the "events" table of that file (node ap.mjs status shows the books, the marks and the inbox).');

if (failures.length) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nEvery step behaved as expected: one mark for one payment, kept across restarts and concurrent deliveries; proven divergences were rejected; an outage and a receipt the node cannot confirm marked nothing and left the invoice open.');
