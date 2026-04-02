import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['NODE_ENV'] = 'development';

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
    buildUniswapSwap: vi.fn(),
    buildEthTransfer: vi.fn(),
    buildTokenTransfer: vi.fn(),
    buildAaveSupply: vi.fn(),
    buildAaveWithdraw: vi.fn(),
    buildApprove: vi.fn(),
  })),
}));

vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: vi.fn().mockImplementation(() => ({
    simulate: vi.fn(),
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
