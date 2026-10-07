import Fastify from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestError } from 'viem';
import { registerErrorHandler } from '../api/errors/handler.js';

process.env['NODE_ENV'] = 'development';

const { simulateMock, buildUniswapSwapMock } = vi.hoisted(() => ({
  simulateMock: vi.fn(),
  buildUniswapSwapMock: vi.fn(),
}));

const { mockDb, queueAddMock } = vi.hoisted(() => ({
  mockDb: {
    agent: {
      findUnique: vi.fn(),
    },
    transaction: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as any,
  queueAddMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));

vi.mock('../services/transaction/builder.service.js', () => ({
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    buildUniswapSwap: buildUniswapSwapMock,
    buildEthTransfer: vi.fn(),
    buildTokenTransfer: vi.fn(),
    buildAaveSupply: vi.fn(),
    buildAaveWithdraw: vi.fn(),
    buildApprove: vi.fn(),
  })),
}));

vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: vi.fn().mockImplementation(() => ({
    simulate: simulateMock,
  })),
}));

vi.mock('../services/transaction/executor.service.js', () => ({
  ExecutorService: vi.fn().mockImplementation(() => ({
    wrapSingle: vi.fn(),
    wrapBatch: vi.fn(),
  })),
}));

vi.mock('../services/policy/policy.service.js', () => ({
  PolicyService: vi.fn().mockImplementation(() => ({
    validateTransaction: vi.fn().mockResolvedValue({ allowed: true }),
    setPolicy: vi.fn(),
    getPolicy: vi.fn(),
    emergencyPause: vi.fn(),
    resume: vi.fn(),
  })),
}));

vi.mock('../services/policy/fee.service.js', () => ({
  FeeService: vi.fn().mockImplementation(() => ({
    checkTxLimit: vi.fn().mockResolvedValue(true),
    calculateFee: vi.fn().mockReturnValue({
      feeAmountWei: 0n,
      feeBps: 30,
      netAmountWei: 0n,
      feeWallet: '0x000000000000000000000000000000000000fEe1',
    }),
  })),
}));

vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: {
    add: queueAddMock,
  },
}));

vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: vi.fn().mockResolvedValue('0'),
}));

let transactionRoutes: any;

beforeAll(async () => {
  const mod = await import('../api/routes/transactions.js');
  transactionRoutes = mod.transactionRoutes;
});

async function buildTestApp() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app); // as in index.ts (S5)

  app.addHook('preHandler', async (request: any) => {
    request.agentId = 'agent-1';
    request.agentTier = 'FREE';
  });

  await app.register(transactionRoutes);
  return app;
}

describe('transaction routes integration guards', () => {
  beforeEach(() => {
    process.env['OPERATOR_FEE_WALLET'] = '0x000000000000000000000000000000000000fEe1';
    vi.clearAllMocks();

    mockDb.agent.findUnique.mockResolvedValue({
      safeAddress: '0x1111111111111111111111111111111111111111',
      walletId: 'wallet-1',
      chainIds: [1],
    });

    mockDb.transaction.findUnique.mockResolvedValue(null);
    mockDb.transaction.findFirst.mockResolvedValue(null);
  });

  it('blocks requests on chains not enabled for the agent', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/simulate',
      payload: {
        fromToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountIn: '0.1',
        chainId: 8453,
        slippageTolerance: 0.5,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Chain 8453 is not enabled for this agent' });

    await app.close();
  });

  it('returns 409 when idempotency key is already used by another agent', async () => {
    mockDb.transaction.findUnique.mockResolvedValue(null);
    mockDb.transaction.findFirst.mockResolvedValueOnce({ id: 'tx-other-agent' });

    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfer',
      payload: {
        token: 'ETH',
        to: '0x2222222222222222222222222222222222222222',
        amount: '0.01',
        chainId: 1,
        idempotencyKey: 'shared-key',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'idempotencyKey is already in use by another agent' });

    await app.close();
  });
});

// S5: the transaction worker stores `err.message` of a failed broadcast (a viem
// message carries the RPC URL with the operator's key) and the simulator's
// error; both used to reach GET /v1/transactions/:id — and the PUBLIC
// /v1/public/transactions/:id — verbatim.
describe('S5: chain errors never reach a transaction response', () => {
  const ALCHEMY_KEY = 'Zq8mN3pL5vR7tX9wB2cD4fG6hJ1kM0aS';
  const ALCHEMY_URL = `https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  const rpcError = () =>
    new HttpRequestError({ url: ALCHEMY_URL, status: 401, details: 'Must be authenticated!', body: { method: 'eth_sendRawTransaction' } });
  const TX_HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  function failedTx(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tx-1',
      agentId: 'agent-1',
      status: 'FAILED',
      type: 'TRANSFER',
      chainId: 84532,
      txHash: TX_HASH,
      fromToken: 'ETH',
      toToken: '0x2222222222222222222222222222222222222222',
      amountIn: '0.01',
      amountOut: null,
      // Exactly what transaction.processor.ts writes on a permanent failure.
      error: rpcError().message.slice(0, 500),
      simulation: { success: false, error: `eth_call failed via ${ALCHEMY_URL}`, simulationId: 'ethcall_1', provider: 'eth_call' },
      metadata: { jobId: 'job-1', a2aPayment: true },
      createdAt: new Date('2026-10-07T12:00:00.000Z'),
      confirmedAt: null,
      ...overrides,
    };
  }

  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env['ALCHEMY_API_KEY'];
    process.env['ALCHEMY_API_KEY'] = ALCHEMY_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env['ALCHEMY_API_KEY'];
    else process.env['ALCHEMY_API_KEY'] = savedKey;
  });

  it('GET /v1/transactions/:id sanitizes `error` and `simulation.error`, everything else as stored', async () => {
    expect(failedTx().error).toContain(ALCHEMY_KEY);
    mockDb.transaction.findFirst.mockResolvedValue(failedTx());
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/v1/transactions/tx-1' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    const body = res.json();
    expect(body.error).toMatch(/^HTTP request failed\./);
    expect(body.error).toContain('URL: https://base-sepolia.g.alchemy.com/v2/[redacted]');
    expect(body.simulation.error).toBe('eth_call failed via https://base-sepolia.g.alchemy.com/v2/[redacted]');
    expect(body).toMatchObject({ id: 'tx-1', status: 'FAILED', txHash: TX_HASH, metadata: { jobId: 'job-1', a2aPayment: true } });
    expect(body.createdAt).toBe('2026-10-07T12:00:00.000Z');
    await app.close();
  });

  it('the public GET /v1/public/transactions/:id is sanitized too', async () => {
    mockDb.transaction.findUnique.mockResolvedValue(failedTx());
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/v1/public/transactions/tx-1' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    expect(res.json().txHash).toBe(TX_HASH);
    await app.close();
  });

  it('GET /v1/transactions (list) sanitizes every row', async () => {
    mockDb.transaction.findMany.mockResolvedValue([failedTx(), failedTx({ id: 'tx-2', error: null, simulation: null })]);
    mockDb.transaction.count.mockResolvedValue(2);
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/v1/transactions' });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    expect(res.json().transactions[1]).toMatchObject({ id: 'tx-2', error: null, simulation: null });
    await app.close();
  });

  it('an idempotent replay returns the stored row sanitized', async () => {
    mockDb.transaction.findUnique.mockResolvedValue(failedTx());
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/transfer',
      payload: { token: 'ETH', to: '0x2222222222222222222222222222222222222222', amount: '0.01', chainId: 1, idempotencyKey: 'same-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('tx-1');
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    await app.close();
  });

  it('an RPC failure inside a transaction route is the opaque 500 envelope, with no message', async () => {
    buildUniswapSwapMock.mockReturnValue({ to: '0x3333333333333333333333333333333333333333', data: '0x', value: 0n });
    simulateMock.mockRejectedValue(rpcError());
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/simulate',
      payload: {
        fromToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountIn: '0.1',
        chainId: 1,
      },
    });

    expect(simulateMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal error', code: 'INTERNAL_ERROR', traceId: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(res.payload).not.toContain(ALCHEMY_KEY);
    await app.close();
  });
});
