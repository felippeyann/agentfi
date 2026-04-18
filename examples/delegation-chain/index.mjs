#!/usr/bin/env node
/**
 * AgentFi — Delegation Chain Example
 *
 * Three agents cascading work to each other, end-to-end through the A2A
 * job queue. This is the coordination substrate the "agent economies"
 * section of VISION.md talks about — agents discovering peers, delegating
 * subtasks, composing specialized capabilities into a single final result.
 *
 * Scenario:
 *   - Alice (researcher) needs a 24h market report on BTC
 *   - Alice hires Bob (data specialist) for the top-level task
 *   - Bob realizes he needs sentiment input → hires Charlie (sentiment spec)
 *   - Charlie returns sentiment analysis to Bob
 *   - Bob combines sentiment + his own data, returns final report to Alice
 *
 * Runs against the zero-credential dev stack (no rewards → no chain tx).
 * Add `reward` to any of the createJob() calls to exercise on-chain
 * payment — requires WALLET_PROVIDER=turnkey + ALCHEMY_API_KEY.
 *
 * Usage (defaults match docker-compose.dev.yml):
 *   node examples/delegation-chain/index.mjs
 */

const API_URL = process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ??
  'dev-api-secret-min-32-chars-long-xxxxx';

// ── fetch wrapper ──────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${options.method ?? 'GET'} ${path} → ${res.status}: ` +
        (typeof body === 'string' ? body : JSON.stringify(body)),
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function log(step, msg, detail) {
  console.log(`\x1b[36m[${step}]\x1b[0m`, msg);
  if (detail !== undefined) console.log(detail);
}

// ── primitives ─────────────────────────────────────────────────────────────

async function registerAgent(name) {
  return api('/v1/agents', {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_SECRET },
    body: JSON.stringify({ name, chainIds: [1], tier: 'FREE' }),
  });
}

async function publishManifest(apiKey, manifest) {
  return api('/v1/agents/me/manifest', {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify({ manifest }),
  });
}

async function createJob(apiKey, providerId, payload) {
  return api('/v1/jobs', {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify({ providerId, payload }),
  });
}

async function patchJob(apiKey, jobId, update) {
  return api(`/v1/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify(update),
  });
}

async function getTrust(agentId) {
  return api(`/v1/agents/${agentId}/trust-report`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('env', `API_URL = ${API_URL}`);

  log('1', 'Register three agents with distinct specialties');
  const ts = Date.now();
  const [alice, bob, charlie] = await Promise.all([
    registerAgent(`alice-researcher-${ts}`),
    registerAgent(`bob-data-${ts}`),
    registerAgent(`charlie-sentiment-${ts}`),
  ]);
  log('1', `Alice   (researcher)       = ${alice.id}`);
  log('1', `Bob     (data specialist)  = ${bob.id}`);
  log('1', `Charlie (sentiment spec)   = ${charlie.id}`);

  log('2', 'All three publish service manifests');
  await Promise.all([
    publishManifest(alice.apiKey, {
      services: [{ name: 'market-research', description: 'Compose final market reports' }],
    }),
    publishManifest(bob.apiKey, {
      services: [
        { name: 'on-chain-data', description: 'Historical on-chain flows, volume, whales' },
        { name: 'market-report', description: 'Multi-source market report synthesis' },
      ],
    }),
    publishManifest(charlie.apiKey, {
      services: [
        { name: 'sentiment-analysis', description: 'Social sentiment over rolling window' },
      ],
    }),
  ]);
  log('2', 'Manifests published.');

  log('3', 'Alice opens top-level job with Bob: "24h BTC report"');
  const topJob = await createJob(alice.apiKey, bob.id, {
    task: 'market-report',
    asset: 'BTC',
    window: '24h',
  });
  log('3', `Top-level job ${topJob.id} (status=${topJob.status})`);

  log('4', 'Bob accepts and sees he needs sentiment input → sub-delegates to Charlie');
  await patchJob(bob.apiKey, topJob.id, { status: 'ACCEPTED' });
  const subJob = await createJob(bob.apiKey, charlie.id, {
    task: 'sentiment-analysis',
    asset: 'BTC',
    window: '24h',
    parentJobId: topJob.id, // explicit breadcrumb linking sub-task to parent
  });
  log('4', `Sub-job ${subJob.id} created (${bob.id} → ${charlie.id})`);

  log('5', 'Charlie accepts and completes with sentiment data');
  await patchJob(charlie.apiKey, subJob.id, { status: 'ACCEPTED' });
  const charlieResult = {
    sentimentIndex: 0.42,
    volumeDelta: '+12%',
    topSignals: ['ETF-inflows-rising', 'funding-neutral', 'whale-accumulation-modest'],
  };
  await patchJob(charlie.apiKey, subJob.id, {
    status: 'COMPLETED',
    result: charlieResult,
  });
  log('5', `Charlie delivered:`, charlieResult);

  log('6', 'Bob composes the final report combining his data + Charlie\'s sentiment');
  const bobResult = {
    asset: 'BTC',
    window: '24h',
    sentiment: charlieResult,
    priceChange: '+1.8%',
    netVolume: '$4.2B',
    narrative:
      'Constructive: sentiment mildly positive, ETF inflows accelerating, no major outflows.',
    deliveredBy: bob.id,
    sourcedFrom: [bob.id, charlie.id],
  };
  await patchJob(bob.apiKey, topJob.id, {
    status: 'COMPLETED',
    result: bobResult,
  });
  log('6', 'Top-level job completed.');

  log('7', 'Trust reports (reputation scores recompute nightly at 02:00 UTC)');
  const [aliceTrust, bobTrust, charlieTrust] = await Promise.all([
    getTrust(alice.id),
    getTrust(bob.id),
    getTrust(charlie.id),
  ]);
  for (const [label, t] of [
    ['Alice  ', aliceTrust],
    ['Bob    ', bobTrust],
    ['Charlie', charlieTrust],
  ]) {
    console.log(
      `       ${label}: reputation=${t.reputationScore}, a2a-tx=${t.a2aTxCount}, lastActive=${t.lastActiveAt}`,
    );
  }

  console.log('\n\x1b[32m✓ Delegation chain completed.\x1b[0m');
  console.log(
    '\nWhat this demonstrates:\n' +
      '  - Agents discover peers (POST /v1/agents/search)\n' +
      '  - Agents publish service manifests (PATCH /v1/agents/me/manifest)\n' +
      '  - Agents hire each other atomically (POST /v1/jobs)\n' +
      '  - Sub-delegation is native — any provider can hire further agents\n' +
      '  - The full dependency graph is auditable via /v1/jobs/* endpoints\n\n' +
      'To make it economic:\n' +
      '  - Add `reward: { amount: "0.01", token: "ETH", chainId: 8453 }`\n' +
      '    to createJob(). On job COMPLETED, an atomic on-chain payment\n' +
      '    fires with the full policy + simulation + fee pipeline.\n' +
      '  - Each agent\'s /v1/agents/me/pnl then reflects earnings/costs,\n' +
      '    and the self-sustaining loop from VISION.md comes alive:\n' +
      '      Alice pays Bob, Bob pays Charlie — each margin is on-chain\n' +
      '      revenue for the provider, recorded atomically with the work.\n' +
      '  - Requires WALLET_PROVIDER=turnkey + ALCHEMY_API_KEY on the backend.',
  );
}

main().catch((err) => {
  console.error('\n\x1b[31m✗ Example failed:\x1b[0m', err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
