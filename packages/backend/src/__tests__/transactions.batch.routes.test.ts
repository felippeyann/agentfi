/**
 * Route-level tests — POST /v1/transactions/batch token whitelist.
 *
 * The action `token` is caller-declared. It must reach
 * `PolicyService.validateTransaction` as `tokenAddress` (so the off-chain
 * `allowedTokens` whitelist applies), and an agent that HAS a token whitelist
 * must declare a token on every action carrying calldata.
 */
import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'development'],
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
  // config/contracts.ts reads the executor address at module load.
  process.env['EXECUTOR_ADDRESS_1'] = '0x00000000000000000000000000000000000000E1';
});

const { mockDb, queueAddMock, validateMock, getPolicyMock, simulateMock } = vi.hoisted(() => ({
  mockDb: {
    agent: { findUnique: vi.fn() },
    transaction: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as any,
  queueAddMock: vi.fn(),
  validateMock: vi.fn(),
  getPolicyMock: vi.fn(),
  simulateMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));
vi.mock('../services/transaction/builder.service.js', () => ({
  TransactionBuilder: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: vi.fn().mockImplementation(() => ({ simulate: simulateMock })),
}));
vi.mock('../services/transaction/executor.service.js', () => ({
  ExecutorService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../services/policy/policy.service.js', () => ({
  PolicyService: vi.fn().mockImplementation(() => ({
    validateTransaction: validateMock,
    getPolicy: getPolicyMock,
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
  transactionQueue: { add: queueAddMock },
}));
vi.mock('../services/transaction/price.service.js', () => ({
  weiToUsd: vi.fn().mockResolvedValue('0'),
  tokenAmountToUsd: vi.fn().mockResolvedValue('0'),
}));

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TARGET = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN_REQUIRED = 'token is required for this action because the agent has a token whitelist';

let transactionRoutes: any;

beforeAll(async () => {
  ({ transactionRoutes } = await import('../api/routes/transactions.js'));
});

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = 'agent-1';
    request.agentTier = 'FREE';
  });
  await app.register(transactionRoutes);
  return app;
}

function batch(actions: Array<Record<string, unknown>>) {
  return { method: 'POST' as const, url: '/v1/transactions/batch', payload: { chainId: 1, actions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.agent.findUnique.mockResolvedValue({
    name: 'agent',
    safeAddress: '0x1111111111111111111111111111111111111111',
    walletId: 'wallet-1',
    chainIds: [1],
  });
  mockDb.transaction.findUnique.mockResolvedValue(null);
  mockDb.transaction.findFirst.mockResolvedValue(null);
  mockDb.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'QUEUED' });
  validateMock.mockResolvedValue({ allowed: true });
  simulateMock.mockResolvedValue({ success: true, simulationId: 'sim-1', gasUsed: '1', gasPrice: '1', provider: 'mock' });
  queueAddMock.mockResolvedValue(undefined);
});

describe('POST /v1/transactions/batch — caller-declared token', () => {
  it('passes a declared token to validateTransaction as tokenAddress', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC] });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, token: USDC.toLowerCase(), data: '0xdeadbeef' }]));

    expect(res.statusCode).toBe(202);
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', targetContract: TARGET, tokenAddress: USDC }),
    );
    expect(queueAddMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects with 400 when the agent has a token whitelist and a calldata action declares no token', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC] });
    const app = await buildApp();

    const res = await app.inject(
      batch([
        { to: TARGET, token: USDC, data: '0x01' },
        { to: TARGET, data: '0xdeadbeef' }, // no token, has calldata
      ]),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TOKEN_REQUIRED, actionIndex: 1 });
    expect(simulateMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('an explicit zero-address token counts as "no token" for the whitelist rule', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC] });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, token: ZERO, data: '0xdeadbeef' }]));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: TOKEN_REQUIRED, actionIndex: 0 });

    await app.close();
  });

  it('a pure ETH transfer (empty data, no token) is allowed even with a token whitelist', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC] });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '1000', data: '0x' }]));

    expect(res.statusCode).toBe(202);
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock.mock.calls[0][0]).not.toHaveProperty('tokenAddress');

    await app.close();
  });

  it('without a token whitelist, an undeclared token on a calldata action is still accepted (allowedContracts binds)', async () => {
    getPolicyMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, data: '0xdeadbeef' }]));

    expect(res.statusCode).toBe(202);
    expect(validateMock.mock.calls[0][0]).not.toHaveProperty('tokenAddress');

    await app.close();
  });

  it('a declared token outside the whitelist is blocked by policy with 403 and the action index', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC] });
    validateMock.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({
      allowed: false,
      reason: `Token ${WETH} is not in the agent's allowed tokens whitelist`,
    });
    const app = await buildApp();

    const res = await app.inject(
      batch([
        { to: TARGET, token: USDC, data: '0x01' },
        { to: TARGET, token: WETH, data: '0x02' },
      ]),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ actionIndex: 1, error: expect.stringContaining(WETH) });
    expect(validateMock.mock.calls[1][0]).toMatchObject({ tokenAddress: WETH });
    expect(queueAddMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects a malformed token with 400 before any policy check', async () => {
    getPolicyMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, token: '0x123', data: '0x' }]));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Validation failed' });
    expect(validateMock).not.toHaveBeenCalled();

    await app.close();
  });
});
