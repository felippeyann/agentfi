/**
 * A1 row 9: child-process launchers for the two real processes of the concurrency test.
 *
 *  - W: `a1c-settlement-worker.entry.ts` (the real settlement worker);
 *  - S: `src/scripts/evaluator-recovery.ts` itself (`npm run evaluator:recover` = `tsx <that file>`),
 *    its `main()` unchanged, stdin a pipe the test types the confirmation phrase into.
 *
 * Both run `node --import tsx --import a1c-child-preload.ts <entry>` from packages/backend with an
 * env built from scratch (no VITEST*, no inherited RPC / provider keys), like the fork harness's
 * `backendEnv`. Output lines are captured (and written to a log file) so the test can wait for a
 * line — the CLI's prompt is a barrier the test controls.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Timeline } from './rpc-barrier-proxy.js';

const BACKEND_DIR = process.cwd();
const PRELOAD = pathToFileURL(join(BACKEND_DIR, 'src', '__tests__', 'helpers', 'a1c-child-preload.ts')).href;

/** Env keys never inherited by a child (test runner, provider keys, stray RPC overrides). */
const DROP = [/^VITEST/, /^RPC_URL_/, /^INFURA_API_KEY$/, /^NODE_OPTIONS$/, /^ESCROW_/, /^AGENT_JOB_ESCROW_ADDRESS_/, /^REPUTATION_/, /^IDENTITY_REGISTRY_/, /^EVALUATOR_/, /^TEST$/, /^NODE_ENV$/, /^PORT$/];

export function childEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.some((re) => re.test(k))) env[k] = v;
  return { ...env, ...vars };
}

export interface Child {
  readonly name: string;
  readonly proc: ChildProcess;
  readonly lines: string[];
  readonly logFile: string;
  /** Resolves with the first output line (from index `from`) matching `re`; rejects on exit or timeout. */
  waitForLine(re: RegExp, timeoutMs: number, from?: number): Promise<{ line: string; index: number }>;
  /** Resolves with the exit code. */
  readonly exited: Promise<number | null>;
  exitCode(): number | null | undefined;
  write(text: string): void;
  output(): string;
  stop(): Promise<void>;
}

export function startChild(opts: { name: string; entry: string; args?: string[]; env: NodeJS.ProcessEnv; timeline?: Timeline }): Child {
  const logDir = join(tmpdir(), 'agentfi-a1c-row9');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${opts.name}-${Date.now()}.log`);
  const log: WriteStream = createWriteStream(logFile);
  log.write(`# ${process.execPath} cwd=${BACKEND_DIR} env keys: ${Object.keys(opts.env).sort().join(',')}\n`);
  const proc = spawn(process.execPath, ['--import', 'tsx', '--import', PRELOAD, opts.entry, ...(opts.args ?? [])], {
    cwd: BACKEND_DIR,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let code: number | null | undefined;
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (c) => {
      code = c;
      opts.timeline?.push(opts.name, 'exit', { code: c });
      for (const w of waiters) w();
      resolve(c);
    });
  });
  const feed = (stream: NodeJS.ReadableStream | null, tag: string) => {
    let buf = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      log.write(chunk);
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      // A prompt without a trailing newline ("> ") is flushed as its own line too.
      if (buf === '> ') {
        parts.push(buf);
        buf = '';
      }
      for (const p of parts) {
        lines.push(p);
        if (tag === 'out' && opts.timeline && /^(A1C-|Type exactly|Incident|REFUSED|ERROR|  nonce \d+:|Plan:)/.test(p)) {
          opts.timeline.push(opts.name, 'line', { line: p });
        }
      }
      if (parts.length > 0) for (const w of waiters) w();
    });
  };
  feed(proc.stdout, 'out');
  feed(proc.stderr, 'err');

  const waitForLine = (re: RegExp, timeoutMs: number, from = 0) =>
    new Promise<{ line: string; index: number }>((resolve, reject) => {
      const check = () => {
        for (let i = from; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            cleanup();
            resolve({ line: lines[i]!, index: i });
            return true;
          }
        }
        if (code !== undefined) {
          cleanup();
          reject(new Error(`${opts.name} exited (${code}) before a line matched ${re}:\n${lines.slice(-60).join('\n')}`));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${opts.name}: no line matched ${re} within ${timeoutMs} ms:\n${lines.slice(-60).join('\n')}`));
      }, timeoutMs);
      const waiter = () => void check();
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };
      if (!check()) waiters.add(waiter);
    });

  return {
    name: opts.name,
    proc,
    lines,
    logFile,
    waitForLine,
    exited,
    exitCode: () => code,
    write: (text) => {
      proc.stdin?.write(text);
    },
    output: () => lines.join('\n'),
    async stop() {
      if (code === undefined) {
        proc.stdin?.end();
        const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
        if (!done) {
          proc.kill();
          await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
        }
      }
      log.end();
    },
  };
}
