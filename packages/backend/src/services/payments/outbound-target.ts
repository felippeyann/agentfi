/**
 * Outbound target policy for paid resources (security task S4).
 *
 * `POST /v1/jobs/:id/pay-resource` makes the backend fetch a URL chosen by an
 * authenticated provider agent and hands up to 64 KiB of the answer back.
 * Without a target policy that is a server-side request forgery primitive:
 * cloud metadata (169.254.169.254), the Postgres / Redis admin ports, the
 * admin API on loopback — reachable through a public DNS name that resolves
 * to a private address, through a redirect, or through a DNS rebind between
 * the check and the connect.
 *
 * Three controls. The development override (`allowPrivateHosts`) only lifts
 * the range refusal; resolution and pinning always run.
 *
 *   1. Resolve before you connect — `assertPublicTarget`: refuse a port the
 *      port policy does not allow (P6: production / staging default 80 and
 *      443 only, `RESOURCE_PAYMENT_ALLOWED_PORTS` overrides; development and
 *      test unrestricted), refuse a literal private / loopback / link-local /
 *      unique-local / unspecified / IPv4-mapped host, then resolve the
 *      hostname (every address, verbatim order) and refuse when ANY address
 *      falls in those ranges.
 *   2. Pin what you validated — `createPinnedDispatcher`: an undici `Agent`
 *      whose connect-time `lookup` answers only the validated addresses, so a
 *      rebind between check and connect cannot move the socket. The URL is
 *      untouched, so the `Host` header and the TLS SNI still carry the
 *      hostname and certificate validation is unchanged.
 *   3. No redirects — enforced by the caller (`redirect: 'manual'` and a 3xx
 *      refusal), because following one would re-open the hole at a new origin
 *      and re-send the signed payment header there.
 *
 * Ranges refused (`isPrivateAddress`):
 *   IPv4  0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24
 *         (IETF protocol assignments), 192.168/16, 198.18/15 (benchmarking),
 *         and everything from 224/4 up (multicast, reserved, broadcast).
 *   IPv6  ::/96 (unspecified, loopback ::1, deprecated IPv4-compatible),
 *         ::ffff:0:0:0/96 (SIIT IPv4-translated), 64:ff9b:1::/48 (local-use
 *         NAT64), fc00::/7 unique-local, fe80::/10 link-local, fec0::/10
 *         site-local, ff00::/8 multicast; ::ffff:0:0/96 (IPv4-mapped),
 *         64:ff9b::/96 (NAT64) and 2002::/16 (6to4) are judged by their
 *         embedded IPv4.
 * Anything that does not parse as an address is refused too.
 *
 * What the agent learns (P6): a DNS name that does not resolve and one that
 * resolves to a refused address get the SAME public refusal
 * (`no-public-address`, `publicRefusal`), so pay-resource cannot be used to
 * probe which internal names exist; the precise reason stays in the log.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolver surface, injectable for tests. Defaults to `dns.promises.lookup(hostname, { all: true, verbatim: true })`. */
export type TargetLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface OutboundTargetPolicy {
  /**
   * Lift the private-range refusal (development / test only — boot refuses it
   * in production and staging). The hostname is still resolved and the
   * connection still pinned to what was resolved.
   */
  allowPrivateHosts?: boolean;
  /**
   * Ports a URL may name (the scheme default when it names none). `'any'` or
   * omitted = unrestricted. See `resolveAllowedPorts` for the env defaults.
   */
  allowedPorts?: readonly number[] | 'any';
  lookup?: TargetLookup;
}

export interface ValidatedTarget {
  /** Lower-cased hostname as the URL names it, IPv6 brackets stripped. */
  hostname: string;
  /** Every address the hostname resolved to; the connection may only use these. */
  addresses: ResolvedAddress[];
}

export type OutboundTargetRefusal =
  /** The URL names a port the port policy does not allow. */
  | 'port-not-allowed'
  /** The hostname itself is a loopback name or a private / reserved address literal. */
  | 'private-host'
  /** At least one address the hostname resolves to is private / reserved. */
  | 'private-address'
  /** The hostname resolves to nothing. */
  | 'unresolvable'
  /** The resolver failed for another reason (transient DNS error). */
  | 'resolver-failed';

/**
 * What a caller is told. `private-address` and `unresolvable` collapse into
 * `no-public-address` (P6): telling them apart would let an agent learn which
 * internal names exist. `private-host` and `port-not-allowed` only restate
 * the agent's own input. `resolver-failed` is not a refusal (transient).
 */
export type PublicTargetRefusal = 'port-not-allowed' | 'private-host' | 'no-public-address';

export class OutboundTargetError extends Error {
  readonly refusal: OutboundTargetRefusal;
  readonly hostname: string;
  /** The offending address, for `private-address`. Logged only — never sent to the caller (S5). */
  readonly address: string | undefined;
  /** The port that was refused, for `port-not-allowed`. */
  readonly port: number | undefined;

  constructor(
    refusal: OutboundTargetRefusal,
    hostname: string,
    message: string,
    extra: { address?: string; port?: number } = {},
  ) {
    super(message);
    this.name = 'OutboundTargetError';
    this.refusal = refusal;
    this.hostname = hostname;
    this.address = extra.address;
    this.port = extra.port;
  }
}

/** The refusal and message a caller may see for `error` (see `PublicTargetRefusal`). */
export function publicRefusal(error: OutboundTargetError): { refusal: PublicTargetRefusal; message: string } {
  if (error.refusal === 'port-not-allowed' || error.refusal === 'private-host') {
    return { refusal: error.refusal, message: error.message };
  }
  return {
    refusal: 'no-public-address',
    message: `url hostname does not resolve to a public address (${error.hostname})`,
  };
}

// ── Port policy ─────────────────────────────────────────────────────────────

/** Ports a production-like deployment allows when `RESOURCE_PAYMENT_ALLOWED_PORTS` is unset. */
export const PRODUCTION_DEFAULT_PORTS: readonly number[] = [80, 443];

/** `"80, 443,8443"` → `[80, 443, 8443]`; throws on anything that is not a list of ports 1-65535. */
export function parsePortList(raw: string): number[] {
  const ports = raw.split(',').map((part) => part.trim());
  if (ports.length === 0 || ports.some((part) => !/^\d{1,5}$/.test(part))) {
    throw new Error(`port list must be comma-separated port numbers, e.g. "80,443"; got ${JSON.stringify(raw)}`);
  }
  const numbers = ports.map(Number);
  if (numbers.some((port) => port < 1 || port > 65535)) {
    throw new Error(`ports must be between 1 and 65535; got ${JSON.stringify(raw)}`);
  }
  return [...new Set(numbers)];
}

/**
 * Port policy from the environment: an explicit `RESOURCE_PAYMENT_ALLOWED_PORTS`
 * list applies everywhere; without one, production and staging allow 80 and
 * 443 only and development / test are unrestricted (local resource servers
 * listen on arbitrary ports).
 */
export function resolveAllowedPorts(nodeEnv: string, raw: string | undefined): readonly number[] | 'any' {
  if (raw !== undefined && raw.trim() !== '') return parsePortList(raw);
  return nodeEnv === 'production' || nodeEnv === 'staging' ? PRODUCTION_DEFAULT_PORTS : 'any';
}

/** The port a request to `url` connects to: the explicit one, or the scheme default. */
export function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

// ── Address classification ──────────────────────────────────────────────────

function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Expands an IPv6 address (optionally with an embedded dotted IPv4 tail or a `%zone`) into its eight 16-bit groups. */
function parseIpv6(ip: string): number[] | undefined {
  const zone = ip.indexOf('%');
  let text = zone === -1 ? ip : ip.slice(0, zone);
  if (isIP(text) !== 6) return undefined;

  // Embedded IPv4 tail (`::ffff:10.0.0.1`) → two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return undefined;
    const [a, b, c, d] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return undefined;
  }
  return groups;
}

/** Dotted IPv4 from two 16-bit groups. */
function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** The IPv4 in the low 32 bits (mapped, translated, NAT64 forms). */
function embeddedIpv4(groups: number[]): string {
  const [hi = 0, lo = 0] = groups.slice(6);
  return ipv4FromGroups(hi, lo);
}

function isPrivateIpv6(ip: string): boolean {
  const groups = parseIpv6(ip);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const zeroTo3 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  const leadingZero = zeroTo3 && g4 === 0;
  // ::/96 — :: (unspecified), ::1 (loopback) and the deprecated
  // IPv4-compatible form; none of them is a public destination.
  if (leadingZero && g5 === 0) return true;
  // ::ffff:0:0/96 — IPv4-mapped: judge the embedded IPv4.
  if (leadingZero && g5 === 0xffff) return isPrivateIpv4(embeddedIpv4(groups));
  // ::ffff:0:0:0/96 — SIIT IPv4-translated (RFC 2765): only meaningful
  // behind a stateless translator, never a public destination.
  if (zeroTo3 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b::/96 — NAT64 well-known prefix: judge the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(embeddedIpv4(groups));
  }
  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215): translates into whatever
  // IPv4 the local network chooses, internal ranges included.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0x0001) return true;
  // 2002::/16 — 6to4: the relay delivers to the IPv4 in bits 16-47.
  if (g0 === 0x2002) return isPrivateIpv4(ipv4FromGroups(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True for any address the backend must never connect to on behalf of an
 * agent: loopback, private, link-local, unique-local, unspecified, mapped /
 * translated IPv4 in those ranges, multicast and reserved space. Anything that
 * is not an IP address at all is also "private" — it cannot be connected to.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

/** `[::1]` → `::1`, `Example.COM.` → `example.com`. */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/**
 * Literal check only: `localhost` names and address literals in a refused
 * range. A DNS name passes here and is judged by what it resolves to in
 * `assertPublicTarget`.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) !== 0) return isPrivateAddress(host);
  return false;
}

// ── Resolve before you connect ──────────────────────────────────────────────

const defaultLookup: TargetLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Resolver answers meaning "this name has no address" (as opposed to a transient failure such as `EAI_AGAIN`). */
const NXDOMAIN_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'EBADNAME']);

/**
 * Validates where a request to `url` would actually go and returns the
 * addresses the connection may use. Throws `OutboundTargetError`.
 */
export async function assertPublicTarget(url: URL, policy: OutboundTargetPolicy = {}): Promise<ValidatedTarget> {
  const hostname = normalizeHostname(url.hostname);
  const allowPrivate = policy.allowPrivateHosts === true;

  const allowedPorts = policy.allowedPorts ?? 'any';
  if (allowedPorts !== 'any') {
    const port = effectivePort(url);
    if (!allowedPorts.includes(port)) {
      throw new OutboundTargetError(
        'port-not-allowed',
        hostname,
        `url port ${port} is not allowed for paid resources (allowed: ${allowedPorts.join(', ')})`,
        { port },
      );
    }
  }

  if (!allowPrivate && isPrivateHost(hostname)) {
    throw new OutboundTargetError(
      'private-host',
      hostname,
      `url must not point at a private, loopback, link-local or reserved host (${hostname})`,
    );
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await (policy.lookup ?? defaultLookup)(hostname);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && NXDOMAIN_CODES.has(code)) {
      throw new OutboundTargetError('unresolvable', hostname, `url hostname does not resolve (${hostname}: ${code})`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new OutboundTargetError('resolver-failed', hostname, `url hostname could not be resolved (${hostname}): ${reason}`);
  }

  const addresses: ResolvedAddress[] = [];
  for (const entry of resolved) {
    const family = isIP(entry.address);
    if (family === 4 || family === 6) addresses.push({ address: entry.address, family });
  }
  if (addresses.length === 0) {
    throw new OutboundTargetError('unresolvable', hostname, `url hostname does not resolve to any address (${hostname})`);
  }

  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        // The message goes back to the agent, so it names the hostname (the
        // agent's input) but not the address it resolved to (S5) — that would
        // let an agent map internal DNS names. `address` is for the log.
        throw new OutboundTargetError(
          'private-address',
          hostname,
          `url hostname resolves to a private, loopback, link-local or reserved address (${hostname})`,
          { address },
        );
      }
    }
  }

  return { hostname, addresses };
}

// ── Pin what you validated ──────────────────────────────────────────────────

/**
 * A `net.connect`-style `lookup` that answers only the addresses validated
 * for `target.hostname` and refuses every other name. Handles both the
 * `{ all: true }` form Node uses for happy-eyeballs connects and the single-
 * address form, plus an explicit `family` filter.
 */
export function pinnedLookup(target: ValidatedTarget): LookupFunction {
  return (hostname, options, callback) => {
    const name = normalizeHostname(hostname);
    if (name !== target.hostname) {
      callback(
        new Error(`refusing to connect to ${name}: only ${target.hostname} was validated for this request`),
        [],
      );
      return;
    }
    const family = options.family === 4 || options.family === 6 ? options.family : undefined;
    const candidates = family ? target.addresses.filter((entry) => entry.family === family) : target.addresses;
    const first = candidates[0];
    if (!first) {
      callback(new Error(`no validated IPv${family ?? '4/6'} address for ${target.hostname}`), []);
      return;
    }
    if (options.all) {
      callback(
        null,
        candidates.map(({ address, family: addressFamily }) => ({ address, family: addressFamily })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

/**
 * A per-request undici `Agent` that can only ever connect to the validated
 * addresses. Pass it as `dispatcher` in the request init and `destroy()` it
 * once the exchange is over.
 */
export function createPinnedDispatcher(target: ValidatedTarget): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(target) } });
}
