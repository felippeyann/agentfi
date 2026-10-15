#!/usr/bin/env tsx
/**
 * C5 — escrow validation runner for Base Sepolia (the owner runs it; nothing
 * here holds or prints a private key, an API key or a secret).
 *
 *   cd packages/backend
 *   npx tsx src/scripts/c5/escrow-validation.ts <command> [scenario]
 *
 * Commands, in order (docs/project/c5-escrow-validation.md has the runbook):
 *   preflight            chain, contracts (this build's bytecode + configuration), backend, window, gas
 *   setup                register the requester and the provider (once), print the funding request
 *   fund                 FORK REHEARSAL ONLY: cheat-fund the agents on a local Anvil fork
 *   snapshot             record balances and nonces once funded (the baseline of `reconcile`)
 *   run <scenario>       happy | contest | cancel — resumable: rerun the same command after any interruption
 *   resolve contest      the operator's decision on the held contest (needs C5_ADMIN_SECRET)
 *   verify <scenario>    read-only acceptance checks + evidence file; safe to repeat
 *   reconcile            whole-run balances, nonces, transfers and reputation vs the snapshot
 *   status               state file and live job states
 *
 * Retry safety: a job is created only when the state file has none for the
 * scenario AND the requester's outbox holds no job tagged with this run and
 * scenario; every later action is chosen from the job's current state
 * (plan.ts `nextStep`), so a rerun never repeats a payment, a submit, a
 * contest or a resolution.
 *
 * Environment (addresses are public; secrets only in the variables marked):
 *   C5_MODE              testnet (default) | fork
 *   C5_API_URL           backend URL (default http://localhost:3000)
 *   C5_RPC_URL           JSON-RPC for reads (default https://sepolia.base.org)
 *   C5_ESCROW, C5_HOOK, C5_EVALUATOR, C5_OPERATOR, C5_FEE_WALLET   the approved addresses (C4 output)
 *   C5_BACKEND_PUBLIC_URL  BACKEND_PUBLIC_URL of the backend (default C5_API_URL), for the agentURI check
 *   C5_STATE_DIR         default <repo>/c5-run (git-ignored)
 *   C5_CONTEST_WINDOW_SEC  fork rehearsal only; testnet refuses anything but 3600
 *   C5_OPERATOR_SECRET   secret: the backend API_SECRET, `setup` only
 *   C5_ADMIN_SECRET      secret: the backend ADMIN_SECRET, `preflight` and `resolve`
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { dirname, join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../../abi/ReputationHook.abi.js';
import { codeIdentityProblem, EXPECTED_CONTRACT_CODE_VERSION } from '../../config/contract-identity.js';
import {
  C5_CHAIN_ID,
  C5_CONTEST_WINDOW_SECONDS,
  C5_IDENTITY_REGISTRY,
  C5_REPUTATION_REGISTRY,
  C5_USDC,
  CHAIN_STATUS,
  requiredEthWei,
  MIN_FEEDBACK_BUDGET_UNITS,
  PLATFORM_FEE_BPS,
  PROVIDER_POLICY,
  REASONS,
  SCENARIO_BUDGET,
  TOTAL_BUDGET_UNITS,
  check,
  expectedOutcome,
  feeUnits,
  holdSecondsLeft,
  isScenario,
  jobViewChecks,
  nextStep,
  nonceCheck,
  requesterPolicy,
  sameAddress,
  settlementChecks,
  windowCheck,
  authorityState,
  MAX_HEAD_AGE_SECONDS,
  type Check,
  type DecodedEvent,
  type JobSnapshot,
  type Scenario,
} from './plan.js';

// ── ABIs not generated in src/abi ───────────────────────────────────────────

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);
const REPUTATION_REGISTRY_ABI = parseAbi([
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
]);
const IDENTITY_REGISTRY_READ_ABI = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
]);

// ── Configuration ───────────────────────────────────────────────────────────

type Mode = 'testnet' | 'fork';
interface Config {
  mode: Mode;
  apiUrl: string;
  rpcUrl: string;
  backendPublicUrl: string;
  stateDir: string;
  escrow: Address;
  hook: Address;
  evaluator: Address;
  operator: Address;
  feeWallet: Address;
  windowSeconds: number;
  operatorSecret: string | undefined;
  adminSecret: string | undefined;
}

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../..');

class StopError extends Error {}
const stop = (reason: string): never => {
  throw new StopError(reason);
};

function addressEnv(name: string): Address {
  const raw = process.env[name];
  if (!raw) stop(`${name} is not set (the approved address from the C4 output)`);
  try {
    return getAddress(raw!);
  } catch {
    return stop(`${name} is not an address`);
  }
}

function loadConfig(): Config {
  const mode = (process.env['C5_MODE'] ?? 'testnet') as Mode;
  if (mode !== 'testnet' && mode !== 'fork') stop('C5_MODE must be "testnet" or "fork"');
  const apiUrl = (process.env['C5_API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  const windowRaw = process.env['C5_CONTEST_WINDOW_SEC'];
  const windowSeconds = windowRaw === undefined ? C5_CONTEST_WINDOW_SECONDS : Number(windowRaw);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 0) stop('C5_CONTEST_WINDOW_SEC must be a whole number of seconds');
  if (mode === 'testnet' && windowSeconds !== C5_CONTEST_WINDOW_SECONDS) {
    stop(`the approved contest window is ${C5_CONTEST_WINDOW_SECONDS} s (Q6 / D12); C5_CONTEST_WINDOW_SEC=${windowSeconds} is for the fork rehearsal only`);
  }
  return {
    mode,
    apiUrl,
    rpcUrl: process.env['C5_RPC_URL'] ?? 'https://sepolia.base.org',
    backendPublicUrl: (process.env['C5_BACKEND_PUBLIC_URL'] ?? apiUrl).replace(/\/+$/, ''),
    stateDir: resolvePath(process.env['C5_STATE_DIR'] ?? join(REPO_ROOT, 'c5-run')),
    escrow: addressEnv('C5_ESCROW'),
    hook: addressEnv('C5_HOOK'),
    evaluator: addressEnv('C5_EVALUATOR'),
    operator: addressEnv('C5_OPERATOR'),
    feeWallet: addressEnv('C5_FEE_WALLET'),
    windowSeconds,
    operatorSecret: process.env['C5_OPERATOR_SECRET'] || undefined,
    adminSecret: process.env['C5_ADMIN_SECRET'] || undefined,
  };
}

// ── State (public data) and agent keys (secret, separate file) ──────────────

interface AgentRecord {
  id: string;
  name: string;
  address: Address;
}
interface Snapshot {
  at: string;
  block: string;
  eth: Record<string, string>;
  usdc: Record<string, string>;
  nonces: Record<'requester' | 'provider' | 'evaluator', number>;
  pendingPlatformFees: string;
}
interface ScenarioRecord {
  runId: string;
  jobId: string;
  createdAt: string;
  onChainJobId?: string;
  submittedAt?: string;
  contestedAt?: string;
  authorityChecks?: Check[];
  holdProvenAt?: string;
  resolveRequestedAt?: string;
  verifiedAt?: string;
  result?: 'PASS' | 'FAIL';
}
interface State {
  version: 1;
  mode: Mode;
  runId: string;
  createdAt: string;
  apiUrl: string;
  chainId: number;
  escrow: Address;
  hook: Address;
  evaluator: Address;
  buildCodeVersion: string;
  agents?: { requester: AgentRecord; provider: AgentRecord };
  snapshot?: Snapshot;
  /** Read from scenarios/<name>.json (one file per scenario, never written through state.json). */
  scenarios: Partial<Record<Scenario, ScenarioRecord>>;
}
interface AgentKeys {
  requesterApiKey?: string;
  providerApiKey?: string;
}

/**
 * Persistence: `state.json` holds the run (written only by `setup` and
 * `snapshot`); each scenario has its own `scenarios/<name>.json`, written only
 * by the one runner that holds `scenarios/<name>.lock`. Scenarios may run in
 * parallel terminals without overwriting each other's records.
 */
const statePath = (cfg: Config) => join(cfg.stateDir, 'state.json');
const keysPath = (cfg: Config) => join(cfg.stateDir, 'agent-keys.secret.json');
const scenarioPath = (cfg: Config, scenario: Scenario) => join(cfg.stateDir, 'scenarios', `${scenario}.json`);
const lockPath = (cfg: Config, scenario: Scenario) => join(cfg.stateDir, 'scenarios', `${scenario}.lock`);

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  renameSync(tmp, path);
}

/**
 * The agents' API keys: owner-only from the first byte (0600 in a 0700
 * directory, exclusive create, so the file is never readable by others even
 * briefly). On Windows the modes are advisory; the state dir lives in the
 * owner's profile or checkout and is git-ignored.
 */
function writeSecretJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function loadState(cfg: Config): State | null {
  if (!existsSync(statePath(cfg))) return null;
  const state = JSON.parse(readFileSync(statePath(cfg), 'utf8')) as State;
  if (state.mode !== cfg.mode) stop(`the state in ${cfg.stateDir} is a ${state.mode} run; this is C5_MODE=${cfg.mode} — use another C5_STATE_DIR`);
  if (!sameAddress(state.escrow, cfg.escrow) || !sameAddress(state.hook, cfg.hook) || !sameAddress(state.evaluator, cfg.evaluator)) {
    stop('C5_ESCROW / C5_HOOK / C5_EVALUATOR differ from the addresses this run started with');
  }
  state.scenarios = {};
  for (const s of ['happy', 'contest', 'cancel'] as const) {
    if (!existsSync(scenarioPath(cfg, s))) continue;
    const rec = JSON.parse(readFileSync(scenarioPath(cfg, s), 'utf8')) as ScenarioRecord;
    if (rec.runId !== state.runId) stop(`${scenarioPath(cfg, s)} belongs to run ${rec.runId}, not ${state.runId}`);
    state.scenarios[s] = rec;
  }
  return state;
}

const saveScenario = (cfg: Config, scenario: Scenario, rec: ScenarioRecord) => writeJsonAtomic(scenarioPath(cfg, scenario), rec);

/** One runner per scenario at a time; a lock left by a dead process is taken over. */
function lockScenario(cfg: Config, scenario: Scenario): void {
  const path = lockPath(cfg, scenario);
  mkdirSync(dirname(path), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    writeFileSync(path, mine, { flag: 'wx' });
  } catch {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; at: string };
    let alive = false;
    try {
      process.kill(held.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && held.pid !== process.pid) stop(`another runner (pid ${held.pid}, since ${held.at}) is driving ${scenario}: stop it first`);
    writeFileSync(path, mine);
  }
  const release = () => {
    try {
      if ((JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid === process.pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
}
process.on('SIGINT', () => process.exit(130));

function requireState(cfg: Config): State & { agents: NonNullable<State['agents']> } {
  const state = loadState(cfg);
  if (!state?.agents) return stop(`no agents yet: run \`setup\` first (state dir ${cfg.stateDir})`);
  return state as State & { agents: NonNullable<State['agents']> };
}

function loadKeys(cfg: Config): Required<AgentKeys> {
  if (!existsSync(keysPath(cfg))) return stop(`missing ${keysPath(cfg)} (written by \`setup\`)`);
  const keys = JSON.parse(readFileSync(keysPath(cfg), 'utf8')) as AgentKeys;
  if (!keys.requesterApiKey || !keys.providerApiKey) return stop(`${keysPath(cfg)} is incomplete`);
  return keys as Required<AgentKeys>;
}

/** Run-level fields only: scenario records live in their own files. */
const saveState = (cfg: Config, state: State) => writeJsonAtomic(statePath(cfg), { ...state, scenarios: {} });

// ── HTTP + chain helpers ────────────────────────────────────────────────────

interface ApiResult<T> {
  status: number;
  body: T;
  raw: string;
}

async function api<T = any>(
  cfg: Config,
  path: string,
  opts: { method?: string; apiKey?: string | undefined; adminSecret?: string | undefined; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
      ...(opts.adminSecret ? { 'x-admin-secret': opts.adminSecret } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: res.status, body, raw };
}

/** GET with retries: a backend restart or an RPC hiccup never turns into an action. */
async function getJob(cfg: Config, apiKey: string, jobId: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await api(cfg, `/v1/jobs/${jobId}`, { apiKey });
      if (res.status === 200) return res.body;
      if (res.status === 404) stop(`job ${jobId} not found on ${cfg.apiUrl} (another backend / database?)`);
      throw new Error(`GET /v1/jobs/${jobId} → ${res.status}`);
    } catch (err) {
      if (err instanceof StopError) throw err;
      if (attempt % 10 === 1) console.log(`       backend unreachable or erroring (${(err as Error).message}); retrying, nothing is sent meanwhile`);
      await sleep(Math.min(30_000, 2_000 * attempt));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = (cfg: Config): PublicClient => createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 4 }) }) as PublicClient;
const usdcUnits = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')} USDC`;
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

async function usdcBalance(cfg: Config, holder: Address): Promise<bigint> {
  return client(cfg).readContract({ address: C5_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] }) as Promise<bigint>;
}

async function readChainJob(cfg: Config, onChainJobId: bigint) {
  return client(cfg).readContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'getJob', args: [onChainJobId] }) as Promise<{
    client: Address;
    provider: Address;
    evaluator: Address;
    budget: bigint;
    status: number;
    hook: Address;
    expiredAt: bigint;
  }>;
}

async function blockTimestamp(cfg: Config, blockNumber?: bigint): Promise<bigint> {
  const block = await client(cfg).getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  return block.timestamp;
}

/**
 * "Now" for the contest hold. On Base Sepolia the chain's head time (a block
 * every ~2 s); a head more than 2 minutes behind the wall clock means a stale
 * RPC, and the run stops rather than reason on old state. An Anvil fork mines
 * only when a transaction arrives, so the rehearsal uses the later of the two.
 */
async function chainNow(cfg: Config): Promise<bigint> {
  const head = await blockTimestamp(cfg);
  const wall = BigInt(Math.floor(Date.now() / 1000));
  if (cfg.mode === 'fork') return head > wall ? head : wall;
  if (wall - head > BigInt(MAX_HEAD_AGE_SECONDS)) stop(`the RPC head is ${wall - head} s behind the wall clock: stale RPC (C5_RPC_URL)`);
  return head;
}

function printChecks(title: string, checks: Check[]): boolean {
  console.log(`\n${title}`);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: expected ${c.expected}, got ${c.actual}`);
  const ok = checks.every((c) => c.ok);
  console.log(ok ? '  → all checks passed' : `  → ${checks.filter((c) => !c.ok).length} check(s) FAILED`);
  return ok;
}

// ── preflight ───────────────────────────────────────────────────────────────

async function preflightChecks(cfg: Config, state: State | null, keys: AgentKeys | null): Promise<Check[]> {
  const c = client(cfg);
  const checks: Check[] = [];

  const chainId = await c.getChainId();
  checks.push(check('RPC chain id', C5_CHAIN_ID, chainId));
  const version = String(await c.request({ method: 'web3_clientVersion' as any }).catch(() => 'unknown'));
  const isAnvil = /anvil/i.test(version);
  checks.push(check('RPC is a local fork only in fork mode', cfg.mode === 'fork' ? 'anvil' : 'not anvil', isAnvil ? 'anvil' : version, cfg.mode === 'fork' ? isAnvil : !isAnvil));
  // Every read below (code, configuration, balances) must come from a live head, not an old one.
  if (cfg.mode === 'testnet') {
    const headAge = BigInt(Math.floor(Date.now() / 1000)) - (await blockTimestamp(cfg));
    checks.push(check('RPC head is current', `≤ ${MAX_HEAD_AGE_SECONDS} s behind the wall clock`, `${headAge} s`, headAge <= BigInt(MAX_HEAD_AGE_SECONDS)));
  }

  const [escrowCode, hookCode] = await Promise.all([c.getCode({ address: cfg.escrow }), c.getCode({ address: cfg.hook })]);
  checks.push(check('escrow runtime code = this build', 'match', codeIdentityProblem('AgentJobEscrow', escrowCode) ?? 'match'));
  checks.push(check('hook runtime code = this build', 'match', codeIdentityProblem('ReputationHook', hookCode) ?? 'match'));

  // A wrong address answers with reverts or garbage: every read becomes a check, never a crash.
  const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) =>
    (c.readContract({ address, abi, functionName, args } as any) as Promise<any>).catch(
      (err: unknown) => `unreadable (${err instanceof BaseError ? err.shortMessage : String(err)})`,
    );
  const [token, platformBp, evaluatorBp, operator, feeWallet, paused] = await Promise.all([
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'token'),
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'platformFeeBP'),
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'evaluatorFeeBP'),
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'operator'),
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'feeWallet'),
    read(cfg.escrow, AGENT_JOB_ESCROW_ABI, 'paused'),
  ]);
  checks.push(check('escrow.token() = Base Sepolia USDC', C5_USDC, token, sameAddress(token, C5_USDC)));
  checks.push(check('escrow.platformFeeBP()', PLATFORM_FEE_BPS, platformBp));
  checks.push(check('escrow.evaluatorFeeBP()', 0n, evaluatorBp));
  checks.push(check('escrow.operator() = C5_OPERATOR', cfg.operator, operator, sameAddress(operator, cfg.operator)));
  checks.push(check('escrow.feeWallet() = C5_FEE_WALLET', cfg.feeWallet, feeWallet, sameAddress(feeWallet, cfg.feeWallet)));
  checks.push(check('escrow not paused', false, paused));

  const [acp, trusted, identity, reputation, minBudget] = await Promise.all([
    read(cfg.hook, REPUTATION_HOOK_ABI, 'acp'),
    read(cfg.hook, REPUTATION_HOOK_ABI, 'trustedEvaluator'),
    read(cfg.hook, REPUTATION_HOOK_ABI, 'identityRegistry'),
    read(cfg.hook, REPUTATION_HOOK_ABI, 'reputationRegistry'),
    read(cfg.hook, REPUTATION_HOOK_ABI, 'minFeedbackBudget'),
  ]);
  checks.push(check('hook.acp() = escrow', cfg.escrow, acp, sameAddress(acp, cfg.escrow)));
  checks.push(check('hook.trustedEvaluator() = C5_EVALUATOR', cfg.evaluator, trusted, sameAddress(trusted, cfg.evaluator)));
  checks.push(check('hook.identityRegistry() = ERC-8004 Identity Registry', C5_IDENTITY_REGISTRY, identity, sameAddress(identity, C5_IDENTITY_REGISTRY)));
  checks.push(check('hook.reputationRegistry() = ERC-8004 Reputation Registry', C5_REPUTATION_REGISTRY, reputation, sameAddress(reputation, C5_REPUTATION_REGISTRY)));
  checks.push(check('hook.minFeedbackBudget()', MIN_FEEDBACK_BUDGET_UNITS, minBudget));

  const [symbol, decimals] = await Promise.all([read(C5_USDC, ERC20_ABI, 'symbol'), read(C5_USDC, ERC20_ABI, 'decimals')]);
  checks.push(check('USDC symbol / decimals', 'USDC/6', `${symbol}/${decimals}`));

  const gasPrice = await c.getGasPrice();
  const evaluatorEth = await c.getBalance({ address: cfg.evaluator });
  const evaluatorNeeds = requiredEthWei('evaluator', gasPrice);
  checks.push(check(`evaluator gas (planned gas × ${Number(gasPrice) / 1e9} gwei × 3, floor 0.001)`, `≥ ${eth(evaluatorNeeds)}`, eth(evaluatorEth), evaluatorEth >= evaluatorNeeds));
  if (state?.agents) {
    for (const role of ['requester', 'provider'] as const) {
      const have = await c.getBalance({ address: state.agents[role].address });
      const needs = requiredEthWei(role, gasPrice);
      checks.push(check(`${role} gas`, `≥ ${eth(needs)}`, eth(have), have >= needs));
    }
  }

  // Backend: readiness, Q7 escrow verification, the window it applies.
  const ready = await api(cfg, '/health/ready').catch((err) => ({ status: 0, body: null, raw: String(err) }));
  const escrowView = Array.isArray(ready.body?.escrowConfig) ? ready.body.escrowConfig.find((v: any) => v.chainId === C5_CHAIN_ID) : undefined;
  checks.push(check('backend /health/ready reachable', 'HTTP 200 or 503 with a body', ready.status, ready.status === 200 || ready.status === 503));
  checks.push(check('backend escrow configuration verified (Q7)', 'verified / allowed', escrowView ? `${escrowView.state} / ${escrowView.allowed}` : 'absent', escrowView?.state === 'verified' && escrowView?.allowed === true));
  if (cfg.mode === 'testnet') checks.push(check('backend Turnkey readiness', true, ready.body?.checks?.turnkey ?? ready.body?.turnkey ?? 'absent', (ready.body?.checks?.turnkey ?? ready.body?.turnkey) === true));
  if (cfg.adminSecret) {
    const admin = await api(cfg, '/admin/escrow/verification', { adminSecret: cfg.adminSecret });
    checks.push(check('admin escrow verification reachable (local, admin secret)', 200, admin.status));
    const delay = admin.body?.escrowWindow?.evaluationDelaySeconds;
    checks.push(check('backend contest window (ESCROW_EVALUATION_DELAY_SECONDS)', cfg.windowSeconds, delay ?? 'absent'));
    const ttl = admin.body?.escrowWindow?.jobTtlSeconds;
    checks.push(check('job TTL leaves the window unclamped', `≥ ${cfg.windowSeconds + 3600}`, ttl ?? 'absent', typeof ttl === 'number' && ttl >= cfg.windowSeconds + 3600));
  } else {
    checks.push(check('C5_ADMIN_SECRET set (window and verification checks)', 'set', 'unset', false));
  }

  // Agents, once registered: same wallets, approved policies, no outflow cap.
  if (state?.agents && keys?.requesterApiKey && keys.providerApiKey) {
    for (const role of ['requester', 'provider'] as const) {
      const me = await api(cfg, '/v1/agents/me', { apiKey: role === 'requester' ? keys.requesterApiKey : keys.providerApiKey });
      const agent = state.agents[role];
      checks.push(check(`${role} API key resolves to the recorded agent`, agent.id, me.body?.id ?? me.status));
      checks.push(check(`${role} wallet unchanged`, agent.address, me.body?.walletAddress ?? 'absent', sameAddress(me.body?.walletAddress, agent.address)));
      const p = me.body?.policy ?? {};
      const want: Record<string, unknown> = role === 'requester' ? requesterPolicy(state.agents.provider.address) : { ...PROVIDER_POLICY };
      for (const [k, v] of Object.entries(want)) {
        const got = Array.isArray(v) ? (p[k] ?? []).map((a: string) => a.toLowerCase()).sort().join(',') : String(p[k]);
        const exp = Array.isArray(v) ? v.map((a) => String(a).toLowerCase()).sort().join(',') : String(v);
        checks.push(check(`${role} policy ${k}`, exp, got));
      }
      checks.push(check(`${role} policy maxOutflowPerTxUsd (null = ordinary outflows blocked)`, null, p.maxOutflowPerTxUsd ?? null));
      checks.push(check(`${role} policy active`, true, p.active));
    }
  }
  return checks;
}

async function cmdPreflight(cfg: Config): Promise<void> {
  const state = loadState(cfg);
  const keys = state?.agents && existsSync(keysPath(cfg)) ? loadKeys(cfg) : null;
  const ok = printChecks(`Preflight — ${cfg.mode} · ${cfg.rpcUrl} · ${cfg.apiUrl} · build ${EXPECTED_CONTRACT_CODE_VERSION.slice(0, 12)}`, await preflightChecks(cfg, state, keys));
  if (!ok) stop('preflight failed: fix the cause before any step that moves funds');
}

// ── setup ───────────────────────────────────────────────────────────────────

async function cmdSetup(cfg: Config): Promise<void> {
  if (loadState(cfg)?.agents) stop(`agents already registered for this run (${statePath(cfg)}); setup runs once`);
  if (!cfg.operatorSecret) stop('C5_OPERATOR_SECRET (the backend API_SECRET) is needed to register the agents');
  const pre = await preflightChecks(cfg, null, null);
  if (!printChecks('Preflight before registering agents', pre)) stop('preflight failed');
  const gasPrice = await client(cfg).getGasPrice();

  const runId = `c5-${new Date().toISOString().slice(0, 10)}-${toHex(crypto.getRandomValues(new Uint8Array(3))).slice(2)}`;
  const state: State = {
    version: 1,
    mode: cfg.mode,
    runId,
    createdAt: new Date().toISOString(),
    apiUrl: cfg.apiUrl,
    chainId: C5_CHAIN_ID,
    escrow: cfg.escrow,
    hook: cfg.hook,
    evaluator: cfg.evaluator,
    buildCodeVersion: EXPECTED_CONTRACT_CODE_VERSION,
    scenarios: {},
  };
  saveState(cfg, state);

  const register = async (role: 'provider' | 'requester', policy: Record<string, unknown>) => {
    const name = `${runId}-${role}`;
    const res = await api(cfg, '/v1/agents', { method: 'POST', apiKey: cfg.operatorSecret, body: { name, chainIds: [C5_CHAIN_ID], policy } });
    if (res.status !== 201) stop(`registering the ${role} failed: HTTP ${res.status} ${res.raw.slice(0, 300)}`);
    return { record: { id: res.body.id as string, name, address: getAddress(res.body.safeAddress) }, apiKey: res.body.apiKey as string };
  };
  // Provider first: the requester's allowedRecipients names the provider wallet.
  const provider = await register('provider', { ...PROVIDER_POLICY });
  writeSecretJson(keysPath(cfg), { providerApiKey: provider.apiKey } satisfies AgentKeys);
  const requester = await register('requester', requesterPolicy(provider.record.address));
  writeSecretJson(keysPath(cfg), { providerApiKey: provider.apiKey, requesterApiKey: requester.apiKey } satisfies AgentKeys);
  state.agents = { requester: requester.record, provider: provider.record };
  saveState(cfg, state);

  console.log(`
Run ${runId} — agents registered (fresh wallets from the backend's wallet provider — Turnkey on Base Sepolia — in EOA mode).
  requester  ${requester.record.id}  wallet ${requester.record.address}
  provider   ${provider.record.id}  wallet ${provider.record.address}
API keys: written to ${keysPath(cfg)} (git-ignored; never printed — keep the file private).

Funding request (testnet faucets only; nothing else may be sent to these wallets):
  requester  ≥ ${usdcUnits(TOTAL_BUDGET_UNITS)} (the three budgets ${SCENARIO_BUDGET.happy.amount} + ${SCENARIO_BUDGET.contest.amount} + ${SCENARIO_BUDGET.cancel.amount}) and ≥ ${eth(requiredEthWei('requester', gasPrice))} at today's gas price
  provider   ≥ ${eth(requiredEthWei('provider', gasPrice))} (no USDC)
Then: \`snapshot\`, and \`run happy\`.`);
}

// ── fund (fork rehearsal only) ──────────────────────────────────────────────

async function cmdFund(cfg: Config): Promise<void> {
  if (cfg.mode !== 'fork') stop('`fund` is a fork-rehearsal cheat; on the real network the faucets fund the wallets');
  const state = requireState(cfg);
  if (state.snapshot) stop('the snapshot is taken: funding now would falsify the reconcile baseline');
  const rpc = async (method: string, params: unknown[]) => client(cfg).request({ method: method as any, params: params as any });
  // Anvil's fork gas price is far above Base Sepolia's (~0.006 gwei): give the fork wallets ample ETH.
  const forkEth = 10n ** 17n;
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [state.agents.requester.address, 9n]));
  const units = TOTAL_BUDGET_UNITS + 500_000n;
  await rpc('anvil_setStorageAt', [C5_USDC, slot, toHex(units, { size: 32 })]);
  for (const addr of [state.agents.requester.address, state.agents.provider.address]) await rpc('anvil_setBalance', [addr, toHex(forkEth)]);
  const got = await usdcBalance(cfg, state.agents.requester.address);
  if (got !== units) stop(`fork funding: requester USDC is ${got}, expected ${units}`);
  console.log(`Fork funding: requester ${usdcUnits(units)} + ${eth(forkEth)}, provider ${eth(forkEth)}`);
}

// ── snapshot ────────────────────────────────────────────────────────────────

async function takeBalances(cfg: Config, state: State & { agents: NonNullable<State['agents']> }) {
  const c = client(cfg);
  const who: Record<string, Address> = {
    requester: state.agents.requester.address,
    provider: state.agents.provider.address,
    evaluator: cfg.evaluator,
    feeWallet: cfg.feeWallet,
    escrow: cfg.escrow,
  };
  const eth: Record<string, string> = {};
  const usdc: Record<string, string> = {};
  for (const [role, addr] of Object.entries(who)) {
    eth[role] = (await c.getBalance({ address: addr })).toString();
    usdc[role] = (await usdcBalance(cfg, addr)).toString();
  }
  const nonces = {
    requester: await c.getTransactionCount({ address: who['requester']! }),
    provider: await c.getTransactionCount({ address: who['provider']! }),
    evaluator: await c.getTransactionCount({ address: who['evaluator']! }),
  };
  const pending = (await c.readContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'pendingPlatformFees' })) as bigint;
  return { eth, usdc, nonces, pendingPlatformFees: pending.toString() };
}

async function cmdSnapshot(cfg: Config): Promise<void> {
  const state = requireState(cfg);
  if (state.snapshot) stop(`a snapshot exists (${state.snapshot.at}); it is the baseline of \`reconcile\` and is never replaced`);
  if (Object.keys(state.scenarios).length > 0) stop('a scenario already started: the snapshot must precede every job');
  const balances = await takeBalances(cfg, state);
  const short: string[] = [];
  if (BigInt(balances.usdc['requester']!) < TOTAL_BUDGET_UNITS) short.push(`requester USDC ${usdcUnits(BigInt(balances.usdc['requester']!))} < ${usdcUnits(TOTAL_BUDGET_UNITS)}`);
  const gasPrice = await client(cfg).getGasPrice();
  for (const role of ['requester', 'provider', 'evaluator'] as const) {
    const needs = requiredEthWei(role, gasPrice);
    if (BigInt(balances.eth[role]!) < needs) short.push(`${role} ETH ${eth(BigInt(balances.eth[role]!))} < ${eth(needs)}`);
  }
  if (short.length) stop(`insufficient balance — fund and retry:\n  ${short.join('\n  ')}`);
  state.snapshot = { at: new Date().toISOString(), block: (await client(cfg).getBlockNumber()).toString(), ...balances };
  saveState(cfg, state);
  console.log(`Snapshot at block ${state.snapshot.block}:`);
  for (const role of Object.keys(balances.eth)) console.log(`  ${role.padEnd(10)} ${eth(BigInt(balances.eth[role]!)).padStart(16)}  ${usdcUnits(BigInt(balances.usdc[role]!))}`);
  console.log(`  nonces ${JSON.stringify(balances.nonces)} · pendingPlatformFees ${balances.pendingPlatformFees}`);
}

// ── run ─────────────────────────────────────────────────────────────────────

async function adoptOrCreate(cfg: Config, state: State & { agents: NonNullable<State['agents']> }, keys: Required<AgentKeys>, scenario: Scenario): Promise<ScenarioRecord> {
  const existing = state.scenarios[scenario];
  if (existing) return existing;

  const outbox = await api(cfg, '/v1/jobs/outbox', { apiKey: keys.requesterApiKey });
  if (outbox.status !== 200) stop(`cannot list the requester's jobs (HTTP ${outbox.status}): refusing to create one blind`);
  const tagged = (outbox.body.jobs as any[]).filter((j) => j.payload?.c5?.runId === state.runId && j.payload?.c5?.scenario === scenario);
  if (tagged.length > 1) stop(`${tagged.length} jobs carry this run's ${scenario} tag: investigate before anything else`);
  if (tagged.length === 1) {
    const rec: ScenarioRecord = { runId: state.runId, jobId: tagged[0].id, createdAt: tagged[0].createdAt };
    state.scenarios[scenario] = rec;
    saveScenario(cfg, scenario, rec);
    console.log(`[${scenario}] adopted job ${rec.jobId} created by an interrupted run (no new job)`);
    return rec;
  }

  const budget = SCENARIO_BUDGET[scenario];
  const [usdc, reqEth, provEth] = await Promise.all([
    usdcBalance(cfg, state.agents.requester.address),
    client(cfg).getBalance({ address: state.agents.requester.address }),
    client(cfg).getBalance({ address: state.agents.provider.address }),
  ]);
  if (usdc < budget.units) stop(`requester holds ${usdcUnits(usdc)}, the ${scenario} budget is ${usdcUnits(budget.units)}`);
  const gasPrice = await client(cfg).getGasPrice();
  if (reqEth < requiredEthWei('requester', gasPrice)) stop(`requester gas ${eth(reqEth)} < ${eth(requiredEthWei('requester', gasPrice))}`);
  if (provEth < requiredEthWei('provider', gasPrice)) stop(`provider gas ${eth(provEth)} < ${eth(requiredEthWei('provider', gasPrice))}`);

  console.log(`[${scenario}] creating the job: ${budget.amount} USDC escrowed from the requester for the provider`);
  const created = await api(cfg, '/v1/jobs', {
    method: 'POST',
    apiKey: keys.requesterApiKey,
    body: {
      providerId: state.agents.provider.id,
      payload: { task: `C5 ${scenario}: summarise the last hour of Base Sepolia activity`, c5: { runId: state.runId, scenario } },
      reward: { amount: budget.amount, token: 'USDC', chainId: C5_CHAIN_ID },
    },
  }).catch(() => null);
  if (!created || created.status >= 500) {
    stop(`the job creation answer was lost or failed (${created ? `HTTP ${created.status}` : 'network'}): rerun \`run ${scenario}\`, which adopts the job if the backend created it`);
  }
  if (created!.status !== 201) stop(`job creation refused: HTTP ${created!.status} ${created!.raw.slice(0, 300)}`);
  const rec: ScenarioRecord = { runId: state.runId, jobId: created!.body.id, createdAt: new Date().toISOString() };
  state.scenarios[scenario] = rec;
  saveScenario(cfg, scenario, rec);
  return rec;
}

/** One-time checks that the job and its on-chain twin are exactly the approved ones. */
async function jobIdentityChecks(cfg: Config, state: State & { agents: NonNullable<State['agents']> }, scenario: Scenario, job: any): Promise<Check[]> {
  const e = job.escrow ?? {};
  const checks = [
    check('escrow contract = C5_ESCROW', cfg.escrow, e.contract, sameAddress(e.contract, cfg.escrow)),
    check('evaluator = C5_EVALUATOR', cfg.evaluator, e.evaluator, sameAddress(e.evaluator, cfg.evaluator)),
    check('budget (units)', SCENARIO_BUDGET[scenario].units, e.budgetAmount),
    check('budget token = USDC', C5_USDC, e.budgetToken, sameAddress(e.budgetToken, C5_USDC)),
    check('provider = approved provider', state.agents.provider.id, job.providerId),
  ];
  if (e.onChainJobId) {
    const chainJob = await readChainJob(cfg, BigInt(e.onChainJobId));
    checks.push(
      check('chain: client = requester wallet', state.agents.requester.address, chainJob.client, sameAddress(chainJob.client, state.agents.requester.address)),
      check('chain: provider = provider wallet', state.agents.provider.address, chainJob.provider, sameAddress(chainJob.provider, state.agents.provider.address)),
      check('chain: evaluator', cfg.evaluator, chainJob.evaluator, sameAddress(chainJob.evaluator, cfg.evaluator)),
      check('chain: hook', cfg.hook, chainJob.hook, sameAddress(chainJob.hook, cfg.hook)),
      check('chain: budget', SCENARIO_BUDGET[scenario].units, chainJob.budget),
    );
  }
  return checks;
}

function simulationRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) return reverted.data?.errorName ?? reverted.reason ?? 'reverted';
    return err.shortMessage;
  }
  return String(err);
}

/** C5 acceptance: an agent without authority cannot resolve the dispute — off-chain or on-chain. Nothing here sends a transaction. */
async function authorityChecks(cfg: Config, state: State & { agents: NonNullable<State['agents']> }, keys: Required<AgentKeys>, jobId: string, onChainJobId: bigint): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [role, apiKey, decision] of [
    ['provider', keys.providerApiKey, 'pay'],
    ['requester', keys.requesterApiKey, 'refund'],
  ] as const) {
    const res = await api(cfg, `/admin/jobs/${jobId}/resolve`, { method: 'POST', apiKey, body: { decision, note: `C5 authority check: ${role} without the admin credential` } });
    checks.push(check(`${role} API key cannot call the operator resolve`, 401, res.status));
  }
  const cancel = await api(cfg, `/v1/jobs/${jobId}`, { method: 'PATCH', apiKey: keys.requesterApiKey, body: { status: 'CANCELLED' } });
  checks.push(check('requester cannot cancel the contested job', '4xx', cancel.status, cancel.status >= 400 && cancel.status < 500));
  const redeliver = await api(cfg, `/v1/jobs/${jobId}`, { method: 'PATCH', apiKey: keys.providerApiKey, body: { status: 'COMPLETED', result: { summary: 'C5 authority check' } } });
  checks.push(check('provider cannot complete it again', '4xx', redeliver.status, redeliver.status >= 400 && redeliver.status < 500));
  const batch = await api(cfg, '/v1/transactions/batch', {
    method: 'POST',
    apiKey: keys.providerApiKey,
    body: {
      chainId: C5_CHAIN_ID,
      actions: [{ to: cfg.escrow, data: encodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, functionName: 'complete', args: [onChainJobId, REASONS.completed, '0x'] }) }],
    },
  });
  checks.push(check('provider cannot route escrow.complete through a batch', 'refused (not 2xx)', batch.status, batch.status >= 400));

  const c = client(cfg);
  for (const [role, account] of [
    ['provider', state.agents.provider.address],
    ['requester', state.agents.requester.address],
  ] as const) {
    for (const functionName of ['complete', 'reject'] as const) {
      const reason = functionName === 'complete' ? REASONS.completed : REASONS.qualityRejected;
      const outcome = await c
        .simulateContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName, args: [onChainJobId, reason, '0x'], account })
        .then(() => 'would succeed')
        .catch(simulationRevert);
      checks.push(check(`chain: ${role} wallet cannot ${functionName} (eth_call, nothing sent)`, 'Unauthorized', outcome));
    }
  }
  const after = await getJob(cfg, keys.requesterApiKey, jobId);
  checks.push(check('job still held after the attempts', 'CONTESTED / no resolution / no settle tx', `${after.escrow?.onChainStatus} / ${after.escrow?.resolution ?? 'none'} / ${after.escrow?.settleTxHash ?? 'none'}`,
    after.escrow?.onChainStatus === 'CONTESTED' && !after.escrow?.resolution && !after.escrow?.settleTxHash));
  checks.push(check('chain: still Submitted', CHAIN_STATUS.Submitted, (await readChainJob(cfg, onChainJobId)).status));
  return checks;
}

async function cmdRun(cfg: Config, scenario: Scenario): Promise<void> {
  const state = requireState(cfg);
  const keys = loadKeys(cfg);
  if (!state.snapshot) stop('take the `snapshot` first (the baseline of `reconcile`)');
  if (scenario !== 'happy') {
    const happy = state.scenarios.happy;
    const happyJob = happy ? await getJob(cfg, keys.requesterApiKey, happy.jobId) : null;
    if (happyJob?.escrow?.providerAgentIdStatus !== 'BOUND') stop('start `run happy` first and wait until its ERC-8004 binding is BOUND (one identity registration, no race)');
  }
  const pre = await preflightChecks(cfg, state, keys);
  if (!printChecks('Preflight', pre)) stop('preflight failed');

  const rec = await adoptOrCreate(cfg, state, keys, scenario);
  console.log(`[${scenario}] job ${rec.jobId} — run ${state.runId}`);
  let identityChecked = false;
  let lastLine = '';
  let lastPrint = 0;

  for (;;) {
    const job = await getJob(cfg, keys.requesterApiKey, rec.jobId);
    const e = job.escrow ?? {};
    if (e.onChainJobId && !rec.onChainJobId) {
      rec.onChainJobId = String(e.onChainJobId);
      saveScenario(cfg, scenario, rec);
    }
    if (!identityChecked && e.onChainJobId && ['FUNDED', 'SUBMITTED', 'CONTESTED', 'SETTLING', 'COMPLETED', 'REJECTED'].includes(e.onChainStatus)) {
      if (!printChecks(`[${scenario}] job and on-chain job are the approved ones`, await jobIdentityChecks(cfg, state, scenario, job))) stop('the job differs from the approved plan');
      identityChecked = true;
    }
    const step = nextStep(scenario, job as JobSnapshot);
    const line = `status=${job.status} onChain=${e.onChainStatus} binding=${e.providerAgentIdStatus ?? '-'} → ${step.kind}${step.kind === 'wait' ? ` (${step.for})` : ''}`;
    if (line !== lastLine || Date.now() - lastPrint > 5 * 60_000) {
      console.log(`  ${new Date().toISOString()}  ${line}`);
      lastLine = line;
      lastPrint = Date.now();
    }

    if ((e.onChainStatus === 'SUBMITTED' || e.onChainStatus === 'CONTESTED') && !rec.submittedAt && rec.onChainJobId) {
      const at = (await client(cfg).readContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'submittedAt', args: [BigInt(rec.onChainJobId)] })) as bigint;
      if (at > 0n) {
        rec.submittedAt = at.toString();
        saveScenario(cfg, scenario, rec);
        console.log(`  submit confirmed on-chain at ${new Date(Number(at) * 1000).toISOString()}; settlement not before ${new Date((Number(at) + cfg.windowSeconds) * 1000).toISOString()}`);
      }
    }

    switch (step.kind) {
      case 'stop':
        return stop(`[${scenario}] ${step.reason}`);
      case 'done': {
        console.log(`[${scenario}] settled on-chain: ${e.onChainStatus} in ${e.settleTxHash}`);
        await cmdVerify(cfg, scenario);
        return;
      }
      case 'accept': {
        const res = await api(cfg, `/v1/jobs/${rec.jobId}`, { method: 'PATCH', apiKey: keys.providerApiKey, body: { status: 'ACCEPTED' } });
        if (res.status !== 200) console.log(`  accept answered HTTP ${res.status}; re-reading the job before anything else`);
        break;
      }
      case 'deliver': {
        const res = await api(cfg, `/v1/jobs/${rec.jobId}`, {
          method: 'PATCH',
          apiKey: keys.providerApiKey,
          body: { status: 'COMPLETED', result: { summary: `C5 ${scenario} deliverable`, run: state.runId } },
        });
        if (res.status !== 200) console.log(`  deliver answered HTTP ${res.status}; re-reading the job before anything else`);
        break;
      }
      case 'cancel': {
        const res = await api(cfg, `/v1/jobs/${rec.jobId}`, { method: 'PATCH', apiKey: keys.requesterApiKey, body: { status: 'CANCELLED' } });
        if (res.status !== 200) console.log(`  cancel answered HTTP ${res.status}; re-reading the job before anything else`);
        break;
      }
      case 'contest': {
        const res = await api(cfg, `/v1/jobs/${rec.jobId}/contest`, { method: 'POST', apiKey: keys.requesterApiKey, body: { reason: 'C5 contest scenario: deliverable does not match the brief' } });
        if (res.status !== 200) console.log(`  contest answered HTTP ${res.status} ${res.raw.slice(0, 200)}; re-reading the job`);
        else {
          rec.contestedAt = new Date().toISOString();
          saveScenario(cfg, scenario, rec);
        }
        break;
      }
      case 'hold': {
        const recorded = authorityState(rec.authorityChecks);
        if (recorded === 'failed') {
          printChecks('[contest] recorded authority checks', rec.authorityChecks!);
          stop('a recorded authority check failed: investigate before anything else — the operator decision stays blocked');
        }
        if (recorded === 'missing') {
          const checks = await authorityChecks(cfg, state, keys, rec.jobId, BigInt(rec.onChainJobId!));
          rec.authorityChecks = checks;
          saveScenario(cfg, scenario, rec);
          if (!printChecks('[contest] agents without authority cannot resolve the dispute', checks)) stop('an authority check failed');
          console.log('  Optional restart test: stop and start the worker (terminal B) now; the job must stay held.');
        }
        if (!rec.submittedAt) break;
        const now = await chainNow(cfg);
        const left = holdSecondsLeft(BigInt(rec.submittedAt), now, cfg.windowSeconds);
        const chainStatus = (await readChainJob(cfg, BigInt(rec.onChainJobId!))).status;
        if (chainStatus !== CHAIN_STATUS.Submitted || e.settleTxHash) stop('the contested job moved on-chain without an operator decision');
        if (left === 0n) {
          rec.holdProvenAt = new Date().toISOString();
          saveScenario(cfg, scenario, rec);
          console.log(`\n[contest] HELD past the window: ${cfg.windowSeconds} s + margin after submit, still CONTESTED and Submitted, nothing settled.`);
          console.log('Operator decision (needs C5_ADMIN_SECRET):  npx tsx src/scripts/c5/escrow-validation.ts resolve contest');
          return;
        }
        if (Date.now() - lastPrint > 5 * 60_000) console.log(`  held; ${left} s until the hold counts as proven`);
        break;
      }
      case 'resolve-by-operator':
      case 'wait':
        break;
    }
    const slow = e.onChainStatus === 'SUBMITTED' || e.onChainStatus === 'CONTESTED';
    await sleep(slow ? 30_000 : 4_000);
  }
}

// ── resolve ─────────────────────────────────────────────────────────────────

async function cmdResolve(cfg: Config, scenario: Scenario): Promise<void> {
  if (scenario !== 'contest') stop('only the contest scenario has an operator decision');
  if (!cfg.adminSecret) stop('C5_ADMIN_SECRET (the backend ADMIN_SECRET) is needed; the request must come from this machine');
  const state = requireState(cfg);
  const keys = loadKeys(cfg);
  const rec = state.scenarios.contest;
  if (!rec?.onChainJobId) stop('no contest job yet');
  if (!rec!.holdProvenAt) stop('the hold is not proven yet: rerun `run contest` until it says HELD past the window');
  if (authorityState(rec!.authorityChecks) !== 'passed') stop('the authority checks are missing or failed: no operator decision until they pass');

  const job = await getJob(cfg, keys.requesterApiKey, rec!.jobId);
  if (job.escrow?.resolution) {
    console.log(`[contest] already resolved (${job.escrow.resolution}); not sending it again — following the settlement`);
  } else {
    if (job.escrow?.onChainStatus !== 'CONTESTED') stop(`the job is ${job.escrow?.onChainStatus}, not CONTESTED`);
    const res = await api(cfg, `/admin/jobs/${rec!.jobId}/resolve`, {
      method: 'POST',
      adminSecret: cfg.adminSecret,
      body: { decision: 'refund', verdict: 'quality-rejected', note: `C5 ${state.runId}: contest upheld by the operator after the held window`, operator: 'c5-owner' },
    }).catch(() => null);
    if (!res) stop('the resolve answer was lost: rerun `resolve contest` (it re-reads the job and never sends a second decision)');
    if (res!.status !== 202) stop(`resolve refused: HTTP ${res!.status} ${res!.raw.slice(0, 300)}`);
    rec!.resolveRequestedAt = new Date().toISOString();
    saveScenario(cfg, 'contest', rec!);
    console.log(`[contest] operator decision accepted: ${JSON.stringify(res!.body)}`);
  }
  await cmdRun(cfg, 'contest');
}

// ── verify ──────────────────────────────────────────────────────────────────

async function txGas(cfg: Config, hash: Hex) {
  const receipt = await client(cfg).getTransactionReceipt({ hash });
  const l1Fee = BigInt((receipt as any).l1Fee ?? 0);
  return { hash, from: getAddress(receipt.from), gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, l1Fee, costWei: receipt.gasUsed * receipt.effectiveGasPrice + l1Fee, status: receipt.status, block: receipt.blockNumber };
}

const word = (value: bigint | Address) => toHex(typeof value === 'bigint' ? value : BigInt(value), { size: 32 });
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));
const APPROVAL_TOPIC = keccak256(toBytes('Approval(address,address,uint256)'));

/** eth_getLogs in windows of 2 000 blocks (public RPCs cap the range). */
async function rawLogs(cfg: Config, filter: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint }): Promise<Log[]> {
  const c = client(cfg);
  const latest = await c.getBlockNumber();
  const out: Log[] = [];
  for (let from = filter.fromBlock; from <= latest; from += 2_000n) {
    const to = from + 1_999n > latest ? latest : from + 1_999n;
    const logs = (await c.request({
      method: 'eth_getLogs',
      params: [{ address: filter.address, topics: filter.topics as any, fromBlock: toHex(from), toBlock: toHex(to) }],
    })) as any[];
    for (const l of logs) out.push({ ...l, blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex), transactionIndex: Number(l.transactionIndex) } as Log);
  }
  return out;
}

/** The job's own escrow transactions (first tx per event), from the escrow logs indexed by jobId. */
async function jobTransactions(cfg: Config, onChainJobId: bigint, fromBlock: bigint): Promise<Record<string, Hex>> {
  const logs = await rawLogs(cfg, { address: cfg.escrow, topics: [null, word(onChainJobId)], fromBlock });
  const byEvent: Record<string, Hex> = {};
  for (const log of parseEventLogs({ abi: AGENT_JOB_ESCROW_ABI, logs }) as any[]) if (!byEvent[log.eventName]) byEvent[log.eventName] = log.transactionHash;
  return byEvent;
}

async function cmdVerify(cfg: Config, scenario: Scenario): Promise<boolean> {
  const state = requireState(cfg);
  const keys = loadKeys(cfg);
  const rec = state.scenarios[scenario];
  if (!rec) return stop(`no ${scenario} job in this run`);
  const job = await getJob(cfg, keys.requesterApiKey, rec.jobId);
  const e = job.escrow ?? {};
  const checks: Check[] = [...jobViewChecks(scenario, job)];
  if (!e.settleTxHash || !e.onChainJobId) {
    printChecks(`[${scenario}] verify`, checks);
    return stop('not settled yet');
  }
  const onChainJobId = BigInt(e.onChainJobId);
  const x = expectedOutcome(scenario);
  const c = client(cfg);

  const receipt = await c.getTransactionReceipt({ hash: e.settleTxHash });
  const decoded: DecodedEvent[] = [];
  const add = (abi: any, address: Address) => {
    const logs = receipt.logs.filter((l) => sameAddress(l.address, address)) as Log[];
    for (const ev of parseEventLogs({ abi, logs }) as any[]) decoded.push({ address: ev.address, eventName: ev.eventName, args: ev.args });
  };
  add(AGENT_JOB_ESCROW_ABI, cfg.escrow);
  add(REPUTATION_HOOK_ABI, cfg.hook);
  add(REPUTATION_REGISTRY_ABI, C5_REPUTATION_REGISTRY);
  add(ERC20_ABI, C5_USDC);
  const providerAgentId = e.providerAgentId ? BigInt(e.providerAgentId) : null;
  checks.push(
    ...settlementChecks({
      scenario,
      onChainJobId,
      requester: state.agents.requester.address,
      provider: state.agents.provider.address,
      escrow: cfg.escrow,
      hook: cfg.hook,
      usdc: C5_USDC,
      providerAgentId,
      events: decoded,
      settleTxStatus: receipt.status,
      settleTxFrom: getAddress(receipt.from),
      evaluator: cfg.evaluator,
    }),
  );

  const chainJob = await readChainJob(cfg, onChainJobId);
  checks.push(check('chain: job status', x.chainStatus, chainJob.status));

  const settledAt = await blockTimestamp(cfg, receipt.blockNumber);
  const submittedAt = (await c.readContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'submittedAt', args: [onChainJobId] })) as bigint;
  if (scenario === 'happy') checks.push(windowCheck(submittedAt, settledAt, cfg.windowSeconds));
  if (scenario === 'contest') {
    checks.push(windowCheck(submittedAt, settledAt, cfg.windowSeconds));
    checks.push(check('hold proven before the operator decision', 'recorded', rec.holdProvenAt ? 'recorded' : 'missing', !!rec.holdProvenAt));
    const auth = rec.authorityChecks ?? [];
    checks.push(check('authority checks recorded and passed', 'all passed', auth.length ? `${auth.filter((a) => a.ok).length}/${auth.length}` : 'none', auth.length > 0 && auth.every((a) => a.ok)));
  }

  // ERC-8004: the provider identity and the public feedback file.
  if (x.feedback.status === 'written' && providerAgentId !== null) {
    const [owner, wallet, uri, bound] = await Promise.all([
      c.readContract({ address: C5_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'ownerOf', args: [providerAgentId] }),
      c.readContract({ address: C5_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'getAgentWallet', args: [providerAgentId] }),
      c.readContract({ address: C5_IDENTITY_REGISTRY, abi: IDENTITY_REGISTRY_READ_ABI, functionName: 'tokenURI', args: [providerAgentId] }),
      c.readContract({ address: cfg.escrow, abi: AGENT_JOB_ESCROW_ABI, functionName: 'providerAgentId', args: [onChainJobId] }),
    ]);
    checks.push(check('ERC-8004 ownerOf(agentId) = provider wallet', state.agents.provider.address, owner, sameAddress(owner as string, state.agents.provider.address)));
    checks.push(check('ERC-8004 getAgentWallet(agentId) = provider wallet', state.agents.provider.address, wallet, sameAddress(wallet as string, state.agents.provider.address)));
    checks.push(check('ERC-8004 tokenURI = the provider registration file', `${cfg.backendPublicUrl}/v1/agents/${state.agents.provider.id}/erc8004.json`, uri));
    checks.push(check('escrow.providerAgentId(job) = bound agent', providerAgentId, bound));

    const feedback = decoded.find((d) => d.eventName === 'NewFeedback');
    const file = await fetch(`${cfg.apiUrl}/v1/jobs/${rec.jobId}/feedback.json`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    checks.push(check('feedback file served', 200, file.status));
    checks.push(check('keccak256(feedback file) = NewFeedback.feedbackHash', feedback?.args['feedbackHash'] ?? 'absent', keccak256(bytes)));
    let json: any = null;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = null;
    }
    checks.push(check('feedback file outcome', x.feedback.tag2, json?.outcome ?? null));
    const txs = await jobTransactions(cfg, onChainJobId, BigInt(state.snapshot?.block ?? 0));
    checks.push(check('feedback file proofOfPayment = the fund tx', txs['JobFunded'] ?? 'absent', json?.proofOfPayment?.txHash ?? null));
  } else {
    const file = await fetch(`${cfg.apiUrl}/v1/jobs/${rec.jobId}/feedback.json`);
    checks.push(check('no feedback file for a skipped feedback', 404, file.status));
  }

  // Gas, kept apart from payments: every escrow transaction of this job.
  const txs = await jobTransactions(cfg, onChainJobId, BigInt(state.snapshot?.block ?? 0));
  const gas: Record<string, unknown> = {};
  for (const [eventName, hash] of Object.entries(txs)) {
    if (hash.toLowerCase() === String(e.settleTxHash).toLowerCase()) continue;
    gas[eventName] = await txGas(cfg, hash);
  }
  gas['settle'] = { ...(await txGas(cfg, e.settleTxHash)), events: Object.entries(txs).filter(([, h]) => h.toLowerCase() === String(e.settleTxHash).toLowerCase()).map(([n]) => n) };
  // The two transactions that carry no escrow event: the requester's USDC approve, and (first job) the provider's ERC-8004 register.
  const created = gas['JobCreated'] as { block: bigint } | undefined;
  const funded = gas['JobFunded'] as { block: bigint } | undefined;
  if (created && funded) {
    const approvals = await rawLogs(cfg, { address: C5_USDC, topics: [APPROVAL_TOPIC, word(state.agents.requester.address), word(cfg.escrow)], fromBlock: created.block });
    const approval = approvals.find((l) => (l.blockNumber ?? 0n) <= funded.block);
    if (approval?.transactionHash) gas['approve'] = await txGas(cfg, approval.transactionHash);
  }
  if (scenario === 'happy') {
    const mints = await rawLogs(cfg, { address: C5_IDENTITY_REGISTRY, topics: [TRANSFER_TOPIC, word(0n), word(state.agents.provider.address)], fromBlock: BigInt(state.snapshot?.block ?? 0) });
    if (mints[0]?.transactionHash) gas['erc8004Register'] = await txGas(cfg, mints[0].transactionHash);
  }

  const ok = printChecks(`[${scenario}] acceptance — job ${rec.jobId} · on-chain #${onChainJobId} · settle ${e.settleTxHash}`, checks);
  rec.verifiedAt = new Date().toISOString();
  rec.result = ok ? 'PASS' : 'FAIL';
  saveScenario(cfg, scenario, rec);
  writeJsonAtomic(join(cfg.stateDir, 'evidence', `${scenario}.json`), {
    runId: state.runId,
    scenario,
    jobId: rec.jobId,
    onChainJobId,
    budgetUnits: SCENARIO_BUDGET[scenario].units,
    expected: { payoutUnits: x.payoutUnits, feeUnits: x.feeUnits, refundUnits: x.refundUnits, feedback: x.feedback },
    job,
    submittedAt,
    settledAt,
    transactions: gas,
    checks,
    result: rec.result,
    verifiedAt: rec.verifiedAt,
  });
  console.log(`  evidence: ${join(cfg.stateDir, 'evidence', `${scenario}.json`)}`);
  if (!ok) stop(`[${scenario}] acceptance FAILED`);
  return ok;
}

// ── reconcile ───────────────────────────────────────────────────────────────

async function cmdReconcile(cfg: Config): Promise<void> {
  const state = requireState(cfg);
  if (!state.snapshot) stop('no snapshot');
  for (const s of ['happy', 'contest', 'cancel'] as const) if (state.scenarios[s]?.result !== 'PASS') stop(`scenario ${s} is not verified PASS yet`);
  const c = client(cfg);
  const now = await takeBalances(cfg, state);
  const before = state.snapshot!;
  const d = (map: 'usdc' | 'eth', role: string) => BigInt(now[map][role]!) - BigInt(before[map][role]!);
  const fee = feeUnits(SCENARIO_BUDGET.happy.units);
  const checks: Check[] = [
    check('requester USDC Δ (only the completed job is paid)', -SCENARIO_BUDGET.happy.units, d('usdc', 'requester')),
    check('provider USDC Δ (payout = budget − 30 bps)', SCENARIO_BUDGET.happy.units - fee, d('usdc', 'provider')),
    check('escrow USDC Δ = accrued platform fee', fee, d('usdc', 'escrow')),
    check('pendingPlatformFees Δ', fee, BigInt(now.pendingPlatformFees) - BigInt(before.pendingPlatformFees)),
    check('fee wallet USDC Δ (fees stay in the escrow until withdrawn)', 0n, d('usdc', 'feeWallet')),
    check('fee wallet ETH Δ', 0n, d('eth', 'feeWallet')),
    nonceCheck('requester', before.nonces.requester, now.nonces.requester),
    nonceCheck('provider', before.nonces.provider, now.nonces.provider),
    nonceCheck('evaluator', before.nonces.evaluator, now.nonces.evaluator),
  ];

  // Every USDC transfer touching the agents since the snapshot must be one the plan explains.
  const fromBlock = BigInt(before.block) + 1n;
  const agentWords = [word(state.agents.requester.address), word(state.agents.provider.address)];
  const transfers = parseEventLogs({
    abi: ERC20_ABI,
    logs: [
      ...(await rawLogs(cfg, { address: C5_USDC, topics: [TRANSFER_TOPIC, agentWords], fromBlock })),
      ...(await rawLogs(cfg, { address: C5_USDC, topics: [TRANSFER_TOPIC, null, agentWords], fromBlock })),
    ],
  }) as any[];
  const unique = new Map(transfers.map((t) => [`${t.transactionHash}:${t.logIndex}`, t]));
  const expectedPairs = new Set([
    `${state.agents.requester.address}>${cfg.escrow}:${SCENARIO_BUDGET.happy.units}`,
    `${state.agents.requester.address}>${cfg.escrow}:${SCENARIO_BUDGET.contest.units}`,
    `${state.agents.requester.address}>${cfg.escrow}:${SCENARIO_BUDGET.cancel.units}`,
    `${cfg.escrow}>${state.agents.requester.address}:${SCENARIO_BUDGET.contest.units}`,
    `${cfg.escrow}>${state.agents.requester.address}:${SCENARIO_BUDGET.cancel.units}`,
    `${cfg.escrow}>${state.agents.provider.address}:${SCENARIO_BUDGET.happy.units - fee}`,
  ].map((s) => s.toLowerCase()));
  const seen = [...unique.values()].map((t) => `${t.args.from}>${t.args.to}:${t.args.value}`.toLowerCase());
  const unexplained = seen.filter((s) => !expectedPairs.has(s));
  checks.push(check('USDC transfers touching the agents', `${expectedPairs.size} expected, 0 other`, `${seen.length} seen, ${unexplained.length} other`, seen.length === expectedPairs.size && unexplained.length === 0));
  for (const u of unexplained) console.log(`  unexplained transfer: ${u}`);

  // ETH: no wallet sends or receives value in this run, so each ETH Δ is gas. The
  // transactions the logs reveal (escrow events of the three jobs, the USDC
  // approvals, the identity mint, the settlements) explain it; what remains
  // must be at most a reverted, log-less transaction's gas (e.g. a late
  // setProviderAgentId in the cancel race), never a value transfer.
  const hashes = new Set<Hex>();
  for (const s of ['happy', 'contest', 'cancel'] as const) {
    const job = state.scenarios[s]!;
    for (const h of Object.values(await jobTransactions(cfg, BigInt(job.onChainJobId!), fromBlock))) hashes.add(h);
  }
  for (const l of await rawLogs(cfg, { address: C5_USDC, topics: [APPROVAL_TOPIC, word(state.agents.requester.address), word(cfg.escrow)], fromBlock })) hashes.add(l.transactionHash!);
  for (const l of await rawLogs(cfg, { address: C5_IDENTITY_REGISTRY, topics: [TRANSFER_TOPIC, null, word(state.agents.provider.address)], fromBlock })) hashes.add(l.transactionHash!);
  const gasBy: Record<string, { count: number; wei: bigint }> = {};
  for (const h of hashes) {
    const g = await txGas(cfg, h);
    const role = sameAddress(g.from, state.agents.requester.address) ? 'requester' : sameAddress(g.from, state.agents.provider.address) ? 'provider' : sameAddress(g.from, cfg.evaluator) ? 'evaluator' : 'other';
    gasBy[role] = { count: (gasBy[role]?.count ?? 0) + 1, wei: (gasBy[role]?.wei ?? 0n) + g.costWei };
  }
  const UNEXPLAINED_MAX_WEI = 100_000_000_000_000n; // 0.0001 ETH: ≈ 16 M gas at 0.006 gwei, far below any value transfer
  for (const role of ['requester', 'provider', 'evaluator'] as const) {
    const delta = d('eth', role);
    const explained = gasBy[role]?.wei ?? 0n;
    const unexplained = -delta - explained;
    console.log(`  ${role}: ETH Δ ${delta} wei, gas of ${gasBy[role]?.count ?? 0} found transactions ${explained} wei, unexplained ${unexplained} wei`);
    checks.push(check(`${role} ETH Δ = gas (found txs + at most a reverted tx's gas)`, `0 ≤ unexplained ≤ ${UNEXPLAINED_MAX_WEI}`, unexplained, unexplained >= 0n && unexplained <= UNEXPLAINED_MAX_WEI));
  }
  checks.push(check('transactions from other senders in the run', 0, gasBy['other']?.count ?? 0));

  const agentId = BigInt((await getJob(cfg, loadKeys(cfg).requesterApiKey, state.scenarios.happy!.jobId)).escrow.providerAgentId);
  for (const [tag2, value] of [['completed', 100n], ['rejected', 0n]] as const) {
    const [count, summary] = (await c.readContract({ address: C5_REPUTATION_REGISTRY, abi: REPUTATION_REGISTRY_ABI, functionName: 'getSummary', args: [agentId, [cfg.hook], 'agentfi.job', tag2] })) as [bigint, bigint, number];
    checks.push(check(`getSummary(#${agentId}, [hook], agentfi.job, ${tag2})`, `1 / ${value}`, `${count} / ${summary}`));
  }

  const ok = printChecks(`Reconcile — run ${state.runId} vs snapshot at block ${before.block}`, checks);
  writeJsonAtomic(join(cfg.stateDir, 'evidence', 'reconcile.json'), { runId: state.runId, before, after: now, checks, result: ok ? 'PASS' : 'FAIL', at: new Date().toISOString() });
  if (!ok) stop('reconcile FAILED');
  console.log('\nRows for docs/project/testnet-log.md §3 (fund tx = JobFunded in evidence/<scenario>.json):');
  for (const s of ['happy', 'contest', 'cancel'] as const) {
    const ev = JSON.parse(readFileSync(join(cfg.stateDir, 'evidence', `${s}.json`), 'utf8'));
    const fund = ev.transactions?.JobFunded?.hash ?? '';
    const settle = ev.transactions?.settle?.hash ?? '';
    const fb = ev.job?.escrow?.feedbackStatus ?? '';
    console.log(`| ${new Date().toISOString().slice(0, 10)} | ${ev.jobId} | ${ev.onChainJobId} | ${fund} | ${settle} | ${ev.job?.escrow?.onChainStatus} (${s}) | ${ev.job?.escrow?.platformFeeAmount ?? 0} | ${fb} | C5 runner ${state.runId} |`);
  }
}

// ── status ──────────────────────────────────────────────────────────────────

async function cmdStatus(cfg: Config): Promise<void> {
  const state = loadState(cfg);
  if (!state) {
    console.log(`no run in ${cfg.stateDir}`);
    return;
  }
  console.log(`run ${state.runId} (${state.mode}) · build ${state.buildCodeVersion.slice(0, 12)} · escrow ${state.escrow} · hook ${state.hook}`);
  if (state.agents) console.log(`  requester ${state.agents.requester.id} ${state.agents.requester.address}\n  provider  ${state.agents.provider.id} ${state.agents.provider.address}`);
  console.log(`  snapshot ${state.snapshot ? `block ${state.snapshot.block}` : 'none'}`);
  const keys = state.agents && existsSync(keysPath(cfg)) ? loadKeys(cfg) : null;
  for (const s of ['happy', 'contest', 'cancel'] as const) {
    const rec = state.scenarios[s];
    if (!rec) {
      console.log(`  ${s.padEnd(8)} not started`);
      continue;
    }
    const job = keys ? await getJob(cfg, keys.requesterApiKey, rec.jobId) : null;
    console.log(`  ${s.padEnd(8)} job ${rec.jobId} #${rec.onChainJobId ?? '-'} · ${job ? `${job.status} / ${job.escrow?.onChainStatus} / binding ${job.escrow?.providerAgentIdStatus ?? '-'}` : 'n/a'} · ${rec.result ?? 'unverified'}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  const scenarioArg = (): Scenario => (isScenario(arg) ? arg : stop(`${command} needs a scenario: happy | contest | cancel`));
  switch (command) {
    case 'preflight':
      return cmdPreflight(cfg);
    case 'setup':
      return cmdSetup(cfg);
    case 'fund':
      return cmdFund(cfg);
    case 'snapshot':
      return cmdSnapshot(cfg);
    case 'run': {
      const scenario = scenarioArg();
      lockScenario(cfg, scenario);
      return cmdRun(cfg, scenario);
    }
    case 'resolve': {
      const scenario = scenarioArg();
      lockScenario(cfg, scenario);
      return cmdResolve(cfg, scenario);
    }
    case 'verify':
      await cmdVerify(cfg, scenarioArg());
      return;
    case 'reconcile':
      return cmdReconcile(cfg);
    case 'status':
      return cmdStatus(cfg);
    default:
      console.log('usage: escrow-validation.ts preflight | setup | fund | snapshot | run <s> | resolve contest | verify <s> | reconcile | status');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  if (err instanceof StopError) {
    console.error(`\nSTOP: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
