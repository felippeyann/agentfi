/**
 * Route-level tests — POST /v1/transactions/batch token whitelist.
 *
 * The action `token` is caller-declared. It must reach
 * `PolicyService.validateTransaction` as `tokenAddress` (so the off-chain
 * `allowedTokens` whitelist applies), and an agent that HAS a token whitelist
 * must declare a token on every action carrying calldata.
 */
import Fastify from 'fastify';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_EXECUTOR_ABI } from '../abi/AgentExecutor.abi.js';

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
  process.env['POLICY_MODULE_ADDRESS_1'] = '0x00000000000000000000000000000000000000A9';
});

const { contractsGate } = vi.hoisted(() => ({ contractsGate: vi.fn() }));
// S9: the executor's verification (real checks run on Anvil in contract-identity.*.anvil.ts).
vi.mock('../config/policy-stack-verification.runtime.js', () => ({ policyStackGate: contractsGate }));

const { mockDb, queueAddMock, validateMock, getPolicyMock, simulateMock, volumeCalls } = vi.hoisted(() => ({
  /** What the route asked the DailyVolume reservation to count (A6d). */
  volumeCalls: [] as Array<{ valueUsd: string | undefined; priceSource?: unknown }>,
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
// A6d: the real ExecutorService (pure: the fee formula on FEE_BPS, read from EXECUTOR_ADDRESS_1 above).
vi.mock('../services/transaction/executor.service.js', async () =>
  vi.importActual<typeof import('../services/transaction/executor.service.js')>('../services/transaction/executor.service.js'),
);
vi.mock('../services/policy/policy.service.js', () => ({
  PolicyService: vi.fn().mockImplementation(() => ({
    validateTransaction: validateMock,
    getPolicy: getPolicyMock,
  })),
}));
vi.mock('../services/policy/fee.service.js', () => ({
  FeeService: vi.fn().mockImplementation(() => ({
    checkTxLimit: vi.fn().mockResolvedValue(true),
    // The tier schedule (FREE 30 / PRO 15 / ENTERPRISE 5 bps), as fee.service.ts computes it.
    calculateFee: vi.fn(({ grossAmountWei, tier }: { grossAmountWei: bigint; tier: 'FREE' | 'PRO' | 'ENTERPRISE' }) => {
      const feeBps = { FREE: 30, PRO: 15, ENTERPRISE: 5 }[tier];
      const feeAmountWei = (grossAmountWei * BigInt(feeBps)) / 10_000n;
      return { feeAmountWei, feeBps, netAmountWei: grossAmountWei - feeAmountWei, feeWallet: '0x000000000000000000000000000000000000fEe1' };
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
// The DailyVolume reservation (A6) runs on Postgres in daily-volume.db.test.ts
// (including the batch's native value and an unpriced value); here the row is
// created through the mocked client and nothing is reserved.
vi.mock('../services/policy/daily-volume.js', () => ({
  createTransactionWithVolume: async (_db: unknown, p: { data: unknown; valueUsd: string | undefined; priceSource?: unknown }) => {
    volumeCalls.push({ valueUsd: p.valueUsd, priceSource: p.priceSource });
    return { ok: true, replayed: false, transaction: await mockDb.transaction.create({ data: p.data }) };
  },
  settleVolumeAfterFailure: vi.fn(),
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

async function buildApp(tier: 'FREE' | 'PRO' | 'ENTERPRISE' = 'FREE') {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = 'agent-1';
    request.agentTier = tier;
  });
  await app.register(transactionRoutes);
  return app;
}

function batch(actions: Array<Record<string, unknown>>) {
  return { method: 'POST' as const, url: '/v1/transactions/batch', payload: { chainId: 1, actions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  volumeCalls.length = 0;
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
  contractsGate.mockImplementation((chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }));
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
    // §5-6: native value is an outflow — the policy carries a USD cap and the value a price.
    getPolicyMock.mockResolvedValue({ allowedTokens: [USDC], allowedRecipients: [], allowedContracts: [], maxOutflowPerTxUsd: '1000' });
    const { weiToUsd } = await import('../services/transaction/price.service.js');
    vi.mocked(weiToUsd).mockResolvedValueOnce('0.000002');
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '1000', data: '0x' }]));

    expect(res.statusCode).toBe(202);
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock.mock.calls[0][0]).not.toHaveProperty('tokenAddress');

    await app.close();
  });

  it('§5-6: a native-value batch whose policy has no maxOutflowPerTxUsd is refused (403 USD_CAP_NOT_CONFIGURED) before simulating', async () => {
    getPolicyMock.mockResolvedValue({ allowedTokens: [], allowedRecipients: [], allowedContracts: [], maxOutflowPerTxUsd: null });
    const { weiToUsd } = await import('../services/transaction/price.service.js');
    vi.mocked(weiToUsd).mockResolvedValueOnce('0.000002');
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '1000', data: '0x' }]));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'USD_CAP_NOT_CONFIGURED', rule: 'maxOutflowPerTxUsd' });
    expect(simulateMock).not.toHaveBeenCalled();

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

describe('POST /v1/transactions/batch — S8: the policy module is never a batch target', () => {
  it.each([
    ['setPolicy selector', '0xb35d9751'],
    ['validateTransaction (no caller check on-chain: would restart a cooldown)', '0xb9c4687c'],
    ['no calldata', '0x'],
  ])('%s → 403 POLICY_MODULE_TARGET, nothing simulated or queued (any case of the address)', async (_label, data) => {
    getPolicyMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject(
      batch([
        { to: TARGET, data: '0x' },
        { to: '0x00000000000000000000000000000000000000a9', data },
      ]),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'POLICY_MODULE_TARGET', actionIndex: 1 });
    expect(simulateMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /v1/transactions/batch — S9: only through a verified executor', () => {
  it('an unverified executor → 503 CONTRACTS_UNVERIFIED after the policy checks, before any simulation, reservation or write', async () => {
    getPolicyMock.mockResolvedValue(null);
    contractsGate.mockReturnValue({ allowed: false, chainId: 1, block: 'mismatch', reason: 'not this build', retryAfterSeconds: 120 });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '1000', data: '0x' }]));

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('120');
    expect(res.json()).toMatchObject({ code: 'CONTRACTS_UNVERIFIED', chainId: 1, state: 'mismatch' });
    expect(validateMock).toHaveBeenCalledTimes(1); // the deterministic policy checks ran first
    expect(simulateMock).not.toHaveBeenCalled();
    expect(mockDb.transaction.create).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('order: a policy refusal (403) answers before the identity gate is even asked', async () => {
    getPolicyMock.mockResolvedValue(null);
    validateMock.mockResolvedValue({ allowed: false, reason: 'blocked by policy' });
    contractsGate.mockReturnValue({ allowed: false, chainId: 1, block: 'unverified', reason: 'rpc down', retryAfterSeconds: 120 });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '1000', data: '0x' }]));

    expect(res.statusCode).toBe(403);
    expect(contractsGate).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * A6d — `AgentExecutor.executeBatch` requires `msg.value >= ΣV + F` with
 * F = floor(ΣV × feeBps / 10 000) on the SUM of the action values
 * (`InsufficientValueForFee` otherwise). The route sent ΣV only, so any batch
 * with ≥ 334 wei of native value reverted at simulation (found in #182). The
 * same reverts on a real executor: transactions.batch.anvil.ts.
 */
describe('POST /v1/transactions/batch — A6d: msg.value carries the executor fee', () => {
  const EXECUTOR = '0x00000000000000000000000000000000000000E1';
  const POLICY = {
    active: true,
    allowedTokens: [],
    allowedRecipients: [],
    allowedContracts: [],
    maxDailyVolumeUsd: '0',
    maxOutflowPerTxUsd: '1000',
  };
  /** The oracle (mocked): 2000 USD per ETH. */
  const usdOf = (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6);

  beforeEach(async () => {
    const { weiToUsd } = await import('../services/transaction/price.service.js');
    vi.mocked(weiToUsd).mockImplementation(async (wei: bigint) => usdOf(wei));
    getPolicyMock.mockResolvedValue(POLICY);
  });

  /** The request's single simulation, job and created row. */
  function sent() {
    expect(simulateMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction.create).toHaveBeenCalledTimes(1);
    const sim = simulateMock.mock.calls[0][0] as { to: string; data: Hex; value: bigint };
    const job = queueAddMock.mock.calls[0][1] as Record<string, unknown>;
    const row = mockDb.transaction.create.mock.calls[0][0].data as { amountIn: string; metadata: { queuePayload: Record<string, unknown> } };
    return { sim, job, row, payload: row.metadata.queuePayload };
  }

  it.each([
    ['334 wei (the smallest value with a non-zero fee)', ['334'], 1n],
    ['333 wei (the fee rounds down to 0)', ['333'], 0n],
    ['200 + 200 wei: the fee is on the SUM (1), not per action (0 + 0)', ['200', '200'], 1n],
    ['0.01 ETH', ['10000000000000000'], 30_000_000_000_000n],
    ['0.004 + 0.006 ETH', ['4000000000000000', '6000000000000000'], 30_000_000_000_000n],
  ])('%s: the simulation, the job and queuePayload all carry ΣV + F; the recorded fee is F', async (_label, values, fee) => {
    const app = await buildApp();

    const res = await app.inject(batch(values.map((value) => ({ to: TARGET, value, data: '0x' }))));

    expect(res.statusCode, res.body).toBe(202);
    const sum = values.reduce((s, v) => s + BigInt(v), 0n);
    const { sim, job, row, payload } = sent();
    expect(getAddress(sim.to)).toBe(getAddress(EXECUTOR));
    expect(sim.value).toBe(sum + fee);
    expect(job).toMatchObject({ value: (sum + fee).toString(), feeAmountWei: fee.toString(), routedViaExecutor: true, data: sim.data });
    // What the stranded-QUEUED sweep re-enqueues: the same value.
    expect(payload).toMatchObject({ value: (sum + fee).toString(), feeAmountWei: fee.toString(), routedViaExecutor: true, data: sim.data });
    // The actions are unchanged: executeBatch with each action's own value.
    const decoded = decodeFunctionData({ abi: AGENT_EXECUTOR_ABI, data: sim.data });
    expect(decoded.functionName).toBe('executeBatch');
    expect((decoded.args![0] as ReadonlyArray<{ value: bigint }>).map((a) => a.value)).toEqual(values.map((v) => BigInt(v)));
    // amountIn keeps its meaning: the value the actions move (the fee is queuePayload.feeAmountWei).
    expect(row.amountIn).toBe(sum.toString());
    await app.close();
  });

  it('F is the executor\'s 30 bps (FEE_BPS = feeBps() on chain), never the tier schedule: a PRO agent\'s batch sends and records 30 bps', async () => {
    const app = await buildApp('PRO');

    const res = await app.inject(batch([{ to: TARGET, value: '10000000000000000', data: '0x' }]));

    expect(res.statusCode, res.body).toBe(202);
    const { sim, job, payload } = sent();
    expect(sim.value).toBe(10_030_000_000_000_000n); // PRO's 15 bps would revert InsufficientValueForFee
    // The FeeEvent amount is what the executor collects (as the swap route records wrapped.feeWei).
    expect(job['feeAmountWei']).toBe('30000000000000');
    expect(payload['feeAmountWei']).toBe('30000000000000');
    await app.close();
  });

  it('the USD counted — the reservation and the outflow cap — is the price of ΣV + F', async () => {
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '10000000000000000', data: '0x' }]));

    expect(res.statusCode, res.body).toBe(202);
    expect(volumeCalls).toEqual([{ valueUsd: usdOf(10_030_000_000_000_000n), priceSource: 'oracle' }]); // 20.06, not 20
    await app.close();
  });

  it('behaviour change: ΣV exactly at maxOutflowPerTxUsd is refused (ΣV + F is above it), before anything is simulated', async () => {
    getPolicyMock.mockResolvedValue({ ...POLICY, maxOutflowPerTxUsd: '25' });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '12500000000000000', data: '0x' }])); // ΣV = 25 USD, F = 0.075 USD

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: 'POLICY_VIOLATION', rule: 'maxOutflowPerTxUsd', limit: '25' });
    expect(simulateMock).not.toHaveBeenCalled();
    expect(volumeCalls).toEqual([]);
    await app.close();
  });

  it('ΣV + F exactly at maxOutflowPerTxUsd passes', async () => {
    getPolicyMock.mockResolvedValue({ ...POLICY, maxOutflowPerTxUsd: '25.075' });
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, value: '12500000000000000', data: '0x' }]));

    expect(res.statusCode, res.body).toBe(202);
    expect(volumeCalls).toEqual([{ valueUsd: '25.075000', priceSource: 'oracle' }]);
    await app.close();
  });

  it('a calldata-only batch (no native value) is unchanged: value 0, fee 0', async () => {
    const app = await buildApp();

    const res = await app.inject(batch([{ to: TARGET, data: '0xdeadbeef' }]));

    expect(res.statusCode, res.body).toBe(202);
    const { sim, job, payload } = sent();
    expect(sim.value).toBe(0n);
    expect(job).toMatchObject({ value: '0', feeAmountWei: '0' });
    expect(payload).toMatchObject({ value: '0', feeAmountWei: '0' });
    await app.close();
  });
});
