/**
 * The headless agent: an HTTP endpoint that receives invoices and answers with a receipt, a
 * refusal or a pending state.
 *
 *   POST /invoices        body: an invoice (see invoice.ts) → 200 { outcome, ... }
 *   GET  /invoices/:id    the ledger row and its events
 *   GET  /health
 *
 * INVOICE_FAIL_AT=after-broadcast makes the process die right after the payment is broadcast and
 * before it answers (the "lost response"); after-sign dies after recording, before broadcasting.
 * Demo and test only.
 */
import { createServer } from 'node:http';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertNodeChain } from './chain.js';
import { loadConfig } from './config.js';
import { InvoiceError, parseInvoice } from './invoice.js';
import { acquireInstanceLock, Ledger } from './ledger.js';
import { FailPointError, InvoicePayer } from './payer.js';

const cfg = loadConfig();
if (!cfg.payerKey) throw new Error('INVOICE_PAYER_KEY is not set: the agent needs its own key to pay');
if (getAddress(privateKeyToAccount(cfg.payerKey).address) !== cfg.mandate.payer) {
  throw new Error(`INVOICE_PAYER_KEY is not the mandate's payer ${cfg.mandate.payer}`);
}
// One agent process per ledger: a second one would decide on the same invoice ids (the double payment).
let releaseLock: () => void;
try {
  releaseLock = acquireInstanceLock(cfg.ledgerPath);
} catch (e) {
  console.error(`[agent] refusing to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
const ledger = new Ledger(cfg.ledgerPath);
const payer = new InvoicePayer({ ledger, chain: cfg.chain, mandate: cfg.mandate, payerKey: cfg.payerKey, ...(cfg.failAt ? { failAt: cfg.failAt } : {}) });

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, payer: cfg.mandate.payer, chainId: cfg.chain.chainId });
    const m = /^\/invoices\/([A-Za-z0-9._-]{1,64})$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      const row = ledger.get(m[1]!);
      return row ? json(res, 200, { row, events: ledger.events(m[1]!) }) : json(res, 404, { error: 'unknown invoice' });
    }
    if (req.method === 'POST' && req.url === '/invoices') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let invoice;
      try {
        invoice = parseInvoice(JSON.parse(body));
      } catch (e) {
        return json(res, 400, { outcome: 'invalid', reason: e instanceof Error ? e.message : String(e) });
      }
      return json(res, 200, await payer.submit(invoice));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof FailPointError) {
      // Simulated crash: die without answering. The caller only sees a dropped connection.
      // A hard kill, like a crash or an OOM kill: no response, no cleanup, nothing flushed but the ledger's committed rows.
      console.error(`[agent] ${e.message}: killing the process without a response`);
      process.kill(process.pid, 'SIGKILL');
    }
    if (e instanceof InvoiceError) return json(res, 400, { outcome: 'invalid', reason: e.message });
    console.error('[agent] error', e);
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

try {
  await assertNodeChain(cfg.chain);
} catch (e) {
  console.error(`[agent] refusing to start: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(4);
}

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[agent] listening on http://127.0.0.1:${cfg.port} · payer ${cfg.mandate.payer} · vendor ${cfg.mandate.vendor.name} ${cfg.mandate.vendor.address} · ≤ ${cfg.mandate.maxPerInvoice} tUSD8/invoice${cfg.failAt ? ` · FAIL_AT=${cfg.failAt}` : ''}`);
});
