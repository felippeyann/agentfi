/**
 * Shared HTTP client for all AgentFi adapters.
 */

export interface AgentFiConfig {
  apiKey: string;
  apiUrl?: string;
}

export class AgentFiClient {
  readonly apiUrl: string;
  private readonly apiKey: string;

  constructor(config: AgentFiConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl ?? 'https://api.agentfi.xyz';
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error: string };
      throw new Error(`AgentFi API ${res.status}: ${err.error}`);
    }

    return res.json() as Promise<T>;
  }

  get<T>(path: string) { return this.call<T>('GET', path); }
  post<T>(path: string, body: unknown) { return this.call<T>('POST', path, body); }
}
