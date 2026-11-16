/**
 * Shared HTTP client for all AgentFi adapters.
 *
 * The adapters are THIN: they translate a tool call into one HTTP request and
 * hand the answer back. Budgets, policy, idempotency and reconciliation live in
 * the AgentFi backend; nothing here computes or enforces a financial rule, and
 * nothing here retries a request.
 */

export const DEFAULT_API_URL = 'http://localhost:3000';

export interface AgentFiConfig {
  /** The agent API key (`x-api-key`). It IS the agent's identity: use the PAYER agent's key. */
  apiKey: string;
  /**
   * Base URL of an AgentFi API you run (e.g. the dev stack). Defaults to
   * `http://localhost:3000`. There is no hosted AgentFi API to default to: the
   * old default `https://agentfi-backend.fly.dev` was decommissioned.
   */
  apiUrl?: string;
  /** Client-side timeout in ms for one request (default 60 000). A timeout is NOT a failed payment: see pay-resource.ts. */
  timeoutMs?: number;
  /**
   * Also expose the LEGACY DeFi tools (swap, transfer, Aave). They are not part
   * of the alpha path, move funds outside any job budget, and are off by default.
   */
  legacyDefi?: boolean;
}

/** An HTTP answer that is not 2xx, with the parsed JSON body kept intact. */
export class AgentFiApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`AgentFi API ${status}: ${typeof body['error'] === 'string' ? body['error'] : 'error'}`);
    this.name = 'AgentFiApiError';
  }
}

export class AgentFiClient {
  readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: AgentFiConfig) {
    if (!config.apiKey) throw new Error('AgentFi adapter: apiKey is required');
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  /** One request, no retry. Resolves with status and parsed body for ANY status; rejects only on transport failure/timeout. */
  async raw(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${this.apiUrl}${path}`, init);
    const parsed = (await res.json().catch(() => ({ error: res.statusText }))) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status < 200 || res.status >= 300) throw new AgentFiApiError(res.status, res.body);
    return res.body as T;
  }

  get<T>(path: string) { return this.call<T>('GET', path); }
  post<T>(path: string, body: unknown) { return this.call<T>('POST', path, body); }
}
