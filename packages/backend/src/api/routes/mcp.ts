/**
 * MCP SSE transport routes — embedded in the backend Fastify server.
 *
 * GET  /mcp/sse      → Opens an SSE stream (requires x-api-key header)
 * POST /mcp/messages  → Receives JSON-RPC messages for an active session
 *
 * Authentication: uses the same agent API key as the rest of the API,
 * but validated inline (not by the global auth middleware) so that
 * unauthenticated tools/list discovery works for Smithery scanning.
 */

import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  describeError,
  newTraceId,
  sanitizeContextFromEnv,
  sanitizeText,
  sanitizeValue,
} from '../errors/sanitize.js';

// ─── Tool definitions (inline to avoid cross-package import issues) ───

/**
 * MCP tool annotations (spec 2025-11-25). Required on every tool so a new
 * proxy tool cannot ship without them. The classification rules — and the
 * annotations of the equivalent stdio tools — live in
 * packages/mcp-server/src/annotations.ts; this surface cannot import that
 * package (separate rootDir and Docker build), so
 * src/__tests__/mcp.annotations.test.ts fails if a tool here disagrees with
 * its counterpart there.
 */
export type ProxyToolAnnotations = ToolAnnotations & {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** Reads only the calling agent's own AgentFi records. */
const READ_OWN_RECORDS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Reads a chain or a third-party API (CoinGecko). */
const READ_OPEN_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Moves or commits funds on-chain; a repeat is a second trade/transfer. */
const MOVES_FUNDS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface ToolDef {
  name: string;
  description: string;
  annotations: ProxyToolAnnotations;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Builds a thin MCP tool list that proxies every call to the backend REST API.
 * The API key is forwarded so agent-level auth still applies.
 */
export function buildProxyTools(apiBaseUrl: string, apiKey: string): ToolDef[] {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const url = `${apiBaseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };

  return [
    {
      name: 'get_my_agent_profile',
      annotations: { title: 'Get my agent profile', ...READ_OWN_RECORDS },
      description: 'Get the authenticated AgentFi agent profile, policy, billing usage, and supported chains',
      inputSchema: z.object({}),
      handler: async () => call('GET', '/v1/agents/me'),
    },
    {
      name: 'get_my_pnl',
      annotations: { title: 'Get my profit and loss', ...READ_OPEN_WORLD },
      description: 'Get the authenticated agent P&L breakdown: earnings, costs, gas, net P&L, and breakeven status',
      inputSchema: z.object({
        since: z.string().datetime().optional().describe('Optional ISO timestamp for the beginning of the P&L period'),
      }),
      handler: async (args: Record<string, unknown>) => {
        const qs = typeof args.since === 'string' ? `?since=${encodeURIComponent(args.since)}` : '';
        return call('GET', `/v1/agents/me/pnl${qs}`);
      },
    },
    {
      name: 'get_wallet',
      annotations: { title: 'Get wallet address', ...READ_OWN_RECORDS },
      description: 'Get the agent wallet address and supported networks',
      inputSchema: z.object({}),
      handler: async () => call('GET', '/v1/wallet/address'),
    },
    {
      name: 'get_balance',
      annotations: { title: 'Get wallet balances', ...READ_OPEN_WORLD },
      description: 'Get ETH and ERC-20 token balances for the agent wallet',
      inputSchema: z.object({
        chainId: z.number().optional().describe('Chain ID to query (omit for all supported chains)'),
      }),
      handler: async (args: Record<string, unknown>) => {
        const qs = args.chainId ? `?chainId=${args.chainId}` : '';
        return call('GET', `/v1/wallet/balance${qs}`);
      },
    },
    {
      name: 'get_allowances',
      annotations: { title: 'Get token allowances', ...READ_OPEN_WORLD },
      description: 'Get active ERC-20 token allowances for the agent wallet',
      inputSchema: z.object({
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
        spender: z.string().optional().describe('Filter by spender address'),
      }),
      handler: async (args: Record<string, unknown>) => {
        const params = new URLSearchParams();
        if (args.chainId) params.set('chainId', String(args.chainId));
        if (args.spender) params.set('spender', String(args.spender));
        const qs = params.toString() ? `?${params}` : '';
        return call('GET', `/v1/wallet/allowances${qs}`);
      },
    },
    {
      name: 'simulate_swap',
      annotations: { title: 'Simulate a Uniswap swap', ...READ_OPEN_WORLD },
      description: 'Simulate a token swap — returns gas estimate and success/failure without executing',
      inputSchema: z.object({
        fromToken: z.string().describe('Source token contract address'),
        toToken: z.string().describe('Destination token contract address'),
        amountIn: z.string().describe('Amount in human-readable decimals (e.g. "1.5")'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/simulate', args),
    },
    {
      name: 'execute_swap',
      annotations: { title: 'Execute a Uniswap swap', ...MOVES_FUNDS },
      description: 'Execute a token swap via Uniswap V3 — requires a prior simulation ID',
      inputSchema: z.object({
        fromToken: z.string().describe('Source token contract address'),
        toToken: z.string().describe('Destination token contract address'),
        amountIn: z.string().describe('Amount in human-readable decimals (e.g. "1.5")'),
        simulationId: z.string().describe('Simulation ID from simulate_swap'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
        slippageTolerance: z.number().optional().describe('Slippage tolerance in % (default: 0.5)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/swap', args),
    },
    {
      name: 'execute_transfer',
      annotations: { title: 'Transfer tokens', ...MOVES_FUNDS },
      description: 'Transfer tokens or native ETH to another address',
      inputSchema: z.object({
        to: z.string().describe('Recipient address (0x...)'),
        token: z.string().describe('Token contract address or "ETH" for native'),
        amount: z.string().describe('Amount in human-readable decimals (e.g. "0.1")'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/transfer', args),
    },
    {
      name: 'supply_aave',
      annotations: { title: 'Supply to Aave V3', ...MOVES_FUNDS },
      description: 'Supply tokens to Aave V3 lending protocol to earn yield',
      inputSchema: z.object({
        asset: z.string().describe('Token contract address to supply'),
        amount: z.string().describe('Amount in human-readable decimals'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/deposit', args),
    },
    {
      name: 'withdraw_aave',
      annotations: { title: 'Withdraw from Aave V3', ...MOVES_FUNDS },
      description: 'Withdraw tokens from Aave V3 lending position',
      inputSchema: z.object({
        asset: z.string().describe('aToken contract address to withdraw'),
        amount: z.string().describe('Amount in decimals, or "max" to withdraw all'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/withdraw', args),
    },
    {
      name: 'supply_compound',
      annotations: { title: 'Supply to Compound V3', ...MOVES_FUNDS },
      description: 'Supply tokens to Compound V3 (Comet USDC market) to earn yield',
      inputSchema: z.object({
        asset: z.string().describe('ERC-20 token address to supply'),
        amount: z.string().describe('Amount in human-readable decimals'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/supply-compound', args),
    },
    {
      name: 'withdraw_compound',
      annotations: { title: 'Withdraw from Compound V3', ...MOVES_FUNDS },
      description: 'Withdraw tokens from Compound V3 position',
      inputSchema: z.object({
        asset: z.string().describe('ERC-20 token address to withdraw'),
        amount: z.string().describe('Amount in decimals, or "max" to withdraw all'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/withdraw-compound', args),
    },
    {
      name: 'deposit_erc4626',
      annotations: { title: 'Deposit into ERC-4626 vault', ...MOVES_FUNDS },
      description: 'Deposit into any ERC-4626 compliant vault (Yearn, Morpho, Beefy, etc.)',
      inputSchema: z.object({
        vault: z.string().describe('ERC-4626 vault contract address'),
        asset: z.string().describe('Underlying ERC-20 token address'),
        amount: z.string().describe('Amount in human-readable decimals'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/deposit-erc4626', args),
    },
    {
      name: 'withdraw_erc4626',
      annotations: { title: 'Withdraw from ERC-4626 vault', ...MOVES_FUNDS },
      description: 'Withdraw from any ERC-4626 compliant vault',
      inputSchema: z.object({
        vault: z.string().describe('ERC-4626 vault contract address'),
        asset: z.string().describe('Underlying ERC-20 token address'),
        amount: z.string().describe('Amount in decimals, or "max" to withdraw all'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/withdraw-erc4626', args),
    },
    {
      name: 'swap_curve',
      annotations: { title: 'Swap on Curve', ...MOVES_FUNDS },
      description: 'Swap between two assets on a Curve StableSwap pool (stablecoins)',
      inputSchema: z.object({
        pool: z.string().describe('Curve pool contract address'),
        fromTokenIndex: z.number().describe('Index of input token in the pool'),
        toTokenIndex: z.number().describe('Index of output token in the pool'),
        fromTokenAddress: z.string().describe('ERC-20 address of input token'),
        toTokenAddress: z.string().describe('ERC-20 address of output token'),
        amountIn: z.string().describe('Amount of input token in human-readable units'),
        minAmountOut: z.string().describe('Minimum output amount (slippage protection)'),
        chainId: z.number().optional().describe('Chain ID (default: 1)'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('POST', '/v1/transactions/swap-curve', args),
    },
    {
      name: 'get_transaction_status',
      annotations: { title: 'Get transaction status', ...READ_OWN_RECORDS },
      description: 'Get the status of a previously submitted transaction',
      inputSchema: z.object({
        transactionId: z.string().describe('Transaction ID returned by execute_*'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('GET', `/v1/transactions/${args.transactionId}`),
    },
    {
      name: 'list_transactions',
      annotations: { title: 'List my transactions', ...READ_OWN_RECORDS },
      description: 'List transaction history with optional status filter',
      inputSchema: z.object({
        page: z.number().optional().describe('Page number (default: 1)'),
        limit: z.number().optional().describe('Results per page (default: 20, max: 100)'),
        status: z.string().optional().describe('Filter by status (PENDING, SIMULATING, BROADCASTING, CONFIRMED, FAILED)'),
      }),
      handler: async (args: Record<string, unknown>) => {
        const params = new URLSearchParams();
        if (args.page) params.set('page', String(args.page));
        if (args.limit) params.set('limit', String(args.limit));
        if (args.status) params.set('status', String(args.status));
        const qs = params.toString() ? `?${params}` : '';
        return call('GET', `/v1/transactions${qs}`);
      },
    },
    {
      name: 'get_agent_policy',
      annotations: { title: 'Get my policy and limits', ...READ_OWN_RECORDS },
      description: 'Get the current agent policy constraints (spending limits, allowed tokens, etc.)',
      inputSchema: z.object({}),
      handler: async () => call('GET', '/v1/agents/me'),
    },
  ];
}

// ─── JSON Schema helpers ───

function inferJsonSchemaType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodArray) return 'array';
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodOptional) return inferJsonSchemaType(schema.unwrap());
  if (schema instanceof z.ZodDefault)
    return inferJsonSchemaType(schema.removeDefault());
  return 'string';
}

function getRequiredFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const isOptional =
      value instanceof z.ZodOptional || value instanceof z.ZodDefault;
    if (!isOptional) required.push(key);
  }
  return required;
}

// ─── MCP Server + Fastify routes ───

const sessions = new Map<
  string,
  { transport: SSEServerTransport; apiKey: string; server: Server }
>();

export interface McpServerOptions {
  /** Where a failed tool call is logged in full (default: the backend logger). Tests inject one. */
  logError?: ProxyErrorLogger;
}

export function createMcpServer(apiKey: string, options: McpServerOptions = {}): Server {
  const apiBaseUrl =
    process.env['API_BASE_URL'] ??
    `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

  const tools = buildProxyTools(apiBaseUrl, apiKey);
  const toolRegistry = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'agentfi', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.annotations.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(tool.inputSchema.shape ?? {}).map(([key, schema]) => [
            key,
            {
              type: inferJsonSchemaType(schema as z.ZodTypeAny),
              description: (schema as z.ZodTypeAny).description,
            },
          ]),
        ),
        required: getRequiredFields(tool.inputSchema),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolRegistry.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      const validated = tool.inputSchema.parse(args);
      const result = await tool.handler(validated as any);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return proxyToolErrorResult(err, name, options.logError);
    }
  });

  return server;
}

// ─── Tool errors (S5) ───

export type ProxyErrorLogger = (traceId: string, tool: string, err: unknown) => void;

/**
 * Fallback when no logger is injected (tests, scripts): stderr. `mcpRoutes`
 * passes the Fastify logger, so in the server the line lands in the app log
 * with the request's other fields. Kept free of `middleware/logger.js` so this
 * module loads without the backend env.
 */
const defaultProxyErrorLogger: ProxyErrorLogger = (traceId, tool, err) => {
  console.error(`[AgentFi /mcp/sse] traceId=${traceId} tool=${tool} failed:`, err);
};

/**
 * The `/mcp/sse` counterpart of @agent_fi/mcp-server's `toolErrorResult`
 * (S2): before S5 this surface returned `err.message` verbatim — a failed
 * call to the backend's own API (`API_BASE_URL`, an internal URL) or any
 * upstream error text reached the MCP client. Now the result carries the
 * sanitized message, the code (INVALID_INPUT for bad arguments,
 * UPSTREAM_UNREACHABLE, …), the tool and a `traceId`; the full error is
 * logged under the same id. REST error bodies the proxy relays are already
 * sanitized by the API itself.
 */
export function proxyToolErrorResult(
  err: unknown,
  tool: string,
  log: ProxyErrorLogger = defaultProxyErrorLogger,
): CallToolResult {
  const traceId = newTraceId();
  const ctx = sanitizeContextFromEnv();
  const described = describeError(err);
  const payload = {
    error: sanitizeText(described.message, ctx) || 'Unknown error',
    ...(described.code !== undefined ? { code: described.code } : {}),
    ...(described.details !== undefined ? { details: sanitizeValue(described.details, ctx) } : {}),
    tool,
    traceId,
    recommendation:
      described.code === 'INVALID_INPUT'
        ? 'Fix the input parameters (see error and details) and try again.'
        : `Unexpected error. Retry later; if it persists, contact the AgentFi operator and quote traceId ${traceId}.`,
  };
  try {
    log(traceId, tool, err);
  } catch {
    // Logging must never turn a tool error into a protocol error.
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

export async function mcpRoutes(fastify: FastifyInstance) {
  // GET /mcp/sse — open SSE stream
  fastify.get('/mcp/sse', async (request, reply) => {
    const apiKey =
      (request.headers['x-api-key'] as string) ??
      (request.query as Record<string, string>)['apiKey'] ??
      '';

    // Allow unauthenticated connections for tool discovery (Smithery scan),
    // but tool calls will fail without a valid key.
    const mcpServer = createMcpServer(apiKey, {
      logError: (traceId, tool, err) => request.log.error({ err, traceId, tool }, 'MCP /mcp/sse tool call failed'),
    });

    // Hijack the response so Fastify doesn't touch it — SSE needs raw streaming
    reply.hijack();

    const transport = new SSEServerTransport('/mcp/messages', reply.raw);
    sessions.set(transport.sessionId, {
      transport,
      apiKey,
      server: mcpServer,
    });
    transport.onclose = () => sessions.delete(transport.sessionId);

    await mcpServer.connect(transport);
  });

  // POST /mcp/messages — receive JSON-RPC messages
  fastify.post('/mcp/messages', async (request, reply) => {
    const sessionId =
      (request.query as Record<string, string>)['sessionId'] ?? '';
    const session = sessions.get(sessionId);

    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    // Hijack and forward the raw request/response to the SSE transport.
    // Pass request.body as parsedBody so the SDK doesn't try to re-read
    // the raw stream (Fastify already consumed it via the content-type parser).
    reply.hijack();
    await session.transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
}
