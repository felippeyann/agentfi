#!/usr/bin/env node
/**
 * AgentFi — A2A Collaboration Example
 *
 * End-to-end agent-to-agent flow against a running AgentFi backend:
 *   1. Register two agents (Alice = provider, Bob = requester)
 *   2. Alice publishes a service manifest advertising what she offers
 *   3. Bob discovers Alice via agent search
 *   4. Bob creates a job hiring Alice (no reward — pure coordination,
 *      so this works on the zero-credential dev stack without RPC)
 *   5. Alice accepts and completes the job with a result
 *   6. Both agents inspect reputation and P&L
 *
 * Zero dependencies (uses Node 22 native fetch). Run against the dev
 * stack (docker-compose.dev.yml) or any deployed AgentFi instance.
 *
 * Usage:
 *   AGENTFI_API_URL=http://localhost:3000 \
 *   AGENTFI_OPERATOR_SECRET=dev-api-secret-min-32-chars-long-xxxxx \
 *   node examples/a2a-collab/index.mjs
 *
 * Defaults match docker-compose.dev.yml, so on a fresh dev stack just:
 *   node examples/a2a-collab/index.mjs
 */

const API_URL =
  process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ??
  'dev-api-secret-min-32-chars-long-xxxxx';

// ── tiny fetch wrapper ─────────────────────────────────────────────────────
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
  const prefix = `\x1b[36m[${step}]\x1b[0m`;
  console.log(prefix, msg);
  if (detail !== undefined) console.log(detail);
}

// ── steps ──────────────────────────────────────────────────────────────────

async function registerAgent(name) {
  return api('/v1/agents', {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_SECRET },
    body: JSON.stringify({
      name,
      chainIds: [1],
      tier: 'FREE',
    }),
  });
}

async function publishManifest(agentApiKey, manifest) {
  return api('/v1/agents/me/manifest', {
    method: 'PATCH',
    headers: { 'x-api-key': agentApiKey },
    body: JSON.stringify({ manifest }),
  });
}

async function searchAgents(query) {
  return api(`/v1/agents/search?q=${encodeURIComponent(query)}`);
}

async function createJob(requesterApiKey, providerId, payload) {
  return api('/v1/jobs', {
    method: 'POST',
    headers: { 'x-api-key': requesterApiKey },
    body: JSON.stringify({
      providerId,
      payload,
      // no `reward` → no on-chain payment, runs on dev stack without RPC
    }),
  });
}

async function patchJob(apiKey, jobId, body) {
  return api(`/v1/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
}

async function getTrustReport(agentId) {
  return api(`/v1/agents/${agentId}/trust-report`);
}

async function getPnL(apiKey) {
  return api('/v1/agents/me/pnl', {
    headers: { 'x-api-key': apiKey },
  });
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  log('env', `API_URL = ${API_URL}`);

  log('1', 'Register Alice (provider) and Bob (requester)');
  const ts = Date.now();
  const alice = await registerAgent(`alice-${ts}`);
  const bob = await registerAgent(`bob-${ts}`);
  log('1', `Alice = ${alice.id} (${alice.walletAddress ?? alice.safeAddress})`);
  log('1', `Bob   = ${bob.id} (${bob.walletAddress ?? bob.safeAddress})`);

  log('2', 'Alice publishes her service manifest');
  await publishManifest(alice.apiKey, {
    services: [
      {
        name: 'market-analysis',
        description: 'Short-term BTC/ETH sentiment summary from social signals',
        pricing: { amount: '0.001', token: 'ETH', chainId: 1 },
      },
      {
        name: 'wallet-lookup',
        description: 'Free lookup of any wallet address reputation',
        pricing: { amount: '0', token: 'ETH', chainId: 1 },
      },
    ],
  });
  log('2', 'Manifest published.');

  log('3', 'Bob searches the agent directory (name contains "alice")');
  // Search matches `name` (and `safeAddress`) case-insensitive, so we target
  // Alice's unique suffix rather than a service keyword.
  const { agents: hits } = await searchAgents(`alice-${ts}`);
  log('3', `Found ${hits.length} agent(s):`);
  for (const h of hits.slice(0, 3)) {
    console.log(`       - ${h.name} (${h.id}) — tier ${h.tier}, chains ${h.chainIds.join(',')}`);
  }

  log('4', 'Bob creates a job hiring Alice');
  const job = await createJob(bob.apiKey, alice.id, {
    action: 'market-analysis',
    target: 'BTC',
    window: '24h',
  });
  log('4', `Job created: ${job.id}, status = ${job.status}`);

  log('5', 'Alice accepts the job');
  await patchJob(alice.apiKey, job.id, { status: 'ACCEPTED' });
  log('5', 'Alice completes with a result');
  await patchJob(alice.apiKey, job.id, {
    status: 'COMPLETED',
    result: {
      summary: 'Neutral-to-mildly-bullish. Social volume +12%, sentiment +0.3σ.',
      confidence: 0.62,
    },
  });
  log('5', 'Job completed.');

  log('6', 'Inspect reputation + P&L for both agents');
  const [aliceTrust, bobTrust, alicePnl, bobPnl] = await Promise.all([
    getTrustReport(alice.id),
    getTrustReport(bob.id),
    getPnL(alice.apiKey),
    getPnL(bob.apiKey),
  ]);

  console.log('\n       \x1b[33mAlice\x1b[0m');
  console.log(`       reputation : ${aliceTrust.reputationScore}`);
  console.log(`       a2a tx     : ${aliceTrust.a2aTxCount}`);
  console.log(`       earnings   : $${alicePnl.earnings.totalEarningsUsd}`);
  console.log(`       costs      : $${alicePnl.costs.totalCostsUsd}`);
  console.log(`       net P&L    : $${alicePnl.netPnlUsd}`);

  console.log('\n       \x1b[33mBob\x1b[0m');
  console.log(`       reputation : ${bobTrust.reputationScore}`);
  console.log(`       a2a tx     : ${bobTrust.a2aTxCount}`);
  console.log(`       earnings   : $${bobPnl.earnings.totalEarningsUsd}`);
  console.log(`       costs      : $${bobPnl.costs.totalCostsUsd}`);
  console.log(`       net P&L    : $${bobPnl.netPnlUsd}`);

  console.log('\n\x1b[32m✓ A2A flow completed end-to-end.\x1b[0m');
  console.log(
    '\nNext: add `reward` to createJob() for an atomic on-chain payment\n' +
      '      (requires WALLET_PROVIDER=turnkey + ALCHEMY_API_KEY).',
  );
}

main().catch((err) => {
  console.error('\n\x1b[31m✗ Example failed:\x1b[0m', err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
