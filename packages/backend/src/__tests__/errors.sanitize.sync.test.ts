/**
 * The backend error sanitizer (api/errors/sanitize.ts, S5) carries a copy of
 * the MCP server's rules (packages/mcp-server/src/errors.ts, S2): the backend
 * cannot import that package (separate rootDir and Docker build; the MCP
 * package is published to npm on its own). This test keeps the two in sync:
 *
 *  1. the "Text rules" and "Structured values" sections are byte-identical
 *     (line endings normalised);
 *  2. both implementations give the same output for a shared corpus, under
 *     the same explicit context.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as backend from '../api/errors/sanitize.js';

const here = dirname(fileURLToPath(import.meta.url));
const MCP_ERRORS = resolve(here, '../../../mcp-server/src/errors.ts');
const BACKEND_ERRORS = resolve(here, '../api/errors/sanitize.ts');

type SanitizeModule = Pick<typeof backend, 'sanitizeText' | 'sanitizeValue' | 'TARGET_REFUSAL_CODES'>;

async function loadMcpSanitizer(): Promise<SanitizeModule> {
  // Loaded by path at runtime, like mcp.annotations.test.ts: a static import
  // from the sibling package is outside the backend's rootDir.
  return (await import(MCP_ERRORS)) as SanitizeModule;
}

/** The shared rule block: from "Text rules" up to (not including) "Error classification". */
function ruleBlock(path: string): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith('// ─── Text rules'));
  const end = lines.findIndex((l) => l.startsWith('// ─── Error classification'));
  expect(start, `${path}: "Text rules" marker`).toBeGreaterThan(-1);
  expect(end, `${path}: "Error classification" marker`).toBeGreaterThan(start);
  return lines.slice(start, end).join('\n');
}

const ctx: backend.SanitizeContext = {
  secrets: ['AbCdEf1234567890XyZ_kEy-0987', 'turnkey-private-key-value-1234567890'].sort((a, b) => b.length - a.length),
  internalOrigins: ['http://agentfi-backend.test-net:3000'],
  internalHosts: ['agentfi-backend.test-net:3000', 'db.example.com'],
};

const TX_HASH = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

const CORPUS: string[] = [
  'HTTP request failed.\n\nStatus: 401\nURL: https://base-sepolia.g.alchemy.com/v2/Zq8mN3pL5vR7tX9wB2cD4fG6hJ\nVersion: viem@2.57.3',
  'request to http://agentfi-backend.test-net:3000/v1/jobs/abc failed',
  'connect ECONNREFUSED agentfi-backend.test-net:3000',
  "Can't reach database server at `db.example.com`:`5432`",
  'GET https://api.coingecko.com/api/v3/simple/price?ids=eth&x_cg_demo_api_key=CG-123',
  'cannot reach https://admin:hunter2@rpc.example.com/x',
  'prisma: postgresql://agentfi:s3cret@db.example.com:5432/agentfi',
  'x402 resource https://api.example.com/v1/data returned 500.',
  'connect ECONNREFUSED 127.0.0.1:3000 and redis at 10.0.4.12:6379 via db.internal:5432 on localhost:8080',
  'upstream http://backend:3000/v1/x failed',
  'Error: boom\n    at handler (file:///app/packages/backend/dist/api/routes/jobs.js:120:11)\n    at async Promise.all (index 0)',
  'Invalid `prisma.agent.findUnique()` invocation in\n/app/packages/backend/dist/api/routes/agents.js:291:36',
  'ENOENT: C:\\Users\\dev\\agentfi\\.env missing',
  'Route PATCH:/v1/jobs/abc/pay-resource not found',
  'turnkey rejected key turnkey-private-key-value-1234567890 in production',
  'other key agfi_live_deadbeefdeadbeefdeadbeef',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and x-api-key: abc123def456',
  '{"password":"hunter22","user":"bob"} client_secret=s3cr3t-value&grant=x',
  'Unsupported token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  `invalid private key ${PRIVATE_KEY}`,
  `Transaction ${TX_HASH} reverted on chain 8453`,
  'redirect to http://169.254.169.254/x from localhost via 10.0.0.5',
  'see (https://docs.example.com/a).',
  'x'.repeat(5_000),
];

describe('backend sanitizer ↔ @agent_fi/mcp-server sanitizer', () => {
  it('has a byte-identical "Text rules" + "Structured values" block', () => {
    expect(ruleBlock(BACKEND_ERRORS)).toBe(ruleBlock(MCP_ERRORS));
  });

  it('gives the same sanitizeText output for every corpus entry, with and without keepNetworkLocations', async () => {
    const mcp = await loadMcpSanitizer();
    for (const input of CORPUS) {
      expect(backend.sanitizeText(input, ctx), input.slice(0, 60)).toBe(mcp.sanitizeText(input, ctx));
      expect(backend.sanitizeText(input, ctx, { keepNetworkLocations: true }), input.slice(0, 60)).toBe(
        mcp.sanitizeText(input, ctx, { keepNetworkLocations: true }),
      );
    }
  });

  it('gives the same sanitizeValue output for a nested error body', async () => {
    const mcp = await loadMcpSanitizer();
    const value = {
      escrowError: 'submit failed: https://base-mainnet.g.alchemy.com/v2/AbCdEf1234567890XyZ_kEy-0987',
      nested: { list: ['ok', 'at http://agentfi-backend.test-net:3000/x'], apiKey: 'whatever', privateKey: PRIVATE_KEY },
      stack: 'Error\n    at x (/app/a.js:1:1)',
      token: 'USDC',
      txHash: TX_HASH,
      amount: 10n,
      count: 3,
      none: null,
      items: Array.from({ length: 60 }, (_, i) => `item ${i}`),
    };
    expect(backend.sanitizeValue(value, ctx)).toEqual(mcp.sanitizeValue(value, ctx));
  });

  it('treats the same codes as typed target refusals', async () => {
    const mcp = await loadMcpSanitizer();
    expect([...backend.TARGET_REFUSAL_CODES].sort()).toEqual([...mcp.TARGET_REFUSAL_CODES].sort());
  });
});
