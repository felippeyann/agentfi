/**
 * Pure helpers of `npm run alpha:framework` (scripts/alpha/framework.mjs): parsing of the KEY=VALUE files that
 * `alpha:serve` writes, and the invariants checked after an agent framework ran against the real local backend.
 * No I/O here, so every invariant is unit-tested (framework-lib.test.mjs).
 *
 * "Evidence" is the JSON of the serve process's read-only /evidence endpoint (chain balances, USDC Transfer logs,
 * seller request counters, ledger rows). A check is { ok, what }: the driver prints them and exits 1 on any !ok.
 */

export const PAYER_SAFE_TOOLS = ['get_my_agent_profile', 'get_policy', 'get_job', 'pay_for_resource'];
export const PRICE_ALLOWED = 300000n; // 0.30 USDC, /report
export const PRICE_PREMIUM = 600000n; // 0.60 USDC, /report-premium (above the 0.50 per-payment cap)

/** KEY=VALUE lines; blank lines and `#` comments ignored. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`not a KEY=VALUE line: ${line.slice(0, 40)}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const check = (ok, what) => ({ ok: Boolean(ok), what });
const usdc = (units) => `${(Number(units) / 1e6).toFixed(2)} USDC`;

/** The tool calls and results of one framework run, from the example's --result-file JSON. */
export function pairTrace(result) {
  const calls = [];
  let pending = null;
  for (const item of result.trace ?? []) {
    if ('call' in item) {
      pending = { name: item.call, args: safeJson(item.arguments) };
      calls.push(pending);
    } else if ('result' in item && pending) {
      pending.result = item.result;
      pending = null;
    }
  }
  return calls;
}
function safeJson(text) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return {};
  }
}

/** The allowlist must be exactly the payer-safe four, and the model may call nothing else. */
export function checkAllowlist(result, calls) {
  const exposed = [...(result.exposedTools ?? [])].sort();
  return [
    check(JSON.stringify(exposed) === JSON.stringify([...PAYER_SAFE_TOOLS].sort()), `tools exposed to the framework = payer-safe four exactly: ${exposed.join(', ')}`),
    check(calls.length > 0 && calls.every((c) => PAYER_SAFE_TOOLS.includes(c.name)), `every tool call is inside the allowlist (${calls.map((c) => c.name).join(', ')})`),
  ];
}

/** Rows of the evidence ledger for one paymentId. */
const rowsFor = (evidence, paymentId) => evidence.ledger.filter((r) => r.paymentId === paymentId);
const transfersTo = (evidence, seller) => evidence.transfers.filter((t) => t.to.toLowerCase() === seller.toLowerCase());

/**
 * ALLOWED purchase. `before`/`after` are evidence snapshots around the framework run; `after` must already show the
 * worker's chain proof (`chainVerifiedAt`). `statusText` is the `x402:ops status --job` output taken after.
 */
export function checkAllowed({ result, before, after, statusText, jobId }) {
  const calls = pairTrace(result);
  const checks = checkAllowlist(result, calls);
  const call = calls.find((c) => c.name === 'pay_for_resource');
  const out = call?.result ?? {};
  const paymentId = call?.args?.payment_id;
  checks.push(check(calls.length === 1 && call && call.args.job_id === jobId, 'the framework made exactly one pay_for_resource call, on the budget job'));
  checks.push(check(out.paid !== false && out.replayed !== true && out.payment?.status === 'settled', `tool result: payment.status=${out.payment?.status}, replayed=${out.replayed ?? false} (the seller reported settlement; no "paid": false refusal)`));
  const rows = paymentId ? rowsFor(after, paymentId) : [];
  const row = rows[0];
  checks.push(check(rows.length === 1 && row.status === 'settled' && row.jobId === jobId, 'one ledger row for that paymentId, status settled'));
  checks.push(check(row && row.amount === PRICE_ALLOWED.toString() && row.payTo.toLowerCase() === after.seller.toLowerCase(), `ledger amount ${row ? usdc(row.amount) : '?'} to the seller address`));
  checks.push(check(row && typeof row.authorizationNonce === 'string' && row.authorizationNonce.length > 0, 'an EIP-3009 authorization nonce was recorded (a signature exists)'));
  checks.push(check(row?.chainVerifiedAt, 'the worker proved the payment on-chain on its own (chainVerifiedAt set, no operator command)'));
  const newTransfers = transfersTo(after, after.seller).filter((t) => !transfersTo(before, before.seller).some((b) => b.tx === t.tx));
  const transfer = newTransfers[0];
  checks.push(check(newTransfers.length === 1 && transfer.value === PRICE_ALLOWED.toString() && transfer.from.toLowerCase() === after.agentWallet.toLowerCase(), `exactly one new USDC Transfer on the fork: agent wallet -> seller, ${transfer ? usdc(transfer.value) : '?'}`));
  checks.push(check(row && transfer && row.settlementTxHash?.toLowerCase() === transfer.tx.toLowerCase(), 'the ledger settlementTxHash equals the Transfer log transaction'));
  checks.push(check(BigInt(before.agentUsdc) - BigInt(after.agentUsdc) === PRICE_ALLOWED, `agent wallet ${usdc(before.agentUsdc)} -> ${usdc(after.agentUsdc)} (-0.30)`));
  checks.push(check(BigInt(after.sellerUsdc) - BigInt(before.sellerUsdc) === PRICE_ALLOWED, `seller ${usdc(before.sellerUsdc)} -> ${usdc(after.sellerUsdc)} (+0.30)`));
  checks.push(check((after.sellerCounts.paid['/report'] ?? 0) - (before.sellerCounts.paid['/report'] ?? 0) === 1, 'the seller saw exactly one paid request for /report'));
  const line = paymentId ? statusText.split(/\r?\n/).find((l) => l.includes(paymentId)) : undefined;
  checks.push(check(line && /\bsettled\b/.test(line) && line.includes('money:proven') && line.includes('delivery:delivered'), `x402:ops status line: ${line?.trim() ?? '(missing)'}`));
  const budget = statusText.split(/\r?\n/).find((l) => l.includes(jobId));
  checks.push(check(budget && /budget 5\b/.test(budget) && /committed 0\.3\b/.test(budget) && /remaining 4\.7\b/.test(budget), `x402:ops status budget: ${budget?.trim() ?? '(missing)'}`));
  return { checks, paymentId, txHash: transfer?.tx };
}

/**
 * BLOCKED purchases (over the job's remaining budget, over the per-payment policy cap). `before`/`after` bracket the
 * framework run: nothing may have moved, nothing may have been signed, no paid request may have reached the seller.
 */
export function checkBlocked({ result, before, after, statusText, smallJobId, jobId }) {
  const calls = pairTrace(result);
  const checks = checkAllowlist(result, calls);
  const [overBudget, overPolicy] = calls;
  const b = overBudget?.result ?? {};
  const p = overPolicy?.result ?? {};
  checks.push(check(calls.length === 2 && overBudget.args.job_id === smallJobId && overPolicy.args.job_id === jobId, 'the framework made two pay_for_resource calls: 0.30 on the 0.20 job, 0.60 on the budget job'));
  checks.push(check(b.paid === false && b.httpStatus === 402 && b.code === 'BUDGET_EXCEEDED', `over-budget tool result: paid=${b.paid} HTTP ${b.httpStatus} ${b.code} (price ${b.priceFormatted}, remaining ${b.remainingFormatted})`));
  checks.push(check(p.paid === false && p.httpStatus === 403 && p.code === 'POLICY_VIOLATION', `over-policy tool result: paid=${p.paid} HTTP ${p.httpStatus} ${p.code} (rule ${p.rule})`));
  for (const [name, call] of [['over-budget', overBudget], ['over-policy', overPolicy]]) {
    const rows = call?.args?.payment_id ? rowsFor(after, call.args.payment_id) : [];
    const row = rows[0];
    checks.push(check(rows.length === 1 && row.status === 'failed_before_signing' && row.authorizationNonce === null && !row.settlementTxHash && row.responseStatus === null, `${name}: ledger row ${row?.status}, authorization nonce ${row?.authorizationNonce}, no settlement tx, no paid response`));
  }
  checks.push(check(transfersTo(after, after.seller).length === transfersTo(before, before.seller).length, 'no new USDC Transfer on the fork'));
  checks.push(check(after.agentUsdc === before.agentUsdc && after.sellerUsdc === before.sellerUsdc, `agent wallet unchanged at ${usdc(after.agentUsdc)}; seller unchanged`));
  const paidKeys = new Set([...Object.keys(before.sellerCounts.paid), ...Object.keys(after.sellerCounts.paid)]);
  checks.push(check([...paidKeys].every((k) => (after.sellerCounts.paid[k] ?? 0) === (before.sellerCounts.paid[k] ?? 0)), 'zero paid requests reached the seller during the blocked run'));
  checks.push(check((after.sellerCounts.paid['/report-premium'] ?? 0) === 0, 'the seller never saw a paid request for /report-premium'));
  for (const [name, call] of [['over-budget', overBudget], ['over-policy', overPolicy]]) {
    const id = call?.args?.payment_id;
    const line = id ? statusText.split(/\r?\n/).find((l) => l.includes(id)) : undefined;
    checks.push(check(line && line.includes('failed_before_signing') && line.includes('[not counted]'), `x402:ops status line (${name}): ${line?.trim() ?? '(missing)'}`));
  }
  return { checks, paymentIds: calls.map((c) => c.args?.payment_id) };
}

/** Render checks like the demo: a tick per line; returns the failed ones. */
export function renderChecks(checks, say) {
  const failed = [];
  for (const c of checks) {
    say(`  ${c.ok ? '✓' : '✗ INVARIANT BROKEN:'} ${c.what}`);
    if (!c.ok) failed.push(c);
  }
  return failed;
}

/**
 * How to stop a spawned process TREE (npm -> shell -> node -> backend, worker, Anvil), per platform.
 * win32: `taskkill /T /F` kills the tree. POSIX: the child is spawned detached (its own process group), so a
 * signal to -pid reaches the whole group: SIGTERM first, SIGKILL after `graceMs` if it is still alive.
 */
export function terminationPlan(platform, pid, graceMs = 10_000) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  if (platform === 'win32') return { detached: false, steps: [{ kind: 'command', command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }] };
  return { detached: true, steps: [{ kind: 'signal', target: -pid, signal: 'SIGTERM', waitMs: graceMs }, { kind: 'signal', target: -pid, signal: 'SIGKILL', waitMs: 0 }] };
}
