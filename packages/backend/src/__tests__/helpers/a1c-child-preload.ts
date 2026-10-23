/**
 * A1 row 9: loaded with `node --import tsx --import <this file>` BEFORE the real entry of a child
 * process (the settlement worker entry, or `src/scripts/evaluator-recovery.ts` itself). Test-only;
 * changes no backend file. Three things, each declared in the row 9 report:
 *
 *  1. NETWORK GUARD — every `fetch` / `https.request` to a host that is not loopback throws. The
 *     child reaches Anvil (through its JSON-RPC proxy), Postgres and Redis on 127.0.0.1 only.
 *  2. RPC CANDIDATES — `config/chains.ts` lists, after `RPC_URL_<id>`, the Alchemy URL and the
 *     chain's PUBLIC RPC (`https://sepolia.base.org`) as candidates; the A1 per-node reads ask
 *     EVERY candidate (strict rule). Here the built-in candidates of the test chain are removed so
 *     that the only node is `RPC_URL_<id>` (= the proxy in front of Anvil) — what an operator does
 *     by configuration in production ("retire the public RPC", integration note P3-3).
 *  3. TTY (only with `A1C_FAKE_TTY=1`) — the CLI refuses `--execute` unless `process.stdin.isTTY`.
 *     A real pseudo-terminal is not available here (Windows, no node-pty); stdin is a pipe the test
 *     writes the typed phrase into, and `isTTY` is set to true. The CLI's `main()` runs unchanged
 *     (`readline.question` on that pipe). See the report: what is NOT proven is the terminal itself.
 */
import https from 'node:https';
import { PUBLIC_RPC_URLS, RPC_URLS } from '../../config/chains.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(input: unknown): string | null {
  try {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL((input as { url: string }).url);
    return url.hostname;
  } catch {
    return null;
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input);
  if (!host || !LOOPBACK.has(host)) {
    throw new Error(`a1c network guard: refused a request to ${host ?? String(input)} (only loopback is allowed in this test process)`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const refuse = ((..._args: unknown[]) => {
  throw new Error('a1c network guard: https requests are refused in this test process');
}) as unknown as typeof https.request;
https.request = refuse;
https.get = refuse as unknown as typeof https.get;

const chainId = Number(process.env['A1C_CHAIN_ID'] ?? '84532');
delete (RPC_URLS as Record<number, string>)[chainId];
delete (PUBLIC_RPC_URLS as Record<number, string>)[chainId];

if (process.env['A1C_FAKE_TTY'] === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
}
