#!/usr/bin/env node
/**
 * Minimal first-run smoke test for the zero-credential dev stack.
 *
 * Requires the stack from docker-compose.dev.yml to be running:
 *   docker compose -f docker-compose.dev.yml up --build
 *
 * Then run:
 *   npm run smoke:dev
 */

const API_URL = process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ?? 'dev-api-secret-min-32-chars-long-xxxxx';

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${detail}`);
  }

  return body;
}

function step(label, message) {
  console.log(`\x1b[36m[${label}]\x1b[0m ${message}`);
}

async function requireApi() {
  try {
    await api('/health');
  } catch (err) {
    throw new Error(
      `AgentFi API is not reachable at ${API_URL}. ` +
        'Start it with `docker compose -f docker-compose.dev.yml up --build` first. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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

async function main() {
  step('env', `API_URL = ${API_URL}`);

  step('1', 'Check API health');
  await requireApi();

  step('2', 'Register provider and requester agents');
  const suffix = Date.now();
  const provider = await registerAgent(`smoke-provider-${suffix}`);
  const requester = await registerAgent(`smoke-requester-${suffix}`);

  step('3', 'Verify authenticated agent lookup');
  const requesterMe = await api('/v1/agents/me', {
    headers: { 'x-api-key': requester.apiKey },
  });
  if (requesterMe.id !== requester.id) {
    throw new Error(`Expected requester /me id ${requester.id}, got ${requesterMe.id}`);
  }

  step('4', 'Publish provider manifest and discover it by name');
  await publishManifest(provider.apiKey, {
    services: [{ name: 'smoke-analysis', description: 'Dev-stack smoke service' }],
  });
  const search = await api(`/v1/agents/search?q=${encodeURIComponent(`smoke-provider-${suffix}`)}`);
  if (!Array.isArray(search.agents) || !search.agents.some((agent) => agent.id === provider.id)) {
    throw new Error('Provider was not returned by /v1/agents/search');
  }

  step('5', 'Create, accept, and complete a no-reward A2A job');
  const job = await createJob(requester.apiKey, provider.id, {
    task: 'smoke-analysis',
    input: 'dev-stack',
  });
  await patchJob(provider.apiKey, job.id, { status: 'ACCEPTED' });
  await patchJob(provider.apiKey, job.id, {
    status: 'COMPLETED',
    result: { ok: true, source: 'smoke-dev' },
  });

  step('6', 'Read provider trust and requester P&L');
  const [trust, pnl] = await Promise.all([
    api(`/v1/agents/${provider.id}/trust-report`),
    api('/v1/agents/me/pnl', { headers: { 'x-api-key': requester.apiKey } }),
  ]);
  if (!trust.id || pnl.netPnlUsd === undefined) {
    throw new Error('Expected trust report and P&L response shapes');
  }

  console.log('\n\x1b[32m✓ Dev smoke completed.\x1b[0m');
  console.log(`provider=${provider.id}`);
  console.log(`requester=${requester.id}`);
  console.log(`job=${job.id}`);
}

main().catch((err) => {
  console.error('\n\x1b[31m✗ Dev smoke failed:\x1b[0m', err instanceof Error ? err.message : err);
  process.exit(1);
});
