/**
 * ERC-8004 identity of escrow providers (R2).
 *
 * Gives the provider of an ERC-8183 job an ERC-8004 identity and binds it to
 * the on-chain job with `AgentJobEscrow.setProviderAgentId`, so the job's
 * `ReputationHook` writes feedback at settlement instead of emitting
 * `FeedbackSkipped(jobId, "no-agent-id")`. Design and verified registry facts:
 * docs/architecture/erc-8004-integration.md §2 and "Backend flow (R2)".
 *
 *   fund confirmed (C3) ─► startProviderBinding
 *       provider REGISTERED on this chain ──────────────► setProviderAgentId ─► BOUND
 *       otherwise: provider wallet register(agentURI) ─► Registered parsed ─► setProviderAgentId ─► BOUND
 *       any failure (revert, guard block, retries exhausted, nothing configured) ─► FAILED / SKIPPED
 *
 * Rules this module keeps:
 *  - Who signs: the provider's own wallet signs both `register` (so the
 *    minted NFT's `ownerOf` — and its initial agentWallet — is `job.provider`,
 *    which is what the hook's `agent-not-provider` gate checks) and
 *    `setProviderAgentId` (the escrow lets client or provider call it).
 *  - One mint per (agent, chain): the unique `AgentIdentity(agentId, chainId)`
 *    row is claimed as REGISTERING before `register` is enqueued with the
 *    deterministic intentId `erc8004:register:<agentId>:<chainId>`; concurrent
 *    jobs of the same unregistered provider wait on that row and bind when it
 *    confirms (decision D7: identity minted lazily on the first funded job).
 *  - One identity transaction at a time per provider wallet and chain: binds
 *    of waiting jobs are sent one after another (`pumpBindings`), because the
 *    transaction submitter reads the nonce with `getTransactionCount` and two
 *    concurrent transactions from one wallet can collide.
 *  - Never blocks payment: every failure ends the binding as FAILED or
 *    SKIPPED and the job proceeds; the hook then skips feedback.
 *
 * Every function takes injected deps (structurally satisfied by
 * `Erc8183Deps`) and returns the ids of jobs whose binding just reached a
 * terminal state, so the orchestrator can release a `submit` it deferred while
 * the binding was in flight. This module never imports the orchestrator.
 */

import type { AgentIdentity } from '@prisma/client';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { IDENTITY_REGISTRY_ABI } from '../../abi/IdentityRegistry.abi.js';
import { enqueueAgentStep, PENDING_TX, PENDING_TX_STATUSES, type SigningAgent, type StepDeps } from './escrow-tx-steps.js';

// ── Types and config ───────────────────────────────────────────────────────

export type IdentityStep = 'register' | 'bindAgent';
export type BindingStatus = 'BINDING' | 'BOUND' | 'FAILED' | 'SKIPPED';
/** Binding states after which a deferred `submit` may be sent. */
export const TERMINAL_BINDING_STATUSES = ['BOUND', 'FAILED', 'SKIPPED'] as const;

export interface IdentityConfig {
  backendPublicUrl: string;
  /** Public MCP endpoint advertised in the registration file (`MCP_PUBLIC_URL`), if any. */
  mcpPublicUrl?: string | null;
  /** ERC-8004 Identity Registry on `chainId`, or null when none is configured. */
  identityRegistry?(chainId: number): Address | null;
  /** The ERC-8183 chain config: the identity flow needs the escrow AND a reputation hook. */
  chain(chainId: number): { hook: Address | null } | null;
}

export interface IdentityDeps extends StepDeps {
  publicClient(chainId: number): Pick<PublicClient, 'getTransactionReceipt'>;
  config: IdentityConfig;
}

/** The slice of an escrow Job row the binding needs. */
export interface BindingJob {
  id: string;
  status: string;
  escrowChainId: number | null;
  provider: SigningAgent;
}

/** The slice of a Transaction row an identity step outcome needs. */
export interface IdentityTx {
  id: string;
  agentId: string;
  chainId: number;
  txHash: string | null;
}

export interface IdentityOutcome {
  status: 'CONFIRMED' | 'REVERTED' | 'FAILED';
  error?: string | null;
}

const ESCROW_KIND = 'erc8183';

/** Job statuses for which binding still makes sense (the provider can still be paid). */
const LIVE_FOR_BINDING = new Set(['PENDING', 'ACCEPTED', 'PAYMENT_PENDING']);

export function registerIntentId(agentId: string, chainId: number): string {
  return `erc8004:register:${agentId}:${chainId}`;
}

export function bindIntentId(jobId: string): string {
  return `erc8183:bindAgent:${jobId}`;
}

export function agentUriFor(config: Pick<IdentityConfig, 'backendPublicUrl'>, agentId: string): string {
  return `${config.backendPublicUrl}/v1/agents/${agentId}/erc8004.json`;
}

/**
 * Whether the identity flow runs for jobs on `chainId`: it needs the ERC-8183
 * escrow, a `ReputationHook` (otherwise nobody reads the id) and an Identity
 * Registry. Returns the registry, or the SKIPPED reason.
 */
export function identityEnablement(config: IdentityConfig, chainId: number): { registry: Address } | { skip: string } {
  const chain = config.chain(chainId);
  if (!chain) return { skip: 'escrow-not-configured' };
  if (!chain.hook) return { skip: 'no-reputation-hook' };
  const registry = config.identityRegistry?.(chainId) ?? null;
  if (!registry) return { skip: 'no-identity-registry' };
  return { registry: getAddress(registry) };
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

// ── Receipt parsing ────────────────────────────────────────────────────────

/**
 * `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
 * emitted by `registry` in a `register` receipt. Logs from other addresses are
 * ignored (a receipt also carries the ERC-721 Transfer and MetadataSet events,
 * and could carry anything a hook emitted).
 */
export function parseRegisteredEvent(
  logs: readonly Log[],
  registry: string,
): { agentId: bigint; owner: Address; agentURI: string } | null {
  const registryLower = registry.toLowerCase();
  const events = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: 'Registered',
    logs: logs.filter((log) => log.address.toLowerCase() === registryLower) as Log[],
  });
  const event = events[0];
  if (!event) return null;
  return { agentId: event.args.agentId, owner: getAddress(event.args.owner), agentURI: event.args.agentURI };
}

// ── Identity rows ──────────────────────────────────────────────────────────

type IdentityRow = AgentIdentity;

async function findIdentity(deps: IdentityDeps, agentId: string, chainId: number): Promise<IdentityRow | null> {
  return deps.db.agentIdentity.findUnique({ where: { agentId_chainId: { agentId, chainId } } });
}

async function loadSigningAgent(deps: IdentityDeps, agentId: string): Promise<SigningAgent | null> {
  return deps.db.agent.findUnique({ where: { id: agentId }, select: { id: true, walletId: true, safeAddress: true } });
}

/**
 * Returns the provider's identity on `chainId`, claiming a new registration
 * (row REGISTERING + `register` enqueued) when there is none, the last one
 * FAILED, or it lives in a registry that is no longer the configured one.
 * `claimed` is true when THIS call enqueued the `register`.
 */
async function ensureIdentity(
  deps: IdentityDeps,
  provider: SigningAgent,
  chainId: number,
  registry: Address,
  triggeringJobId: string,
): Promise<{ identity: IdentityRow; claimed: boolean }> {
  const agentURI = agentUriFor(deps.config, provider.id);
  const existing = await findIdentity(deps, provider.id, chainId);
  const sameRegistry = existing !== null && existing.registry.toLowerCase() === registry.toLowerCase();
  if (existing && sameRegistry && (existing.status === 'REGISTERED' || existing.status === 'REGISTERING')) {
    return { identity: existing, claimed: false };
  }

  let identity: IdentityRow;
  let freshIntent = false;
  if (!existing) {
    try {
      identity = await deps.db.agentIdentity.create({
        data: { agentId: provider.id, chainId, registry, status: 'REGISTERING', agentURI },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent job of the same provider claimed the registration first.
      const winner = await findIdentity(deps, provider.id, chainId);
      if (!winner) throw err;
      return { identity: winner, claimed: false };
    }
  } else {
    // FAILED before, or registered in a registry that is no longer configured:
    // claim a new mint. The conditional update makes exactly one caller win.
    const claim = await deps.db.agentIdentity.updateMany({
      where: { id: existing.id, status: existing.status, registry: existing.registry },
      data: { status: 'REGISTERING', registry, erc8004AgentId: null, registerTxHash: null, error: null, agentURI },
    });
    const current = await findIdentity(deps, provider.id, chainId);
    if (claim.count === 0 || !current) {
      return { identity: current ?? existing, claimed: false };
    }
    identity = current;
    freshIntent = true;
  }

  try {
    await enqueueAgentStep(deps, {
      intentId: registerIntentId(provider.id, chainId),
      freshIntent,
      jobId: triggeringJobId,
      chainId,
      step: 'register',
      signer: provider,
      to: registry,
      data: encodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: [agentURI] }),
      type: 'ERC8004_IDENTITY',
      extraMetadata: { erc8004: true, identityId: identity.id, registry },
    });
  } catch (err) {
    const error = `register could not be enqueued: ${errorMessage(err)}`;
    const failed = await deps.db.agentIdentity.update({ where: { id: identity.id }, data: { status: 'FAILED', error } });
    deps.logger.error({ agentId: provider.id, chainId, error }, 'ERC-8004 registration could not be started');
    return { identity: failed, claimed: true };
  }
  deps.logger.info({ agentId: provider.id, chainId, registry, agentURI, jobId: triggeringJobId }, 'ERC-8004 registration enqueued');
  return { identity, claimed: true };
}

// ── Job bindings ───────────────────────────────────────────────────────────

const WAITING_WHERE = (providerId: string, chainId: number) => ({
  providerId,
  escrowChainId: chainId,
  escrowKind: ESCROW_KIND,
  providerAgentIdStatus: 'BINDING',
  providerAgentId: null,
});

async function endBinding(deps: IdentityDeps, jobId: string, status: 'SKIPPED' | 'FAILED', reason: string): Promise<boolean> {
  const ended = await deps.db.job.updateMany({
    where: { id: jobId, providerAgentIdStatus: 'BINDING' },
    data: { providerAgentIdStatus: status, providerAgentIdError: reason },
  });
  if (ended.count > 0) {
    deps.logger.warn({ jobId, status, reason }, `ERC-8004 binding ${status} — job continues, the hook will skip feedback`);
  }
  return ended.count > 0;
}

/** Marks every job still waiting for the provider's identity on `chainId` as FAILED. */
async function failWaitingJobs(deps: IdentityDeps, providerId: string, chainId: number, reason: string): Promise<string[]> {
  const waiting = await deps.db.job.findMany({ where: WAITING_WHERE(providerId, chainId), select: { id: true } });
  const failed: string[] = [];
  for (const { id } of waiting) {
    if (await endBinding(deps, id, 'FAILED', reason)) failed.push(id);
  }
  return failed;
}

/**
 * Sends the next pending `setProviderAgentId` for this provider and chain, if
 * the provider's identity is REGISTERED and no identity transaction of the
 * provider is in flight there. At most one bind is enqueued per call; the
 * next one goes out when it reaches a terminal state. Jobs that can no longer
 * be bound (cancelled, expired, not Funded) are SKIPPED on the way.
 */
async function pumpBindings(deps: IdentityDeps, provider: SigningAgent, chainId: number): Promise<string[]> {
  const terminal: string[] = [];
  const identity = await findIdentity(deps, provider.id, chainId);
  if (!identity || identity.status !== 'REGISTERED' || identity.erc8004AgentId === null) return terminal;

  const busy = await deps.db.transaction.findFirst({
    where: { agentId: provider.id, chainId, type: 'ERC8004_IDENTITY', status: { in: [...PENDING_TX_STATUSES] } },
    select: { id: true },
  });
  if (busy) return terminal;

  for (;;) {
    const next = await deps.db.job.findFirst({
      where: WAITING_WHERE(provider.id, chainId),
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, onChainStatus: true, onChainJobId: true, escrowContract: true },
    });
    if (!next) return terminal;

    if (!LIVE_FOR_BINDING.has(next.status) || next.onChainStatus !== 'FUNDED' || !next.onChainJobId || !next.escrowContract) {
      const reason = `job is ${next.status} / ${next.onChainStatus ?? 'unknown'} on-chain — setProviderAgentId is only valid while Open or Funded`;
      if (await endBinding(deps, next.id, 'SKIPPED', reason)) terminal.push(next.id);
      continue;
    }
    if (identity.erc8004AgentId === '0') {
      // The registry's first mint is id 0, which the escrow treats as "clear"
      // and the hook as "no-agent-id": binding it would be a no-op.
      if (await endBinding(deps, next.id, 'SKIPPED', 'agent-id-zero')) terminal.push(next.id);
      continue;
    }

    const claim = await deps.db.job.updateMany({
      where: { id: next.id, providerAgentIdStatus: 'BINDING', providerAgentId: null },
      data: { providerAgentId: identity.erc8004AgentId },
    });
    // A concurrent pump took this job: it now owns the lane, stop here.
    if (claim.count === 0) return terminal;

    try {
      await enqueueAgentStep(deps, {
        intentId: bindIntentId(next.id),
        jobId: next.id,
        chainId,
        step: 'bindAgent',
        signer: provider,
        to: getAddress(next.escrowContract),
        data: encodeFunctionData({
          abi: AGENT_JOB_ESCROW_ABI,
          functionName: 'setProviderAgentId',
          args: [BigInt(next.onChainJobId), BigInt(identity.erc8004AgentId)],
        }),
        type: 'ERC8004_IDENTITY',
        extraMetadata: { erc8004: true, erc8004AgentId: identity.erc8004AgentId },
      });
      deps.logger.info(
        { jobId: next.id, onChainJobId: next.onChainJobId, erc8004AgentId: identity.erc8004AgentId },
        'ERC-8004 setProviderAgentId enqueued',
      );
      return terminal;
    } catch (err) {
      if (await endBinding(deps, next.id, 'FAILED', `setProviderAgentId could not be enqueued: ${errorMessage(err)}`)) {
        terminal.push(next.id);
      }
    }
  }
}

/**
 * Called by the orchestrator when `fund` confirmed (`onChainStatus = FUNDED`).
 * Marks the job BINDING and either binds right away (identity REGISTERED) or
 * starts / joins the provider's registration. Returns the jobs whose binding
 * became terminal during the call.
 */
export async function startProviderBinding(deps: IdentityDeps, job: BindingJob): Promise<string[]> {
  if (job.escrowChainId === null) return [];
  const chainId = job.escrowChainId;

  const enablement = identityEnablement(deps.config, chainId);
  if ('skip' in enablement) {
    await deps.db.job.update({
      where: { id: job.id },
      data: { providerAgentIdStatus: 'SKIPPED', providerAgentIdError: enablement.skip },
    });
    deps.logger.info({ jobId: job.id, chainId, reason: enablement.skip }, 'ERC-8004 binding SKIPPED');
    return [job.id];
  }
  if (!LIVE_FOR_BINDING.has(job.status)) {
    await deps.db.job.update({
      where: { id: job.id },
      data: { providerAgentIdStatus: 'SKIPPED', providerAgentIdError: `job is ${job.status}` },
    });
    return [job.id];
  }

  await deps.db.job.update({
    where: { id: job.id },
    data: { providerAgentIdStatus: 'BINDING', providerAgentId: null, providerAgentIdError: null },
  });

  let ensured: { identity: IdentityRow; claimed: boolean };
  try {
    ensured = await ensureIdentity(deps, job.provider, chainId, enablement.registry, job.id);
  } catch (err) {
    const reason = `identity lookup failed: ${errorMessage(err)}`;
    return (await endBinding(deps, job.id, 'FAILED', reason)) ? [job.id] : [];
  }

  const { identity, claimed } = ensured;
  if (identity.status === 'FAILED') {
    return failWaitingJobs(deps, job.provider.id, chainId, `ERC-8004 registration failed: ${identity.error ?? 'unknown error'}`);
  }
  if (identity.status === 'REGISTERING') {
    // Someone else's registration: join it. If its register already reached a
    // terminal state whose outcome was lost (crash), replay it now; a register
    // that is not even created yet is the concurrent claimer still enqueuing
    // it, never a failure (the recovery scan handles a claimer that died).
    return claimed ? [] : repairRegistration(deps, identity, job.provider, { failIfMissing: false });
  }
  return pumpBindings(deps, job.provider, chainId);
}

// ── Step outcomes ──────────────────────────────────────────────────────────

async function failIdentity(deps: IdentityDeps, identity: IdentityRow, reason: string): Promise<string[]> {
  await deps.db.agentIdentity.update({ where: { id: identity.id }, data: { status: 'FAILED', error: reason } });
  deps.logger.error(
    { agentId: identity.agentId, chainId: identity.chainId, registry: identity.registry, reason },
    'ERC-8004 registration FAILED — waiting jobs continue without an identity',
  );
  return failWaitingJobs(deps, identity.agentId, identity.chainId, `ERC-8004 registration failed: ${reason}`);
}

async function onRegisterOutcome(deps: IdentityDeps, tx: IdentityTx | null, identity: IdentityRow, outcome: IdentityOutcome): Promise<string[]> {
  const provider = await loadSigningAgent(deps, identity.agentId);
  if (!provider) return [];
  if (identity.status === 'REGISTERED') return pumpBindings(deps, provider, identity.chainId);

  if (outcome.status !== 'CONFIRMED') {
    return failIdentity(deps, identity, `register ${outcome.status}: ${outcome.error ?? 'no error recorded'}`);
  }
  if (!tx?.txHash) return failIdentity(deps, identity, 'register CONFIRMED without a txHash');

  let logs: readonly Log[];
  try {
    const receipt = await deps.publicClient(identity.chainId).getTransactionReceipt({ hash: tx.txHash as Hex });
    logs = receipt.logs;
  } catch (err) {
    // The NFT is minted; minting again would create a second identity. Leave
    // the row REGISTERING: the next funded job or the payment-recovery scan
    // re-reads the receipt (`repairRegistration`).
    deps.logger.error(
      { agentId: identity.agentId, chainId: identity.chainId, txHash: tx.txHash, err: errorMessage(err) },
      'ERC-8004 register receipt could not be read — identity left REGISTERING for repair',
    );
    return [];
  }

  const event = parseRegisteredEvent(logs, identity.registry);
  if (!event) return failIdentity(deps, identity, `Registered event from ${identity.registry} not found in receipt ${tx.txHash}`);
  if (event.owner.toLowerCase() !== provider.safeAddress.toLowerCase()) {
    return failIdentity(deps, identity, `Registered owner ${event.owner} is not the provider wallet ${provider.safeAddress}`);
  }

  await deps.db.agentIdentity.update({
    where: { id: identity.id },
    data: { status: 'REGISTERED', erc8004AgentId: event.agentId.toString(), registerTxHash: tx.txHash, error: null },
  });
  deps.logger.info(
    { agentId: identity.agentId, chainId: identity.chainId, erc8004AgentId: event.agentId.toString(), txHash: tx.txHash },
    'ERC-8004 identity registered',
  );
  return pumpBindings(deps, provider, identity.chainId);
}

async function onBindOutcome(deps: IdentityDeps, providerId: string, chainId: number, jobId: string, outcome: IdentityOutcome): Promise<string[]> {
  const bound = outcome.status === 'CONFIRMED';
  const ended = await deps.db.job.updateMany({
    where: { id: jobId, providerAgentIdStatus: 'BINDING' },
    data: bound
      ? { providerAgentIdStatus: 'BOUND', providerAgentIdError: null }
      : {
          providerAgentIdStatus: 'FAILED',
          providerAgentIdError: `setProviderAgentId ${outcome.status}: ${outcome.error ?? 'no error recorded'}`,
        },
  });
  if (ended.count > 0) {
    if (bound) deps.logger.info({ jobId }, 'ERC-8004 identity bound to the escrow job');
    else deps.logger.warn({ jobId, error: outcome.error }, 'ERC-8004 setProviderAgentId failed — job continues without feedback');
  }
  const provider = await loadSigningAgent(deps, providerId);
  const next = provider ? await pumpBindings(deps, provider, chainId) : [];
  return [jobId, ...next];
}

/**
 * Outcome of a `register` or `bindAgent` Transaction (dispatched by
 * `onEscrowTxOutcome`). Idempotent: a redelivered outcome finds the row
 * already terminal and only advances the lane.
 */
export async function onIdentityTxOutcome(
  deps: IdentityDeps,
  tx: IdentityTx,
  step: IdentityStep,
  jobId: string,
  outcome: IdentityOutcome,
): Promise<string[]> {
  if (step === 'bindAgent') return onBindOutcome(deps, tx.agentId, tx.chainId, jobId, outcome);

  const identity = await findIdentity(deps, tx.agentId, tx.chainId);
  if (!identity) {
    deps.logger.warn({ transactionId: tx.id, agentId: tx.agentId, chainId: tx.chainId }, 'ERC-8004 register outcome without an identity row');
    return [];
  }
  return onRegisterOutcome(deps, tx, identity, outcome);
}

// ── Repair / recovery ──────────────────────────────────────────────────────

export interface ResumeResult {
  /** True while an identity transaction for this job (or its provider) is still in flight. */
  waiting: boolean;
  terminalJobIds: string[];
}

/**
 * How long a REGISTERING row may exist without its `register` Transaction row
 * before recovery declares the claimer dead (it creates the row right after
 * claiming, so anything past a few seconds is a crash).
 */
export const REGISTER_CLAIM_GRACE_MS = 120_000;

/**
 * A REGISTERING row: nothing to do while its `register` is in flight;
 * otherwise replay that transaction's outcome (a crash between confirmation
 * and the outcome handler, or a receipt read that failed). A row without any
 * register transaction is failed only when `failIfMissing` (recovery, after
 * `REGISTER_CLAIM_GRACE_MS`): a fresh claimer may still be enqueuing it.
 */
async function repairRegistration(
  deps: IdentityDeps,
  identity: IdentityRow,
  provider: SigningAgent,
  opts: { failIfMissing: boolean },
): Promise<string[]> {
  const registerTx = await deps.db.transaction.findFirst({
    where: { agentId: provider.id, chainId: identity.chainId, intentId: { startsWith: registerIntentId(provider.id, identity.chainId) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, agentId: true, chainId: true, txHash: true, status: true, error: true, createdAt: true },
  });
  if (registerTx && PENDING_TX.has(registerTx.status)) return [];
  // A terminal tx older than the current claim belongs to a previous attempt
  // (the row was re-claimed after it failed): the new one is still coming.
  const staleAttempt = registerTx !== null && registerTx.createdAt < identity.updatedAt && registerTx.status !== 'CONFIRMED';
  if (!registerTx || staleAttempt) {
    if (!opts.failIfMissing) return [];
    return onRegisterOutcome(deps, null, identity, { status: 'FAILED', error: 'REGISTERING without a live register transaction' });
  }

  const outcome: IdentityOutcome =
    registerTx.status === 'CONFIRMED'
      ? { status: 'CONFIRMED' }
      : { status: registerTx.status === 'REVERTED' ? 'REVERTED' : 'FAILED', error: registerTx.error };
  return onRegisterOutcome(deps, registerTx, identity, outcome);
}

/**
 * Payment-recovery entry point for a job whose binding is still BINDING:
 * replays the outcome of an identity transaction that is no longer in flight
 * (crash between confirmation and the outcome handler, lost lane), or reports
 * that one still is. Never sends a second `register` for a live row.
 */
export async function resumeBinding(deps: IdentityDeps, jobId: string): Promise<ResumeResult> {
  const job = await deps.db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      escrowChainId: true,
      providerAgentId: true,
      providerAgentIdStatus: true,
      provider: { select: { id: true, walletId: true, safeAddress: true } },
    },
  });
  if (!job || job.providerAgentIdStatus !== 'BINDING' || job.escrowChainId === null) {
    return { waiting: false, terminalJobIds: [] };
  }
  const chainId = job.escrowChainId;
  const terminalJobIds = await advanceBinding(deps, jobId, job.providerAgentId, job.provider, chainId);
  // Whatever happened above, the job is "waiting" exactly while its own
  // binding is still BINDING (its bind or its provider's register in flight,
  // or its turn in the provider's lane not reached yet).
  const fresh = await deps.db.job.findUnique({ where: { id: jobId }, select: { providerAgentIdStatus: true } });
  return { waiting: fresh?.providerAgentIdStatus === 'BINDING', terminalJobIds };
}

async function advanceBinding(
  deps: IdentityDeps,
  jobId: string,
  providerAgentId: string | null,
  provider: SigningAgent,
  chainId: number,
): Promise<string[]> {
  if (providerAgentId !== null) {
    const bindTx = await deps.db.transaction.findFirst({
      where: { intentId: { startsWith: bindIntentId(jobId) } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, error: true },
    });
    if (bindTx && PENDING_TX.has(bindTx.status)) return [];
    const outcome: IdentityOutcome = !bindTx
      ? { status: 'FAILED', error: 'recovery: no setProviderAgentId transaction' }
      : bindTx.status === 'CONFIRMED'
        ? { status: 'CONFIRMED' }
        : { status: bindTx.status === 'REVERTED' ? 'REVERTED' : 'FAILED', error: bindTx.error };
    return onBindOutcome(deps, provider.id, chainId, jobId, outcome);
  }

  const identity = await findIdentity(deps, provider.id, chainId);
  if (!identity) {
    return (await endBinding(deps, jobId, 'FAILED', 'recovery: no ERC-8004 identity row for the provider')) ? [jobId] : [];
  }
  if (identity.status === 'REGISTERING') {
    const now = (deps.now?.() ?? new Date()).getTime();
    return repairRegistration(deps, identity, provider, {
      failIfMissing: now - identity.updatedAt.getTime() > REGISTER_CLAIM_GRACE_MS,
    });
  }
  if (identity.status === 'FAILED') {
    return failWaitingJobs(deps, provider.id, chainId, `ERC-8004 registration failed: ${identity.error ?? 'unknown error'}`);
  }
  // REGISTERED but this job never got its turn: restart the lane.
  return pumpBindings(deps, provider, chainId);
}

// ── Registration file + API view ───────────────────────────────────────────

export const REGISTRATION_FILE_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface RegistrationFile {
  type: typeof REGISTRATION_FILE_TYPE;
  name: string;
  description: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: number | string; agentRegistry: string }>;
  supportedTrust: string[];
}

export interface IdentitySummaryRow {
  chainId: number;
  registry: string;
  erc8004AgentId: string | null;
  status: string;
}

/** `agentId` as a JSON number when it fits (the EIP example uses a number), else a decimal string. */
function registrationAgentId(id: string): number | string {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : id;
}

/**
 * The agent's ERC-8004 registration file (`registration-v1`), served at the
 * agentURI `GET /v1/agents/:id/erc8004.json`.
 *
 *  - `services`: the AgentFi manifest endpoint (`web`), the public MCP
 *    endpoint when `MCP_PUBLIC_URL` is set, the ENS name when the agent has one.
 *  - `x402Support: false`: the field advertises that the agent's own
 *    endpoints accept x402 payments (it sells behind HTTP 402). AgentFi agents
 *    are hired through the escrow and only PAY x402 resources (P2), so false.
 *  - `registrations`: every REGISTERED identity, `eip155:<chainId>:<registry>`.
 *  - `supportedTrust: ["reputation"]`: feedback from the escrow's hook.
 *  - `image` is omitted: AgentFi stores no agent image.
 */
export function buildRegistrationFile(
  agent: { id: string; name: string; active: boolean; ensName: string | null },
  identities: readonly IdentitySummaryRow[],
  config: Pick<IdentityConfig, 'backendPublicUrl' | 'mcpPublicUrl'>,
): RegistrationFile {
  const services: RegistrationFile['services'] = [
    { name: 'web', endpoint: `${config.backendPublicUrl}/v1/agents/${agent.id}/manifest` },
  ];
  if (config.mcpPublicUrl) services.push({ name: 'MCP', endpoint: config.mcpPublicUrl, version: LATEST_PROTOCOL_VERSION });
  if (agent.ensName) services.push({ name: 'ENS', endpoint: agent.ensName, version: 'v1' });

  return {
    type: REGISTRATION_FILE_TYPE,
    name: agent.name,
    description:
      `AgentFi agent "${agent.name}". Hire it through AgentFi: the job budget is escrowed in USDC on an ` +
      'ERC-8183 job escrow and released on settlement, and each settled job is rated on-chain by the ' +
      "escrow's ERC-8004 reputation hook.",
    services,
    x402Support: false,
    active: agent.active,
    registrations: identities
      .filter((identity) => identity.status === 'REGISTERED' && identity.erc8004AgentId !== null)
      .map((identity) => ({
        agentId: registrationAgentId(identity.erc8004AgentId!),
        agentRegistry: `eip155:${identity.chainId}:${getAddress(identity.registry)}`,
      })),
    supportedTrust: ['reputation'],
  };
}

/** `erc8004` array on agent responses. `agentId` is null until the mint is confirmed. */
export function identityView(identities: readonly IdentitySummaryRow[]): Array<{ chainId: number; registry: string; agentId: string | null; status: string }> {
  return identities.map((identity) => ({
    chainId: identity.chainId,
    registry: identity.registry,
    agentId: identity.erc8004AgentId,
    status: identity.status,
  }));
}
