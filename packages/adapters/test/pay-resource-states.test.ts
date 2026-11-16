import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AgentFiClient } from '../src/client.js';
import { payForResource } from '../src/pay-resource.js';

/** Raw TCP "API": answers one request with the given bytes and closes (mid-body when Content-Length is larger). */
async function run(raw: string) {
  const server = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(raw);
      sock.end();
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new AgentFiClient({ apiKey: 'k', apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 3000 });
    return await payForResource(client, { job_id: 'job_1', url: 'https://seller.example/r', payment_id: 'pay-0123456789abcdef' });
  } finally {
    server.close();
  }
}
const http200 = (body: string) =>
  `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
const settled = (resource: unknown) => JSON.stringify({ payment: { status: 'settled' }, remainingBudget: {}, resource });

describe('pay_for_resource: unreadable answers and delivery', () => {
  it('200 headers + incomplete body then disconnect is UNKNOWN, with do-not-retry guidance', async () => {
    const out = await run('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{"payment": {"sta');
    expect(out['httpStatus']).toBe(200);
    expect(out['code']).toBe('RESPONSE_UNREADABLE');
    expect(String(out['guidance'])).toMatch(/UNKNOWN/);
    expect(String(out['guidance'])).toMatch(/do NOT use a new payment_id/i);
  });

  it('a 200 with invalid JSON is UNKNOWN too', async () => {
    const out = await run(http200('not json'));
    expect(out['code']).toBe('RESPONSE_UNREADABLE');
  });

  it('a 200 without a payment field is uncertain; an explicit payment: null is not flagged', async () => {
    expect(String((await run(http200('{}')))['guidance'])).toMatch(/no "payment" field/);
    const free = await run(http200(JSON.stringify({ payment: null, remainingBudget: {}, resource: { status: 200 } })));
    expect(free['guidance']).toBeUndefined();
  });

  it('settled + seller HTTP error: paid, NOT delivered, no instruction to pay again', async () => {
    for (const status of [404, 500]) {
      const out = await run(http200(settled({ status })));
      expect(String(out['guidance'])).toMatch(/NOT delivered/);
      expect(String(out['guidance'])).toMatch(/Do NOT pay again/);
    }
  });

  it('settled + truncated is partial delivery; settled + 2xx whole has no warning', async () => {
    expect(String((await run(http200(settled({ status: 200, truncated: true }))))['guidance'])).toMatch(/partial delivery/);
    expect((await run(http200(settled({ status: 200 }))))['guidance']).toBeUndefined();
  });
});
