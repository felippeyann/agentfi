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

/**
 * Non-2xx response from the backend. `body` is the decoded error payload
 * (`{ error, code?, ... }`) so tools can turn a typed refusal — e.g. a
 * `BUDGET_EXCEEDED` with `price` and `remaining` — into structured output
 * instead of a bare message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    const message = typeof body['error'] === 'string' ? body['error'] : `HTTP ${status}`;
    super(`AgentFi API error ${status}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof body['code'] === 'string' ? body['code'] : undefined;
    this.body = body;
  }
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

  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(url.toString(), init);

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: response.statusText }))) as Record<
      string,
      unknown
    >;
    throw new ApiError(response.status, error);
  }

  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};
