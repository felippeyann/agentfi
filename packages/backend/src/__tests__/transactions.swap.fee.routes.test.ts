/**
 * A6e(2) — POST /v1/transactions/swap: the 202 `fee` and the recorded
 * `feeBps` describe the fee the AgentExecutor actually charges.
 *
 * An ETH-input swap (fromToken = the chain's WETH) is routed through
 * `AgentExecutor.executeSingle` with msg.value = amountIn + F, F =
 * floor(amountIn × 30 / 10 000), on every tier (`wrapSingle`). Before A6e(2)
 * the response and the recorded bps followed the tier schedule (PRO 15 /
 * ENTERPRISE 5), while the recorded amount was F.
 *
 * Each case compares the response with the DEBIT (what the simulation and the
 * job send beyond amountIn), with the LEDGER (the job's and queuePayload's
 * `feeAmountWei` / `feeBps`, which the processor turns into the FeeEvent) and
 * with the contract's formula. The FeeEvent on Postgres and the on-chain debit
 * are checked on Anvil (transactions.batch.anvil.ts).
 *
 * Real: the route, the TransactionBuilder (Uniswap calldata), the
 * ExecutorService (fee formula, EXECUTOR_ADDRESS_1). Mocked: Prisma, the
 * policy, the simulator, the queue, the price oracle, the simulation cache and
 * the chain client (no quoter: amountOutMinimum 0).
 */
import Fastify from 'fastify';
import { decodeFunctionData, getAddress, parseUnits, type Hex } from 'viem';
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
  process.env['EXECUTOR_ADDRESS_1'] = '0x00000000000000000000000000000000000000E1';
  process.env['POLICY_MODULE_ADDRESS_1'] = '0x00000000000000000000000000000000000000A9';
});

const { contractsGate } = vi.hoisted(() => ({ contractsGate: vi.fn() }));
vi.mock('../config/policy-stack-verification.runtime.js', () => ({ policyStackGate: contractsGate }));

const { mockDb, queueAddMock, validateMock, simulateMock } = vi.hoisted(() => ({
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
  simulateMock: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockDb),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: vi.fn().mockImplementation(() => ({ simulate: simulateMock })),
}));
vi.mock('../services/policy/policy.service.js', () => ({
  PolicyService: vi.fn().mockImplementation(() => ({
    validateTransaction: validateMock,
    getPolicy: vi.fn().mockResolvedValue(null),
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
  weiToUsd: vi.fn(async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6)),
  tokenAmountToUsd: vi.fn(async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6)),
}));
vi.mock('../services/policy/daily-volume.js', () => ({
  createTransactionWithVolume: async (_db: unknown, p: { data: unknown }) => ({
    ok: true,
    replayed: false,
    transaction: await mockDb.transaction.create({ data: p.data }),
  }),
  settleVolumeAfterFailure: vi.fn(),
}));
vi.mock('../services/transaction/simulation-cache.js', () => ({
  getSimulation: vi.fn(async () => ({ agentId: 'agent-1', success: true })),
  cacheSimulation: vi.fn(),
}));
// No RPC: the quoter call fails (amountOutMinimum 0); WETH / USDC decimals come from the token registry.
vi.mock('../config/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../config/chains.js')>('../config/chains.js');
  return {
    ...actual,
    createChainPublicClient: () => ({
      simulateContract: async () => {
        throw new Error('no quoter in this test');
      },
      readContract: async () => {
        throw new Error('no RPC in this test');
      },
    }),
  };
});

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const EXECUTOR = '0x00000000000000000000000000000000000000E1';

let transactionRoutes: any;

beforeAll(async () => {
  ({ transactionRoutes } = await import('../api/routes/transactions.js'));
});

async function buildApp(tier: 'FREE' | 'PRO' | 'ENTERPRISE') {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: any) => {
    request.agentId = 'agent-1';
    request.agentTier = tier;
  });
  await app.register(transactionRoutes);
  return app;
}

function swap(fromToken: string, toToken: string, amountIn: string) {
  return {
    method: 'POST' as const,
    url: '/v1/transactions/swap',
    payload: { fromToken, toToken, amountIn, chainId: 1, slippageTolerance: 0.5, simulationId: 'sim-cached' },
  };
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
  contractsGate.mockImplementation((chainId: number) => ({ allowed: true, chainId, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) }));
});

describe('POST /v1/transactions/swap — A6e(2): an ETH-input swap reports the fee the executor charges', () => {
  /** AgentExecutor.calculateFee, written out here: floor(value × 30 / 10 000). */
  const contractFee = (value: bigint) => (value * 30n) / 10_000n;

  const cases: Array<[string, string, bigint]> = [
    ['333 wei (F rounds down to 0)', '0.000000000000000333', 0n],
    ['334 wei (F = 1 wei; PRO 15 bps would give 0)', '0.000000000000000334', 1n],
    ['667 wei (F = 2; PRO 15 bps would give 1, ENTERPRISE 0)', '0.000000000000000667', 2n],
    ['0.01 ETH', '0.01', 30_000_000_000_000n],
  ];
  const tiers = ['FREE', 'PRO', 'ENTERPRISE'] as const;

  it.each(tiers.flatMap((tier) => cases.map(([label, amountIn, fee]) => [tier, label, amountIn, fee] as const)))(
    '%s, %s: fee.amountWei = the debit (msg.value − amountIn) = the recorded feeAmountWei; fee.bps = the recorded feeBps = 30',
    async (tier, _label, amountIn, fee) => {
      const app = await buildApp(tier);

      const res = await app.inject(swap(WETH, USDC, amountIn));

      expect(res.statusCode, res.body).toBe(202);
      const amountInWei = parseUnits(amountIn, 18);
      const sim = simulateMock.mock.calls[0][0] as { to: string; value: bigint; data: Hex };
      const job = queueAddMock.mock.calls[0][1] as Record<string, unknown>;
      const payload = (mockDb.transaction.create.mock.calls[0][0].data as { metadata: { queuePayload: Record<string, unknown> } })
        .metadata.queuePayload;
      // Routed through the executor: executeSingle with the swap's own value.
      expect(getAddress(sim.to)).toBe(getAddress(EXECUTOR));
      const decoded = decodeFunctionData({ abi: AGENT_EXECUTOR_ABI, data: sim.data });
      expect(decoded.functionName).toBe('executeSingle');
      expect((decoded.args![0] as { value: bigint }).value).toBe(amountInWei);
      expect(job['routedViaExecutor']).toBe(true);
      // The debit beyond amountIn, in wei.
      const debit = sim.value - amountInWei;
      expect(debit).toBe(fee);
      expect(debit).toBe(contractFee(amountInWei));
      expect(BigInt(job['value'] as string) - amountInWei).toBe(debit);
      expect(BigInt(payload['value'] as string) - amountInWei).toBe(debit);
      // The ledger (what the processor records as the FeeEvent).
      expect(job['feeAmountWei']).toBe(debit.toString());
      expect(payload['feeAmountWei']).toBe(debit.toString());
      // The response, against the debit and the ledger.
      const body = res.json() as { fee: { bps: number; amountWei: string; feeWallet: string } };
      expect(body.fee.amountWei).toBe(debit.toString());
      expect(body.fee.bps).toBe(30);
      expect(job['feeBps']).toBe(body.fee.bps);
      expect(payload['feeBps']).toBe(body.fee.bps);
      expect(BigInt(body.fee.amountWei)).toBe((amountInWei * BigInt(body.fee.bps)) / 10_000n);
      expect(job['tier']).toBe(tier);
      await app.close();
    },
  );

  it.each(['FREE', 'PRO', 'ENTERPRISE'] as const)(
    '%s, out of scope and unchanged: an ERC-20-input swap is not routed through the executor (no on-chain fee, no FeeEvent) and still reports the tier schedule',
    async (tier) => {
      const app = await buildApp(tier);

      const res = await app.inject(swap(USDC, WETH, '100'));

      expect(res.statusCode, res.body).toBe(202);
      const sim = simulateMock.mock.calls[0][0] as { to: string; value: bigint };
      const job = queueAddMock.mock.calls[0][1] as Record<string, unknown>;
      expect(sim.value).toBe(0n);
      expect(job['routedViaExecutor']).toBe(false);
      const bps = { FREE: 30, PRO: 15, ENTERPRISE: 5 }[tier];
      const tierFee = (100_000_000n * BigInt(bps)) / 10_000n;
      expect(res.json().fee).toMatchObject({ bps, amountWei: tierFee.toString() });
      expect(job).toMatchObject({ feeBps: bps, feeAmountWei: tierFee.toString() });
      await app.close();
    },
  );
});
