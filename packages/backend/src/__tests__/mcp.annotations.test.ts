/**
 * The backend's own MCP surface (/mcp/sse) must advertise the same behaviour
 * hints as @agent_fi/mcp-server for the same operation. The stdio package
 * holds the reviewed table (packages/mcp-server/src/annotations.ts); this
 * test loads it and fails on any disagreement, on a proxy tool without
 * annotations, or on a new proxy tool nobody classified.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildProxyTools, createMcpServer } from '../api/routes/mcp.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Proxy tool → the stdio tool that performs the same operation under another name. */
const COUNTERPART: Record<string, string> = {
  get_balance: 'get_wallet_info',
  execute_transfer: 'transfer_token',
  supply_aave: 'deposit_aave',
  get_agent_policy: 'get_policy',
};

/** Proxy tools with no stdio equivalent — classified on their own in mcp.ts. */
const NO_COUNTERPART = new Set(['get_wallet', 'get_allowances', 'list_transactions']);

type Hints = Record<(typeof HINTS)[number], boolean> & { title: string };

async function loadStdioAnnotations(): Promise<Record<string, Hints>> {
  // Loaded by path at runtime: the backend's tsconfig rootDir (src) does not
  // allow a static import from the sibling package. The module is pure data
  // (its SDK import is type-only).
  const here = dirname(fileURLToPath(import.meta.url));
  const modulePath = resolve(here, '../../../mcp-server/src/annotations.ts');
  const mod = (await import(modulePath)) as { TOOL_ANNOTATIONS: Record<string, Hints> };
  return mod.TOOL_ANNOTATIONS;
}

const tools = buildProxyTools('http://backend.test', 'agfi_live_test');

describe('backend MCP proxy tool annotations', () => {
  it('sets a title and all four hints on every proxy tool', () => {
    expect(tools).toHaveLength(18);
    for (const tool of tools) {
      expect(tool.annotations.title.length, tool.name).toBeGreaterThan(0);
      for (const hint of HINTS) expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe('boolean');
      if (tool.annotations.readOnlyHint) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
        expect(tool.annotations.idempotentHint, tool.name).toBe(true);
      }
    }
  });

  it('agrees with @agent_fi/mcp-server for every tool that has a stdio counterpart', async () => {
    const stdio = await loadStdioAnnotations();
    for (const tool of tools) {
      if (NO_COUNTERPART.has(tool.name)) continue;
      const counterpart = COUNTERPART[tool.name] ?? tool.name;
      const expected = stdio[counterpart];
      expect(expected, `${tool.name} → ${counterpart} is not in the stdio table`).toBeDefined();
      for (const hint of HINTS) {
        expect(tool.annotations[hint], `${tool.name}.${hint} vs ${counterpart}`).toBe(expected?.[hint]);
      }
    }
  });

  it('classifies the proxy-only tools as read-only', () => {
    for (const name of NO_COUNTERPART) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
    }
  });

  it('shows title and annotations in tools/list', async () => {
    const server = createMcpServer('agfi_live_test');
    const client = new Client({ name: 'backend-annotations-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(tools.length);
    for (const tool of listed.tools) {
      const def = tools.find((t) => t.name === tool.name);
      expect(tool.annotations, tool.name).toEqual(def?.annotations);
      expect(tool.title, tool.name).toBe(def?.annotations.title);
    }

    await client.close();
    await server.close();
  });
});
