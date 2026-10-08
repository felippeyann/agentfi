import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolAnnotationsSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_ANNOTATIONS, annotationsFor, CAUTIOUS_DEFAULT_ANNOTATIONS } from '../annotations.js';
import { ALL_TOOLS, createServer } from '../server.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

const registeredNames = ALL_TOOLS.map((t) => t.name);
const annotatedNames = Object.keys(TOOL_ANNOTATIONS);

/** Tools that move or commit funds. A new one must be added here on purpose. */
const FUND_MOVING = [
  'execute_swap',
  'transfer_token',
  'deposit_aave',
  'withdraw_aave',
  'supply_compound',
  'withdraw_compound',
  'deposit_erc4626',
  'withdraw_erc4626',
  'swap_curve',
  'open_gmx_position',
  'close_gmx_position',
  'pay_agent',
  'pay_for_resource',
  'post_job',
  'update_job_status',
];

describe('tool annotation coverage', () => {
  it('registers 35 tools with unique names', () => {
    expect(registeredNames).toHaveLength(35);
    expect(new Set(registeredNames).size).toBe(registeredNames.length);
  });

  it('annotates every registered tool', () => {
    const missing = registeredNames.filter((name) => !annotatedNames.includes(name));
    expect(missing).toEqual([]);
  });

  it('does not annotate tools that do not exist', () => {
    const unknown = annotatedNames.filter((name) => !registeredNames.includes(name));
    expect(unknown).toEqual([]);
  });

  it('sets a title and all four hints explicitly on every entry, valid per the SDK schema', () => {
    for (const [name, annotations] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(ToolAnnotationsSchema.safeParse(annotations).success, name).toBe(true);
      expect(typeof annotations.title, name).toBe('string');
      expect(annotations.title.length, name).toBeGreaterThan(0);
      for (const hint of HINTS) expect(typeof annotations[hint], `${name}.${hint}`).toBe('boolean');
    }
  });
});

describe('tool annotation classification', () => {
  it('never marks a read-only tool destructive or non-idempotent', () => {
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      if (!a.readOnlyHint) continue;
      expect(a.destructiveHint, name).toBe(false);
      expect(a.idempotentHint, name).toBe(true);
    }
  });

  it('marks every fund-moving tool as writing, destructive, non-idempotent and open-world', () => {
    for (const name of FUND_MOVING) {
      expect(TOOL_ANNOTATIONS, name).toHaveProperty(name);
      expect(annotationsFor(name), name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it('keeps signing and publishing out of the read-only set', () => {
    for (const name of ['sign_handshake', 'set_my_manifest', 'update_policy']) {
      expect(annotationsFor(name).readOnlyHint, name).toBe(false);
    }
  });

  it('marks contest_job as a destructive, idempotent, open-world write (X3a)', () => {
    // Destructive: it turns the settlement into a refund and cannot be undone.
    // Idempotent: the backend's conditional update wins once; a repeat is a 409.
    expect(annotationsFor('contest_job')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('lists exactly the expected read-only tools', () => {
    const readOnly = Object.entries(TOOL_ANNOTATIONS)
      .filter(([, a]) => a.readOnlyHint)
      .map(([name]) => name)
      .sort();
    expect(readOnly).toEqual(
      [
        'check_inbox',
        'check_outbox',
        'get_job',
        'get_agent_manifest',
        'get_agent_trust_report',
        'get_defi_rates',
        'get_my_agent_profile',
        'get_my_pnl',
        'get_policy',
        'get_token_price',
        'get_transaction_status',
        'get_wallet_info',
        'list_gmx_markets',
        'search_agents',
        'simulate_swap',
        'verify_handshake',
      ].sort(),
    );
  });

  it('falls back to the most cautious hints for an unknown tool', () => {
    expect(annotationsFor('not_a_tool')).toEqual({ title: 'not_a_tool', ...CAUTIOUS_DEFAULT_ANNOTATIONS });
  });
});

describe('tools/list over MCP', () => {
  it('shows title and annotations for every tool', async () => {
    const server = createServer();
    const client = new Client({ name: 'annotations-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(35);
    for (const tool of tools) {
      const expected = TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS];
      expect(expected, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toEqual(expected);
      expect(tool.title, tool.name).toBe(expected.title);
    }

    await client.close();
    await server.close();
  });
});
