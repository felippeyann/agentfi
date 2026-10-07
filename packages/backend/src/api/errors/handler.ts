/**
 * The backend's Fastify error handler (S5) — the last line for anything a
 * route did not turn into a response itself.
 *
 *  - An unexpected error (no status, or a 5xx) answers
 *    `{ error: 'Internal error', code: 'INTERNAL_ERROR', traceId }` and never
 *    its message; the full error (stack, cause, viem metadata) is logged once
 *    at `error` level with the same `traceId`. Before S5 Fastify's default
 *    handler sent `err.message` — a viem error's message includes the RPC
 *    URL, and the Alchemy URL carries the operator's API key in its path.
 *  - A thrown `ZodError` (routes that call `schema.parse(request.body)`) is a
 *    400 in the shape the routes already use for `safeParse` failures:
 *    `{ error: 'Validation failed', code: 'VALIDATION_FAILED', details }`.
 *    It used to fall through to the default handler as a 500.
 *  - Any other 4xx keeps its status and Fastify's own shape
 *    (`{ statusCode, code, error, message }`, message sanitized): malformed
 *    JSON, unsupported media type, body too large, rate limit, …
 *
 * Routes keep answering their own business errors (`{ error, code, … }`); the
 * fields of those that carry a caught error go through `./sanitize.ts`.
 */
import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isZodLikeError,
  newTraceId,
  sanitizeContextFromEnv,
  sanitizeText,
  sanitizeValue,
} from './sanitize.js';

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
export const INTERNAL_ERROR_MESSAGE = 'Internal error';

export interface InternalErrorBody {
  error: typeof INTERNAL_ERROR_MESSAGE;
  code: typeof INTERNAL_ERROR_CODE;
  traceId: string;
}

/**
 * The status an error asks for: `statusCode` only (Fastify's errors, the rate
 * limiter, SimulationUnavailableError). Unlike Fastify's default handler,
 * `status` is NOT trusted: viem's HttpRequestError uses it for the RPC
 * provider's answer (401 bad key, 429 over quota), which must not become this
 * API's status — an RPC 429 is our 500, not the agent's rate limit.
 */
function explicitStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const { statusCode } = error as { statusCode?: unknown };
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return statusCode;
  }
  return undefined;
}

/** The error's own status, then a 4xx/5xx already set on the reply (as Fastify does), else 500. */
function statusFor(error: unknown, reply: FastifyReply): number {
  return explicitStatus(error) ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
}

export function errorHandler(error: FastifyError | unknown, request: FastifyRequest, reply: FastifyReply) {
  const headers = (error as { headers?: unknown } | null)?.headers;
  if (headers && typeof headers === 'object') reply.headers(headers as Record<string, string>);

  if (isZodLikeError(error)) {
    request.log.info({ err: error }, 'Request validation failed');
    const ctx = sanitizeContextFromEnv();
    return reply
      .code(400)
      .send({ error: 'Validation failed', code: 'VALIDATION_FAILED', details: sanitizeValue(error.issues, ctx) });
  }

  const status = statusFor(error, reply);

  if (status < 500) {
    request.log.info({ err: error, statusCode: status }, 'Request refused');
    const ctx = sanitizeContextFromEnv();
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return reply.code(status).send({
        statusCode: status,
        ...(typeof code === 'string' ? { code } : {}),
        error: STATUS_CODES[status] ?? 'Error',
        message: sanitizeText(error.message, ctx),
      });
    }
    // A thrown plain object (e.g. the rate limiter's errorResponseBuilder) is
    // already a response body.
    return reply.code(status).send(sanitizeValue(error, ctx) ?? { error: STATUS_CODES[status] ?? 'Error' });
  }

  const traceId = newTraceId();
  request.log.error({ err: error, traceId, statusCode: status }, 'Unhandled error');
  const body: InternalErrorBody = { error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE, traceId };
  return reply.code(status).send(body);
}

/**
 * Installs the handler on the root instance. Call it before any route plugin
 * is registered: Fastify captures the error handler of the encapsulation
 * context when a route is added.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler(errorHandler);
}
