#!/usr/bin/env node
/**
 * Item 7 (2026-10-14) — minimal reproduction, outside vitest, of the native
 * crash behind "the joint DB suite segfaults on Windows" (exit 139 in Git
 * Bash, 0xC0000005 STATUS_ACCESS_VIOLATION in PowerShell).
 *
 * vitest's `threads` pool runs each test file in a worker_thread and tears the
 * thread down afterwards. Prisma's default query engine is a Node-API library
 * (`query_engine-windows.dll.node`) loaded into that thread. On Windows with
 * Node 24 the PROCESS dies, at a random point, after threads that used Prisma
 * end — whether or not the client was `$disconnect()`ed. Child processes (the
 * `forks` pool) never crashed, and neither did threads that never loaded Prisma.
 *
 * Usage (from the repo root; needs a reachable, migrated DATABASE_URL — it
 * only runs `SELECT 1` and `count(*)` on Agent):
 *   DATABASE_URL=postgresql://… node scripts/repro-prisma-worker-thread-crash.mjs [workers=40] [mode=disconnect]
 *
 * Modes (one worker after another, `workers` times):
 *   disconnect            thread: connect, query, $disconnect(), ends by itself
 *   nodisconnect          thread: connect, query, ends by itself (client left open)
 *   terminate             thread: connect, query; the parent worker.terminate()s it
 *   disconnect-terminate  thread: connect, query, $disconnect(); then terminate()d
 *   noprisma-terminate    control — a thread that never loads Prisma, terminate()d
 *   proc-disconnect       control — the `disconnect` body in a child PROCESS
 *
 * Exit code 0 and "all workers completed" = no crash in this run, and every
 * lifecycle ended as its mode expects: a child process with exit code 0 and
 * no signal; a thread that ends by itself with 0; a terminate()d thread with
 * 1 (Node's code for terminate()), before the 15 s timeout. Any other end is
 * marked `!` (a timeout `T!`), counted, and the run exits 1 — a failed child
 * or a hung worker is never reported as a clean control run. A native crash
 * of this process itself shows as 139 / 0xC0000005 (it never gets here).
 * Results on the maintainer's machine: docs/operations/local-validation.md §4.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

async function body(mode, notify) {
  if (mode === 'noprisma-terminate') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    notify('queried');
    setInterval(() => undefined, 1000);
    return;
  }
  const require = createRequire(join(ROOT, 'packages/backend/package.json'));
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$queryRaw`SELECT 1`;
  await prisma.agent.count();
  notify('queried');
  if (mode === 'disconnect' || mode === 'disconnect-terminate') await prisma.$disconnect();
  if (mode === 'disconnect-terminate') {
    notify('disconnected');
    setInterval(() => undefined, 1000); // stay alive until terminated, as a pool worker does
  }
}

if (process.argv[2] === '--child') {
  await body(process.argv[3], () => undefined);
} else if (isMainThread) {
  const count = Number(process.argv[2] ?? 40);
  const mode = process.argv[3] ?? 'disconnect';
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (a reachable, migrated AgentFi database).');
    process.exit(2);
  }
  console.log(`node ${process.version} ${process.platform} workers=${count} mode=${mode}`);
  // terminate() ends a worker with exit code 1: the expected end in these modes.
  const expectedThreadExit = mode === 'terminate' || mode.endsWith('-terminate') ? 1 : 0;
  let failed = 0;
  for (let i = 0; i < count; i++) {
    await new Promise((resolve, reject) => {
      if (mode.startsWith('proc-')) {
        const child = fork(SELF, ['--child', mode.slice('proc-'.length)], { stdio: 'inherit' });
        child.on('exit', (code, signal) => {
          const clean = code === 0 && signal === null;
          if (!clean) failed++;
          process.stdout.write(`${i}:${code ?? signal}${clean ? '' : '!'} `);
          resolve();
        });
        child.on('error', reject);
        return;
      }
      const worker = new Worker(SELF, { workerData: { mode } });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void worker.terminate();
      }, 15_000);
      worker.on('message', async (msg) => {
        if (msg === 'queried' && (mode === 'terminate' || mode === 'noprisma-terminate')) await worker.terminate();
        if (msg === 'disconnected' && mode === 'disconnect-terminate') await worker.terminate();
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        clearTimeout(timer);
        const clean = !timedOut && code === expectedThreadExit;
        if (!clean) failed++;
        process.stdout.write(`${i}:${code}${timedOut ? 'T' : ''}${clean ? '' : '!'} `);
        resolve();
      });
    });
  }
  if (failed > 0) {
    console.error(`\n${failed} of ${count} lifecycles did not end cleanly (marked "!") — not a clean run`);
    process.exit(1);
  }
  console.log('\nall workers completed');
} else {
  await body(workerData.mode, (msg) => parentPort.postMessage(msg));
}
