/**
 * C5a — full rehearsal of the ERC-8183 escrow + ERC-8004 reputation flow
 * against a local Anvil fork of Base Sepolia, driven over HTTP like an agent.
 *
 *   E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run test:e2e:escrow-fork
 *
 * Real on the fork: Circle testnet USDC, the ERC-8004 Identity + Reputation
 * registries (v2.0.0), chain id 84532. Deployed fresh by globalSetup with the
 * C4 runbook script: AgentJobEscrow + ReputationHook. The backend runs as a
 * child process (`src/index.ts`, WALLET_PROVIDER=local, RPC_URL_84532 → Anvil,
 * transaction + escrow settlement workers), so every contract call the real
 * C5 makes is exercised here. Skipped (not failed) without E2E_ANVIL_FORK_URL.
 *
 * Paths: happy (fund → bind identity → submit → complete → fee + feedback),
 * contest (reject → full refund, feedback 0 "rejected"), cancellation while
 * FUNDED (reject → full refund, no feedback), expiry (claimRefund after
 * expiredAt), and the `examples/escrow-erc8183` script end to end.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getAddress, keccak256, parseEventLogs, toBytes, type Address, type Hex, type Log } from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';
import {
  IDENTITY_REGISTRY_READ_ABI,
  PLATFORM_FEE_BPS,
  REPO_ROOT,
  REPUTATION_REGISTRY_ABI,
  call,
  forkClient,
  rpc,
  setEthBalance,
  setUsdcBalance,
  startBackend,
  usdcBalanceOf,
  waitFor,
  type BackendHandle,
  type EscrowForkContext,
} from './escrow-fork.harness.js';

const ctx = inject('escrowFork');

// ── Types of the API responses the suite reads ─────────────────────────────

interface EscrowView {
  kind: string;
  chainId: number;
  contract: string;
  onChainJobId: string | null;
  onChainStatus: string | null;
  evaluator: string | null;
  budgetAmount: string | null;
  budgetToken: string | null;
  expiresAt: string | null;
  deliverableHash: string | null;
  settleTxHash: Hex | null;
  platformFeeAmount: string | null;
  feedbackStatus: string | null;
  contestedAt: string | null;
  escrowError: string | null;
  providerAgentId: string | null;
  providerAgentIdStatus: string | null;
  providerAgentIdError: string | null;
  deferredSubmitAt: string | null;
}

interface JobView {
  id: string;
  status: string;
  escrow: EscrowView | null;
}

interface Agent {
  id: string;
  name: string;
  apiKey: string;
  address: Address;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const CHAIN_JOB_STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 } as const;
const BUDGET = '2.5';
const BUDGET_UNITS = 2_500_000n;
const FEE_UNITS = (BUDGET_UNITS * PLATFORM_FEE_BPS) / 10_000n; // 7 500 = 0.0075 USDC
const REQUESTER_USDC = 10_000_000n; // 10 USDC
const GAS_ETH = 10n ** 17n; // 0.1 ETH each

function summary(job: JobView): string {
  const e = job.escrow;
  return JSON.stringify({
    status: job.status,
    onChainStatus: e?.onChainStatus,
    onChainJobId: e?.onChainJobId,
    binding: e?.providerAgentIdStatus,
    providerAgentId: e?.providerAgentId,
    feedbackStatus: e?.feedbackStatus,
    escrowError: e?.escrowError,
    providerAgentIdError: e?.providerAgentIdError,
  });
}

async function registerAgent(backend: BackendHandle, fork: EscrowForkContext, name: string): Promise<Agent> {
  const res = await call<{ id: string; apiKey: string; safeAddress: string }>(backend.url, '/v1/agents', {
    method: 'POST',
    apiKey: fork.apiSecret,
    body: { name, chainIds: [fork.chainId] },
  });
  expect(res.status, res.raw).toBe(201);
  return { id: res.body.id, name, apiKey: res.body.apiKey, address: getAddress(res.body.safeAddress) };
}

/** Registers a requester + provider and funds them on the fork: gas for both, USDC for the requester. */
async function fundedPair(backend: BackendHandle, fork: EscrowForkContext, label: string): Promise<{ requester: Agent; provider: Agent }> {
  const stamp = Date.now();
  const requester = await registerAgent(backend, fork, `c5a-${label}-requester-${stamp}`);
  const provider = await registerAgent(backend, fork, `c5a-${label}-provider-${stamp}`);
  await setEthBalance(fork.anvilRpc, requester.address, GAS_ETH);
  await setEthBalance(fork.anvilRpc, provider.address, GAS_ETH);
  await setUsdcBalance(fork.anvilRpc, fork.usdc, requester.address, REQUESTER_USDC);
  return { requester, provider };
}

async function getJob(backend: BackendHandle, apiKey: string, jobId: string): Promise<JobView> {
  const res = await call<JobView>(backend.url, `/v1/jobs/${jobId}`, { apiKey });
  if (res.status !== 200) throw new Error(`GET /v1/jobs/${jobId} → ${res.status}: ${res.raw}`);
  return res.body;
}

/** Polls the job as an agent would until `done`; a FAILED funding chain or an unexpected terminal status fails fast. */
async function waitForJob(
  backend: BackendHandle,
  apiKey: string,
  jobId: string,
  what: string,
  done: (job: JobView) => boolean,
  opts: { timeoutMs?: number; allowFailed?: boolean } = {},
): Promise<JobView> {
  try {
    return await waitFor(`job ${jobId}: ${what}`, () => getJob(backend, apiKey, jobId), done, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      describe: summary,
      fail: (job) => {
        if (opts.allowFailed) return null;
        if (job.escrow?.onChainStatus === 'FAILED') return `escrow funding chain FAILED: ${job.escrow.escrowError}`;
        if (job.status === 'FAILED' || job.status === 'PAYMENT_FAILED') return `job ${job.status}: ${summary(job)}`;
        return null;
      },
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- backend log (tail) ---\n${backend.logTail(60)}`);
  }
}

async function createUsdcJob(backend: BackendHandle, fork: EscrowForkContext, requester: Agent, provider: Agent, payload: Record<string, unknown>): Promise<JobView> {
  const res = await call<JobView>(backend.url, '/v1/jobs', {
    method: 'POST',
    apiKey: requester.apiKey,
    body: { providerId: provider.id, payload, reward: { amount: BUDGET, token: 'USDC', chainId: fork.chainId } },
  });
  expect(res.status, res.raw).toBe(201);
  expect(res.body.escrow?.kind).toBe('erc8183');
  expect(res.body.escrow?.onChainStatus).toBe('CREATING');
  expect(res.body.escrow?.budgetAmount).toBe(BUDGET_UNITS.toString());
  expect(getAddress(res.body.escrow!.evaluator!)).toBe(fork.evaluator);
  return res.body;
}

async function patchJob(backend: BackendHandle, apiKey: string, jobId: string, body: Record<string, unknown>): Promise<JobView> {
  const res = await call<JobView>(backend.url, `/v1/jobs/${jobId}`, { method: 'PATCH', apiKey, body });
  expect(res.status, res.raw).toBe(200);
  return res.body;
}

interface SettlementEvents {
  escrow: Array<{ eventName: string; args: Record<string, unknown> }>;
  hook: Array<{ eventName: string; args: Record<string, unknown> }>;
  feedback: Array<{
    agentId: bigint;
    clientAddress: Address;
    feedbackIndex: bigint;
    value: bigint;
    valueDecimals: number;
    tag1: string;
    tag2: string;
    endpoint: string;
    feedbackURI: string;
    feedbackHash: Hex;
  }>;
}

async function settlementEvents(fork: EscrowForkContext, txHash: Hex): Promise<SettlementEvents> {
  const receipt = await forkClient(fork.anvilRpc).getTransactionReceipt({ hash: txHash });
  expect(receipt.status).toBe('success');
  const from = (address: Address) => receipt.logs.filter((log) => getAddress(log.address) === address) as Log[];
  const escrow = parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs: from(fork.escrow) }) as unknown as SettlementEvents['escrow'];
  const hook = parseEventLogs({ abi: REPUTATION_HOOK_ABI, logs: from(fork.hook) }) as unknown as SettlementEvents['hook'];
  const feedback = parseEventLogs({ abi: REPUTATION_REGISTRY_ABI, eventName: 'NewFeedback', logs: from(fork.reputationRegistry) }).map(
    (event) => ({ ...event.args, clientAddress: getAddress(event.args.clientAddress) }),
  ) as SettlementEvents['feedback'];
  return { escrow, hook, feedback };
}

async function readChainJob(fork: EscrowForkContext, onChainJobId: string) {
  return forkClient(fork.anvilRpc).readContract({
    address: fork.escrow,
    abi: AGENT_JOB_ESCROW_ABI,
    functionName: 'getJob',
    args: [BigInt(onChainJobId)],
  }) as Promise<{ client: Address; provider: Address; evaluator: Address; budget: bigint; expiredAt: bigint; status: number; hook: Address }>;
}

async function pendingPlatformFees(fork: EscrowForkContext): Promise<bigint> {
  return forkClient(fork.anvilRpc).readContract({ address: fork.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'pendingPlatformFees' }) as Promise<bigint>;
}

/** The fund tx of an on-chain job, from the escrow's JobFunded log (the feedback file's proofOfPayment). */
async function fundTxHash(fork: EscrowForkContext, onChainJobId: string): Promise<Hex> {
  const logs = await forkClient(fork.anvilRpc).getContractEvents({
    address: fork.escrow,
    abi: AGENT_JOB_ESCROW_ABI,
    eventName: 'JobFunded',
    fromBlock: BigInt(fork.forkBlockNumber),
  });
  const match = logs.find((log) => (log.args as { jobId?: bigint }).jobId === BigInt(onChainJobId));
  if (!match?.transactionHash) throw new Error(`no JobFunded log for on-chain job ${onChainJobId}`);
  return match.transactionHash;
}

/** Fetches the public feedback file as raw bytes (the hash is over the exact body). */
async function fetchFeedbackFile(backend: BackendHandle, jobId: string): Promise<{ status: number; bytes: Uint8Array; json: Record<string, unknown> | null; contentType: string | null }> {
  const res = await fetch(`${backend.url}/v1/jobs/${jobId}/feedback.json`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, bytes, json, contentType: res.headers.get('content-type') };
}

function log(msg: string): void {
  console.log(`[c5a] ${msg}`);
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe.skipIf(!ctx)('ERC-8183 escrow + ERC-8004 reputation on a Base Sepolia fork (C5a)', () => {
  const fork = ctx!;

  beforeAll(async () => {
    log(
      `fork block ${fork.forkBlockNumber} · chain ${fork.chainId} · AgentJobEscrow ${fork.escrow} · ReputationHook ${fork.hook} · ` +
        `evaluator ${fork.evaluator} · fee wallet ${fork.feeWallet}`,
    );
    const client = forkClient(fork.anvilRpc);
    const [chainId, symbol, identityVersion, reputationVersion, reputationIdentity] = await Promise.all([
      client.getChainId(),
      client.readContract({ address: fork.usdc, abi: [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const, functionName: 'symbol' }),
      client.readContract({ address: fork.identityRegistry, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'getVersion' }),
      client.readContract({ address: fork.reputationRegistry, abi: REPUTATION_REGISTRY_ABI, functionName: 'getVersion' }),
      client.readContract({ address: fork.reputationRegistry, abi: REPUTATION_REGISTRY_ABI, functionName: 'getIdentityRegistry' }),
    ]);
    expect(chainId).toBe(84532);
    expect(symbol).toBe('USDC');
    expect(identityVersion).toBe('2.0.0');
    expect(reputationVersion).toBe('2.0.0');
    expect(getAddress(reputationIdentity)).toBe(fork.identityRegistry);
  });

  // ── Backend A: ESCROW_EVALUATION_DELAY_SECONDS=0 ─────────────────────────
  describe('evaluation delay 0', () => {
    let backend: BackendHandle;

    beforeAll(async () => {
      backend = await startBackend(fork, { name: 'delay0', overrides: { ESCROW_EVALUATION_DELAY_SECONDS: '0' } });
      log(`backend (delay 0) on ${backend.url} — log ${backend.logFile}`);
    });
    afterAll(async () => {
      await backend?.stop();
    });

    it('happy path: fund → ERC-8004 bind → submit → complete; payout, 30 bps fee and hook feedback on-chain', async () => {
      const { requester, provider } = await fundedPair(backend, fork, 'happy');
      const [requesterBefore, providerBefore, feesBefore, escrowUsdcBefore] = await Promise.all([
        usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address),
        usdcBalanceOf(fork.anvilRpc, fork.usdc, provider.address),
        pendingPlatformFees(fork),
        usdcBalanceOf(fork.anvilRpc, fork.usdc, fork.escrow),
      ]);
      expect(requesterBefore).toBe(REQUESTER_USDC);

      // 1. requester: POST /v1/jobs → createJob → setBudget → approve → fund (requester wallet)
      const created = await createUsdcJob(backend, fork, requester, provider, { task: 'summarise the Base Sepolia fork', format: 'markdown' });
      const funded = await waitForJob(backend, requester.apiKey, created.id, 'FUNDED', (j) => j.escrow?.onChainStatus === 'FUNDED');
      const onChainJobId = funded.escrow!.onChainJobId!;
      log(`happy: job ${created.id} funded on-chain as #${onChainJobId}`);

      const chainFunded = await readChainJob(fork, onChainJobId);
      expect(chainFunded.status).toBe(CHAIN_JOB_STATUS.Funded);
      expect(getAddress(chainFunded.client)).toBe(requester.address);
      expect(getAddress(chainFunded.provider)).toBe(provider.address);
      expect(getAddress(chainFunded.evaluator)).toBe(fork.evaluator);
      expect(getAddress(chainFunded.hook)).toBe(fork.hook);
      expect(chainFunded.budget).toBe(BUDGET_UNITS);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address)).toBe(REQUESTER_USDC - BUDGET_UNITS);

      // 2. provider accepts (only allowed once FUNDED)
      await patchJob(backend, provider.apiKey, created.id, { status: 'ACCEPTED' });

      // 3. R2: provider wallet registers its ERC-8004 identity (first funded job) and binds it
      const bound = await waitForJob(backend, provider.apiKey, created.id, 'ERC-8004 binding BOUND', (j) => j.escrow?.providerAgentIdStatus === 'BOUND', {
        timeoutMs: 120_000,
      });
      const agentId = BigInt(bound.escrow!.providerAgentId!);
      log(`happy: provider ${provider.address} is ERC-8004 agent #${agentId}, bound to on-chain job #${onChainJobId}`);

      // 4. provider delivers → submit(keccak256(result)) → evaluator complete (delay 0)
      const result = { summary: 'Fork rehearsal deliverable', items: 3 };
      const submitted = await patchJob(backend, provider.apiKey, created.id, { status: 'COMPLETED', result });
      expect(submitted.status).toBe('PAYMENT_PENDING');
      const completed = await waitForJob(backend, requester.apiKey, created.id, 'COMPLETED', (j) => j.status === 'COMPLETED', { timeoutMs: 120_000 });
      const settleTx = completed.escrow!.settleTxHash!;
      log(`happy: settled by evaluator in ${settleTx}`);

      // ── on-chain ────────────────────────────────────────────────────────
      const chainDone = await readChainJob(fork, onChainJobId);
      expect(chainDone.status).toBe(CHAIN_JOB_STATUS.Completed);

      const [requesterAfter, providerAfter, feesAfter, escrowUsdcAfter] = await Promise.all([
        usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address),
        usdcBalanceOf(fork.anvilRpc, fork.usdc, provider.address),
        pendingPlatformFees(fork),
        usdcBalanceOf(fork.anvilRpc, fork.usdc, fork.escrow),
      ]);
      expect(FEE_UNITS).toBe(7_500n);
      expect(requesterAfter).toBe(requesterBefore - BUDGET_UNITS);
      expect(providerAfter - providerBefore).toBe(BUDGET_UNITS - FEE_UNITS);
      expect(feesAfter - feesBefore).toBe(FEE_UNITS);
      expect(escrowUsdcAfter - escrowUsdcBefore).toBe(FEE_UNITS); // accrued fee stays in the escrow until withdrawPlatformFees

      const events = await settlementEvents(fork, settleTx);
      const escrowEventNames = events.escrow.map((e) => e.eventName);
      expect(escrowEventNames).toEqual(expect.arrayContaining(['JobCompleted', 'PaymentReleased', 'PlatformFeeAccrued']));
      expect(events.escrow.find((e) => e.eventName === 'PaymentReleased')!.args['amount']).toBe(BUDGET_UNITS - FEE_UNITS);
      expect(events.escrow.find((e) => e.eventName === 'PlatformFeeAccrued')!.args['amount']).toBe(FEE_UNITS);

      const written = events.hook.find((e) => e.eventName === 'FeedbackWritten');
      expect(written, `hook events: ${JSON.stringify(events.hook, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`).toBeDefined();
      expect(written!.args['jobId']).toBe(BigInt(onChainJobId));
      expect(written!.args['agentId']).toBe(agentId);
      expect(written!.args['value']).toBe(100n);

      expect(events.feedback).toHaveLength(1);
      const feedback = events.feedback[0]!;
      expect(feedback.agentId).toBe(agentId);
      expect(feedback.clientAddress).toBe(fork.hook); // the hook is the canonical clientAddress
      expect(feedback.value).toBe(100n);
      expect(feedback.valueDecimals).toBe(0);
      expect(feedback.tag1).toBe('agentfi.job');
      expect(feedback.tag2).toBe('completed');
      expect(feedback.feedbackURI).toBe(`${backend.url}/v1/jobs/${created.id}/feedback.json`);

      const client = forkClient(fork.anvilRpc);
      const [boundId, owner, agentWallet, tokenURI, summaryAll] = await Promise.all([
        client.readContract({ address: fork.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'providerAgentId', args: [BigInt(onChainJobId)] }),
        client.readContract({ address: fork.identityRegistry, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'ownerOf', args: [agentId] }),
        client.readContract({ address: fork.identityRegistry, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'getAgentWallet', args: [agentId] }),
        client.readContract({ address: fork.identityRegistry, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'tokenURI', args: [agentId] }),
        client.readContract({ address: fork.reputationRegistry, abi: REPUTATION_REGISTRY_ABI, functionName: 'getSummary', args: [agentId, [fork.hook], 'agentfi.job', ''] }),
      ]);
      expect(boundId).toBe(agentId);
      expect(getAddress(owner)).toBe(provider.address);
      expect(getAddress(agentWallet)).toBe(provider.address);
      expect(tokenURI).toBe(`${backend.url}/v1/agents/${provider.id}/erc8004.json`);
      const [count, summaryValue, summaryDecimals] = summaryAll;
      log(`happy: getSummary(#${agentId}, [hook], "agentfi.job", "") = count ${count}, value ${summaryValue}, decimals ${summaryDecimals}`);
      expect(count).toBe(1n);
      expect(summaryValue).toBe(100n * 10n ** BigInt(summaryDecimals));

      // ── off-chain ───────────────────────────────────────────────────────
      expect(completed.escrow!.onChainStatus).toBe('COMPLETED');
      expect(completed.escrow!.platformFeeAmount).toBe(FEE_UNITS.toString());
      expect(completed.escrow!.feedbackStatus).toBe('written');
      expect(completed.escrow!.deliverableHash).toBe(keccak256(toBytes(JSON.stringify(result))));

      const file = await fetchFeedbackFile(backend, created.id); // public: no API key
      expect(file.status).toBe(200);
      expect(file.contentType).toMatch(/application\/json/);
      expect(keccak256(file.bytes)).toBe(feedback.feedbackHash);
      expect(file.json).toMatchObject({
        type: 'https://eips.ethereum.org/EIPS/eip-8004#feedback-v1',
        jobId: created.id,
        outcome: 'completed',
        deliverableHash: keccak256(toBytes(JSON.stringify(result))),
        escrow: { chainId: 84532, contract: fork.escrow, onChainJobId: Number(onChainJobId) },
        proofOfPayment: { chainId: 84532, txHash: await fundTxHash(fork, onChainJobId), fromAddress: requester.address, toAddress: fork.escrow },
      });
      expect(getAddress(String(file.json!['evaluator']))).toBe(fork.evaluator);

      // the agentURI minted into the Identity Registry resolves to the registration file
      const registration = await call<{ registrations: Array<{ agentId: number | string; agentRegistry: string }> }>(backend.url, `/v1/agents/${provider.id}/erc8004.json`);
      expect(registration.status).toBe(200);
      expect(registration.body.registrations).toContainEqual({ agentId: Number(agentId), agentRegistry: `eip155:84532:${fork.identityRegistry}` });
    });

    it('cancellation while FUNDED: evaluator reject, full refund, no feedback', async () => {
      const { requester, provider } = await fundedPair(backend, fork, 'cancel');
      const feesBefore = await pendingPlatformFees(fork);

      const created = await createUsdcJob(backend, fork, requester, provider, { task: 'will be cancelled' });
      const funded = await waitForJob(backend, requester.apiKey, created.id, 'FUNDED', (j) => j.escrow?.onChainStatus === 'FUNDED');
      const onChainJobId = funded.escrow!.onChainJobId!;
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address)).toBe(REQUESTER_USDC - BUDGET_UNITS);

      const cancelled = await patchJob(backend, requester.apiKey, created.id, { status: 'CANCELLED' });
      expect(cancelled.status).toBe('CANCELLED');
      const rejected = await waitForJob(backend, requester.apiKey, created.id, 'REJECTED on-chain', (j) => j.escrow?.onChainStatus === 'REJECTED', {
        allowFailed: true,
      });
      log(`cancel: job ${created.id} (#${onChainJobId}) refunded by evaluator reject ${rejected.escrow!.settleTxHash}`);

      const chainJob = await readChainJob(fork, onChainJobId);
      expect(chainJob.status).toBe(CHAIN_JOB_STATUS.Rejected);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address)).toBe(REQUESTER_USDC);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, provider.address)).toBe(0n);
      expect(await pendingPlatformFees(fork)).toBe(feesBefore);

      const events = await settlementEvents(fork, rejected.escrow!.settleTxHash!);
      expect(events.escrow.map((e) => e.eventName)).toEqual(expect.arrayContaining(['JobRejected', 'Refunded']));
      expect(events.feedback).toHaveLength(0);
      const skipped = events.hook.find((e) => e.eventName === 'FeedbackSkipped');
      expect(skipped).toBeDefined();
      // A cancellation reject carries no optParams ("0x", erc-8183-mapping §6.4), so the
      // hook's first gate already skips it — before the `not-submitted` gate.
      expect(rejected.escrow!.feedbackStatus).toBe('skipped:no-params');
      expect(rejected.status).toBe('CANCELLED');
      expect((await fetchFeedbackFile(backend, created.id)).status).toBe(404);

      // Let the provider's identity transactions (started at FUNDED) settle before the backend stops.
      const settledBinding = await waitForJob(
        backend,
        requester.apiKey,
        created.id,
        'binding terminal',
        (j) => j.escrow?.providerAgentIdStatus !== 'BINDING',
        { allowFailed: true, timeoutMs: 90_000 },
      );
      log(`cancel: provider binding ended ${settledBinding.escrow!.providerAgentIdStatus} (${settledBinding.escrow!.providerAgentIdError ?? 'no error'})`);
    });

    it.each([
      ['happy', 'Escrow flow completed end to end', 'feedback written'],
      ['cancel', 'Escrow cancellation refunded end to end', 'requester got     2.500000 USDC back'],
    ])('examples/escrow-erc8183 (AGENTFI_FLOW=%s) runs end to end against this backend', async (flow, done, detail) => {
      const script = join(REPO_ROOT, 'examples', 'escrow-erc8183', 'index.mjs');
      const child = spawn(process.execPath, [script], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENTFI_API_URL: backend.url,
          AGENTFI_OPERATOR_SECRET: fork.apiSecret,
          AGENTFI_CHAIN_ID: String(fork.chainId),
          AGENTFI_RPC_URL: fork.anvilRpc,
          AGENTFI_FORK_FUNDING: 'true',
          AGENTFI_FLOW: flow,
          AGENTFI_REWARD_USDC: BUDGET,
          AGENTFI_POLL_INTERVAL_MS: '1000',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      if (code !== 0) throw new Error(`example exited ${code}:\n${output}\n--- backend log (tail) ---\n${backend.logTail(60)}`);
      expect(output).toContain(done);
      expect(output).toContain(detail);
      log(`example (${flow}) output (last lines):\n${output.trim().split(/\r?\n/).slice(-7).join('\n')}`);
    });
  });

  // ── Backend B: ESCROW_EVALUATION_DELAY_SECONDS=20 (contest window) ──────
  describe('evaluation delay 20 s', () => {
    let backend: BackendHandle;

    beforeAll(async () => {
      backend = await startBackend(fork, { name: 'delay20', overrides: { ESCROW_EVALUATION_DELAY_SECONDS: '20' } });
      log(`backend (delay 20 s) on ${backend.url} — log ${backend.logFile}`);
    });
    afterAll(async () => {
      await backend?.stop();
    });

    // C2b / D9 (second adversarial review, 2026-10-08): a requester's contest is not an evaluator
    // verdict. The backend still rejects with `keccak256("agentfi.contested")` (until C3d moves the
    // contest to operator review), and the hook now refunds WITHOUT writing negative feedback
    // (`FeedbackSkipped("not-verdict")`). Before C2b this scenario asserted a value-0 entry.
    it('contest while SUBMITTED: evaluator reject, full refund, no feedback ("not-verdict", D9)', async () => {
      const { requester, provider } = await fundedPair(backend, fork, 'contest');
      const feesBefore = await pendingPlatformFees(fork);

      const created = await createUsdcJob(backend, fork, requester, provider, { task: 'contested deliverable' });
      const funded = await waitForJob(backend, requester.apiKey, created.id, 'FUNDED', (j) => j.escrow?.onChainStatus === 'FUNDED');
      const onChainJobId = funded.escrow!.onChainJobId!;

      // Accept and deliver right away: if the ERC-8004 binding is still in
      // flight the submit is deferred behind it (R2) and released when it ends.
      await patchJob(backend, provider.apiKey, created.id, { status: 'ACCEPTED' });
      const result = { summary: 'not what was asked' };
      const delivered = await patchJob(backend, provider.apiKey, created.id, { status: 'COMPLETED', result });
      log(`contest: submit ${delivered.escrow?.deferredSubmitAt ? 'deferred behind the ERC-8004 binding' : 'sent immediately'}`);

      const submitted = await waitForJob(backend, requester.apiKey, created.id, 'SUBMITTED', (j) => j.escrow?.onChainStatus === 'SUBMITTED', {
        timeoutMs: 120_000,
      });
      expect(submitted.escrow!.providerAgentIdStatus).toBe('BOUND');
      const agentId = BigInt(submitted.escrow!.providerAgentId!);

      const contest = await call<JobView>(backend.url, `/v1/jobs/${created.id}/contest`, {
        method: 'POST',
        apiKey: requester.apiKey,
        body: { reason: 'Deliverable does not match the brief' },
      });
      expect(contest.status, contest.raw).toBe(200);
      expect(contest.body.escrow!.contestedAt).not.toBeNull();

      const rejected = await waitForJob(
        backend,
        requester.apiKey,
        created.id,
        'PAYMENT_FAILED / REJECTED',
        (j) => j.status === 'PAYMENT_FAILED' && j.escrow?.onChainStatus === 'REJECTED',
        { allowFailed: true, timeoutMs: 120_000 },
      );
      log(`contest: job ${created.id} (#${onChainJobId}) rejected in ${rejected.escrow!.settleTxHash}`);

      const chainJob = await readChainJob(fork, onChainJobId);
      expect(chainJob.status).toBe(CHAIN_JOB_STATUS.Rejected);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address)).toBe(REQUESTER_USDC);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, provider.address)).toBe(0n);
      expect(await pendingPlatformFees(fork)).toBe(feesBefore);

      const events = await settlementEvents(fork, rejected.escrow!.settleTxHash!);
      expect(events.escrow.map((e) => e.eventName)).toEqual(expect.arrayContaining(['JobRejected', 'Refunded']));
      expect(events.hook.find((e) => e.eventName === 'FeedbackWritten')).toBeUndefined();
      const skipped = events.hook.find((e) => e.eventName === 'FeedbackSkipped');
      expect(skipped).toBeDefined();
      expect(events.feedback).toHaveLength(0);
      expect(rejected.escrow!.feedbackStatus).toBe('skipped:not-verdict');

      const [count, value, decimals] = await forkClient(fork.anvilRpc).readContract({
        address: fork.reputationRegistry,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: 'getSummary',
        args: [agentId, [fork.hook], 'agentfi.job', 'rejected'],
      });
      expect(count).toBe(0n);
      expect(value).toBe(0n);
      log(`contest: getSummary(#${agentId}, [hook], "agentfi.job", "rejected") = count ${count}, value ${value}, decimals ${decimals}`);

      // The backend still builds and serves the feedback file it committed in optParams; the hook
      // just did not record it (C3d decides what the contest flow sends once it is an operator review).
      const file = await fetchFeedbackFile(backend, created.id);
      expect(file.status).toBe(200);
      expect(file.json).toMatchObject({ outcome: 'rejected', jobId: created.id });
    });
  });

  // ── Backend C: short TTL + fast sweep (expiry) ───────────────────────────
  describe('expiry (ESCROW_JOB_TTL_SECONDS=60)', () => {
    let backend: BackendHandle;
    const TTL_SECONDS = 60;

    beforeAll(async () => {
      backend = await startBackend(fork, {
        name: 'expiry',
        overrides: { ESCROW_JOB_TTL_SECONDS: String(TTL_SECONDS), PAYMENT_RECOVERY_INTERVAL_SEC: '5' },
      });
      log(`backend (TTL ${TTL_SECONDS} s, sweep 5 s) on ${backend.url} — log ${backend.logFile}`);
    });
    afterAll(async () => {
      await backend?.stop();
    });

    it('FUNDED past expiredAt: the sweep claims the refund (claimRefund), no feedback', async () => {
      const { requester, provider } = await fundedPair(backend, fork, 'expiry');
      const created = await createUsdcJob(backend, fork, requester, provider, { task: 'nobody delivers' });
      const funded = await waitForJob(backend, requester.apiKey, created.id, 'FUNDED', (j) => j.escrow?.onChainStatus === 'FUNDED', { timeoutMs: 50_000 });
      const onChainJobId = funded.escrow!.onChainJobId!;
      const chainFunded = await readChainJob(fork, onChainJobId);
      expect(BigInt(Math.floor(new Date(funded.escrow!.expiresAt!).getTime() / 1000))).toBe(chainFunded.expiredAt);

      // Move chain time past expiredAt (claimRefund checks block.timestamp);
      // the backend's sweep uses the wall clock, which gets there by itself.
      const latest = await forkClient(fork.anvilRpc).getBlock();
      const jump = Number(chainFunded.expiredAt - latest.timestamp) + 5;
      if (jump > 0) await rpc(fork.anvilRpc, 'evm_increaseTime', [jump]);
      await rpc(fork.anvilRpc, 'evm_mine');

      const expired = await waitForJob(backend, requester.apiKey, created.id, 'EXPIRED', (j) => j.escrow?.onChainStatus === 'EXPIRED', {
        allowFailed: true,
        timeoutMs: (TTL_SECONDS + 90) * 1000,
      });
      log(`expiry: job ${created.id} (#${onChainJobId}) refunded by claimRefund ${expired.escrow!.settleTxHash}`);
      expect(expired.status).toBe('FAILED');

      expect((await readChainJob(fork, onChainJobId)).status).toBe(CHAIN_JOB_STATUS.Expired);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, requester.address)).toBe(REQUESTER_USDC);
      expect(await usdcBalanceOf(fork.anvilRpc, fork.usdc, provider.address)).toBe(0n);

      const events = await settlementEvents(fork, expired.escrow!.settleTxHash!);
      expect(events.escrow.map((e) => e.eventName)).toEqual(expect.arrayContaining(['JobExpired', 'Refunded']));
      expect(events.hook).toHaveLength(0); // claimRefund is not hookable
      expect(events.feedback).toHaveLength(0);

      await waitForJob(backend, requester.apiKey, created.id, 'binding terminal', (j) => j.escrow?.providerAgentIdStatus !== 'BINDING', {
        allowFailed: true,
        timeoutMs: 90_000,
      });
    });
  });
});
