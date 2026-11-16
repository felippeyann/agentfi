#!/usr/bin/env node
/**
 * `npm run alpha:demo` — checks the prerequisites of the LOCAL FORK demo with clear messages, then runs it.
 *
 *   npm run alpha:demo              # check, then run the demo (about 2.5 minutes)
 *   npm run alpha:demo -- --check   # only check
 *
 * It adds no behaviour of its own: the demo is `npm run demo:x402:fork` (packages/backend/src/__tests__/e2e/
 * x402-spend.demo.ts). It needs NO credentials, funds or accounts. Mode: LOCAL FORK (a local Anvil that forks
 * Base Sepolia read-only; nothing is sent to the public testnet).
 *
 * Environment (all optional; same names the demo reads):
 *   X402_DEMO_DATABASE_URL  default postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402  (RESET by the demo)
 *   X402_DEMO_REDIS_URL     default redis://localhost:6379/14                                      (FLUSHED by the demo)
 *   E2E_ANVIL_FORK_URL      default https://sepolia.base.org (read-only RPC of Base Sepolia, chain 84532)
 *   X402_DEMO_ANVIL_PORT    default 8547      X402_DEMO_BACKEND_PORT  default 3157
 *   X402_DEMO_TRANSCRIPT    default <tmp>/agentfi-alpha-demo-transcript.txt
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'packages', 'backend');
const checkOnly = process.argv.includes('--check');

const DATABASE_URL = process.env.X402_DEMO_DATABASE_URL?.trim() || 'postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402';
const REDIS_URL = process.env.X402_DEMO_REDIS_URL?.trim() || 'redis://localhost:6379/14';
const FORK_URL = process.env.E2E_ANVIL_FORK_URL?.trim() || 'https://sepolia.base.org';
const ANVIL_PORT = Number(process.env.X402_DEMO_ANVIL_PORT || 8547);
const BACKEND_PORT = Number(process.env.X402_DEMO_BACKEND_PORT || 3157);
const TRANSCRIPT = process.env.X402_DEMO_TRANSCRIPT?.trim() || join(tmpdir(), 'agentfi-alpha-demo-transcript.txt');

const failures = [];
const ok = (what) => console.log(`  ok    ${what}`);
const fail = (what, fix) => {
  failures.push(what);
  console.log(`  FAIL  ${what}\n        -> ${fix}`);
};

function reachable(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function portFree(port) {
  // A listener bound to 0.0.0.0 can still let a second bind on 127.0.0.1 succeed on Windows: also try to connect.
  if (await reachable("127.0.0.1", port, 500)) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function hostPort(url, fallbackPort) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || fallbackPort), name: u.pathname.replace(/^\//, '') };
}

console.log('AgentFi alpha demo - mode: LOCAL FORK (no credentials, funds or accounts; nothing is sent to a public network)\n');
console.log('Checking prerequisites:');

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.versions.node} (package.json engines: >=20; CI runs 22)`);
else fail(`Node ${process.versions.node} is too old`, 'install Node 22 (https://nodejs.org) and run `npm ci` again');

// Dependencies installed + Prisma client generated
if (existsSync(join(ROOT, 'node_modules', 'tsx')) && existsSync(join(ROOT, 'node_modules', '@prisma', 'client'))) ok('npm dependencies installed');
else fail('npm dependencies are not installed', 'run `npm ci` in the repository root');

// Anvil
const anvilCandidates = ['anvil', join(homedir(), '.foundry', 'bin', 'anvil'), join(homedir(), '.foundry', 'bin', 'anvil.exe')];
let anvilVersion = null;
for (const candidate of anvilCandidates) {
  const run = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  if (run.status === 0) {
    anvilVersion = `${run.stdout.split('\n')[0]} (${candidate === 'anvil' ? 'on PATH' : candidate})`;
    break;
  }
}
if (anvilVersion) ok(anvilVersion);
else fail('Foundry `anvil` not found (not on PATH, not in ~/.foundry/bin)', 'install Foundry: https://book.getfoundry.sh/getting-started/installation (`foundryup`); the demo was verified with anvil 1.7.1');

// Postgres + Redis (reachability only: the demo creates/migrates/resets its own database)
try {
  const pg = hostPort(DATABASE_URL, 5432);
  if (!pg.name) throw new Error('no database name');
  if (pg.name === 'agentfi') fail('X402_DEMO_DATABASE_URL points at the dev database "agentfi", which the demo refuses to reset', 'use a dedicated database name, e.g. agentfi_e2e_x402 (the default)');
  else if (await reachable(pg.host, pg.port)) ok(`Postgres reachable at ${pg.host}:${pg.port} (database "${pg.name}" will be RESET by the demo)`);
  else fail(`Postgres not reachable at ${pg.host}:${pg.port}`, 'start one: `docker compose -f docker-compose.dev.yml up -d postgres redis` (user/password agentfi/agentfi), or set X402_DEMO_DATABASE_URL');
} catch (error) {
  fail(`X402_DEMO_DATABASE_URL is not a valid postgres URL (${error.message})`, 'e.g. postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402');
}
try {
  const redis = hostPort(REDIS_URL, 6379);
  if (!redis.name || redis.name === '0') fail('X402_DEMO_REDIS_URL uses Redis DB 0, which the demo refuses to flush', 'use another logical DB, e.g. redis://localhost:6379/14 (the default)');
  else if (await reachable(redis.host, redis.port)) ok(`Redis reachable at ${redis.host}:${redis.port} (logical DB ${redis.name} will be FLUSHED by the demo)`);
  else fail(`Redis not reachable at ${redis.host}:${redis.port}`, 'start one: `docker compose -f docker-compose.dev.yml up -d postgres redis`, or set X402_DEMO_REDIS_URL');
} catch (error) {
  fail(`X402_DEMO_REDIS_URL is not a valid redis URL (${error.message})`, 'e.g. redis://localhost:6379/14');
}

// Ports
for (const [port, what, variable] of [
  [ANVIL_PORT, 'Anvil', 'X402_DEMO_ANVIL_PORT'],
  [BACKEND_PORT, 'backend API', 'X402_DEMO_BACKEND_PORT'],
]) {
  if (await portFree(port)) ok(`port ${port} free (${what})`);
  else fail(`port ${port} is in use (${what})`, `stop what listens there or set ${variable}`);
}

// Read-only RPC to fork
try {
  const response = await fetch(FORK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (body.result === '0x14a34') ok(`${new URL(FORK_URL).host} answers chain 84532 (Base Sepolia); read-only, nothing is sent to it`);
  else fail(`${FORK_URL} answers chain ${body.result ?? JSON.stringify(body)}, not Base Sepolia (0x14a34)`, 'set E2E_ANVIL_FORK_URL to a Base Sepolia RPC');
} catch (error) {
  fail(`cannot reach ${FORK_URL} (${error.message})`, 'the demo forks Base Sepolia and needs outbound HTTPS to a public read-only RPC; set E2E_ANVIL_FORK_URL to another Base Sepolia RPC if this one is blocked');
}


// (No process.exit() right after the fetch above: on Windows with Node 24 it can trip a libuv assertion.)
if (failures.length > 0) {
  console.log(`\n${failures.length} prerequisite(s) missing. Nothing was started.`);
  process.exitCode = 2;
} else {
  console.log('\nAll prerequisites met.');
  if (!checkOnly) await run();
}

async function run() {
  // Make the Prisma client explicit and idempotent (a fresh clone has none until generated).
  console.log('\nGenerating the Prisma client (idempotent)...');
  const generate = spawnSync('npx prisma generate --schema=packages/backend/src/db/schema.prisma', { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (generate.status !== 0) {
    console.log('prisma generate failed (see above); nothing was started.');
    process.exitCode = 3;
    return;
  }
  console.log(`\nRunning the demo (about 2.5 minutes). Transcript: ${TRANSCRIPT}\n`);
  await new Promise((resolve) => {
    const child = spawn('npm run demo:x402:fork', {
      cwd: BACKEND,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, X402_DEMO_TRANSCRIPT: TRANSCRIPT },
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
