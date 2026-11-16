#!/usr/bin/env node
/**
 * Runs the TypeScript and Python reference clients against the in-process STUB
 * API (../_stub-api/stub-api.mjs). Nothing is paid; it proves the clients
 * handle every documented outcome and never pay twice for one paymentId.
 *
 *   (cd ts && npm install && npm run build) && node run-stub-demo.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStub, STUB_API_KEY } from '../_stub-api/stub-api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stub = await startStub();
const env = { ...process.env, AGENTFI_API_URL: `http://127.0.0.1:${stub.port}`, AGENTFI_API_KEY: STUB_API_KEY };
const scenarios = ['--scenarios', 'job_stub_1', `http://stub-seller.example`];
console.log(`[STUB] AgentFi API on ${env.AGENTFI_API_URL}: not AgentFi, nothing is paid\n`);

let failed = false;
for (const [label, cmd, args] of [
  ['TypeScript (node fetch)', process.execPath, [join(here, 'ts', 'dist', 'main.js'), ...scenarios]],
  ['Python (urllib)', process.env.PYTHON ?? 'python', [join(here, 'python', 'agentfi_pay.py'), ...scenarios]],
]) {
  console.log(`\n################ ${label}`);
  // async spawn: the stub runs in THIS process, a blocking spawn would deadlock it
  const r = await new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
  console.log(r.stdout);
  if (r.status !== 0) { failed = true; console.error(r.stderr); }
}

const { paidRequests } = stub.stats();
console.log('\n[STUB] paid requests per path (2 clients x 1 purchase each; the replays added none):', JSON.stringify(paidRequests));
const ok = paidRequests['/settled'] === 2 && paidRequests['/unknown'] === 2 && paidRequests['/partial'] === 2;
console.log(ok ? '[STUB] OK: no paymentId was paid twice.' : '[STUB] FAIL: unexpected paid counts');
await stub.close();
process.exit(failed || !ok ? 1 : 0);
