/**
 * `npm run mcp`: a READ-ONLY MCP server (stdio) so Claude can answer "was invoice INV-001 paid?" with
 * evidence. Two tools, both read-only:
 *
 *   invoice_status { invoiceId }   the ledger's record checked against the chain (inquiry.ts):
 *                                  paid_verified | pending | not_paid | failed | unresolved | mismatch |
 *                                  unknown_invoice | cannot_verify_now, with network, hash, block, receipt;
 *                                  with a vault (mandate.vault) also its settlementOf and InvoiceSettled event
 *   list_invoices {}               the ids and states in the ledger (no chain reads)
 *
 * Nothing else: no signing, no sending, no reconcile (which can rebroadcast), no mandate or policy
 * change, no admin. The server never holds the payer key (INVOICE_PAYER_KEY is cleared at start) and
 * opens the ledger with a read-only SQLite connection.
 *
 * Environment: INVOICE_RPC_URL, INVOICE_MANDATE, INVOICE_LEDGER (the agent's), optional
 * INVOICE_CONFIRMATION / INVOICE_EXPLORER_URL / INVOICE_LOGS_FROM_BLOCK as for the agent.
 */
import { existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { inquireInvoice } from './inquiry.js';
import { formatUnits6 } from './invoice.js';
import { Ledger } from './ledger.js';

// This surface never signs: it must not even see the key.
delete process.env['INVOICE_PAYER_KEY'];
delete process.env['INVOICE_FAIL_AT'];

export const TOOLS = [
  {
    name: 'invoice_status',
    description:
      'Was this invoice paid? Reads the invoice agent\'s ledger and checks it against the chain (receipt by transaction hash, the exact tUSD8 Transfer, the confirmation rule, every transfer to that payee matched to an invoice). When the operator\'s mandate names an InvoiceMandate vault, it also reads the vault\'s settlementOf(invoiceId) and its InvoiceSettled event, and answers from the vault alone for an invoice the ledger does not know. Returns one state: paid_verified, pending, not_paid, failed, unresolved, mismatch, unknown_invoice or cannot_verify_now, with the network, transaction hash, block, explorer link and, when paid and verified, the receipt. Read-only: never pays, retries or changes anything. If the state is not paid_verified, do NOT advise paying again before the original transaction is checked.',
    inputSchema: {
      type: 'object' as const,
      properties: { invoiceId: { type: 'string', description: 'The invoice id exactly as written (case-sensitive), e.g. INV-001.' } },
      required: ['invoiceId'],
      additionalProperties: false,
    },
    annotations: { title: 'Invoice payment status (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_invoices',
    description: 'Lists the invoices in the agent\'s ledger (id, ledger status, amount, payee, transaction hash). Ledger only, no chain check: use invoice_status to know whether one was really paid.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    annotations: { title: 'Invoices in the ledger (read-only)', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export function createInvoiceMcpServer() {
  const cfg = loadConfig();
  const server = new Server({ name: 'agentfi-invoice-status', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (name === 'invoice_status') {
      const id = typeof args['invoiceId'] === 'string' ? args['invoiceId'].trim() : '';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return { isError: true, content: [{ type: 'text' as const, text: 'invoiceId must be 1–64 characters of letters, digits, ".", "_" or "-".' }] };
      const result = await inquireInvoice(cfg.chain, cfg.mandate, cfg.ledgerPath, id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
    }
    if (name === 'list_invoices') {
      if (!existsSync(cfg.ledgerPath)) return { content: [{ type: 'text' as const, text: JSON.stringify({ ledger: cfg.ledgerPath, invoices: [] }) }] };
      const ledger = new Ledger(cfg.ledgerPath, { readOnly: true });
      try {
        const invoices = ledger.all().map((r) => ({ invoiceId: r.invoice_id, ledgerStatus: r.status, amount: `${formatUnits6(BigInt(r.amount))} tUSD8`, payTo: r.pay_to, txHash: r.tx_hash }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ chainId: cfg.chain.chainId, invoices }, null, 2) }] };
      } finally {
        ledger.close();
      }
    }
    return { isError: true, content: [{ type: 'text' as const, text: `unknown tool ${name}: this server only answers invoice_status and list_invoices (read-only)` }] };
  });
  return server;
}

const isMain = process.argv[1] && /mcp\.ts$/.test(process.argv[1]);
if (isMain) {
  createInvoiceMcpServer()
    .connect(new StdioServerTransport())
    .catch((e) => {
      console.error(`[invoice-mcp] ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
