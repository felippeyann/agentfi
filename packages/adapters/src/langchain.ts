/**
 * AgentFi LangChain adapter (thin).
 *
 * No LangChain dependency: each tool is a plain object with the fields
 * LangChain's `DynamicStructuredTool` takes (`name`, `description`, `schema`
 * as JSON Schema, `func`), so you build the real tool yourself:
 *
 *   import { DynamicStructuredTool } from '@langchain/core/tools';
 *   import { AgentFiToolkit } from '@agent_fi/adapters/langchain';
 *
 *   const toolkit = new AgentFiToolkit({ apiKey: process.env.AGENTFI_API_KEY!, apiUrl: process.env.AGENTFI_API_URL });
 *   const tools = toolkit.getToolFields().map((f) => new DynamicStructuredTool(f));
 *
 * The legacy duck-typed `getTools()` (objects with `call(input: string)`) is
 * kept for old callers. It is NOT a LangChain Tool instance.
 *
 * Package `@agent_fi/adapters`, not published to npm: build it from the repo.
 * The agent key is the agent's identity: use the PAYER agent's key. The tool
 * set is the alpha payer-safe set (pay_for_resource + two read-only tools);
 * legacy DeFi tools only with `legacyDefi: true`. No admin/approval/policy
 * tools exist here. No budget logic, no retries.
 */

import { AgentFiClient, type AgentFiConfig } from './client.js';
import { enabledTools, runTool, type JsonSchemaObject } from './tools.js';

/** Fields accepted by `new DynamicStructuredTool(fields)`. */
export interface LangChainToolFields {
  name: string;
  description: string;
  schema: JsonSchemaObject;
  func: (input: Record<string, unknown>) => Promise<string>;
}

// Legacy duck type (kept for compatibility with the pre-alpha adapter).
interface LangChainTool {
  name: string;
  description: string;
  call(input: string): Promise<string>;
}

export class AgentFiToolkit {
  private readonly client: AgentFiClient;
  private readonly opts: { legacyDefi?: boolean };

  constructor(config: AgentFiConfig) {
    this.client = new AgentFiClient(config);
    this.opts = config.legacyDefi === undefined ? {} : { legacyDefi: config.legacyDefi };
  }

  /** Fields for `DynamicStructuredTool` (JSON Schema `schema`). */
  getToolFields(): LangChainToolFields[] {
    return enabledTools(this.opts).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.parameters,
      func: (input: Record<string, unknown>) => runTool(this.client, t.name, input ?? {}, this.opts),
    }));
  }

  /** Legacy shape: `call(jsonString)`. */
  getTools(): LangChainTool[] {
    const client = this.client;
    const opts = this.opts;
    return enabledTools(this.opts).map((t) => ({
      name: t.name,
      description: t.description,
      async call(input: string): Promise<string> {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(input || '{}') as Record<string, unknown>;
        } catch {
          return JSON.stringify({ error: 'Tool input is not valid JSON' });
        }
        return runTool(client, t.name, parsed, opts);
      },
    }));
  }
}

