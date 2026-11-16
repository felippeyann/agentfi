/**
 * AgentFi OpenAI function-calling adapter (thin).
 *
 * For code that calls a chat model with `tools` directly (OpenAI, or any
 * tool-use API that accepts the OpenAI function shape). It only translates:
 * the tool definitions below, and one HTTP call per tool call. It computes no
 * budget, applies no policy and never retries.
 *
 * Usage (package name: `@agent_fi/adapters`, not published to npm yet: build
 * it from the repository, `npm run build -w packages/adapters`):
 *
 *   import { getAgentFiTools, handleAgentFiToolCall } from '@agent_fi/adapters/openai';
 *
 *   const config = { apiKey: process.env.AGENTFI_API_KEY!, apiUrl: process.env.AGENTFI_API_URL };
 *   const tools = getAgentFiTools(config);   // pay_for_resource + two read-only tools
 *   // pass `tools` to the model; when a tool_call comes back:
 *   const result = await handleAgentFiToolCall(call.function.name, call.function.arguments, config);
 *   // feed `result` (a JSON string) back to the model as the tool message.
 *
 * `apiKey` is the agent's identity: use the key of the PAYER agent (the
 * provider of the ACCEPTED job). No admin, approval or policy tool exists here.
 */

import { AgentFiClient, type AgentFiConfig } from './client.js';
import { enabledTools, runTool } from './tools.js';

// OpenAI tool definition format
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: readonly string[];
    };
  };
}

/** Tool definitions. Alpha set by default; pass `{ legacyDefi: true }` to add the legacy DeFi tools. */
export function getAgentFiTools(options: { legacyDefi?: boolean } = {}): OpenAITool[] {
  return enabledTools(options).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Handles a tool call returned by the model: one HTTP request, no retry.
 * Returns a JSON string for the tool message. Backend answers (including
 * 402/403/409/502 refusals) are returned verbatim, never thrown.
 */
export async function handleAgentFiToolCall(
  toolName: string,
  argumentsJson: string,
  config: AgentFiConfig,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson || '{}') as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'Tool arguments are not valid JSON' });
  }
  const client = new AgentFiClient(config);
  return runTool(client, toolName, args, config.legacyDefi === undefined ? {} : { legacyDefi: config.legacyDefi });
}
