import { z } from 'zod';

/**
 * An id as it goes into a URL path (`/v1/jobs/<id>`, `/v1/agents/<id>/manifest`,
 * `/v1/transactions/<id>`). AgentFi ids are CUIDs; anything with `/`, `.`,
 * `?`, `#`, `%` or whitespace is refused so a crafted id cannot point a call
 * at another route (`../agents/me/...`) or add a query string. Introduced for
 * `job_id` in X3a and applied to every id a tool interpolates into a path in S6.
 */
export const PATH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Zod schema for an id interpolated into a backend path; `kind` names it in the error ("job", "agent", …). */
export function pathIdSchema(kind: string, description: string) {
  return z
    .string()
    .regex(PATH_ID_PATTERN, `must be a ${kind} id (letters, digits, "_" or "-")`)
    .describe(description);
}
