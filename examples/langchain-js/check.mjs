#!/usr/bin/env node
/**
 * LangChain JS check against the STUB API: builds real `DynamicStructuredTool`s
 * from @agent_fi/adapters (built from this checkout) and invokes them. No LLM,
 * no key, nothing is paid. This tests the TOOLS, not a LangChain agent/LangGraph graph.
 *
 *   npm install && npm run build -w packages/adapters      # at the repo root
 *   cd examples/langchain-js && npm install && node check.mjs
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentFiToolkit } from '../../packages/adapters/dist/langchain.js';
import { startStub, STUB_API_KEY } from '../_stub-api/stub-api.mjs';

const stub = await startStub();
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
try {
  const toolkit = new AgentFiToolkit({ apiKey: STUB_API_KEY, apiUrl: `http://127.0.0.1:${stub.port}` });
  const tools = toolkit.getToolFields().map((f) => new DynamicStructuredTool(f));
  console.log('tools:', tools.map((t) => t.name).join(', '));
  check(tools.length === 3 && tools.every((t) => !/admin|policy|approve|reject/.test(t.name)), 'payer-safe set only (pay_for_resource + 2 read-only), no admin/policy tool');

  const pay = tools.find((t) => t.name === 'agentfi_pay_for_resource');
  const id = 'lc-check-settled-0000001';
  const a = JSON.parse(await pay.invoke({ job_id: 'job_stub_1', url: 'http://stub-seller.example/settled', payment_id: id }));
  check(a.httpStatus === 200 && a.payment?.status === 'settled', 'invoke -> 200, payment.status settled');
  const b = JSON.parse(await pay.invoke({ job_id: 'job_stub_1', url: 'http://stub-seller.example/settled', payment_id: id }));
  check(b.replayed === true && /Nothing was paid again/.test(b.guidance), 'same payment_id -> replayed:true with guidance');
  const u = JSON.parse(await pay.invoke({ job_id: 'job_stub_1', url: 'http://stub-seller.example/unknown' }));
  check(u.httpStatus === 502 && u.code === 'PAYMENT_OUTCOME_UNKNOWN' && /Do NOT retry with a new payment_id/.test(u.guidance), 'uncertain outcome: 502 verbatim + do-not-retry guidance');
  check(stub.stats().paidRequests['/unknown'] === 1, 'the stub saw exactly one paid request for the uncertain purchase');
  const job = JSON.parse(await tools.find((t) => t.name === 'agentfi_get_job').invoke({ job_id: 'job_stub_1' }));
  check(job.status === 'ACCEPTED', 'agentfi_get_job -> ACCEPTED');
} finally {
  await stub.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
