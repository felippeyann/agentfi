/**
 * x402 spend operations for the operator (first x402 delivery, 2026-11-15).
 *
 *   npm run x402:ops -- status    [--agent <id>] [--job <id>] [--json]
 *   npm run x402:ops -- reconcile [--agent <id>] [--job <id>] [--apply]
 *                                 [--head finalized|safe | --confirmations N [--local-chain]]
 *                                 [--expiry-margin-seconds S] [--stale-minutes M] [--rpc <url>] [--json]
 *   npm run x402:ops -- auto      [--agent <id>] [--job <id>] [--head … | --confirmations N [--local-chain]] [--expiry-margin-seconds S]
 *                                 [--stale-minutes M] [--rpc <url>] [--json]
 *   npm run x402:ops -- resolve   --job <id> --payment <paymentId> --as expired|settled [--tx <hash>]
 *                                 --operator <name> --note "<evidence / why>" [--apply]
 *
 * `auto` runs ONE cycle of the automatic reconciliation the worker runs on
 * every payment-recovery tick (backoff, escalation, leases — see
 * `services/payments/resource-payment-auto-reconcile.ts`); defaults from the
 * X402_RECONCILE_* env, overridden by the flags. `reconcile --apply` re-arms
 * the automation (clears backoff / escalation) for the rows it judged.
 *
 * `resolve` is the operator's exit for rows reconciliation leaves `manual`
 * (Permit2, rows written before migration 0027, a chain that cannot be read):
 * an attestation recorded on the row with who and why, never chain proof
 * (`chainVerifiedAt` stays null). Only unknown / pending / refused rows.
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
 * An `expired` transition (a release with no transfer to point at) is only
 * written with `--second-rpc <url>` (an independent node that must agree on
 * the block hash and the state) or an explicit `--accept-single-source-expiry`
 * (the operator takes that risk); otherwise it is shown, not written.
 *
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
  resolveManually,
  DEFAULT_EXPIRY_MARGIN_SECONDS,
  DEFAULT_STALE_AFTER_MS,
  type ChainEvidenceReader,
  type ReconcileResult,
} from '../services/payments/resource-payment-reconciliation.js';
import { buildSpendReport, renderSpendReport } from '../services/payments/resource-payment-report.js';
import {
  autoReconcileConfigFromEnv,
  confirmWithSecondSource,
  DEFAULT_AUTO_RECONCILE_CONFIG,
  rearmAutoReconcile,
  runAutoReconcileCycle,
  type AutoReconcileOutcome,
} from '../services/payments/resource-payment-auto-reconcile.js';

export interface OpsArgs {
  command: 'status' | 'reconcile' | 'resolve' | 'auto';
  /** True when --head / --confirmations was given (otherwise `auto` keeps the env's head). */
  headGiven?: boolean;
  paymentId?: string;
  resolveAs?: 'expired' | 'settled';
  tx?: string;
  operator?: string;
  note?: string;
  agentId?: string;
  jobId?: string;
  apply: boolean;
  json: boolean;
  head: HeadSelector;
  expiryMarginSeconds?: number;
  staleMinutes?: number;
  rpc?: string;
  secondRpc?: string;
  acceptSingleSourceExpiry?: boolean;
}

export function parseOpsArgs(argv: string[]): OpsArgs | string {
  const command = argv[0];
  if (command !== 'status' && command !== 'reconcile' && command !== 'resolve' && command !== 'auto') {
    return 'usage: x402:ops <status|reconcile|auto|resolve> [options]';
  }
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
  if (headTag !== undefined || confirmationsRaw !== undefined) args.headGiven = true;
  const agentId = value('--agent');
  const jobId = value('--job');
  const rpc = value('--rpc');
  const secondRpc = value('--second-rpc');
  if (secondRpc) args.secondRpc = secondRpc;
  if (argv.includes('--accept-single-source-expiry')) args.acceptSingleSourceExpiry = true;
  if (agentId) args.agentId = agentId;
  if (jobId) args.jobId = jobId;
  if (rpc) args.rpc = rpc;
  if (stale !== undefined) args.staleMinutes = Number(stale);
  if (args.apply && (command === 'status' || command === 'auto')) return `--apply does not apply to ${command}`;
  if (command === 'resolve') {
    const as = value('--as');
    if (as !== 'expired' && as !== 'settled') return 'resolve needs --as expired|settled';
    const paymentId = value('--payment');
    if (!jobId || !paymentId) return 'resolve needs --job and --payment';
    args.paymentId = paymentId;
    args.resolveAs = as;
    const tx = value('--tx');
    if (tx) args.tx = tx;
    args.operator = value('--operator') ?? '';
    args.note = value('--note') ?? '';
  }
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
  db: Pick<PrismaClient, 'resourcePayment' | 'agent' | 'job' | 'dailyVolume' | 'resourcePaymentReconcileState'>;
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

  if (args.command === 'auto') {
    const { config, problems } = autoReconcileConfigFromEnv();
    for (const p of problems) deps.print(`WARN: ${p}`);
    if (args.headGiven) config.head = args.head;
    if (args.expiryMarginSeconds !== undefined) config.expiryMarginSeconds = args.expiryMarginSeconds;
    if (staleAfterMs !== undefined) config.staleAfterMs = staleAfterMs;
    const makeReader = deps.readerFor ?? readerForRpcUrl;
    const outcomes = await runAutoReconcileCycle({
      db: deps.db,
      rpcFor: (chainId) => args.rpc ?? deps.rpcFor(chainId),
      config,
      readerFor: (chainId) => makeReader(args.rpc ?? deps.rpcFor(chainId), config.head),
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
    });
    deps.print(args.json ? JSON.stringify(outcomes, null, 2) : renderAuto(outcomes));
    return 0;
  }

  if (args.command === 'resolve') {
    const result = await resolveManually(deps.db, {
      jobId: args.jobId!,
      paymentId: args.paymentId!,
      outcome: args.resolveAs!,
      ...(args.tx ? { txHash: args.tx } : {}),
      operator: args.operator ?? '',
      note: args.note ?? '',
      apply: args.apply,
    });
    deps.print(args.apply ? result.message : `${result.message} (dry-run — pass --apply to write)`);
    return result.ok ? 0 : 1;
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
  const secondReaders = new Map<number, ChainEvidenceReader>();
  if (args.secondRpc) for (const chainId of readers.keys()) secondReaders.set(chainId, makeReader(args.secondRpc, args.head));
  const results = await reconcileResourcePayments(deps.db, {
    readers,
    apply: args.apply,
    ...(args.acceptSingleSourceExpiry
      ? {}
      : {
          confirmExpiry: async (row, verdict) => {
            const chainId = chainIdOfNetwork(row.network);
            const primary = chainId !== null ? readers.get(chainId) : undefined;
            if (!primary) return { ok: false, transient: true, note: 'no primary reader' };
            return confirmWithSecondSource(row, verdict, primary, chainId !== null ? secondReaders.get(chainId) : undefined, {
              ...DEFAULT_AUTO_RECONCILE_CONFIG,
              singleSourceExpiry: false,
            });
          },
        }),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
    ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    ...(args.expiryMarginSeconds !== undefined ? { expiryMarginSeconds: args.expiryMarginSeconds } : {}),
  });
  if (args.apply) {
    // The operator looked at these rows: automation starts over for them (clears backoff / escalation).
    await rearmAutoReconcile(deps.db, results.map((r) => r.row.id));
  }
  deps.print(
    args.json
      ? JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      : renderReconcile(results, args.apply),
  );
  return 0;
}

export function renderAuto(outcomes: AutoReconcileOutcome[]): string {
  if (outcomes.length === 0) return 'Automatic reconciliation: nothing due.';
  const lines = ['Automatic reconciliation (one cycle):'];
  for (const o of outcomes) {
    const what = o.applied ? 'WRITTEN' : o.raced ? 'RACED (nothing written)' : o.escalated ? 'ESCALATED to the operator' : 'no change';
    const next = o.nextAttemptAt && !o.applied && !o.escalated ? `; next look ${o.nextAttemptAt.toISOString()}` : '';
    lines.push(`  - job ${o.jobId} payment ${o.paymentId} [${o.statusBefore}] → ${o.verdict}${o.transient ? ' (transient)' : ''} (${what}${next})`);
    lines.push(`      ${o.note}`);
  }
  return lines.join('\n');
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
