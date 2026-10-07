/**
 * Non-2xx response from the backend. `body` is the decoded error payload
 * (`{ error, code?, ... }`) so tools can turn a typed refusal — e.g. a
 * `BUDGET_EXCEEDED` with `price` and `remaining` — into structured output
 * instead of a bare message.
 *
 * Lives in its own module (no env reads, no side effects) so the error
 * sanitizer and the tests can use it without loading the HTTP client.
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
