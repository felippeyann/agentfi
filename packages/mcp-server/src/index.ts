#!/usr/bin/env node
/**
 * AgentFi MCP Server
 *
 * Provides DeFi and A2A economy tools for AI agents via the Model Context Protocol.
 * Supports stdio transport (local) and SSE transport (hosted/remote).
 *
 * Usage (stdio):
 *   AGENTFI_API_KEY=agfi_live_xxx npx @agent_fi/mcp-server
 *
 * Usage (SSE):
 *   AGENTFI_API_KEY=agfi_live_xxx MCP_TRANSPORT=sse node dist/index.js
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// Tool registry, tools/list (with annotations) and the sanitizing tools/call
// dispatcher live in server.ts; this file only starts a transport.
const server = createServer();

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

main().catch((err) => {
  console.error('[AgentFi MCP] Fatal error:', err);
  process.exit(1);
});
