// node --test: needs `npm run build` first (imports ../dist/client.js). No network beyond localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { payResource } from '../dist/client.js';

/** A raw TCP "API": answers every request with the given raw bytes, then closes. */
function rawServer(rawResponse) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(rawResponse);
        sock.destroy(); // closes mid-body when Content-Length promises more than was sent
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}
const http200 = (body, extra = '') =>
  `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body) + extra.length}\r\nConnection: close\r\n\r\n${body}`;
const run = async (raw) => {
  const s = await rawServer(raw);
  try {
    return await payResource({ baseUrl: s.url, apiKey: 'agfi_stub_not_a_secret', jobId: 'job_1', url: 'https://seller.example/r', paymentId: 'ts-test-payment-000001', timeoutMs: 3000 });
  } finally { s.close(); }
};
const settled = (resource) => JSON.stringify({ payment: { status: 'settled', amount: '300000' }, remainingBudget: {}, resource });

test('P1: 200 headers + incomplete JSON body then disconnect is outcome_unknown, never free_resource', async () => {
  const r = await run('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{"payment": {"sta');
  assert.equal(r.outcome, 'outcome_unknown');
  assert.equal(r.newPaymentIdAllowed, false);
  assert.equal(r.httpStatus, 200);
  assert.match(r.advice, /do not retry with a new paymentId/i);
});

test('P1: a 200 with invalid JSON is outcome_unknown', async () => {
  const r = await run(http200('not json at all'));
  assert.equal(r.outcome, 'outcome_unknown');
  assert.equal(r.newPaymentIdAllowed, false);
});

test('P1: a 200 without a payment field is uncertain; only an explicit payment: null is free', async () => {
  const missing = await run(http200('{}'));
  assert.equal(missing.outcome, 'outcome_unknown');
  assert.equal(missing.newPaymentIdAllowed, false);
  const free = await run(http200(JSON.stringify({ payment: null, remainingBudget: {}, resource: { status: 200 } })));
  assert.equal(free.outcome, 'free_resource');
});

test('P2: settled + seller HTTP error is paid, NOT delivered, and never says to buy again', async () => {
  for (const status of [404, 500, 502]) {
    const r = await run(http200(settled({ status, body: 'oops' })));
    assert.equal(r.outcome, 'settled_not_delivered', `resource ${status}`);
    assert.equal(r.newPaymentIdAllowed, false);
    assert.doesNotMatch(r.advice, /Paid and delivered/);
    assert.match(r.advice, /NOT delivered/);
  }
});

test('P2: settled + 2xx whole = settled; settled + truncated = partial', async () => {
  assert.equal((await run(http200(settled({ status: 200, body: {} })))).outcome, 'settled');
  assert.equal((await run(http200(settled({ status: 200, body: 'x', truncated: true })))).outcome, 'settled_partial_delivery');
});
