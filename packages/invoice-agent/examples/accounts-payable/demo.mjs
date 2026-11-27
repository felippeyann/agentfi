// npm run ap:demo: the accounts-payable example end to end, each step a SEPARATE process (a restart between steps).
// The positive case is the real public payment of invoice QDAY-2026-11-24-001 on QDay Aevum Testnet, checked
// read-only against the public RPC. The negative cases are local copies of the receipt and a simulated outage.
// Nothing is signed or sent. State: examples/accounts-payable/.state (and .state-concurrency), recreated each run.
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
const COPIES = join(STATE, 'copies');

/** Runs `node ap.mjs …` as its own process; resolves with its exit code and parsed RESULT line. */
function ap(args, env = {}, state = STATE) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(HERE, 'ap.mjs'), ...args], { env: { ...process.env, AP_STATE: state, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      done({ code, result: line ? JSON.parse(line.slice(7)) : undefined, err: err.trim(), pid: p.pid });
    });
  });
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
const paidCount = async (state = STATE) => (await ap(['status'], {}, state)).result?.settlements;

rmSync(STATE, { recursive: true, force: true });
rmSync(STATE2, { recursive: true, force: true });
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

step('The network is down when the receipt arrives (simulated outage)', await ap(['deliver', 'AP-2026-0001', RECEIPT], { AP_RPC_DOWN: '1' }),
  (r) => r.code === 3 && r.result?.outcome === 'queued' && r.result.state === 'inconclusive');
const duringOutage = await paidCount();
console.log(`   Marks in the ledger during the outage: ${duringOutage} (expected 0); the delivery waits in the queue.`);
if (duringOutage !== 0) failures.push('an invoice was marked paid during the outage');

const first = step('The network is back: retry the queued delivery (first and only mark)', await ap(['retry']),
  (r) => r.code === 0 && r.result?.results?.[0]?.outcome === 'settled');
if (first.results?.[0]?.outcome === 'queued') {
  console.error('\nThe RPC did not answer: nothing is concluded. Run the demo again later.');
  process.exit(3);
}

step('Restart, then the same receipt is delivered again', await ap(['deliver', 'AP-2026-0001', RECEIPT]),
  (r) => r.code === 0 && r.result?.outcome === 'already_settled');

step('The valid receipt of invoice -001 delivered for invoice AP-2026-0002 (-002)', await ap(['deliver', 'AP-2026-0002', RECEIPT]),
  (r) => r.code === 2 && r.result?.state === 'divergent' && r.result.differences?.some((d) => d.field === 'invoice.id'));

step('A copy that claims another vault (and invoice -002)', await ap(['deliver', 'AP-2026-0002', otherVault]),
  (r) => r.code === 2 && r.result?.state === 'divergent' && r.result.differences?.some((d) => d.field === 'vault'));

step('A copy edited to claim invoice -002 (matches the books, not the chain)', await ap(['deliver', 'AP-2026-0002', forged]),
  (r) => r.code === 2 && r.result?.state === 'not_paid');

const paid = await paidCount();
console.log(`\n   Marks in the ledger: ${paid} (expected 1)`);
if (paid !== 1) failures.push(`expected 1 mark, found ${paid}`);

// Two processes deliver the same receipt at the same time, on a fresh state.
await ap(['init'], {}, STATE2);
const [a, b] = await Promise.all([ap(['deliver', 'AP-2026-0001', RECEIPT], {}, STATE2), ap(['deliver', 'AP-2026-0001', RECEIPT], {}, STATE2)]);
const outcomes = [a.result?.outcome, b.result?.outcome].sort();
n++;
console.log(`\n${n}. Two processes deliver the same receipt at the same time (fresh state)`);
console.log(`   process ${a.pid}: ${a.result?.outcome}; process ${b.pid}: ${b.result?.outcome}`);
const paid2 = await paidCount(STATE2);
console.log(`   Marks in that ledger: ${paid2} (expected 1)`);
const concOk = outcomes[0] === 'already_settled' && outcomes[1] === 'settled' && paid2 === 1;
console.log(`   ${concOk ? 'as expected' : 'NOT AS EXPECTED'}`);
if (!concOk) failures.push('concurrent deliveries');

const s = (await ap(['status'])).result;
console.log(`\nFinal books (${STATE}):`);
for (const [ref, v] of Object.entries(s.invoices)) console.log(`   ${ref}: ${v.status}${v.txHash ? ` (tx ${v.txHash}, block ${v.blockNumber})` : ''}`);
console.log(`   Audit log: ${join(STATE, 'events.jsonl')}`);

if (failures.length) {
  console.error(`\nFAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nEvery step behaved as expected: one mark for one payment, kept across restarts and concurrent deliveries; divergent receipts and an outage marked nothing.');
