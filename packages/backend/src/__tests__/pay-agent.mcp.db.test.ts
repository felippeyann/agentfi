/**
 * X5 — the MCP `pay_agent` tool against the REAL transfer route, on REAL
 * Postgres.
 *
 * The finding (G1 round, #170): `@agent_fi/mcp-server`'s `pay_agent` posted
 * `{ recipient, amount, token: <symbol>, chainId, reason }` to
 * `POST /v1/transactions/transfer`, whose schema is
 * `{ to, token: "ETH" | <ERC-20 address>, amount, chainId, idempotencyKey? }`:
 * every call was refused `400 VALIDATION_FAILED` (`to` required) — and with
 * `to` present a symbol would have reached `getAddress("USDC")`.
 *
 * Real here: the stdio MCP server's own `tools/call` dispatcher and HTTP
 * client (`packages/mcp-server/src`, loaded from the sibling package as
 * `mcp.annotations.test.ts` does), the route and its zod schema, the error
 * handler, the policy service, the DailyVolume reservation and the testnet
 * synthetic prices (Q9). The MCP client's `fetch` is answered by
 * `app.inject` — the same method, path, headers and JSON body, no socket.
 * Faked: the queue (jobs captured), the simulator, notifications, the fee /
 * revenue price oracle and the ERC-8183 runtime. Nothing is broadcast.
 *
 * Skipped (with a warning) when DATABASE_URL is not a reachable, migrated
 * database; on CI (`CI` set) an unreachable database fails the suite.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => {
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
  // Base Sepolia spends are priced only with configured synthetic prices (Q9).
  process.env['SYNTHETIC_TEST_PRICES_USD'] = '84532:native=2000,84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1';
  // Read by the MCP client at import time.
  const apiUrl = 'http://agentfi-backend.x5.test:3000';
  process.env['AGENTFI_API_URL'] = apiUrl;
  process.env['AGENTFI_API_KEY'] = 'agfi_live_x5_contract_test_key';
  return {
    apiUrl,
    queued: [] as Array<{ name: string; data: Record<string, unknown> }>,
    /** Every HTTP exchange the MCP client had with the backend. */
    exchanges: [] as Array<{ method: string; path: string; request: unknown; status: number; body: unknown }>,
  };
});

vi.mock('../api/middleware/logger.js', () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  logger['child'] = () => logger;
  return { logger };
});
vi.mock('bullmq', () => ({
  Queue: class {
    add = async () => undefined;
    getJob = async () => undefined;
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));
vi.mock('../queues/transaction.queue.js', () => ({
  transactionQueue: {
    add: async (name: string, data: Record<string, unknown>) => {
      h.queued.push({ name, data });
      return { id: `job-${h.queued.length}` };
    },
  },
}));
vi.mock('../services/transaction/price.service.js', () => ({
  // Fees / revenue only; policy accounting on 84532 uses the synthetic prices.
  weiToUsd: async (wei: bigint) => ((Number(wei) / 1e18) * 2000).toFixed(6),
  tokenAmountToUsd: async (units: bigint, _token: string, decimals: number) => (Number(units) / 10 ** decimals).toFixed(6),
}));
vi.mock('../services/transaction/simulator.service.js', () => ({
  SimulatorService: class {
    async simulate() {
      return { success: true, gasUsed: '21000', gasPrice: '1', simulationId: `sim-${Math.random()}`, provider: 'stub' };
    }
  },
}));
vi.mock('../services/notification.service.js', () => ({
  notificationService: { notify: async () => undefined },
}));
vi.mock('../services/wallet/index.js', () => ({ getWalletService: () => ({}) }));
vi.mock('../services/job/escrow-erc8183.runtime.js', () => ({
  onEscrowTxOutcome: async () => undefined,
  isErc8183Enabled: () => false,
  erc8183Config: { chains: {} },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, parseEther } from 'viem';

async function databaseReady(): Promise<boolean> {
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT "allowedRecipients" FROM "AgentPolicy" LIMIT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect().catch(() => undefined);
  }
}

const DB_READY = await databaseReady();
if (!DB_READY) {
  if (process.env['CI']) throw new Error('pay-agent.mcp.db.test.ts needs a migrated Postgres at DATABASE_URL on CI');
  console.warn('[pay-agent.mcp.db.test] DATABASE_URL is not a reachable, migrated database — suite skipped');
}
const describeDb = DB_READY ? describe : describe.skip;

type CallTool = (name: string, args: unknown, options?: { log?: (...a: unknown[]) => void }) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

type Modules = {
  db: typeof import('../db/client.js')['db'];
  transactionRoutes: typeof import('../api/routes/transactions.js')['transactionRoutes'];
  registerErrorHandler: typeof import('../api/errors/handler.js')['registerErrorHandler'];
  callTool: CallTool;
};
let m: Modules;

const NAME_PREFIX = 'x5-pay-agent';
const RUN = randomBytes(3).toString('hex');
const BASE_SEPOLIA = 84532;
const USDC_84532 = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x00000000000000000000000000000000000000b0';
let seq = 0;

/** The backend the MCP client talks to: one Fastify app per agent. */
let backend: FastifyInstance | undefined;

async function wipe(): Promise<void> {
  const agents = { name: { startsWith: NAME_PREFIX } };
  await m.db.transaction.deleteMany({ where: { agent: agents } });
  const ids = (await m.db.agent.findMany({ where: agents, select: { id: true } })).map((a) => a.id);
  if (ids.length) {
    await m.db.dailyVolume.deleteMany({ where: { agentId: { in: ids } } });
    await m.db.agentPolicy.deleteMany({ where: { agentId: { in: ids } } });
  }
  await m.db.agent.deleteMany({ where: agents });
}

async function mkAgent(policy: Record<string, unknown> = {}) {
  seq++;
  return m.db.agent.create({
    data: {
      name: `${NAME_PREFIX} ${RUN}-${seq}`,
      apiKeyHash: `x5-${RUN}-${seq}`,
      apiKeyPrefix: 'agfi_live_x5',
      walletId: `x5-wallet-${RUN}-${seq}`,
      safeAddress: `0x5a5a${randomBytes(18).toString('hex')}`,
      chainIds: [BASE_SEPOLIA],
      policy: {
        create: {
          maxValuePerTxEth: '10',
          maxValueForAutoApprovalEth: '10',
          maxDailyVolumeUsd: '1000',
          cooldownSeconds: 0,
          // §5-6: a configured outflow cap out of the way (this suite tests other rules).
          maxOutflowPerTxUsd: '1000000',
          ...policy,
        },
      },
    },
  });
}

/** Points the MCP client at a backend acting as `agentId` (auth is not under test here). */
async function serveAs(agentId: string): Promise<void> {
  await backend?.close();
  const a = Fastify({ logger: false });
  m.registerErrorHandler(a);
  a.addHook('preHandler', async (request) => {
    (request as unknown as { agentId: string; agentTier: string }).agentId = agentId;
    (request as unknown as { agentId: string; agentTier: string }).agentTier = 'FREE';
  });
  await a.register(m.transactionRoutes);
  await a.ready();
  backend = a;
}

/** The MCP client's `fetch`, answered by the backend in-process. */
async function fetchViaInject(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (`${url.protocol}//${url.host}` !== h.apiUrl) throw new Error(`unexpected outbound fetch: ${url.origin}`);
  if (!backend) throw new Error('no backend');
  const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH';
  const request = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  const res = await backend.inject({
    method,
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string>,
    ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
  });
  const body = res.body ? (JSON.parse(res.body) as unknown) : undefined;
  h.exchanges.push({ method, path: url.pathname, request, status: res.statusCode, body });
  return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
}

function textOf(result: Awaited<ReturnType<CallTool>>): Record<string, unknown> {
  const first = result.content[0];
  if (!first?.text) throw new Error('no text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** The single HTTP exchange of the last tool call, printed whole when an expectation fails. */
function onlyExchange() {
  expect(h.exchanges, JSON.stringify(h.exchanges)).toHaveLength(1);
  return h.exchanges[0]!;
}

function payAgent(args: Record<string, unknown>) {
  return m.callTool('pay_agent', {
    recipient_address: RECIPIENT,
    amount: '1.5',
    reason: 'paid for the risk report',
    ...args,
  }, { log: () => undefined });
}

describeDb('X5 — MCP pay_agent against the real transfer route (Postgres)', () => {
  beforeAll(async () => {
    const [db, routes, handler] = await Promise.all([
      import('../db/client.js'),
      import('../api/routes/transactions.js'),
      import('../api/errors/handler.js'),
    ]);
    const here = dirname(fileURLToPath(import.meta.url));
    const mcp = (await import(resolve(here, '../../../mcp-server/src/server.ts'))) as { callTool: CallTool };
    m = {
      db: db.db,
      transactionRoutes: routes.transactionRoutes,
      registerErrorHandler: handler.registerErrorHandler,
      callTool: mcp.callTool,
    };
    vi.stubGlobal('fetch', fetchViaInject);
    await wipe();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await backend?.close();
    if (!m) return;
    await wipe();
    await m.db.$disconnect();
  });

  beforeEach(() => {
    h.queued.length = 0;
    h.exchanges.length = 0;
  });

  it('native ETH on Base Sepolia: 202, one TRANSFER row paying the recipient, its value queued to it', async () => {
    const agent = await mkAgent();
    await serveAs(agent.id);

    const result = await payAgent({ token_symbol: 'ETH', chain_id: BASE_SEPOLIA, amount: '0.01' });

    const ex = onlyExchange();
    expect(ex.status, JSON.stringify(ex.body)).toBe(202);
    expect(result.isError).toBeFalsy();
    const rows = await m.db.transaction.findMany({ where: { agentId: agent.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'TRANSFER', chainId: BASE_SEPOLIA, fromToken: 'ETH', toToken: RECIPIENT, amountIn: '0.01' });
    expect(textOf(result)).toMatchObject({ transactionId: rows[0]!.id, status: 'QUEUED' });
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.data).toMatchObject({ to: RECIPIENT, value: parseEther('0.01').toString(), data: '0x' });
  });

  it('USDC on Base Sepolia, resolved through the token registry: an ERC-20 transfer(recipient, 1.5 USDC) on the USDC contract', async () => {
    const agent = await mkAgent();
    await serveAs(agent.id);

    const result = await payAgent({ token_symbol: 'USDC', chain_id: BASE_SEPOLIA });

    const ex = onlyExchange();
    expect(ex.status, JSON.stringify(ex.body)).toBe(202);
    expect(ex.request).toEqual({ to: RECIPIENT, token: USDC_84532, amount: '1.5', chainId: BASE_SEPOLIA });
    expect(result.isError).toBeFalsy();
    const row = await m.db.transaction.findFirstOrThrow({ where: { agentId: agent.id } });
    expect(row).toMatchObject({ type: 'TRANSFER', fromToken: USDC_84532, toToken: RECIPIENT, amountIn: '1.5' });
    expect(h.queued[0]!.data).toMatchObject({
      to: USDC_84532,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, 1_500_000n] }),
    });
    // Counted against the daily limit at the synthetic 1 USD.
    expect(Number(row.volumeReservedUsd)).toBeCloseTo(1.5, 6);
  });

  it('the real policy applies to the MCP payment: a recipient outside allowedRecipients is 403, nothing created', async () => {
    const agent = await mkAgent({ allowedRecipients: [OTHER] });
    await serveAs(agent.id);

    const result = await payAgent({ token_symbol: 'USDC', chain_id: BASE_SEPOLIA });

    const ex = onlyExchange();
    expect(ex.status, JSON.stringify(ex.body)).toBe(403);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ status: 403 });
    expect(String(textOf(result)['error'])).toMatch(/allowed recipients whitelist/);
    expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(0);
    expect(h.queued).toHaveLength(0);
  });

  it('a retry with the same idempotency_key is the same transaction (one row, one job)', async () => {
    const agent = await mkAgent();
    await serveAs(agent.id);
    const key = `x5-retry-${RUN}-0000000000`;

    const first = await payAgent({ token_symbol: 'USDC', chain_id: BASE_SEPOLIA, idempotency_key: key });
    const second = await payAgent({ token_symbol: 'USDC', chain_id: BASE_SEPOLIA, idempotency_key: key });

    expect(h.exchanges.map((e) => e.status), JSON.stringify(h.exchanges)).toEqual([202, 200]);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(1);
    expect(h.queued).toHaveLength(1);
  });

  it('an unknown symbol never reaches the backend', async () => {
    const agent = await mkAgent();
    await serveAs(agent.id);

    const result = await payAgent({ token_symbol: 'DOGE', chain_id: BASE_SEPOLIA });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.exchanges, JSON.stringify(h.exchanges)).toHaveLength(0);
    expect(await m.db.transaction.count({ where: { agentId: agent.id } })).toBe(0);
  });
});
