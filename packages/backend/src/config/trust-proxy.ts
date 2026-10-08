/**
 * `TRUST_PROXY` → Fastify's `trustProxy` option (S6). Pure; no env import.
 *
 * Default `false`: `request.ip` is the TCP peer and `X-Forwarded-For` is
 * ignored. Behind a reverse proxy / PaaS edge, set the number of proxy hops
 * (`1` on Railway / Fly / Render) or the proxies' addresses / CIDRs, so the
 * per-IP rate limits (public registration, /health/ready) see the client.
 * `true` trusts every hop: the left-most `X-Forwarded-For` entry — which the
 * client chooses — becomes `request.ip`; accepted, but warned about at boot in
 * production / staging.
 *
 * Whatever the setting, the admin loopback gate (`api/routes/admin.ts`) never
 * relies on `request.ip`: it requires the TCP peer AND every forwarded hop to
 * be loopback.
 */

import { isIP } from 'node:net';

export type TrustProxySetting = boolean | number | string[];

const CIDR = /^(.+)\/(\d{1,3})$/;

function isAddressOrCidr(entry: string): boolean {
  const cidr = entry.match(CIDR);
  if (!cidr) return isIP(entry) !== 0;
  const family = isIP(cidr[1]!);
  const bits = Number(cidr[2]);
  return (family === 4 && bits <= 32) || (family === 6 && bits <= 128);
}

/**
 * Parses `TRUST_PROXY`: `false` / unset / blank, `true`, a hop count (1-10),
 * or a comma-separated list of IP addresses / CIDRs. Returns an error string
 * for anything else.
 */
export function parseTrustProxy(raw: string | undefined): { value: TrustProxySetting } | { error: string } {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return { value: false };
  if (value === 'true') return { value: true };
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops >= 1 && hops <= 10) return { value: hops };
    return { error: 'TRUST_PROXY hop count must be between 1 and 10 (or false)' };
  }
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 0 && entries.every(isAddressOrCidr)) return { value: entries };
  return {
    error: 'TRUST_PROXY must be false, true, a hop count (1-10) or a comma-separated list of IP addresses / CIDRs',
  };
}
