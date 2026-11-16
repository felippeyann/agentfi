#!/usr/bin/env node
/**
 * MCP stdio check against the STUB API (nothing is paid, no model is used).
 *
 *   npm install && npm run build -w packages/mcp-server
 *   node examples/_stub-api/mcp-check.mjs
 *
 * Starts the stub, spawns the MCP server built from THIS checkout
 * (packages/mcp-server/dist/index.js) over stdio with the stub's dummy key,
 * then: lists tools, checks the payer-safe subset exists and the description of
 * pay_for_resource does not invite a blind retry, calls pay_for_resource twice
 * with the same payment_id (settled, then replay) and once for an uncertain
 * outcome, and prints the stub's paid-request counters.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub, STUB_API_KEY } from './stub-api.mjs';

/** The tools a PAYER agent needs for the x402 alpha path. Everything else is not for the payer. */
export const PAYER_SAFE_TOOLS = ['get_my_agent_profile', 'get_policy', 'get_job', 'pay_for_resource'];
/** Tools that must never be handed to the paying agent (admin-like, policy-changing, other money paths). */
export const NOT_FOR_PAYER = ['update_policy', 'set_my_manifest', 'update_job_status', 'contest_job', 'post_job', 'pay_agent', 'transfer_token', 'execute_swap'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stub = await startStub();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'packages', 'mcp-server', 'dist', 'index.js')],
  env: { ...process.env, AGENTFI_API_URL: `http://127.0.0.1:${stub.port}`, AGENTFI_API_KEY: STUB_API_KEY },
  stderr: 'pipe',
});
const client = new Client({ name: 'agentfi-mcp-check', version: '0.0.0' });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.log(`tools/list -> ${names.length} tools`);
  check(PAYER_SAFE_TOOLS.every((n) => names.includes(n)), `payer-safe subset present: ${PAYER_SAFE_TOOLS.join(', ')}`);
  check(NOT_FOR_PAYER.every((n) => names.includes(n)), 'the server ALSO registers admin-like/other tools: the client must filter (allowlist) them out');

  const pay = tools.find((t) => t.name === 'pay_for_resource');
  check(/do NOT retry with a new id/.test(pay.description), 'pay_for_resource description says: PAYMENT_OUTCOME_UNKNOWN -> do NOT retry with a new id');
  check(pay.annotations?.destructiveHint === true && pay.annotations?.idempotentHint === false && pay.annotations?.readOnlyHint === false, 'pay_for_resource annotations: not read-only, destructive, NOT idempotent (clients must not auto-retry)');
  const anyBlindRetry = tools.filter((t) => /\b(retry|try again)\b/i.test(t.description) && !/(same|reuse|do not|do NOT|never|after)/i.test(t.description));
  check(anyBlindRetry.length === 0, `no tool description tells the model to retry without a same-id/never qualifier (${anyBlindRetry.map((t) => t.name).join(',') || 'none flagged'})`);

  const call = async (args) => JSON.parse((await client.callTool({ name: 'pay_for_resource', arguments: args })).content[0].text);
  const id = 'mcp-check-settled-000001';
  const a = await call({ job_id: 'job_stub_1', url: 'http://stub-seller.example/settled', payment_id: id });
  check(a.payment?.status === 'settled', 'pay_for_resource /settled -> payment.status settled');
  const b = await call({ job_id: 'job_stub_1', url: 'http://stub-seller.example/settled', payment_id: id });
  check(b.replayed === true && b.resource === null, 'same payment_id again -> replayed:true, resource null (nothing paid twice)');
  const u = await call({ job_id: 'job_stub_1', url: 'http://stub-seller.example/unknown', payment_id: 'mcp-check-unknown-00001' });
  check(u.paid === false && u.code === 'PAYMENT_OUTCOME_UNKNOWN' && u.httpStatus === 502, 'uncertain outcome comes back as structured tool output (paid:false, code PAYMENT_OUTCOME_UNKNOWN), not a thrown error');
  const p = await call({ job_id: 'job_stub_1', url: 'http://stub-seller.example/policy' });
  check(p.paid === false && p.code === 'POLICY_VIOLATION', 'policy refusal comes back structured');
  const { paidRequests } = stub.stats();
  check(paidRequests['/settled'] === 1 && paidRequests['/unknown'] === 1, `stub saw 1 paid request each for /settled and /unknown: ${JSON.stringify(paidRequests)}`);
} finally {
  await client.close().catch(() => {});
  await stub.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
