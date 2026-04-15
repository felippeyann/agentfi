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
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ─── Tool definitions (inline to avoid cross-package import issues) ───

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Builds a thin MCP tool list that proxies every call to the backend REST API.
 * The API key is forwarded so agent-level auth still applies.
 */
function buildProxyTools(apiBaseUrl: string, apiKey: string): ToolDef[] {
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
      name: 'get_wallet',
      description: 'Get the agent wallet address and supported networks',
      inputSchema: z.object({}),
      handler: async () => call('GET', '/v1/wallet/address'),
    },
    {
      name: 'get_balance',
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
      name: 'get_transaction_status',
      description: 'Get the status of a previously submitted transaction',
      inputSchema: z.object({
        transactionId: z.string().describe('Transaction ID returned by execute_*'),
      }),
      handler: async (args: Record<string, unknown>) =>
        call('GET', `/v1/transactions/${args.transactionId}`),
    },
    {
      name: 'list_transactions',
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

function createMcpServer(apiKey: string): Server {
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
      description: tool.description,
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
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message, tool: name }) }],
        isError: true,
      };
    }
  });

  return server;
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
    const mcpServer = createMcpServer(apiKey);

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
