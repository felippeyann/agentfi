#!/usr/bin/env node
/**
 * AgentFi MCP Server
 *
 * Provides 10 DeFi tools for AI agents via the Model Context Protocol.
 * Supports stdio transport (local) and SSE transport (hosted/remote).
 *
 * Usage (stdio):
 *   AGENTFI_API_KEY=agfi_live_xxx npx @agentfi/mcp-server
 *
 * Usage (SSE):
 *   AGENTFI_API_KEY=agfi_live_xxx MCP_TRANSPORT=sse node dist/index.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { walletTools } from './tools/wallet.js';
import { swapTools } from './tools/swap.js';
import { defiTools } from './tools/defi.js';
import { statusTools } from './tools/status.js';

// Combine all tools
const ALL_TOOLS = [...walletTools, ...swapTools, ...defiTools, ...statusTools];

// Build tool registry
const toolRegistry = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// Create MCP server
const server = new Server(
  {
    name: 'agentfi',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
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

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = toolRegistry.get(name);
  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
      isError: true,
    };
  }

  try {
    // Validate input schema
    const validated = tool.inputSchema.parse(args);
    // Execute handler
    const result = await tool.handler(validated as any);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: message,
            tool: name,
            recommendation:
              'Check the input parameters and try again. If the error persists, contact AgentFi support.',
          }),
        },
      ],
      isError: true,
    };
  }
});

// Start transport
async function main() {
  const transport = process.env['MCP_TRANSPORT'];

  if (transport === 'sse') {
    if (!process.env['AGENTFI_API_KEY']) {
      throw new Error('AGENTFI_API_KEY is required when MCP_TRANSPORT=sse');
    }
    // SSE transport for hosted/remote use
    await startSSEServer();
  } else {
    // Default: stdio transport for local use
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('[AgentFi MCP] Started on stdio transport');
  }
}

async function startSSEServer() {
  const { createServer } = await import('http');
  // Railway injects PORT; fall back to MCP_PORT for local dev
  const port = parseInt(process.env['PORT'] ?? process.env['MCP_PORT'] ?? '3002');
  const configuredApiKey = process.env['AGENTFI_API_KEY'] ?? '';
  const corsOrigin = process.env['MCP_CORS_ORIGIN'] ?? '';

  // SSE implementation using MCP SDK SSE transport
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');

  // Map session ID → active transport for POST message routing
  const transports = new Map<string, {
    transport: InstanceType<typeof SSEServerTransport>;
    apiKey: string;
  }>();

  const getHeaderApiKey = (req: { headers: Record<string, string | string[] | undefined> }): string => {
    const raw = req.headers['x-api-key'];
    if (Array.isArray(raw)) return raw[0] ?? '';
    return raw ?? '';
  };

  const setCorsHeaders = (req: { headers: Record<string, string | string[] | undefined> }, res: { setHeader: (name: string, value: string) => void }) => {
    // Default: deny all cross-origin requests unless MCP_CORS_ORIGIN is explicitly set
    if (!corsOrigin) return;
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (corsOrigin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && corsOrigin.split(',').map(o => o.trim()).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  };

  const httpServer = createServer(async (req, res) => {
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === '/mcp/sse' && req.method === 'GET') {
      const presentedApiKey = getHeaderApiKey(req);
      if (!presentedApiKey || presentedApiKey !== configuredApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const transport = new SSEServerTransport('/mcp/messages', res);
      transports.set(transport.sessionId, { transport, apiKey: presentedApiKey });
      transport.onclose = () => transports.delete(transport.sessionId);
      await server.connect(transport);
      return;
    }

    if (req.url?.startsWith('/mcp/messages') && req.method === 'POST') {
      const sessionId = new URL(req.url, `http://localhost`).searchParams.get('sessionId') ?? '';
      const session = transports.get(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      // Always require API key on POST — must match the key used to open the session
      const presentedApiKey = getHeaderApiKey(req);
      if (!presentedApiKey || presentedApiKey !== session.apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'sse' }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(port, () => {
    console.error(`[AgentFi MCP] SSE server running on port ${port}`);
    console.error(`[AgentFi MCP] SSE endpoint: http://localhost:${port}/mcp/sse`);
  });
}

// Helper: infer JSON Schema type from Zod schema
function inferJsonSchemaType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodArray) return 'array';
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodOptional) return inferJsonSchemaType(schema.unwrap());
  if (schema instanceof z.ZodDefault) return inferJsonSchemaType(schema.removeDefault());
  return 'string';
}

function getRequiredFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const isOptional = value instanceof z.ZodOptional || value instanceof z.ZodDefault;
    if (!isOptional) required.push(key);
  }
  return required;
}

main().catch((err) => {
  console.error('[AgentFi MCP] Fatal error:', err);
  process.exit(1);
});
