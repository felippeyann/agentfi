// The page's UI: reads the form (or the URL: ?vault=…&invoice=…&rpc=…&chain=…&tx=…), runs verify.js, renders the
// verdict with textContent only (nothing from the chain or the URL is ever parsed as HTML).
import { DEFAULTS, rpcClient, verifyInvoice } from './verify.js';

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
  const ul = $('checks');
  ul.replaceChildren(...v.checks.map((c) => {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : 'bad';
    li.textContent = `${c.ok ? '✓' : '✗'} ${c.what}`;
    return li;
  }));
}

// Busy state uses aria-disabled, not `disabled`: a disabled button loses focus (it falls to <body>), so a keyboard
// user who pressed Enter on it would be thrown back to the top of the page. Re-submits while busy are ignored.
// #status is a role="status" region that is in the DOM from the start (a live region revealed already filled may not
// be announced); it gets "Reading the chain…" and then a one-line summary, so every check, even a repeat, changes it.
let busy = false;

async function run() {
  if (busy) return;
  busy = true;
  const button = $('go');
  button.setAttribute('aria-disabled', 'true');
  button.textContent = 'Reading the chain…';
  $('status').textContent = 'Reading the chain…';
  try {
    const chain = $('chain').value.trim();
    const v = await verifyInvoice({
      rpc: rpcClient($('rpc').value.trim()),
      vault: $('vault').value.trim(),
      invoiceId: $('invoice').value.trim(),
      ...($('vendor').value.trim() ? { vendorId: $('vendor').value.trim() } : {}),
      ...(chain ? { chainId: Number(chain) } : {}),
      explorerUrl: $('explorer').value.trim(),
      ...($('tx').value.trim() ? { txHash: $('tx').value.trim() } : {}),
    });
    render(v);
    document.body.dataset.state = v.state;
    const label = LABELS[v.state] ?? v.state;
    $('status').textContent = v.answer.startsWith(label) ? v.answer : `${label}: ${v.answer}`;
  } finally {
    busy = false;
    button.removeAttribute('aria-disabled');
    button.textContent = 'Check on-chain';
  }
}

$('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  run();
});
if ($('vault').value && $('invoice').value) run();
