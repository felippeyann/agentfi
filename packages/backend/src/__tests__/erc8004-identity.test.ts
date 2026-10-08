/**
 * Unit tests — ERC-8004 identity of escrow providers (R2).
 *
 * Drives the real orchestrator (`onEscrowTxOutcome`, `enqueueSubmit`,
 * `recoverErc8183Job`, `processSettlementJob`) and `erc8004-identity.service`
 * against an in-memory Prisma stand-in, a fake transaction queue and a fake
 * public client whose receipts are built with viem `encodeEventTopics` /
 * `encodeAbiParameters` from the checked-in Identity Registry ABI — no Redis,
 * no RPC. `confirm()` plays the transaction worker: it sets the row's final
 * status and calls `onEscrowTxOutcome`, exactly like the monitor's callback.
 *
 *  - first funded job of an unregistered provider → register from the provider
 *    wallet → Registered parsed → identity stored → setProviderAgentId → BOUND
 *  - provider already registered → only the bind step
 *  - two jobs funded concurrently for one unregistered provider → one register,
 *    both bound, one bind in flight at a time
 *  - register reverts / is blocked → identity FAILED, binding FAILED, job goes on;
 *    the next funded job retries the mint with a fresh intentId
 *  - PATCH COMPLETED while BINDING → submit deferred, released after BOUND / FAILED
 *  - chain without hook or registry → SKIPPED, submit immediate
 *  - agent id 0, missing Registered event, wrong owner
 *  - payment recovery resumes a lost outcome and never releases before the bind
 *  - settlement of an already-submitted (pre-R2) job is unchanged
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  parseUnits,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { IDENTITY_REGISTRY_ABI } from '../abi/IdentityRegistry.abi.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';
import {
  CHAIN_JOB_STATUS,
  enqueueSubmit,
  onEscrowTxOutcome,
  processSettlementJob,
  recoverErc8183Job,
  toJobResponse,
  type Erc8183Config,
  type Erc8183Deps,
} from '../services/job/escrow-erc8183.service.js';
import { bindIntentId, registerIntentId } from '../services/job/erc8004-identity.service.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const CHAIN_ID = 84532;
const NO_HOOK_CHAIN = 8453;
const NO_REGISTRY_CHAIN = 1;
const ESCROW = getAddress('0x00000000000000000000000000000000000e5c20');
const HOOK = getAddress('0x000000000000000000000000000000000000400c');
const REGISTRY = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const EVALUATOR = getAddress('0x000000000000000000000000000000000000ea1d');
const REQUESTER = { id: 'agent-req', walletId: 'wallet-req', safeAddress: '0x1111111111111111111111111111111111111111' };
const PROVIDER = { id: 'agent-prov', walletId: 'wallet-prov', safeAddress: '0x2222222222222222222222222222222222222222' };
const NOW = new Date('2026-10-07T12:00:00.000Z');
const BUDGET = parseUnits('12.5', 6);
const BACKEND = 'https://api.example.test';
const AGENT_URI = `${BACKEND}/v1/agents/${PROVIDER.id}/erc8004.json`;
const REGISTER_SELECTOR = toFunctionSelector('register(string)');

const config: Erc8183Config = {
  evaluatorAddress: EVALUATOR,
  jobTtlSeconds: 604_800,
  evaluationDelaySeconds: 0,
  backendPublicUrl: BACKEND,
  chain: (chainId) =>
    chainId === CHAIN_ID || chainId === NO_REGISTRY_CHAIN
      ? { chainId, escrow: ESCROW, hook: HOOK }
      : chainId === NO_HOOK_CHAIN
        ? { chainId, escrow: ESCROW, hook: null }
        : null,
  identityRegistry: (chainId) => (chainId === CHAIN_ID || chainId === NO_HOOK_CHAIN ? REGISTRY : null),
  mcpPublicUrl: null,
};

type Row = Record<string, unknown> & { id: string };

let txHashSeq = 0;
function nextHash(): Hex {
  txHashSeq += 1;
  return `0x${txHashSeq.toString(16).padStart(64, '0')}` as Hex;
}

function fundedJob(overrides: Partial<Row> = {}): Row {
  return {
    id: 'job-1',
    requesterId: REQUESTER.id,
    providerId: PROVIDER.id,
    status: 'ACCEPTED',
    reward: { amount: '12.5', token: 'USDC', chainId: CHAIN_ID },
    result: null,
    reservationStatus: 'PENDING',
    escrowKind: 'erc8183',
    escrowChainId: CHAIN_ID,
    escrowContract: ESCROW,
    onChainJobId: '7',
    onChainStatus: 'APPROVED',
    evaluator: EVALUATOR,
    budgetToken: USDC,
    budgetAmount: BUDGET.toString(),
    expiresAt: new Date(NOW.getTime() + 604_800_000),
    deliverableHash: null,
    settleTxHash: null,
    platformFeeAmount: null,
    feedbackStatus: null,
    feedbackFile: null,
    contestedAt: null,
    contestReason: null,
    escrowError: null,
    providerAgentId: null,
    providerAgentIdStatus: null,
    providerAgentIdError: null,
    deferredSubmitAt: null,
    createdAt: new Date(NOW.getTime()),
    ...overrides,
  };
}

/** Encodes an event the way a node would log it. */
function makeLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: Address, txHash: Hex): Log {
  const item = getAbiItem({ abi, name: eventName }) as unknown as { inputs: Array<{ name: string; type: string; indexed?: boolean }> };
  const topics = encodeEventTopics({ abi, eventName, args } as never);
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed.map((i) => ({ name: i.name, type: i.type })),
        nonIndexed.map((i) => args[i.name]),
      )
    : '0x';
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: 1n,
    blockHash: '0x00' as Hex,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

/** The logs `register(agentURI)` emits on the real registry (Transfer, Registered, MetadataSet). */
function registerReceiptLogs(agentId: bigint, owner: string, txHash: Hex, opts: { registry?: Address; withForeign?: boolean } = {}): Log[] {
  const registry = opts.registry ?? REGISTRY;
  const logs: Log[] = [
    makeLog(IDENTITY_REGISTRY_ABI, 'Transfer', { from: '0x0000000000000000000000000000000000000000', to: owner, tokenId: agentId }, registry, txHash),
    makeLog(IDENTITY_REGISTRY_ABI, 'Registered', { agentId, agentURI: AGENT_URI, owner }, registry, txHash),
    makeLog(
      IDENTITY_REGISTRY_ABI,
      'MetadataSet',
      { agentId, indexedMetadataKey: 'agentWallet', metadataKey: 'agentWallet', metadataValue: owner as Hex },
      registry,
      txHash,
    ),
  ];
  if (opts.withForeign) {
    // Same event shape from another contract: must be ignored.
    logs.unshift(makeLog(IDENTITY_REGISTRY_ABI, 'Registered', { agentId: 1n, agentURI: 'x', owner }, ESCROW, txHash));
  }
  return logs;
}

// ── In-memory Prisma stand-in ──────────────────────────────────────────────

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; lt?: Date; startsWith?: string };
      if ('in' in c && !c.in!.includes(value)) return false;
      if ('not' in c && (c.not === null ? value === null || value === undefined : value === c.not)) return false;
      if ('lt' in c && !((value as Date) < c.lt!)) return false;
      if ('startsWith' in c && !(typeof value === 'string' && value.startsWith(c.startsWith!))) return false;
    } else if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function pick(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return { ...row };
  const out: Row = { id: row.id };
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

function makeStore(seed: { jobs?: Row[]; identities?: Row[]; txs?: Row[] } = {}) {
  const agents = new Map<string, Row>([
    [REQUESTER.id, { ...REQUESTER }],
    [PROVIDER.id, { ...PROVIDER }],
  ]);
  const jobs = new Map((seed.jobs ?? []).map((j) => [j.id, j]));
  const identities = new Map((seed.identities ?? []).map((i) => [i.id, i]));
  const txs = new Map((seed.txs ?? []).map((t) => [t.id, t]));
  let txSeq = txs.size;
  let identitySeq = identities.size;
  let clock = 0;

  const withRelations = (row: Row): Row => ({
    ...row,
    requester: agents.get(row['requesterId'] as string),
    provider: agents.get(row['providerId'] as string),
  });

  const db = {
    agent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const a = agents.get(where.id);
        return a ? { ...a } : null;
      }),
    },
    job: {
      findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const row = jobs.get(where.id);
        if (!row) return null;
        const full = withRelations(row);
        return select ? { ...pick(full, select), ...(select['provider'] ? { provider: full['provider'] } : {}) } : full;
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const rows = [...jobs.values()].filter((r) => matches(r, where));
        rows.sort((a, b) => (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime());
        return rows[0] ? pick(rows[0], select) : null;
      }),
      findMany: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
        [...jobs.values()].filter((r) => matches(r, where)).map((r) => pick(r, select)),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = jobs.get(where.id);
        if (!row) throw new Error(`job ${where.id} not found`);
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of jobs.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
    },
    agentIdentity: {
      findUnique: vi.fn(async ({ where }: { where: { agentId_chainId: { agentId: string; chainId: number } } }) => {
        const { agentId, chainId } = where.agentId_chainId;
        const row = [...identities.values()].find((i) => i['agentId'] === agentId && i['chainId'] === chainId);
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // Synchronous unique check, like Postgres' unique index.
        if ([...identities.values()].some((i) => i['agentId'] === data['agentId'] && i['chainId'] === data['chainId'])) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`agentId`,`chainId`)'), { code: 'P2002' });
        }
        const row: Row = {
          id: `identity-${++identitySeq}`,
          erc8004AgentId: null,
          registerTxHash: null,
          error: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        identities.set(row.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = identities.get(where.id);
        if (!row) throw new Error(`identity ${where.id} not found`);
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of identities.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
    },
    transaction: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; intentId?: string } }) => {
        if (where.id) {
          const row = txs.get(where.id);
          return row ? { ...row } : null;
        }
        const row = [...txs.values()].find((t) => t['intentId'] === where.intentId);
        return row ? { ...row } : null;
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const rows = [...txs.values()].filter((t) => matches(t, where));
        rows.sort((a, b) => (b['seq'] as number) - (a['seq'] as number)); // newest first
        return rows[0] ? pick(rows[0], select) : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data['intentId'] && [...txs.values()].some((t) => t['intentId'] === data['intentId'])) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`intentId`)'), { code: 'P2002' });
        }
        const row: Row = { id: `tx-${++txSeq}`, txHash: null, error: null, seq: ++clock, ...data };
        txs.set(row.id, row);
        return { id: row.id };
      }),
    },
  };
  return { db: db as unknown as PrismaClient, dbMock: db, agents, jobs, identities, txs };
}

function makeDeps(seed: { jobs?: Row[]; identities?: Row[]; txs?: Row[] } = {}) {
  const store = makeStore(seed);
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const settlement = { add: vi.fn().mockResolvedValue(undefined) };
  const receipts = new Map<string, Log[]>();
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => ({ status: 'success', logs: receipts.get(hash) ?? [] }));
  /** On-chain status `getJob` reports (tests set it; settlement tests run against Submitted). */
  const chain: { status: number } = { status: CHAIN_JOB_STATUS.Submitted };
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'token') return USDC;
    if (functionName === 'getJob') return { status: chain.status, budget: BUDGET };
    throw new Error(`unexpected read ${functionName}`);
  });
  const signer = {
    address: EVALUATOR,
    chainId: CHAIN_ID,
    writeContract: vi.fn(async () => nextHash()),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] as Log[] })),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: Erc8183Deps = {
    db: store.db,
    queue: queue as never,
    settlement,
    publicClient: () => ({ readContract, getTransactionReceipt }) as never,
    evaluatorSigner: () => signer as never,
    config,
    releaseJobEscrow: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    logger,
    now: () => NOW,
  };

  /** Plays the transaction worker: final status (+hash, +receipt logs) then the outcome hook. */
  async function confirm(txId: string, status: 'CONFIRMED' | 'REVERTED' | 'FAILED' = 'CONFIRMED', logs?: (hash: Hex) => Log[], error?: string) {
    const row = store.txs.get(txId);
    if (!row) throw new Error(`no tx ${txId}`);
    const hash = nextHash();
    Object.assign(row, { status, txHash: status === 'FAILED' ? null : hash, error: error ?? (status === 'CONFIRMED' ? null : `tx ${status}`) });
    if (logs) receipts.set(hash, logs(hash));
    await onEscrowTxOutcome(deps, { transactionId: txId, status, error: row['error'] as string | null });
    return hash;
  }

  /** The newest Transaction row for an intentId prefix. */
  function txFor(intentPrefix: string): Row | undefined {
    return [...store.txs.values()].filter((t) => String(t['intentId'] ?? '').startsWith(intentPrefix)).sort((a, b) => (b['seq'] as number) - (a['seq'] as number))[0];
  }

  /** Simulates `fund` confirming for a job (seeds the fund tx and runs the outcome). */
  async function fundConfirmed(jobId: string) {
    const id = `tx-fund-${jobId}`;
    store.txs.set(id, {
      id,
      agentId: REQUESTER.id,
      chainId: store.jobs.get(jobId)!['escrowChainId'],
      intentId: `erc8183:fund:${jobId}`,
      status: 'QUEUED',
      txHash: null,
      seq: 0,
      metadata: { jobId, erc8183: true, escrowStep: 'fund' },
    });
    return confirm(id);
  }

  return { ...store, deps, queue, settlement, getTransactionReceipt, signer, logger, receipts, confirm, txFor, fundConfirmed, chain };
}

function registeredIdentity(overrides: Partial<Row> = {}): Row {
  return {
    id: 'identity-x',
    agentId: PROVIDER.id,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    erc8004AgentId: '9598',
    status: 'REGISTERED',
    agentURI: AGENT_URI,
    registerTxHash: '0xfeed',
    error: null,
    ...overrides,
  };
}

function queuedSteps(queue: { add: ReturnType<typeof vi.fn> }): string[] {
  return queue.add.mock.calls.map((call) => call[0] as string);
}

// ── Happy path: first funded job of an unregistered provider ────────────────

describe('first funded job of an unregistered provider', () => {
  it('register from the provider wallet → Registered parsed → identity stored → setProviderAgentId → BOUND', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });

    await h.fundConfirmed('job-1');

    // Funding outcome itself is untouched by R2.
    expect(h.jobs.get('job-1')).toMatchObject({ onChainStatus: 'FUNDED', status: 'ACCEPTED', providerAgentIdStatus: 'BINDING', providerAgentId: null });
    expect([...h.identities.values()]).toEqual([
      expect.objectContaining({ agentId: PROVIDER.id, chainId: CHAIN_ID, registry: REGISTRY, status: 'REGISTERING', agentURI: AGENT_URI, erc8004AgentId: null }),
    ]);

    // register(agentURI) from the PROVIDER's wallet, to the registry, through the transaction queue.
    const registerTx = h.txFor(registerIntentId(PROVIDER.id, CHAIN_ID))!;
    expect(registerTx).toMatchObject({
      agentId: PROVIDER.id,
      type: 'ERC8004_IDENTITY',
      status: 'QUEUED',
      intentId: `erc8004:register:${PROVIDER.id}:${CHAIN_ID}`,
      metadata: expect.objectContaining({ jobId: 'job-1', erc8183: true, erc8004: true, escrowStep: 'register', registry: REGISTRY }),
    });
    const [name, payload] = h.queue.add.mock.calls.at(-1)!;
    expect(name).toBe('erc8183-register');
    expect(payload).toMatchObject({ transactionId: registerTx.id, from: PROVIDER.safeAddress, walletId: PROVIDER.walletId, agentId: PROVIDER.id, to: REGISTRY, value: '0' });
    expect((payload.data as Hex).slice(0, 10)).toBe(REGISTER_SELECTOR);
    const decoded = decodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, data: payload.data as Hex });
    expect(decoded.functionName).toBe('register');
    expect(decoded.args).toEqual([AGENT_URI]);

    // Register confirms; the receipt also carries a Registered-shaped log from another contract.
    await h.confirm(registerTx.id, 'CONFIRMED', (hash) => registerReceiptLogs(9598n, PROVIDER.safeAddress, hash, { withForeign: true }));

    const identity = [...h.identities.values()][0]!;
    expect(identity).toMatchObject({ status: 'REGISTERED', erc8004AgentId: '9598', registerTxHash: registerTx['txHash'], error: null });

    // setProviderAgentId(onChainJobId, agentId) from the provider wallet to the escrow.
    const bindTx = h.txFor(bindIntentId('job-1'))!;
    expect(bindTx).toMatchObject({ agentId: PROVIDER.id, type: 'ERC8004_IDENTITY', intentId: 'erc8183:bindAgent:job-1' });
    const [bindName, bindPayload] = h.queue.add.mock.calls.at(-1)!;
    expect(bindName).toBe('erc8183-bindAgent');
    expect(bindPayload).toMatchObject({ from: PROVIDER.safeAddress, walletId: PROVIDER.walletId, to: ESCROW });
    const bind = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: bindPayload.data as Hex });
    expect(bind.functionName).toBe('setProviderAgentId');
    expect(bind.args).toEqual([7n, 9598n]);
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'BINDING', providerAgentId: '9598' });

    await h.confirm(bindTx.id);
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'BOUND', providerAgentId: '9598', providerAgentIdError: null, onChainStatus: 'FUNDED' });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-register', 'erc8183-bindAgent']);

    const view = toJobResponse(h.jobs.get('job-1')!);
    expect(view.escrow).toMatchObject({ providerAgentId: '9598', providerAgentIdStatus: 'BOUND', providerAgentIdError: null, deferredSubmitAt: null });
  });

  it('a provider already REGISTERED on the chain gets only the bind step', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });

    await h.fundConfirmed('job-1');

    expect(h.txFor('erc8004:register:')).toBeUndefined();
    expect(queuedSteps(h.queue)).toEqual(['erc8183-bindAgent']);
    const bind = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: h.queue.add.mock.calls[0]![1].data as Hex });
    expect(bind.args).toEqual([7n, 9598n]);

    await h.confirm(h.txFor(bindIntentId('job-1'))!.id);
    expect(h.jobs.get('job-1')!['providerAgentIdStatus']).toBe('BOUND');
  });
});

// ── Concurrency ─────────────────────────────────────────────────────────────

describe('concurrent first jobs of the same unregistered provider', () => {
  it('mint once, then bind both jobs one after the other', async () => {
    const h = makeDeps({
      jobs: [fundedJob({ id: 'job-a', onChainJobId: '11' }), fundedJob({ id: 'job-b', onChainJobId: '12', createdAt: new Date(NOW.getTime() + 1000) })],
    });

    await Promise.all([h.fundConfirmed('job-a'), h.fundConfirmed('job-b')]);

    const registers = [...h.txs.values()].filter((t) => t['type'] === 'ERC8004_IDENTITY' && (t['metadata'] as Row)['escrowStep'] === 'register');
    expect(registers).toHaveLength(1);
    expect(h.identities.size).toBe(1);
    expect(h.jobs.get('job-a')!['providerAgentIdStatus']).toBe('BINDING');
    expect(h.jobs.get('job-b')!['providerAgentIdStatus']).toBe('BINDING');

    await h.confirm(registers[0]!.id, 'CONFIRMED', (hash) => registerReceiptLogs(42n, PROVIDER.safeAddress, hash));

    // One identity transaction in flight at a time per provider wallet: only job-a's bind so far.
    expect(h.txFor(bindIntentId('job-a'))).toBeDefined();
    expect(h.txFor(bindIntentId('job-b'))).toBeUndefined();
    expect(h.jobs.get('job-b')).toMatchObject({ providerAgentIdStatus: 'BINDING', providerAgentId: null });

    await h.confirm(h.txFor(bindIntentId('job-a'))!.id);
    expect(h.jobs.get('job-a')!['providerAgentIdStatus']).toBe('BOUND');
    const bindB = h.txFor(bindIntentId('job-b'))!;
    expect(decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: h.queue.add.mock.calls.at(-1)![1].data as Hex }).args).toEqual([12n, 42n]);

    await h.confirm(bindB.id);
    expect(h.jobs.get('job-b')!['providerAgentIdStatus']).toBe('BOUND');
    expect(queuedSteps(h.queue)).toEqual(['erc8183-register', 'erc8183-bindAgent', 'erc8183-bindAgent']);
  });

  it('a job funded between the claimer creating the identity row and enqueuing register waits (never fails the mint)', async () => {
    // The race window: job-a's call has created the REGISTERING row but not yet its register tx.
    const h = makeDeps({
      jobs: [fundedJob({ id: 'job-b', onChainJobId: '12' })],
      identities: [registeredIdentity({ status: 'REGISTERING', erc8004AgentId: null, registerTxHash: null, updatedAt: NOW })],
    });

    await h.fundConfirmed('job-b');

    expect([...h.identities.values()][0]!['status']).toBe('REGISTERING');
    expect(h.jobs.get('job-b')).toMatchObject({ providerAgentIdStatus: 'BINDING', providerAgentId: null });
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('a job that was cancelled while waiting for the registration is SKIPPED, the next one is bound', async () => {
    const h = makeDeps({
      jobs: [fundedJob({ id: 'job-a', onChainJobId: '11' }), fundedJob({ id: 'job-b', onChainJobId: '12', createdAt: new Date(NOW.getTime() + 1000) })],
    });
    await h.fundConfirmed('job-a');
    await h.fundConfirmed('job-b');
    Object.assign(h.jobs.get('job-a')!, { status: 'CANCELLED', onChainStatus: 'REJECTED' });

    await h.confirm(h.txFor('erc8004:register:')!.id, 'CONFIRMED', (hash) => registerReceiptLogs(42n, PROVIDER.safeAddress, hash));

    expect(h.jobs.get('job-a')).toMatchObject({ providerAgentIdStatus: 'SKIPPED' });
    expect(h.txFor(bindIntentId('job-a'))).toBeUndefined();
    expect(h.txFor(bindIntentId('job-b'))).toBeDefined();
  });
});

// ── Failures never block payment ────────────────────────────────────────────

describe('registration and binding failures', () => {
  it('register REVERTED → identity FAILED, binding FAILED, no bind, the job goes on', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');

    await h.confirm(h.txFor('erc8004:register:')!.id, 'REVERTED', undefined, 'execution reverted');

    expect([...h.identities.values()][0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('register REVERTED') });
    expect(h.jobs.get('job-1')).toMatchObject({
      providerAgentIdStatus: 'FAILED',
      providerAgentIdError: expect.stringContaining('ERC-8004 registration failed'),
      status: 'ACCEPTED',
      onChainStatus: 'FUNDED',
      escrowError: null,
    });
    expect(h.txFor(bindIntentId('job-1'))).toBeUndefined();
    expect(h.deps.releaseJobEscrow).not.toHaveBeenCalled();
    expect(h.settlement.add).not.toHaveBeenCalled();
  });

  it('register blocked by the pre-submit guard (FAILED, no hash) is handled the same way', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    await h.confirm(h.txFor('erc8004:register:')!.id, 'FAILED', undefined, 'Agent paused before submission');
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'FAILED', status: 'ACCEPTED' });
  });

  it('the next funded job retries a FAILED registration with a fresh intentId', async () => {
    const h = makeDeps({ jobs: [fundedJob(), fundedJob({ id: 'job-2', onChainJobId: '8', createdAt: new Date(NOW.getTime() + 1000) })] });
    await h.fundConfirmed('job-1');
    await h.confirm(h.txFor('erc8004:register:')!.id, 'REVERTED');

    await h.fundConfirmed('job-2');

    const registers = [...h.txs.values()].filter((t) => String(t['intentId']).startsWith(registerIntentId(PROVIDER.id, CHAIN_ID)));
    expect(registers).toHaveLength(2);
    expect(registers[1]!['intentId']).toBe(`${registerIntentId(PROVIDER.id, CHAIN_ID)}#${NOW.getTime()}`);
    expect([...h.identities.values()][0]).toMatchObject({ status: 'REGISTERING', error: null });
    expect(h.jobs.get('job-1')!['providerAgentIdStatus']).toBe('FAILED');
    expect(h.jobs.get('job-2')!['providerAgentIdStatus']).toBe('BINDING');
  });

  it('setProviderAgentId REVERTED → binding FAILED, identity stays REGISTERED', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });
    await h.fundConfirmed('job-1');
    await h.confirm(h.txFor(bindIntentId('job-1'))!.id, 'REVERTED', undefined, 'InvalidStatus');
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'FAILED', providerAgentIdError: expect.stringContaining('setProviderAgentId REVERTED') });
    expect([...h.identities.values()][0]!['status']).toBe('REGISTERED');
  });

  it('a register receipt without our Registered event → FAILED (a log from another address does not count)', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    const other = getAddress('0x000000000000000000000000000000000000beef');
    await h.confirm(h.txFor('erc8004:register:')!.id, 'CONFIRMED', (hash) => registerReceiptLogs(5n, PROVIDER.safeAddress, hash, { registry: other }));
    expect([...h.identities.values()][0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('Registered event') });
    expect(h.jobs.get('job-1')!['providerAgentIdStatus']).toBe('FAILED');
  });

  it('a Registered owner other than the provider wallet → FAILED', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    await h.confirm(h.txFor('erc8004:register:')!.id, 'CONFIRMED', (hash) => registerReceiptLogs(5n, REQUESTER.safeAddress, hash));
    expect([...h.identities.values()][0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('is not the provider wallet') });
  });

  it('agent id 0 (first mint of a fresh registry) is SKIPPED: the escrow treats 0 as "clear"', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    await h.confirm(h.txFor('erc8004:register:')!.id, 'CONFIRMED', (hash) => registerReceiptLogs(0n, PROVIDER.safeAddress, hash));
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'SKIPPED', providerAgentIdError: 'agent-id-zero' });
    expect(h.txFor(bindIntentId('job-1'))).toBeUndefined();
  });

  it('an unreadable register receipt leaves the identity REGISTERING (no second mint) and recovery repairs it', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    const registerTx = h.txFor('erc8004:register:')!;
    h.getTransactionReceipt.mockRejectedValueOnce(new Error('rpc down'));
    await h.confirm(registerTx.id, 'CONFIRMED', (hash) => registerReceiptLogs(77n, PROVIDER.safeAddress, hash));
    expect([...h.identities.values()][0]!['status']).toBe('REGISTERING');

    // Provider completes meanwhile → deferred; the recovery scan replays the register outcome.
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    expect(await enqueueSubmit(h.deps, { jobId: 'job-1', result: { ok: true } })).toEqual({ deferred: true });
    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('awaitingBinding');
    expect([...h.identities.values()][0]).toMatchObject({ status: 'REGISTERED', erc8004AgentId: '77' });
    expect(h.txFor(bindIntentId('job-1'))).toBeDefined();
    expect(h.txFor('erc8183:submit:')).toBeUndefined();
    expect([...h.txs.values()].filter((t) => String(t['intentId']).startsWith('erc8004:register:'))).toHaveLength(1);
  });
});

// ── Chains without the identity flow ────────────────────────────────────────

describe('chains without a reputation hook or identity registry', () => {
  it.each([
    [NO_HOOK_CHAIN, 'no-reputation-hook'],
    [NO_REGISTRY_CHAIN, 'no-identity-registry'],
  ])('chain %i → SKIPPED (%s), nothing enqueued, submit is immediate', async (chainId, reason) => {
    const h = makeDeps({ jobs: [fundedJob({ escrowChainId: chainId })] });
    await h.fundConfirmed('job-1');

    expect(h.jobs.get('job-1')).toMatchObject({ onChainStatus: 'FUNDED', providerAgentIdStatus: 'SKIPPED', providerAgentIdError: reason });
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.identities.size).toBe(0);

    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    expect(await enqueueSubmit(h.deps, { jobId: 'job-1', result: { done: 1 } })).toEqual({ deferred: false });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-submit']);
  });
});

// ── Ordering: bind before submit ────────────────────────────────────────────

describe('PATCH COMPLETED while the binding is in flight', () => {
  it('defers submit while BINDING and enqueues it only after BOUND', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });
    await h.fundConfirmed('job-1');
    const bindTx = h.txFor(bindIntentId('job-1'))!;

    // The route has moved the job to PAYMENT_PENDING before calling enqueueSubmit.
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING', result: { answer: 42 } });
    const res = await enqueueSubmit(h.deps, { jobId: 'job-1', result: { answer: 42 } });

    expect(res).toEqual({ deferred: true });
    expect(h.txFor('erc8183:submit:')).toBeUndefined();
    expect(h.jobs.get('job-1')).toMatchObject({ deferredSubmitAt: NOW, status: 'PAYMENT_PENDING' });
    const deliverable = h.jobs.get('job-1')!['deliverableHash'] as Hex;
    expect(deliverable).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toJobResponse(h.jobs.get('job-1')!).escrow).toMatchObject({ providerAgentIdStatus: 'BINDING', deferredSubmitAt: NOW });

    await h.confirm(bindTx.id);

    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'BOUND', deferredSubmitAt: null });
    const submitTx = h.txFor('erc8183:submit:')!;
    expect(submitTx).toMatchObject({ agentId: PROVIDER.id, type: 'ESCROW_SUBMIT', intentId: 'erc8183:submit:job-1' });
    // Order on the provider wallet: setProviderAgentId strictly before submit.
    expect(queuedSteps(h.queue)).toEqual(['erc8183-bindAgent', 'erc8183-submit']);
    expect((submitTx['seq'] as number) > (bindTx['seq'] as number)).toBe(true);
    const submit = decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: h.queue.add.mock.calls.at(-1)![1].data as Hex });
    expect(submit.functionName).toBe('submit');
    expect(submit.args).toEqual([7n, deliverable, '0x']);

    // A redelivered bind outcome does not send the submit twice.
    await onEscrowTxOutcome(h.deps, { transactionId: bindTx.id, status: 'CONFIRMED' });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-bindAgent', 'erc8183-submit']);
  });

  it('defers submit while the registration is pending and releases it when the binding FAILS', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    expect(await enqueueSubmit(h.deps, { jobId: 'job-1', result: {} })).toEqual({ deferred: true });

    await h.confirm(h.txFor('erc8004:register:')!.id, 'CONFIRMED', (hash) => registerReceiptLogs(9n, PROVIDER.safeAddress, hash));
    expect(h.txFor('erc8183:submit:')).toBeUndefined(); // the bind is in flight now

    await h.confirm(h.txFor(bindIntentId('job-1'))!.id, 'REVERTED', undefined, 'InvalidStatus');

    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'FAILED', deferredSubmitAt: null, status: 'PAYMENT_PENDING' });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-register', 'erc8183-bindAgent', 'erc8183-submit']);
  });

  it('releases the deferred submit when the registration itself fails', async () => {
    const h = makeDeps({ jobs: [fundedJob()] });
    await h.fundConfirmed('job-1');
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    await enqueueSubmit(h.deps, { jobId: 'job-1', result: {} });

    await h.confirm(h.txFor('erc8004:register:')!.id, 'FAILED', undefined, 'insufficient funds for gas');

    expect(h.jobs.get('job-1')!['providerAgentIdStatus']).toBe('FAILED');
    expect(queuedSteps(h.queue)).toEqual(['erc8183-register', 'erc8183-submit']);
  });

  it('submits immediately when the binding is already terminal, and for jobs funded before R2 (status null)', async () => {
    for (const providerAgentIdStatus of ['BOUND', 'FAILED', 'SKIPPED', null]) {
      const h = makeDeps({ jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus })] });
      expect(await enqueueSubmit(h.deps, { jobId: 'job-1', result: { x: 1 } })).toEqual({ deferred: false });
      expect(queuedSteps(h.queue)).toEqual(['erc8183-submit']);
      expect(h.jobs.get('job-1')!['deferredSubmitAt']).toBeNull();
    }
  });

  it('drops a deferred submit if the job expired and was refunded meanwhile', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });
    await h.fundConfirmed('job-1');
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    await enqueueSubmit(h.deps, { jobId: 'job-1', result: {} });
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_FAILED', onChainStatus: 'EXPIRED' });

    await h.confirm(h.txFor(bindIntentId('job-1'))!.id, 'REVERTED');

    expect(h.txFor('erc8183:submit:')).toBeUndefined();
    expect(h.jobs.get('job-1')!['deferredSubmitAt']).toBeNull();
  });
});

// ── Payment recovery ────────────────────────────────────────────────────────

describe('payment recovery of a job whose submit is deferred', () => {
  it('waits while the bind is in flight (never releases the submit before the bind)', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });
    await h.fundConfirmed('job-1');
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    await enqueueSubmit(h.deps, { jobId: 'job-1', result: {} });

    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('awaitingBinding');
    expect(h.txFor('erc8183:submit:')).toBeUndefined();
    expect(h.jobs.get('job-1')!['status']).toBe('PAYMENT_PENDING');
  });

  it('replays a bind outcome that was lost (tx CONFIRMED, job still BINDING) and releases the submit', async () => {
    const h = makeDeps({ jobs: [fundedJob()], identities: [registeredIdentity()] });
    await h.fundConfirmed('job-1');
    Object.assign(h.jobs.get('job-1')!, { status: 'PAYMENT_PENDING' });
    await enqueueSubmit(h.deps, { jobId: 'job-1', result: {} });
    Object.assign(h.txFor(bindIntentId('job-1'))!, { status: 'CONFIRMED', txHash: nextHash() }); // crash before the outcome hook

    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('submitReleased');
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'BOUND', deferredSubmitAt: null });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-bindAgent', 'erc8183-submit']);
  });

  it('fails a registration whose claimer died (REGISTERING, no register tx, past the grace period) and releases the submit', async () => {
    const claimedAt = new Date(NOW.getTime() - 10 * 60_000);
    const h = makeDeps({
      jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus: 'BINDING', deferredSubmitAt: claimedAt })],
      identities: [registeredIdentity({ status: 'REGISTERING', erc8004AgentId: null, updatedAt: claimedAt })],
    });

    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('submitReleased');
    expect([...h.identities.values()][0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('without a live register transaction') });
    expect(h.jobs.get('job-1')).toMatchObject({ providerAgentIdStatus: 'FAILED', deferredSubmitAt: null });
    expect(queuedSteps(h.queue)).toEqual(['erc8183-submit']);
  });

  it('keeps waiting on a REGISTERING row inside the grace period', async () => {
    const h = makeDeps({
      jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus: 'BINDING', deferredSubmitAt: NOW })],
      identities: [registeredIdentity({ status: 'REGISTERING', erc8004AgentId: null, updatedAt: new Date(NOW.getTime() - 5_000) })],
    });
    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('awaitingBinding');
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('keeps the C3 behaviour for a FUNDED job without a deferred submit', async () => {
    const h = makeDeps({ jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'FUNDED', providerAgentIdStatus: 'BOUND' })] });
    h.chain.status = CHAIN_JOB_STATUS.Funded; // C3c: handed back only when the chain confirms nothing was submitted
    expect(await recoverErc8183Job(h.deps, { id: 'job-1', onChainStatus: 'FUNDED' })).toBe('returnedToAccepted');
    expect(h.jobs.get('job-1')!['status']).toBe('ACCEPTED');
  });
});

// ── Settlement unchanged ────────────────────────────────────────────────────

describe('settlement of jobs already submitted', () => {
  it('a pre-R2 job (no binding) settles exactly as in C3 and reports the hook skip', async () => {
    const h = makeDeps({
      jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', deliverableHash: `0x${'ab'.repeat(32)}` })],
      txs: [{ id: 'tx-fund', intentId: 'erc8183:fund:job-1', status: 'CONFIRMED', txHash: `0x${'cd'.repeat(32)}`, seq: 0 }],
    });
    const skipped = makeLog(
      REPUTATION_HOOK_ABI,
      'FeedbackSkipped',
      { jobId: 7n, reason: `0x${Buffer.from('no-agent-id').toString('hex').padEnd(64, '0')}` },
      HOOK,
      nextHash(),
    );
    const completed = makeLog(AGENT_JOB_ESCROW_ABI, 'JobCompleted', { jobId: 7n, evaluator: EVALUATOR, reason: `0x${'00'.repeat(32)}` }, ESCROW, nextHash());
    h.signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [completed, skipped] });

    const result = await processSettlementJob(h.deps, { data: { jobId: 'job-1', action: 'settle' } });

    expect(result).toMatchObject({ outcome: 'settled', onChainStatus: 'COMPLETED', feedbackStatus: 'skipped:no-agent-id' });
    expect(h.signer.writeContract).toHaveBeenCalledTimes(1);
    expect(h.queue.add).not.toHaveBeenCalled(); // no identity step is ever sent from settlement
    expect(h.identities.size).toBe(0);
  });

  it('a BOUND job settles through the same path and records the written feedback', async () => {
    const h = makeDeps({
      jobs: [fundedJob({ status: 'PAYMENT_PENDING', onChainStatus: 'SUBMITTED', providerAgentId: '9598', providerAgentIdStatus: 'BOUND' })],
      identities: [registeredIdentity()],
    });
    const log = makeLog(REPUTATION_HOOK_ABI, 'FeedbackWritten', { jobId: 7n, agentId: 9598n, value: 100n }, HOOK, nextHash());
    const completed = makeLog(AGENT_JOB_ESCROW_ABI, 'JobCompleted', { jobId: 7n, evaluator: EVALUATOR, reason: `0x${'00'.repeat(32)}` }, ESCROW, nextHash());
    h.signer.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [completed, log] });

    const result = await processSettlementJob(h.deps, { data: { jobId: 'job-1', action: 'settle' } });
    expect(result).toMatchObject({ outcome: 'settled', feedbackStatus: 'written' });
    expect(h.jobs.get('job-1')).toMatchObject({ feedbackStatus: 'written', providerAgentIdStatus: 'BOUND' });
  });
});
