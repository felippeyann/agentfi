/**
 * Thin HTTP client for the AgentFi Backend API.
 * The MCP server acts as a protocol adapter — it translates MCP tool calls
 * into typed HTTP requests to the backend.
 */

import 'dotenv/config';

const API_URL = process.env['AGENTFI_API_URL'] ?? 'http://localhost:3000';
const API_KEY = process.env['AGENTFI_API_KEY'] ?? '';

if (!API_KEY) {
  console.error('[AgentFi MCP] AGENTFI_API_KEY is not set. Set it to your agent API key.');
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, API_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error: string;
    };
    throw new Error(`AgentFi API error ${response.status}: ${error.error}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};
