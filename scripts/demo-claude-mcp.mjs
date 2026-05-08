#!/usr/bin/env node
/**
 * Prepare a local Claude Desktop + AgentFi MCP demo.
 *
 * Requires the dev stack:
 *   docker compose -f docker-compose.dev.yml up --build -d
 *
 * Then run:
 *   npm run demo:claude-mcp
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = process.env.AGENTFI_API_URL ?? 'http://localhost:3000';
const OPERATOR_SECRET =
  process.env.AGENTFI_OPERATOR_SECRET ?? 'dev-api-secret-min-32-chars-long-xxxxx';
const MCP_PACKAGE = process.env.AGENTFI_MCP_PACKAGE;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

async function requireApi() {
  try {
    await api('/health');
  } catch (err) {
    throw new Error(
      `AgentFi API is not reachable at ${API_URL}. ` +
        'Start it with `docker compose -f docker-compose.dev.yml up --build -d` first. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function registerAgent(name) {
  return api('/v1/agents', {
    method: 'POST',
    headers: { 'x-api-key': OPERATOR_SECRET },
    body: JSON.stringify({ name, chainIds: [1, 8453], tier: 'FREE' }),
  });
}

async function publishManifest(apiKey, manifest) {
  return api('/v1/agents/me/manifest', {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey },
    body: JSON.stringify({ manifest }),
  });
}

function mcpCommand() {
  if (!MCP_PACKAGE) {
    if (process.platform === 'win32') {
      return {
        command: 'cmd',
        args: ['/c', `cd /d "${REPO_ROOT}" && npm run start -w packages/mcp-server`],
      };
    }
    const escapedRoot = REPO_ROOT.replace(/'/g, "'\\''");
    return {
      command: 'sh',
      args: ['-lc', `cd '${escapedRoot}' && npm run start -w packages/mcp-server`],
    };
  }

  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PACKAGE],
    };
  }
  return {
    command: 'npx',
    args: ['-y', MCP_PACKAGE],
  };
}

function mcpServer(apiKey) {
  return {
    ...mcpCommand(),
    env: {
      AGENTFI_API_URL: API_URL,
      AGENTFI_API_KEY: apiKey,
    },
  };
}

function printJson(label, value) {
  console.log(`\n## ${label}\n`);
  console.log(JSON.stringify(value, null, 2));
}

function printPrompt(number, text) {
  console.log(`\n### Prompt ${number}\n`);
  console.log(text.trim());
}

async function main() {
  await requireApi();

  const suffix = Date.now().toString(36);
  const providerName = `demo-risk-oracle-${suffix}`;
  const requesterName = `demo-requester-${suffix}`;

  const provider = await registerAgent(providerName);
  const requester = await registerAgent(requesterName);

  await publishManifest(provider.apiKey, {
    services: [
      {
        name: 'risk-summary',
        description: 'Summarizes a market or wallet risk question for another agent.',
        pricing: { token: 'ETH', amount: '0' },
        inputs: ['question'],
        outputs: ['summary', 'riskLevel', 'nextAction'],
      },
    ],
  });

  const requesterMe = await api('/v1/agents/me', {
    headers: { 'x-api-key': requester.apiKey },
  });

  console.log('# AgentFi Claude Desktop MCP demo\n');
  console.log(`API URL: ${API_URL}`);
  console.log(`Provider: ${provider.name} (${provider.id})`);
  console.log(`Requester: ${requester.name} (${requester.id})`);
  console.log(`Requester /me verified: ${requesterMe.id === requester.id ? 'yes' : 'no'}`);

  printJson('Claude Desktop config snippet', {
    mcpServers: {
      'agentfi-provider': mcpServer(provider.apiKey),
      'agentfi-requester': mcpServer(requester.apiKey),
    },
  });

  printPrompt(
    1,
    `
Using only the agentfi-provider MCP server, call get_policy to confirm the connected AgentFi policy/usage, then call get_wallet_info to show the wallet identity. Then call set_my_manifest with a risk-summary service for wallet or market risk questions.
`,
  );

  printPrompt(
    2,
    `
Using only the agentfi-requester MCP server, search for agents matching "${providerName}". Pick provider id ${provider.id}, fetch its manifest, and fetch its trust report before posting any job.
`,
  );

  printPrompt(
    3,
    `
Using only the agentfi-requester MCP server, post a no-reward job to provider ${provider.id}. Payload: {"task":"risk-summary","question":"Give me a concise risk read on holding idle ETH versus USDC on Base for the next 24 hours."}
`,
  );

  printPrompt(
    4,
    `
After the job id is returned, use only the agentfi-provider MCP server. Check the inbox, accept that job, then complete it with a structured result containing summary, riskLevel, and nextAction.
`,
  );

  printPrompt(
    5,
    `
Using only the agentfi-requester MCP server, fetch provider ${provider.id}'s trust report again, then call get_my_pnl. Summarize what changed after the A2A job and whether the requester is profitable or breakeven.
`,
  );

  console.log('\n## P&L checkpoint\n');
  console.log('Preferred: call get_my_pnl from the agentfi-requester MCP server.');
  console.log('REST fallback:');
  console.log(`curl ${API_URL}/v1/agents/me/pnl -H "x-api-key: ${requester.apiKey}"`);

  console.log('\n## Notes\n');
  console.log('- The job is intentionally no-reward so the zero-credential dev stack does not need real RPC or funded wallets.');
  console.log('- For a paid A2A job, add reward_amount/reward_token in post_job and run against real-chain credentials.');
}

main().catch((err) => {
  console.error('Demo prep failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
