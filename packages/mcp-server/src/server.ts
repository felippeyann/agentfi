/**
 * MCP server wiring: the tool registry, `tools/list` (with annotations from
 * annotations.ts) and the single `tools/call` dispatcher that routes every
 * thrown error through the sanitizer in errors.ts. Transport startup lives in
 * index.ts, so this module can be loaded by tests without starting a server.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { annotationsFor } from './annotations.js';
import { toolErrorResult, type ErrorLogger } from './errors.js';
import { walletTools } from './tools/wallet.js';
import { swapTools } from './tools/swap.js';
import { defiTools } from './tools/defi.js';
import { gmxTools } from './tools/gmx.js';
import { statusTools } from './tools/status.js';
import { agentTools } from './tools/agent.js';

export const SERVER_NAME = 'agentfi';
export const SERVER_VERSION = '0.5.0';

/** Every tool this server registers, in tools/list order. */
export const ALL_TOOLS = [
  ...walletTools,
  ...swapTools,
  ...defiTools,
  ...gmxTools,
  ...statusTools,
  ...agentTools,
];

type RegisteredTool = (typeof ALL_TOOLS)[number];

const toolRegistry = new Map<string, RegisteredTool>(ALL_TOOLS.map((t) => [t.name, t]));

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

/** The `tools/list` payload: schema plus title and behaviour annotations. */
export function listTools(): Tool[] {
  return ALL_TOOLS.map((tool) => {
    const annotations = annotationsFor(tool.name);
    return {
      name: tool.name,
      title: annotations.title,
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
        required: getRequiredFields(tool.inputSchema as z.ZodObject<z.ZodRawShape>),
      },
      annotations,
    };
  });
}

export interface CallToolOptions {
  /** Where the full original error goes (default: stderr). */
  log?: ErrorLogger;
}

/**
 * Validates and runs one tool. Any error — input validation, backend
 * refusal, network failure, a bug — leaves through toolErrorResult, so no
 * tool handler needs its own error sanitizing.
 */
export async function callTool(
  name: string,
  args: unknown,
  options: CallToolOptions = {},
): Promise<CallToolResult> {
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
    const validated = tool.inputSchema.parse(args);
    const result = await (tool.handler as (input: unknown) => Promise<unknown>)(validated);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return toolErrorResult(err, { tool: name, ...(options.log ? { log: options.log } : {}) });
  }
}

/** Builds the MCP server with the list/call handlers registered. */
export function createServer(options: CallToolOptions = {}): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args, options);
  });

  return server;
}
