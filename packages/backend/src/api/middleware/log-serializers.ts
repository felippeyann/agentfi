/**
 * Request log serializer (S6): Fastify logs `req.url` on every request, query
 * string included. `GET /mcp/sse?apiKey=agfi_live_…` used to put agent keys
 * in the access log (the route now refuses query-string keys, and this
 * serializer is the second layer for any other credential-like parameter).
 */

/** Query parameter names whose values never reach a log line. */
const SENSITIVE_QUERY_PARAM = /(api[-_]?key|secret|token|password|passwd|auth|signature|credential|^key$|^sig$)/i;

/** `url` with the values of sensitive query parameters replaced by `[redacted]`. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const path = url.slice(0, q);
  const query = url.slice(q + 1);
  const hashAt = query.indexOf('#');
  const params = hashAt >= 0 ? query.slice(0, hashAt) : query;
  const redacted = params
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // keep the raw name
      }
      return SENSITIVE_QUERY_PARAM.test(name) ? `${rawName}=[redacted]` : pair;
    })
    .join('&');
  return `${path}?${redacted}`;
}

interface SerializableSocket {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
}

interface SerializableRequest {
  method?: string | undefined;
  url?: string | undefined;
  hostname?: string | undefined;
  host?: string | undefined;
  ip?: string | undefined;
  socket?: SerializableSocket | null | undefined;
  raw?: { socket?: SerializableSocket | null | undefined } | undefined;
}

export interface SerializedRequest {
  [key: string]: unknown;
  method?: string;
  url?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
}

/** Fastify's default `req` log fields, with the URL query redacted. */
export function requestSerializer(request: SerializableRequest): SerializedRequest {
  const socket = request.socket ?? request.raw?.socket ?? undefined;
  const out: SerializedRequest = {};
  if (request.method !== undefined) out.method = request.method;
  const url = redactUrl(request.url);
  if (url !== undefined) out.url = url;
  const host = request.host ?? request.hostname;
  if (host !== undefined) out.host = host;
  const remoteAddress = request.ip ?? socket?.remoteAddress;
  if (remoteAddress !== undefined) out.remoteAddress = remoteAddress;
  if (socket?.remotePort !== undefined) out.remotePort = socket.remotePort;
  return out;
}
