/**
 * CLI around payResource.
 *
 *   AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=<provider agent key> \
 *   node dist/main.js <jobId> <resourceUrl> [--max-amount 0.50] [--payment-id <id>]
 *
 * With `--scenarios <jobId> <baseResourceUrl>` it walks every stub scenario path
 * (/settled, /partial, ...). That mode only makes sense against the STUB API
 * in ../../_stub-api; a real backend decides outcomes from the real resource.
 */
import { payResource, type PayResult } from './client.js';

const baseUrl = process.env['AGENTFI_API_URL'] ?? 'http://localhost:3000';
const apiKey = process.env['AGENTFI_API_KEY'] ?? '';
if (!apiKey) {
  console.error('Set AGENTFI_API_KEY to the PROVIDER agent key of the job (it is the identity; never share it).');
  process.exit(2);
}

function show(label: string, r: PayResult): void {
  const p = r.body?.['payment'];
  const res = r.body?.['resource'];
  console.log(`\n== ${label}`);
  console.log(`   outcome        : ${r.outcome}   (HTTP ${r.httpStatus ?? 'no answer'})`);
  console.log(`   paymentId      : ${r.paymentId}`);
  if (p) console.log(`   payment.status : ${p.status}   amount ${p.amount} base units`);
  if (res) console.log(`   delivery       : resource.status ${res.status}, truncated=${res.truncated === true}`);
  if (r.body?.['remainingBudget']) console.log(`   remaining      : ${r.body['remainingBudget'].remainingFormatted} USDC`);
  if (r.body?.['code']) console.log(`   code           : ${r.body['code']}`);
  console.log(`   new id allowed : ${r.newPaymentIdAllowed}`);
  console.log(`   advice         : ${r.advice}`);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === '--scenarios') {
  const jobId = args[1]!;
  const base = args[2]!.replace(/\/+$/, '');
  const idFor = (name: string) => `ts-example-${name}-0000000001`; // fixed ids make the demo repeatable
  for (const name of ['settled', 'partial', 'free', 'budget', 'policy', 'in-progress', 'outstanding', 'refused', 'unknown']) {
    show(`/${name}`, await payResource({ baseUrl, apiKey, jobId, url: `${base}/${name}`, paymentId: idFor(name) }));
  }
  // The right answer to an uncertain outcome: ask again with the SAME id.
  show('/unknown again, SAME paymentId (replay: the recorded state, nothing paid twice)', await payResource({ baseUrl, apiKey, jobId, url: `${base}/unknown`, paymentId: idFor('unknown') }));
  show('/settled again, SAME paymentId', await payResource({ baseUrl, apiKey, jobId, url: `${base}/settled`, paymentId: idFor('settled') }));
} else {
  const [jobId, url] = args;
  if (!jobId || !url) {
    console.error('usage: node dist/main.js <jobId> <resourceUrl> [--max-amount 0.50] [--payment-id <id>]');
    process.exit(2);
  }
  const maxAmount = flag('--max-amount');
  const paymentId = flag('--payment-id');
  show(url, await payResource({ baseUrl, apiKey, jobId, url, ...(maxAmount ? { maxAmount } : {}), ...(paymentId ? { paymentId } : {}) }));
}
