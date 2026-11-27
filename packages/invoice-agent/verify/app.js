// The page's UI: reads the form (or the URL: ?vault=…&invoice=…&rpc=…&chain=…&tx=…), runs verify.js, renders the
// verdict with textContent only (nothing from the chain or the URL is ever parsed as HTML).
import { DEFAULTS, describeSimCall, rpcClient, simulateResend, units6, verifyInvoice } from './verify.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
$('vault').value = params.get('vault') ?? '';
$('invoice').value = params.get('invoice') ?? '';
$('vendor').value = params.get('vendor') ?? '';
$('tx').value = params.get('tx') ?? '';
$('rpc').value = params.get('rpc') ?? DEFAULTS.rpcUrl;
$('chain').value = params.get('chain') ?? String(DEFAULTS.chainId);
$('explorer').value = params.get('explorer') ?? DEFAULTS.explorerUrl;

const LABELS = {
  paid_verified: 'Paid and verified',
  pending: 'Pending: not final',
  failed: 'Failed: not paid',
  unknown_invoice: 'Not settled by this vault',
  mismatch: 'Mismatch: records disagree',
  cannot_verify_now: 'Cannot verify now',
};

function rows(dl, entries) {
  dl.replaceChildren();
  for (const [k, v] of entries) {
    if (v === undefined || v === null || v === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    dl.append(dt, dd);
  }
  dl.closest('.card').hidden = dl.childElementCount === 0;
}

function render(v) {
  $('result').hidden = false;
  const badge = $('badge');
  badge.textContent = LABELS[v.state] ?? v.state;
  badge.dataset.state = v.state;
  $('answer').textContent = v.answer;
  $('next').textContent = v.next;
  const link = v.explorer && /^https?:\/\//.test(v.explorer) ? v.explorer : undefined;
  $('explorer-link').hidden = !link;
  if (link) $('explorer-a').href = link;
  const m = v.mandate;
  rows($('mandate'), m ? [
    ['current vendor', m.vendor], ['pays only', m.payTo], ['agent', m.agent], ['operator', m.operator], ['token', m.token],
    ['cap per invoice', `${m.maxPerInvoice} tUSD8`], ['daily limit', `${m.maxPerDay} tUSD8 (UTC day)`],
    ['expires', m.expiresAt ? new Date(m.expiresAt * 1000).toISOString() : 'not set'], ['paused', m.paused ? 'YES' : 'no'],
  ] : []);
  const s = v.settlement;
  rows($('settlement'), s ? [['settled', s.settled ? 'yes' : 'no'], ...(s.settled ? [['vendor', s.vendor], ['amount', `${s.amount} tUSD8`], ['block', s.blockNumber], ['agent', s.agent]] : []), ['invoice key', s.invoiceKey]] : []);
  const e = v.event, t = v.transfer;
  rows($('transfer'), [
    ...(e ? [['transaction', e.txHash], ['event', `InvoiceSettled, log ${e.logIndex}`], ['payee', e.payTo]] : []),
    ...(t ? [['transfer', `${t.amount} tUSD8 vault → payee, log ${t.logIndex}`]] : []),
  ]);
  const f = v.finality;
  rows($('finality'), f ? [['rule', 'finalized (the block is at or below the node\'s finalized block)'], ['block', f.block], ['block time', f.blockTime], ['finalized block', f.finalizedBlock], ['head', f.head], ['canonical', f.canonical ? 'yes' : 'NO']] : []);
  checkList($('checks'), v.checks);
  // A new receipt: any earlier simulation is cleared; the button is offered only for a paid_verified receipt.
  $('resend-result').hidden = true;
  const offered = v.state === 'paid_verified';
  $('resend-go').hidden = !offered;
  $('resend-why').hidden = offered;
  $('resend-why').textContent = offered ? '' : `Available once the receipt is paid_verified; this one is ${v.state}, so there is no settlement to try again.`;
}

function checkList(ul, checks) {
  ul.replaceChildren(...checks.map((c) => {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : 'bad';
    li.textContent = `${c.ok ? '✓' : '✗'} ${c.what}`;
    return li;
  }));
}

const RESEND_LABELS = {
  proven: 'Second payment refused by the vault',
  inconclusive: 'Inconclusive: not a proof',
  unavailable: 'Simulation unavailable',
  not_available: 'Not available',
};

function renderResend(s, rpcUrl) {
  $('resend-result').hidden = false;
  const badge = $('resend-badge');
  badge.textContent = RESEND_LABELS[s.state] ?? s.state;
  badge.dataset.state = `resend_${s.state}`;
  $('resend-answer').textContent = s.answer;
  const c = s.call, q = s.query, ctl = s.control;
  rows($('resend-facts'), [
    ['settlement block', s.settlementBlock !== undefined ? `${s.settlementBlock} (from the verified receipt above)` : undefined],
    ['simulated call', c ? `payInvoice("${c.args.invoiceId}", vendor "${c.args.vendorId}", payee ${c.args.payTo}, ${units6(BigInt(c.args.amountUnits))} tUSD8) from the agent ${c.from}` : undefined],
    ['queried block', q ? `${q.block} (${q.blockTime})` : undefined],
    ['why this block', q?.chosenBecause],
    ['answer from', q ? `eth_call to the vault ${c.to} on ${rpcUrl} at block ${q.block}: read-only, simulated, nothing sent` : undefined],
    ['vault\'s answer', s.result ? `the call ${describeSimCall(s.result)}` : undefined],
    ['control', ctl ? `${ctl.summary}${ctl.blockTime ? ` (block time ${ctl.blockTime})` : ''}` : undefined],
  ]);
  checkList($('resend-checks'), s.checks);
}

// Busy state uses aria-disabled, not `disabled`: a disabled button loses focus (it falls to <body>), so a keyboard
// user who pressed Enter on it would be thrown back to the top of the page. Re-submits while busy are ignored.
// #status is a role="status" region that is in the DOM from the start (a live region revealed already filled may not
// be announced). It is emptied when a check starts (the busy button label already says "Reading the chain…") and then
// gets a one-line summary, so every check, even a repeat with the same result, is a new addition to announce.
let busy = false;
// The receipt the resend simulation runs against: the last completed check and the RPC it was read from (not the
// form's current values, which may have been edited since). `generation` drops a simulation that finishes after a
// newer check started.
let last;
let generation = 0;

async function run() {
  if (busy) return;
  busy = true;
  generation++;
  last = undefined;
  $('resend-result').hidden = true;
  const button = $('go');
  button.setAttribute('aria-disabled', 'true');
  button.textContent = 'Reading the chain…';
  $('status').textContent = '';
  try {
    const chain = $('chain').value.trim();
    const rpcUrl = $('rpc').value.trim();
    const v = await verifyInvoice({
      rpc: rpcClient(rpcUrl),
      vault: $('vault').value.trim(),
      invoiceId: $('invoice').value.trim(),
      ...($('vendor').value.trim() ? { vendorId: $('vendor').value.trim() } : {}),
      ...(chain ? { chainId: Number(chain) } : {}),
      explorerUrl: $('explorer').value.trim(),
      ...($('tx').value.trim() ? { txHash: $('tx').value.trim() } : {}),
    });
    render(v);
    last = { verdict: v, rpcUrl };
    document.body.dataset.state = v.state;
    const label = LABELS[v.state] ?? v.state;
    $('status').textContent = v.answer.startsWith(label) ? v.answer : `${label}: ${v.answer}`;
  } catch (err) {
    $('status').textContent = 'The check did not complete. Do not pay again before the original transaction is checked.';
    throw err;
  } finally {
    busy = false;
    button.removeAttribute('aria-disabled');
    button.textContent = 'Check on-chain';
  }
}

// The resend simulation: the same busy pattern as the check (aria-disabled, focus stays on the button, #status
// emptied then given a one-line summary). Ignored while a check or another simulation runs.
let simulating = false;

async function resend() {
  if (simulating || busy || !last || last.verdict.state !== 'paid_verified') return;
  simulating = true;
  const gen = generation;
  const { verdict, rpcUrl } = last;
  const button = $('resend-go');
  button.setAttribute('aria-disabled', 'true');
  button.textContent = 'Simulating…';
  $('status').textContent = '';
  try {
    const s = await simulateResend({ rpc: rpcClient(rpcUrl), verdict });
    if (gen !== generation) return; // a newer check replaced the receipt
    renderResend(s, rpcUrl);
    $('status').textContent = `${RESEND_LABELS[s.state] ?? s.state}: ${s.answer}`;
  } catch (err) {
    if (gen === generation) $('status').textContent = 'The simulation did not complete: this says nothing either way.';
    throw err;
  } finally {
    simulating = false;
    button.removeAttribute('aria-disabled');
    button.textContent = 'Simulate a resend after the payment';
  }
}

$('resend-go').addEventListener('click', () => {
  resend();
});
$('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  run();
});
if ($('vault').value && $('invoice').value) run();
