/**
 * Unit + socket-level tests — `services/payments/outbound-target.ts` (S4).
 *
 * Address classification and the resolve-then-refuse policy are pure (the
 * resolver is injected). The pinning tests open real sockets: a loopback
 * HTTP server, an undici `Agent` from `createPinnedDispatcher`, and undici's
 * own `fetch` — the same package copy, which is what the x402 client's
 * default transport uses — for hostnames under `.test`, which never resolve
 * (RFC 6761). A response therefore proves the connection went to the
 * validated address through the pinned lookup, not the system resolver.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundTargetError,
  assertPublicTarget,
  createPinnedDispatcher,
  isPrivateAddress,
  isPrivateHost,
  pinnedLookup,
  type TargetLookup,
  type ValidatedTarget,
} from '../services/payments/outbound-target.js';
import { undiciTransport } from '../services/payments/x402-client.service.js';

async function refusal(promise: Promise<unknown>): Promise<OutboundTargetError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OutboundTargetError) return error;
    throw error;
  }
  throw new Error('expected an OutboundTargetError, but the promise resolved');
}

function resolvesTo(...addresses: Array<[string, number]>) {
  return vi.fn<Parameters<TargetLookup>, ReturnType<TargetLookup>>(async () =>
    addresses.map(([address, family]) => ({ address, family })),
  );
}

describe('isPrivateAddress', () => {
  it.each([
    // IPv4 range boundaries
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['126.255.255.255', false],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['128.0.0.0', false],
    ['169.253.255.255', false],
    ['169.254.0.0', true],
    ['169.254.169.254', true],
    ['169.255.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['192.169.0.0', false],
    ['223.255.255.255', false],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    // IPv6
    ['::', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::127.0.0.1', true],
    ['::8.8.8.8', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:a9fe:a9fe', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
    ['64:ff9b::10.0.0.1', true],
    ['64:ff9b::a00:1', true],
    ['64:ff9b::8.8.8.8', false],
    ['fbff:ffff::1', false],
    ['fc00::', true],
    ['fd12:3456::1', true],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fe7f:ffff::1', false],
    ['fe80::', true],
    ['fe80::1%eth0', true],
    ['febf:ffff::1', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['2001:4860:4860::8888', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it.each(['', 'not-an-ip', '1.2.3', '256.1.1.1', '1.2.3.4.5', '::g', ':::1', 'example.com', '[::1]'])(
    'treats malformed input %j as private (refused)',
    (input) => {
      expect(isPrivateAddress(input)).toBe(true);
    },
  );
});

describe('isPrivateHost (literal check only)', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['localhost.', true],
    ['api.localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['[::ffff:7f00:1]', true],
    ['[64:ff9b::a00:1]', true],
    ['8.8.8.8', false],
    ['[2001:4860:4860::8888]', false],
    // DNS names pass the literal check; their resolved addresses are judged later.
    ['example.com', false],
    ['localhost.example.com', false],
  ])('%s → %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe('assertPublicTarget', () => {
  it('refuses a private literal without resolving it', async () => {
    const lookup = resolvesTo(['93.184.216.34', 4]);
    const error = await refusal(assertPublicTarget(new URL('http://169.254.169.254/latest/'), { lookup }));
    expect(error).toMatchObject({ refusal: 'private-host', hostname: '169.254.169.254' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses when ANY resolved address is private, naming it', async () => {
    const lookup = resolvesTo(['93.184.216.34', 4], ['2606:4700:4700::1111', 6], ['10.1.2.3', 4]);
    const error = await refusal(assertPublicTarget(new URL('https://Mixed.Example.com/x'), { lookup }));
    expect(error).toMatchObject({ refusal: 'private-address', hostname: 'mixed.example.com', address: '10.1.2.3' });
    expect(lookup).toHaveBeenCalledWith('mixed.example.com');
  });

  it('returns every resolved address for a public name, in resolver order', async () => {
    const lookup = resolvesTo(['2606:4700:4700::1111', 6], ['93.184.216.34', 4]);
    await expect(assertPublicTarget(new URL('https://api.example.com/'), { lookup })).resolves.toEqual({
      hostname: 'api.example.com',
      addresses: [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ],
    });
  });

  it('a public IP literal is "resolved" to itself and passes', async () => {
    const lookup = resolvesTo(['8.8.8.8', 4]);
    await expect(assertPublicTarget(new URL('http://8.8.8.8/'), { lookup })).resolves.toEqual({
      hostname: '8.8.8.8',
      addresses: [{ address: '8.8.8.8', family: 4 }],
    });
  });

  it('classifies resolver failures: no such name → unresolvable, anything else → resolver-failed', async () => {
    const failing = (code: string): TargetLookup => async () => {
      throw Object.assign(new Error(`getaddrinfo ${code} x`), { code });
    };
    for (const code of ['ENOTFOUND', 'ENODATA', 'EBADNAME']) {
      const error = await refusal(assertPublicTarget(new URL('https://x.example/'), { lookup: failing(code) }));
      expect(error.refusal).toBe('unresolvable');
    }
    for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT']) {
      const error = await refusal(assertPublicTarget(new URL('https://x.example/'), { lookup: failing(code) }));
      expect(error.refusal).toBe('resolver-failed');
    }
  });

  it('an empty or non-IP answer is unresolvable', async () => {
    for (const lookup of [resolvesTo(), resolvesTo(['not-an-ip', 4])]) {
      const error = await refusal(assertPublicTarget(new URL('https://x.example/'), { lookup }));
      expect(error.refusal).toBe('unresolvable');
    }
  });

  it('allowPrivateHosts lifts the range refusal but still resolves (so the connection can be pinned)', async () => {
    const lookup = resolvesTo(['127.0.0.1', 4]);
    await expect(
      assertPublicTarget(new URL('http://127.0.0.1:8080/'), { allowPrivateHosts: true, lookup }),
    ).resolves.toEqual({ hostname: '127.0.0.1', addresses: [{ address: '127.0.0.1', family: 4 }] });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('the default resolver (all addresses, verbatim) resolves localhost when the override is on', async () => {
    const target = await assertPublicTarget(new URL('http://localhost:1/'), { allowPrivateHosts: true });
    expect(target.hostname).toBe('localhost');
    expect(target.addresses.length).toBeGreaterThan(0);
    for (const { address } of target.addresses) expect(isPrivateAddress(address)).toBe(true);
  });
});

describe('pinnedLookup', () => {
  const target: ValidatedTarget = {
    hostname: 'pinned.agentfi.test',
    addresses: [
      { address: '2001:db8::1', family: 6 },
      { address: '192.0.2.1', family: 4 },
    ],
  };

  function call(hostname: string, options: { all?: boolean; family?: number }) {
    return new Promise<{ error: Error | null; result: unknown; family?: number }>((resolve) => {
      pinnedLookup(target)(hostname, options as never, ((error: Error | null, result: unknown, family?: number) =>
        resolve({ error, result, ...(family !== undefined ? { family } : {}) })) as never);
    });
  }

  it('refuses any hostname other than the validated one', async () => {
    const { error } = await call('other.agentfi.test', { all: true });
    expect(error?.message).toMatch(/refusing to connect to other\.agentfi\.test: only pinned\.agentfi\.test was validated/);
  });

  it('answers every validated address for { all: true } (happy-eyeballs connects)', async () => {
    const { error, result } = await call('PINNED.agentfi.test', { all: true });
    expect(error).toBeNull();
    expect(result).toEqual([
      { address: '2001:db8::1', family: 6 },
      { address: '192.0.2.1', family: 4 },
    ]);
  });

  it('answers the first validated address in the single-address form, honouring a family filter', async () => {
    expect(await call('pinned.agentfi.test', {})).toEqual({ error: null, result: '2001:db8::1', family: 6 });
    expect(await call('pinned.agentfi.test', { family: 4 })).toEqual({ error: null, result: '192.0.2.1', family: 4 });
  });

  it('fails when the requested family has no validated address', async () => {
    const v4only: ValidatedTarget = { hostname: 'v4.agentfi.test', addresses: [{ address: '192.0.2.1', family: 4 }] };
    const error = await new Promise<Error | null>((resolve) => {
      pinnedLookup(v4only)('v4.agentfi.test', { family: 6 } as never, ((err: Error | null) => resolve(err)) as never);
    });
    expect(error?.message).toMatch(/no validated IPv6 address/);
  });
});

describe('createPinnedDispatcher (real sockets)', () => {
  const cleanup: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  async function startServer() {
    const seen: Array<{ host: string | undefined; path: string | undefined }> = [];
    let connections = 0;
    const server: Server = createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    server.on('connection', () => {
      connections++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { port, seen, connections: () => connections };
  }

  function pinned(hostname: string) {
    const dispatcher = createPinnedDispatcher({ hostname, addresses: [{ address: '127.0.0.1', family: 4 }] });
    cleanup.push(() => dispatcher.destroy());
    return dispatcher;
  }

  it('sends a real request to the validated address; the Host header keeps the hostname', async () => {
    const server = await startServer();
    const dispatcher = pinned('pinned.agentfi.test');

    const response = await undiciFetch(`http://pinned.agentfi.test:${server.port}/resource`, { dispatcher });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, host: `pinned.agentfi.test:${server.port}` });
    expect(server.seen).toEqual([{ host: `pinned.agentfi.test:${server.port}`, path: '/resource' }]);
  });

  it('works through the x402 default transport (global Request in, pinned undici Agent underneath)', async () => {
    const server = await startServer();
    const dispatcher = pinned('pinned.agentfi.test');
    const request = new Request(`http://pinned.agentfi.test:${server.port}/via-transport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-probe': '1' },
      body: JSON.stringify({ q: 1 }),
      redirect: 'manual',
    });

    const response = await undiciTransport(request, { dispatcher } as RequestInit);

    expect(response.status).toBe(200);
    expect(server.seen).toEqual([{ host: `pinned.agentfi.test:${server.port}`, path: '/via-transport' }]);
  });

  it('refuses to connect for any hostname other than the validated one — no socket is opened', async () => {
    const server = await startServer();
    const dispatcher = pinned('pinned.agentfi.test');

    const error = await undiciFetch(`http://other.agentfi.test:${server.port}/resource`, { dispatcher }).then(
      () => undefined,
      (err: unknown) => err as Error & { cause?: Error },
    );

    expect(error).toBeDefined();
    expect(error?.cause?.message).toMatch(/refusing to connect to other\.agentfi\.test/);
    expect(server.seen).toHaveLength(0);
    expect(server.connections()).toBe(0);
  });
});
