/**
 * G1 review P3-1 — "is this transaction known?" must ask every RPC node.
 *
 * `transaction.queue.ts` answers it for the A6b adoption check (does an
 * earlier signed attempt live? then adopt it instead of signing the next
 * nonce) and for the re-poll's drop decision. It used one viem client with a
 * `fallback([...])` transport over the chain's RPC candidates: a `null` from
 * `eth_getTransactionByHash` is a valid answer, so the fallback never asks the
 * next node, and a transaction only the secondary node accepted was
 * "unknown" — the re-poll declared it dropped, the adoption check signed a
 * second transaction with the next nonce.
 *
 * Two real JSON-RPC servers on 127.0.0.1 stand in for the candidates: the
 * primary never saw the transaction (answers `null`), the secondary has it
 * pending. The chain's RPC candidates are pointed at them; the read client is
 * built exactly as `createChainPublicClient` builds it for those candidates.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

const h = vi.hoisted(() => ({
  urls: [] as string[],
  db: {
    transaction: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    job: { findUnique: vi.fn() },
  } as any,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
}));
vi.mock('../db/client.js', () => ({ db: h.db }));
vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({ onEscrowTxOutcome: vi.fn(), vetBindBeforeBroadcast: vi.fn() }));
vi.mock('../services/job/payment-finalizer.service.js', () => ({ finalizeA2APaymentJob: vi.fn() }));
vi.mock('../config/chains.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/chains.js')>();
  const viem = await import('viem');
  return {
    ...actual,
    // The chain's RPC candidates are the two local nodes, primary first.
    getRpcCandidates: () => [...h.urls],
    getPrimaryRpcUrl: () => h.urls[0]!,
    getSecondaryRpcUrl: () => h.urls[1],
    // What `createChainPublicClient` builds for those candidates.
    createChainPublicClient: (chainId: number) =>
      viem.createPublicClient({ chain: actual.getChain(chainId), transport: viem.fallback(h.urls.map((url) => viem.http(url))) }),
  };
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TX_HASH = `0x${'ab'.repeat(32)}`;
const PENDING_TX = {
  hash: TX_HASH,
  nonce: '0x7',
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  value: '0x0',
  gas: '0x5208',
  gasPrice: '0x3b9aca00',
  input: '0x',
  type: '0x0',
  chainId: '0x14a34',
  v: '0x29237',
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`,
};

/** A JSON-RPC node that knows the transaction (pending) or not (null). Counts what it was asked. */
function node(knows: boolean) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
      const answer = (call: { id: number; method: string }) => {
        asked.push(call.method);
        if (call.method === 'eth_getTransactionByHash') return { jsonrpc: '2.0', id: call.id, result: knows ? PENDING_TX : null };
        if (call.method === 'eth_getTransactionReceipt') return { jsonrpc: '2.0', id: call.id, result: null };
        if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x14a34' };
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'method not found' } };
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return { server, asked };
}

const primary = node(false);
const secondary = node(true);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  h.urls.push(await listen(primary.server), await listen(secondary.server));
});

afterAll(async () => {
  await Promise.all([primary.server, secondary.server].map((s) => new Promise((resolve) => s.close(resolve))));
});

beforeEach(() => {
  vi.clearAllMocks();
  primary.asked.length = 0;
  secondary.asked.length = 0;
  h.db.transaction.findMany.mockResolvedValue([
    { id: 'tx-1', chainId: 84532, agentId: 'agent-1', txHash: TX_HASH, metadata: null, updatedAt: new Date(Date.now() - 3 * 3_600_000) },
  ]);
  h.db.transaction.updateMany.mockResolvedValue({ count: 1 });
  h.db.transaction.findUnique.mockResolvedValue({ status: 'FAILED', amountIn: null, error: 'dropped', metadata: null });
});

describe('P3-1: the re-poll asks every RPC node before declaring a transaction dropped', () => {
  it('only the secondary node knows the pending transaction → still pending, NOT marked FAILED (dropped)', async () => {
    const { repollSubmittedTransactionsNow } = await import('../queues/transaction.queue.js');
    const summary = await repollSubmittedTransactionsNow({ olderThanMs: 0, dropAfterMs: 60_000, limit: 10 });
    expect(summary).toMatchObject({ scanned: 1, pending: 1, dropped: 0, errors: 0 });
    expect(h.db.transaction.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    expect(secondary.asked).toContain('eth_getTransactionByHash');
  });
});
