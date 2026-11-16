#!/usr/bin/env node
/**
 * MCP SSE check against the STUB API: the standalone server (packages/mcp-server)
 * started with MCP_TRANSPORT=sse, driven by the SDK's SSE client. Nothing is paid.
 *
 *   npm run build -w packages/mcp-server && node examples/_stub-api/mcp-sse-check.mjs
 *
 * Checks: 401 without / with a wrong x-api-key, tools/list and a pay_for_resource
 * call over SSE with the right key, and what a SECOND concurrent SSE session does
 * (the server wires ONE shared Server instance to every SSE transport).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub, STUB_API_KEY } from './stub-api.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stub = await startStub();
const port = 39000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [join(root, 'packages', 'mcp-server', 'dist', 'index.js')], {
  env: { ...process.env, MCP_TRANSPORT: 'sse', PORT: String(port), AGENTFI_API_URL: `http://127.0.0.1:${stub.port}`, AGENTFI_API_KEY: STUB_API_KEY },
  stdio: ['ignore', 'ignore', 'pipe'],
});
await new Promise((resolve) => child.stderr.on('data', (d) => String(d).includes('SSE endpoint') && resolve()));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const sse = new URL(`http://127.0.0.1:${port}/mcp/sse`);
const open = async () => {
  const c = new Client({ name: 'sse-check', version: '0.0.0' });
  await c.connect(new SSEClientTransport(sse, { requestInit: { headers: { 'x-api-key': STUB_API_KEY } } }));
  return c;
};

try {
  check((await fetch(sse)).status === 401, 'GET /mcp/sse without x-api-key -> 401');
  check((await fetch(sse, { headers: { 'x-api-key': 'wrong' } })).status === 401, 'GET /mcp/sse with a wrong key -> 401');
  const a = await open();
  const tools = (await a.listTools()).tools;
  check(tools.length === 35 && tools.some((t) => t.name === 'pay_for_resource'), `SSE session lists ${tools.length} tools incl. pay_for_resource`);
  const r = JSON.parse((await a.callTool({ name: 'pay_for_resource', arguments: { job_id: 'job_stub_1', url: 'http://stub-seller.example/settled', payment_id: 'sse-check-settled-00001' } })).content[0].text);
  check(r.payment?.status === 'settled', 'pay_for_resource over SSE -> settled');
  // A second concurrent session: does the first keep working?
  let second = 'ok';
  try { const b = await open(); await b.listTools(); await b.close(); } catch (e) { second = `error: ${e.message}`; }
  console.log(`INFO  second concurrent SSE session: ${second}`);
  let first = 'ok';
  try { await Promise.race([a.listTools(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch (e) { first = `error: ${e.message}`; }
  console.log(`INFO  first session still answering after the second connected: ${first}`);
  await a.close().catch(() => {});
} finally {
  console.log('INFO  server process exited by itself: ' + (child.exitCode !== null) + ' (code ' + child.exitCode + ')');
  child.kill();
  await stub.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
