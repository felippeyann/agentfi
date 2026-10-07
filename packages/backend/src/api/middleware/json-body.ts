import type { FastifyInstance } from 'fastify';

/** The Stripe webhook verifies its signature over the raw bytes. */
export const RAW_BODY_ROUTES: ReadonlySet<string> = new Set(['/v1/billing/webhook']);

/**
 * JSON body parser. Stripe's webhook needs the raw request body for signature
 * verification, so `/v1/billing/webhook` keeps the Buffer; every other route
 * gets parsed JSON. Register it BEFORE any other plugin so Fastify does not
 * JSON-parse the webhook payload.
 *
 * A malformed body is a 400 (S5), as with Fastify's built-in JSON parser:
 * the parse error carries `statusCode: 400`, so the error handler answers it
 * as a client error instead of the unexplained 500 a bare `SyntaxError` used
 * to become.
 */
export function registerJsonBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const url = req.routeOptions?.url;
    if (url !== undefined && RAW_BODY_ROUTES.has(url)) {
      // Keep as Buffer — passed directly to stripe.webhooks.constructEvent
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(body.toString()));
    } catch (err) {
      const parseError = (err instanceof Error ? err : new SyntaxError(String(err))) as Error & { statusCode?: number };
      parseError.statusCode = 400;
      done(parseError, undefined);
    }
  });
}
