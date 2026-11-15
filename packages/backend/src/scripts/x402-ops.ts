/**
 * x402 spend operations for the operator (first x402 delivery, 2026-11-15).
 *
 *   npm run x402:ops -- status    [--agent <id>] [--job <id>] [--json]
 *   npm run x402:ops -- reconcile [--agent <id>] [--job <id>] [--apply]
 *                                 [--head finalized|safe | --confirmations N [--local-chain]]
 *                                 [--expiry-margin-seconds S] [--stale-minutes M] [--rpc <url>] [--json]
 *
 * `status` is read-only: authorized limits, committed / proven / reported /
 * open spend per job, delivery evidence, block reasons and the action each
 * open row needs.
 *
 * `reconcile` reads the USDC contract (EIP-3009 `authorizationState`,
 * `AuthorizationUsed` / `AuthorizationCanceled`, the tx's `Transfer`) and is a
 * DRY-RUN unless `--apply`. It never signs, sends or retries a payment and
 * only writes transitions proven by the chain (see
 * `services/payments/resource-payment-reconciliation.ts`). Evidence comes
 * from ONE RPC per chain — `--rpc`, else the chain's primary RPC
 * (`RPC_URL_<chainId>` when set) — never the provider fallback.
 * Verdicts are judged at the `finalized` block by default (`--head safe`, or
 * `--confirmations N` for `latest − N`); `--confirmations 0` is refused unless
 * `--local-chain` says the RPC is a local chain or fork. `expired` also needs
 * that head to be `--expiry-margin-seconds` (default 60) past validBefore.
 *
 * Runs with the backend's own env (DATABASE_URL, RPC_URL_<chainId>).
 */
import type { PrismaClient } from '@prisma/client';
import {
  type HeadSelector,
  chainIdOfNetwork,
  readerForRpcUrl,
  reconcilableWhere,
  reconcileResourcePayments,
  type ChainEvidenceReader,
  type ReconcileResult,
} from '../services/payments/resource-payment-reconciliation.js';
import { buildSpendReport, renderSpendReport } from '../services/payments/resource-payment-report.js';

export interface OpsArgs {
  command: 'status' | 'reconcile';
  agentId?: string;
  jobId?: string;
  apply: boolean;
  json: boolean;
  head: HeadSelector;
  expiryMarginSeconds?: number;
  staleMinutes?: number;
  rpc?: string;
}

export function parseOpsArgs(argv: string[]): OpsArgs | string {
  const command = argv[0];
  if (command !== 'status' && command !== 'reconcile') return 'usage: x402:ops <status|reconcile> [options]';
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let head: HeadSelector = { tag: 'finalized' };
  const headTag = value('--head');
  const confirmationsRaw = value('--confirmations');
  if (headTag !== undefined && confirmationsRaw !== undefined) return 'use either --head or --confirmations';
  if (headTag !== undefined) {
    if (headTag !== 'finalized' && headTag !== 'safe') return '--head must be finalized or safe';
    head = { tag: headTag };
  }
  if (confirmationsRaw !== undefined) {
    const confirmations = Number(confirmationsRaw);
    if (!Number.isInteger(confirmations) || confirmations < 0) return '--confirmations must be a non-negative integer';
    if (confirmations === 0 && !argv.includes('--local-chain')) {
      return '--confirmations 0 judges at an unsafe head: only with --local-chain (a local chain or fork)';
    }
    head = { confirmations };
  }
  const margin = value('--expiry-margin-seconds');
  if (margin !== undefined && !(Number.isInteger(Number(margin)) && Number(margin) >= 0)) {
    return '--expiry-margin-seconds must be a non-negative integer';
  }
  const stale = value('--stale-minutes');
  if (stale !== undefined && !(Number(stale) > 0)) return '--stale-minutes must be positive';
  const args: OpsArgs = {
    command,
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    head,
  };
  if (margin !== undefined) args.expiryMarginSeconds = Number(margin);
  const agentId = value('--agent');
  const jobId = value('--job');
  const rpc = value('--rpc');
  if (agentId) args.agentId = agentId;
  if (jobId) args.jobId = jobId;
  if (rpc) args.rpc = rpc;
  if (stale !== undefined) args.staleMinutes = Number(stale);
  if (args.apply && command !== 'reconcile') return '--apply only applies to reconcile';
  return args;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

export function renderReconcile(results: ReconcileResult[], apply: boolean): string {
  if (results.length === 0) return 'Nothing to reconcile.';
  const lines = [apply ? 'Reconciliation (APPLIED):' : 'Reconciliation (dry-run — pass --apply to write):'];
  for (const { row, verdict, applied, raced } of results) {
    const mark = applied ? 'WRITTEN' : raced ? 'RACED (row changed; nothing written)' : verdict.kind === 'confirmed' || verdict.kind === 'expired' || verdict.kind === 'release-unsigned' ? 'would write' : 'no change';
    lines.push(`  - job ${row.jobId} payment ${row.paymentId} [${row.status}] → ${verdict.kind} (${mark})`);
    lines.push(`      ${verdict.note}`);
  }
  return lines.join('\n');
}

export interface OpsDeps {
  db: Pick<PrismaClient, 'resourcePayment' | 'agent' | 'job' | 'dailyVolume'>;
  /** RPC URL for a chain (defaults to the backend's primary RPC). */
  rpcFor: (chainId: number) => string;
  print: (line: string) => void;
  readerFor?: (rpcUrl: string, head: HeadSelector) => ChainEvidenceReader;
}

export async function runOps(args: OpsArgs, deps: OpsDeps): Promise<number> {
  const staleAfterMs = args.staleMinutes !== undefined ? args.staleMinutes * 60_000 : undefined;
  if (args.command === 'status') {
    const report = await buildSpendReport(deps.db, {
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    });
    deps.print(args.json ? JSON.stringify(report, null, 2) : renderSpendReport(report));
    return 0;
  }

  const networks = await deps.db.resourcePayment.findMany({
    where: {
      ...reconcilableWhere(),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.jobId ? { jobId: args.jobId } : {}),
    },
    select: { network: true },
    distinct: ['network'],
  });
  const readers = new Map<number, ChainEvidenceReader>();
  const makeReader = deps.readerFor ?? readerForRpcUrl;
  for (const { network } of networks) {
    const chainId = chainIdOfNetwork(network);
    if (chainId === null || readers.has(chainId)) continue;
    const url = args.rpc ?? deps.rpcFor(chainId);
    const at = 'tag' in args.head ? `the ${args.head.tag} block` : `latest − ${args.head.confirmations} blocks`;
    if (!args.json) deps.print(`Chain ${chainId}: evidence from ${hostOf(url)} at ${at}`);
    readers.set(chainId, makeReader(url, args.head));
  }
  const results = await reconcileResourcePayments(deps.db, {
    readers,
    apply: args.apply,
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
    ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    ...(args.expiryMarginSeconds !== undefined ? { expiryMarginSeconds: args.expiryMarginSeconds } : {}),
  });
  deps.print(
    args.json
      ? JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      : renderReconcile(results, args.apply),
  );
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseOpsArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(parsed);
    process.exit(2);
  }
  await import('../config/env.js');
  const [{ db }, chains] = await Promise.all([import('../db/client.js'), import('../config/chains.js')]);
  try {
    const code = await runOps(parsed, {
      db,
      rpcFor: (chainId) => chains.getPrimaryRpcUrl(chainId),
      print: (line) => console.log(line),
    });
    await db.$disconnect();
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await db.$disconnect();
    process.exit(1);
  }
}

const invokedDirectly = /x402-ops\.ts$/.test((process.argv[1] ?? '').replace(/\\/g, '/'));
if (invokedDirectly && !process.env['VITEST']) {
  void main();
}
