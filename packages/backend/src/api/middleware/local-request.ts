/**
 * "Is this request really from this machine?" — the admin loopback gate (S6).
 *
 * `request.ip` is NOT used: with Fastify `trustProxy` on (TRUST_PROXY), it is
 * derived from `X-Forwarded-For`, whose left-most entry the client chooses —
 * `X-Forwarded-For: 127.0.0.1` would pass a gate based on it. Instead a
 * request is local only when
 *   1. the TCP peer (`socket.remoteAddress`) is loopback, AND
 *   2. every address any forwarding header names is loopback too.
 * A spoofed header can only ADD addresses, so it can make a request look
 * remote, never local; and a same-host reverse proxy that forwards a remote
 * client (loopback peer + the client in `X-Forwarded-For`) is refused instead
 * of being mistaken for the operator.
 */

import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/** Headers proxies use to name the original client. */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-client-ip',
  'x-cluster-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'fastly-client-ip',
] as const;

export function isLoopbackAddress(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const ip = raw.trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  if (ip === '::1') return true;
  if (isIP(ip) === 4) return ip.split('.')[0] === '127';
  return false;
}

/** Strips a port and IPv6 brackets / quotes from one forwarded address token. */
function addressOf(token: string): string {
  let value = token.trim().replace(/^"|"$/g, '');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  // IPv4 with a port (1.2.3.4:5678); a bare IPv6 address has several colons.
  if ((value.match(/:/g) ?? []).length === 1) value = value.split(':')[0]!;
  return value;
}

/** Every address named by the forwarding headers (unparseable tokens are returned as-is and count as remote). */
export function forwardedAddresses(headers: IncomingHttpHeaders): string[] {
  const addresses: string[] = [];
  for (const name of FORWARDING_HEADERS) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (name === 'forwarded') {
        // RFC 7239: `for=192.0.2.60;proto=http, for="[2001:db8::1]:4711"`
        for (const match of value.matchAll(/for=("[^"]*"|[^;,\s]+)/gi)) addresses.push(addressOf(match[1]!));
        if (!/for=/i.test(value) && value.trim()) addresses.push(value.trim());
      } else {
        for (const part of value.split(',')) if (part.trim()) addresses.push(addressOf(part));
      }
    }
  }
  return addresses;
}

export interface LocalRequestLike {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string | undefined } | null;
  raw?: { socket?: { remoteAddress?: string | undefined } | null };
}

/** True only for a request whose TCP peer and every forwarded hop are loopback. */
export function isLocalOnlyRequest(request: LocalRequestLike): boolean {
  const peer = request.socket?.remoteAddress ?? request.raw?.socket?.remoteAddress;
  if (!isLoopbackAddress(peer)) return false;
  return forwardedAddresses(request.headers).every((address) => isLoopbackAddress(address));
}
