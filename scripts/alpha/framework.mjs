#!/usr/bin/env node
/**
 * `npm run alpha:framework` — runs a REAL agent framework (OpenAI Agents SDK, Python) through the AgentFi MCP server
 * (stdio, built from this checkout) against the REAL LOCAL BACKEND of the fork demo, and checks the result against
 * the ledger, the chain and the seller. One command, exit 0 only if every invariant held.
 *
 *   npm run alpha:framework              # prerequisites, banner, run
 *   npm run alpha:framework -- --yes     # confirm a wipe of non-default targets without a prompt
 *   npm run alpha:framework -- --check   # only the prerequisites
 *
 * What is real: the framework, the MCP stdio transport and server, the API, the worker, the EIP-3009 signature, the
 * seller's @x402/evm exact facilitator, the USDC contract (on a LOCAL Anvil fork). What is stubbed: the model (a
 * scripted one: no LLM, no key). Mode: LOCAL FORK. Nothing is sent to a public network.
 *
 * Steps: start `npm run demo:x402:serve` (API + worker + seller + Anvil fork) -> framework run 1 (an allowed
 * purchase) -> `x402:ops status` -> framework run 2 (over-budget and over-policy purchases) -> `x402:ops status` ->
 * assertions -> stop everything. Destructive targets and the --yes rule are the demo's (scripts/alpha/guard.mjs).
 *
 * Environment: the demo's (X402_DEMO_DATABASE_URL, X402_DEMO_REDIS_URL, X402_DEMO_ANVIL_PORT, X402_DEMO_BACKEND_PORT,
 * E2E_ANVIL_FORK_URL, X402_DEMO_ALLOW_REMOTE) plus ALPHA_PYTHON (default `python`; needs `pip install -r
 * examples/openai-agents/requirements.txt`) and X402_FRAMEWORK_TRANSCRIPT (default <tmp>/agentfi-alpha-framework-transcript.txt).
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmWipe } from './confirm.mjs';
import { DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL, destructiveProblems } from './guard.mjs';
import { checkAllowed, checkBlocked, parseEnvFile, renderChecks, spawnDetached, terminationPlan } from './framework-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'packages', 'backend');
const checkOnly = process.argv.includes('--check');
const assumeYes = process.argv.includes('--yes');
const DATABASE_URL = process.env.X402_DEMO_DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
const REDIS_URL = process.env.X402_DEMO_REDIS_URL?.trim() || DEFAULT_REDIS_URL;
const PYTHON = process.env.ALPHA_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
const CHILD_TIMEOUT_MS = 180_000;
const TRANSCRIPT = process.env.X402_FRAMEWORK_TRANSCRIPT?.trim() || join(tmpdir(), 'agentfi-alpha-framework-transcript.txt');
const WORK = join(tmpdir(), `agentfi-alpha-framework-${process.pid}`);

const lines = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flush(code) {
  try {
    writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`);
  } catch {
    /* transcript is best effort */
  }
  process.exitCode = code;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm', ...opts });
}

async function main() {
  say('AgentFi alpha: agent framework x real local backend - mode: LOCAL FORK (scripted model; no LLM, no key, nothing sent to a public network)\n');
  for (const problem of destructiveProblems({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, allowRemote: process.env.X402_DEMO_ALLOW_REMOTE === '1' })) {
    say(`  FAIL  ${problem}`);
    return 2;
  }
  // Same prerequisite checks as the demo (Node, deps, anvil, Postgres, Redis, ports, RPC).
  const prereq = run('node', [join(ROOT, 'scripts', 'alpha', 'demo.mjs'), '--check'], { stdio: 'inherit', env: process.env });
  if (prereq.status !== 0) return 2;
  const py = run(PYTHON, ['-c', 'import sys, agents, mcp; from importlib.metadata import version as v; print("python", sys.version.split()[0], "· openai-agents", v("openai-agents"), "· mcp", v("mcp"), "· openai", v("openai"))'], { timeout: CHILD_TIMEOUT_MS });
  if (py.status !== 0) {
    say(`  FAIL  "${PYTHON}" cannot import the OpenAI Agents SDK (${(py.stderr || py.error?.message || '').trim().split('\n').pop()})`);
    say('        -> python3 -m venv .venv && .venv/bin/pip install -r examples/openai-agents/requirements.txt, then ALPHA_PYTHON=.venv/bin/python (Windows: py -m venv .venv, .venv/Scripts/pip, ALPHA_PYTHON=.venv/Scripts/python.exe)');
    return 2;
  }
  const mcpServerVersion = JSON.parse(readFileSync(join(ROOT, 'packages', 'mcp-server', 'package.json'), 'utf8')).version;
  say(`  ok    ${py.stdout.trim()} · AgentFi MCP server (packages/mcp-server from this checkout) ${mcpServerVersion} · node ${process.versions.node} · ${process.platform}`);
  if (checkOnly) return 0;
  if (!(await confirmWipe({ databaseUrl: DATABASE_URL, redisUrl: REDIS_URL, assumeYes }))) return 4;

  say('\nBuilding (idempotent): Prisma client, MCP server...');
  for (const [cmd, args] of [
    ['npx', ['prisma', 'generate', '--schema=packages/backend/src/db/schema.prisma']],
    ['npm', ['run', 'build', '-w', 'packages/mcp-server']],
  ]) {
    const built = spawnSync(`${cmd} ${args.join(' ')}`, { cwd: ROOT, shell: true, stdio: 'inherit' });
    if (built.status !== 0) {
      say(`${cmd} ${args.join(' ')} failed; nothing was started.`);
      return 3;
    }
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const stopFile = join(WORK, 'stop');
  const serveLog = join(WORK, 'serve.log');
  say(`\nStarting the real local backend (API + worker + seller + Anvil fork); log ${serveLog}`);
  const logFd = openSync(serveLog, 'w');
  const serve = spawn(`npm run demo:x402:serve -- --out-dir "${WORK}" --stop-file "${stopFile}"`, {
    cwd: BACKEND, shell: true, stdio: ['ignore', logFd, logFd], env: process.env, detached: spawnDetached(process.platform),
  });
  closeSync(logFd);
  let serveExited = false;
  const serveDone = new Promise((r) => serve.on('exit', () => { serveExited = true; r(); }));
  let stopping;
  const stopServe = () => (stopping ??= stopServeOnce()); // idempotent: finally and a signal may both ask
  const stopServeOnce = async () => {
    // Graceful first: the stop file lets serve close the API, worker, seller and Anvil itself.
    try {
      writeFileSync(stopFile, 'stop');
    } catch {
      /* the work dir may be gone */
    }
    await Promise.race([serveDone, sleep(30_000)]);
    if (serveExited && process.platform === 'win32') return;
    if (!Number.isInteger(serve.pid)) return; // spawn failed: nothing to terminate
    // Timeout, error or leftovers: terminate the whole process tree, and wait for it.
    for (const step of terminationPlan(process.platform, serve.pid).steps) {
      if (step.kind === 'command') {
        spawnSync(step.command, step.args, { stdio: 'ignore', timeout: 30_000 });
      } else {
        try {
          process.kill(step.target, step.signal);
        } catch {
          return; // the group is gone
        }
        await sleep(step.waitMs);
        try {
          process.kill(step.target, 0);
        } catch {
          return; // gone after the signal
        }
      }
    }
  };
  // Ctrl+C / SIGTERM on the driver: on POSIX serve runs in its own process group and would survive us otherwise.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      say(`\n${signal} received: stopping the backend...`);
      stopServe().finally(() => {
        flush(130);
        process.exit(130);
      });
    });
  }

  try {
    const agentEnvPath = join(WORK, 'agent.env');
    const deadline = Date.now() + 240_000;
    while (!existsSync(agentEnvPath)) {
      if (serveExited || Date.now() > deadline) {
        say(`serve did not become ready (${serveExited ? 'exited' : 'timeout'}). Log tail:\n${readFileSync(serveLog, 'utf8').split('\n').slice(-30).join('\n')}`);
        return 1;
      }
      await sleep(500);
    }
    const agentEnv = parseEnvFile(readFileSync(agentEnvPath, 'utf8'));
    const opEnv = parseEnvFile(readFileSync(join(WORK, 'operator.env'), 'utf8'));
    say(readFileSync(serveLog, 'utf8').split('\n').filter((l) => l.startsWith('SERVE READY')).join('\n'));
    const evidence = async () => (await fetch(`${opEnv.CONTROL_URL}/evidence`)).json();
    const ops = (job) => {
      if (!/^[A-Za-z0-9_-]+$/.test(job)) throw new Error(`unexpected job id ${job}`);
      const out = spawnSync(`npm run x402:ops -- status --job ${job}`, { cwd: BACKEND, shell: true, encoding: 'utf8', env: { ...process.env, ...opEnv }, timeout: CHILD_TIMEOUT_MS });
      if (out.status !== 0) throw new Error(`x402:ops status failed:\n${out.stdout}\n${out.stderr}`);
      return out.stdout.slice(out.stdout.search(/^\s*(Agent|Job)\b/m) >= 0 ? out.stdout.search(/^\s*(Agent|Job)\b/m) : 0).trim();
    };
    const framework = (scenario) => {
      const resultFile = join(WORK, `result-${scenario}.json`);
      const args = [join(ROOT, 'examples', 'openai-agents', 'agent.py'), '--mode', 'stub', '--backend', 'env-file', '--env-file', agentEnvPath, '--scenario', scenario, '--result-file', resultFile];
      const out = spawnSync(PYTHON, args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: CHILD_TIMEOUT_MS });
      say(indent(`$ python examples/openai-agents/agent.py --mode stub --backend env-file --env-file <agent.env> --scenario ${scenario}`));
      say(indent(out.stdout.trim()));
      if (out.status !== 0) throw new Error(`framework run (${scenario}) exited ${out.status ?? out.signal ?? out.error?.message}:\n${out.stderr}`);
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
      say(indent('full tool results (JSON):'));
      for (const item of parsed.trace) if ('result' in item) say(indent(JSON.stringify(item.result, null, 2), 6));
      return parsed;
    };
    const failures = [];

    // 1. ALLOWED
    say('\n## 1. Allowed purchase through the framework');
    const before1 = await evidence();
    say(`  agent wallet ${before1.agentWallet}: ${(Number(before1.agentUsdc) / 1e6).toFixed(2)} USDC before; seller ${before1.seller}: ${(Number(before1.sellerUsdc) / 1e6).toFixed(2)} USDC`);
    const result1 = framework('allowed');
    let after1;
    for (const end = Date.now() + 120_000; ; await sleep(500)) {
      after1 = await evidence();
      if (after1.ledger.some((r) => r.chainVerifiedAt) || Date.now() > end) break;
    }
    const status1 = ops(agentEnv.AGENTFI_JOB_ID);
    say('  x402:ops status after the allowed purchase:');
    say(indent(status1, 4));
    say(`  Anvil Transfer logs (agent -> seller): ${JSON.stringify(after1.transfers)}`);
    say(`  seller request counters: ${JSON.stringify(after1.sellerCounts)}`);
    const allowed = checkAllowed({ result: result1, before: before1, after: after1, statusText: status1, jobId: agentEnv.AGENTFI_JOB_ID });
    say(`  paymentId ${allowed.paymentId} -> tx ${allowed.txHash}`);
    failures.push(...renderChecks(allowed.checks, say));

    // 2. BLOCKED
    say('\n## 2. Blocked purchases through the framework (over the job budget, over the per-payment policy cap)');
    const result2 = framework('blocked');
    const after2 = await evidence();
    const status2 = `${ops(agentEnv.AGENTFI_JOB_ID)}\n${ops(agentEnv.AGENTFI_SMALL_JOB_ID)}`;
    say('  x402:ops status after the blocked purchases (budget job, then the 0.20 job):');
    say(indent(status2, 4));
    say(`  agent wallet ${(Number(after2.agentUsdc) / 1e6).toFixed(2)} USDC after (before this run: ${(Number(after1.agentUsdc) / 1e6).toFixed(2)}); seller counters ${JSON.stringify(after2.sellerCounts)}`);
    const blocked = checkBlocked({ result: result2, before: after1, after: after2, statusText: status2, smallJobId: agentEnv.AGENTFI_SMALL_JOB_ID, jobId: agentEnv.AGENTFI_JOB_ID });
    failures.push(...renderChecks(blocked.checks, say));

    say('\nWhat this run is: a scripted model (no LLM) driving the real OpenAI Agents SDK and the real AgentFi MCP server (stdio) against the real local API + worker, a seller we control with the real @x402/evm exact facilitator, on a LOCAL Anvil fork of Base Sepolia. Not the public testnet, not an independent seller.');
    if (failures.length > 0) {
      say(`\nFAILED: ${failures.length} invariant(s) broken.`);
      return 1;
    }
    say(`\nOK: ${allowed.checks.length + blocked.checks.length} invariants held.`);
    return 0;
  } finally {
    try {
      await stopServe();
    } catch (error) {
      say(`warning: stopping the backend failed (${error instanceof Error ? error.message : String(error)}); check for leftover anvil/node processes`);
    }
  }
}

const indent = (text, n = 4) => text.split('\n').map((l) => `${' '.repeat(n)}${l}`).join('\n');

main()
  .then((code) => flush(code))
  .catch((error) => {
    say(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    flush(1);
  });
