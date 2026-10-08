/**
 * Bounded response reads in `X402ClientService` (task P6, second adversarial
 * review 2026-10-08).
 *
 * The reviewer's proof: the final body was read with `response.text()` before
 * the 64 KiB cap was applied, so any provider could make the backend buffer an
 * unbounded answer (256 MiB streamed in 2.9 s, RSS +774 MB); the 402 body was
 * read whole through a clone as well. Now the final body is read up to
 * `maxBodyBytes` and the transfer aborted beyond it, and a 402 body above
 * `maxPaymentRequiredBytes` is refused before anything is signed.
 *
 * The servers below stream on demand and count what they managed to write, so
 * the tests assert on bytes moved, not on timing alone.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_MAX_BODY_BYTES,
  MAX_PAYMENT_REQUIRED_BYTES,
  PaymentFailedError,
  X402ClientService,
  readBodyLimited,
} from '../services/payments/x402-client.service.js';
import { NETWORK, USDC_BASE_SEPOLIA, accountSigner, isPaidRequest, rejection } from './helpers/x402-fixture.js';

const MiB = 1024 * 1024;

interface StreamStats {
  /** Bytes the server handed to the socket before the client went away. */
  written: number;
  /** True when the connection closed before the full body was sent. */
  abortedEarly: boolean;
}

interface StreamingServerOptions {
  status: number;
  headers?: Record<string, string>;
  /** Total body size the server would send if the client kept reading. */
  total: number;
  chunk?: Buffer;
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

/** HTTP server that streams `total` bytes with backpressure and records how far it got. */
async function streamingServer(options: StreamingServerOptions) {
  const chunk = options.chunk ?? Buffer.alloc(MiB, 0x61);
  const stats: StreamStats = { written: 0, abortedEarly: false };
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(options.status, options.headers ?? { 'content-type': 'text/plain' });
    res.on('close', () => {
      if (!res.writableFinished) stats.abortedEarly = true;
    });
    const pump = () => {
      while (stats.written < options.total) {
        if (res.destroyed) return;
        const piece = chunk.subarray(0, Math.min(chunk.length, options.total - stats.written));
        stats.written += piece.length;
        if (!res.write(piece)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${port}/big`, stats };
}

function signer() {
  return accountSigner(privateKeyToAccount(generatePrivateKey()));
}

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC_BASE_SEPOLIA,
    amount: '400000',
    payTo: '0x00000000000000000000000000000000000000b0',
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  };
}

function paymentRequiredHeader(url: string): string {
  const paymentRequired: PaymentRequired = { x402Version: 2, resource: { url }, accepts: [requirement()] };
  return encodePaymentRequiredHeader(paymentRequired);
}

describe('final response body (P6)', () => {
  it('a free resource streaming 256 MiB is cut at 64 KiB and the transfer is aborted (the reviewer\'s proof)', async () => {
    const total = 256 * MiB;
    const { url, stats } = await streamingServer({ status: 200, total });
    const client = new X402ClientService();
    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();

    const result = await client.payResource({
      signer: signer(),
      url,
      maxAmountUsd: '1',
      allowedNetworks: [NETWORK],
    });

    const elapsed = Date.now() - started;
    const rssDelta = process.memoryUsage().rss - rssBefore;
    expect(result.status).toBe(200);
    expect(result.bodyTruncated).toBe(true);
    expect(result.body.length).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(result.paid).toBe(false);
    // The server could only push what the socket buffers absorbed before the
    // client hung up — nowhere near the 256 MiB it was asked to send.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stats.abortedEarly).toBe(true);
    expect(stats.written).toBeLessThan(32 * MiB);
    expect(rssDelta).toBeLessThan(128 * MiB);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it('a body of exactly the limit is complete (not truncated); one byte more is', async () => {
    const exact = await streamingServer({ status: 200, total: 1024 });
    const client = new X402ClientService({ maxBodyBytes: 1024 });
    const full = await client.payResource({ signer: signer(), url: exact.url, maxAmountUsd: '1', allowedNetworks: [NETWORK] });
    expect(full).toMatchObject({ bodyTruncated: false });
    expect(full.body).toHaveLength(1024);

    const over = await streamingServer({ status: 200, total: 1025 });
    const cut = await client.payResource({ signer: signer(), url: over.url, maxAmountUsd: '1', allowedNetworks: [NETWORK] });
    expect(cut).toMatchObject({ bodyTruncated: true });
    expect(cut.body).toHaveLength(1024);
  });

  it('a cut never ends in half a UTF-8 character', async () => {
    // "€" is 3 bytes; 1024 is not a multiple of 3.
    const { url } = await streamingServer({ status: 200, total: 3 * 4096, chunk: Buffer.from('€'.repeat(4096), 'utf8') });
    const client = new X402ClientService({ maxBodyBytes: 1024 });
    const result = await client.payResource({ signer: signer(), url, maxAmountUsd: '1', allowedNetworks: [NETWORK] });
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).not.toContain('�');
    expect(result.body).toBe('€'.repeat(341));
  });

  it('the paid response body is bounded too: the stream is cancelled after the limit', async () => {
    const url = 'https://paid.example/huge';
    let pulled = 0;
    let cancelled = false;
    const transport: typeof fetch = async (input) => {
      if (!isPaidRequest(input)) {
        return new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(url) } });
      }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x62));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    };
    const client = new X402ClientService({ fetch: transport });

    const result = await client.payResource({ signer: signer(), url, maxAmountUsd: '1', allowedNetworks: [NETWORK] });

    expect(result.payment).toBeDefined();
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toHaveLength(DEFAULT_MAX_BODY_BYTES);
    expect(cancelled).toBe(true);
    // A couple of chunks of read-ahead at most, never an unbounded drain.
    expect(pulled).toBeLessThanOrEqual(DEFAULT_MAX_BODY_BYTES + 4 * 64 * 1024);
  });

  it('readBodyLimited returns an empty body for a response without one', async () => {
    await expect(readBodyLimited(new Response(null, { status: 204 }), 10)).resolves.toEqual({
      bytes: new Uint8Array(0),
      truncated: false,
    });
  });
});

describe('402 body (P6)', () => {
  it('a 402 streaming an endless body is refused before anything is signed, and the transfer aborted', async () => {
    const { url, stats } = await streamingServer({
      status: 402,
      total: 256 * MiB,
      headers: { 'content-type': 'application/json' },
    });
    const s = signer();
    const client = new X402ClientService();

    const error = await rejection(
      client.payResource({ signer: s, url, maxAmountUsd: '1', allowedNetworks: [NETWORK] }),
      PaymentFailedError,
    );

    expect(error.message).toMatch(new RegExp(`402 from .* has a body larger than ${MAX_PAYMENT_REQUIRED_BYTES} bytes`));
    expect(error.details).toMatchObject({ status: 402, stage: 'request', authorizationSent: false, timedOut: false });
    expect(s.signatures).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stats.abortedEarly).toBe(true);
    expect(stats.written).toBeLessThan(32 * MiB);
  }, 30_000);

  it('a 402 declaring a Content-Length above the limit is refused without reading it', async () => {
    const { url, stats } = await streamingServer({
      status: 402,
      total: 256 * MiB,
      headers: { 'content-type': 'application/json', 'content-length': String(256 * MiB) },
    });
    const s = signer();
    const client = new X402ClientService();

    const error = await rejection(
      client.payResource({ signer: s, url, maxAmountUsd: '1', allowedNetworks: [NETWORK] }),
      PaymentFailedError,
    );

    expect(error.details).toMatchObject({ status: 402, authorizationSent: false, maxPaymentRequiredBytes: MAX_PAYMENT_REQUIRED_BYTES });
    expect(s.signatures).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stats.abortedEarly).toBe(true);
    expect(stats.written).toBeLessThan(32 * MiB);
  }, 30_000);

  it('a 402 with a small body still pays (the library is handed a bounded replay of it)', async () => {
    const url = 'https://paid.example/small-body';
    const transport: typeof fetch = async (input) => {
      if (isPaidRequest(input)) return new Response('{"ok":true}', { status: 200 });
      return new Response(JSON.stringify({ note: 'x'.repeat(8 * 1024) }), {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': paymentRequiredHeader(url) },
      });
    };
    const s = signer();
    const client = new X402ClientService({ fetch: transport });

    const result = await client.payResource({ signer: s, url, maxAmountUsd: '1', allowedNetworks: [NETWORK] });

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(s.signatures).toBe(1);
  });
});
