/**
 * A1 row 9 (concurrency across OS processes): a JSON-RPC proxy that sits between ONE process (the
 * settlement worker, the recovery CLI, or the test's own in-process settle) and Anvil. Test-only.
 *
 * What it gives the test — deterministic barriers, never sleeps:
 *  - `hold({ method })`: the NEXT request of that method (one shot) is parked until `release()`;
 *    `reached` resolves the moment it arrives. The process behind the proxy is then blocked at a
 *    known point of its code (e.g. `eth_estimateGas` = the worker holds the evaluator lane, nothing
 *    signed yet; `eth_feeHistory` after the typed phrase = the CLI is inside its critical section).
 *  - `rewrite(fn)`: change a result on the way back (e.g. a `pending` nonce that lags, R2-P2-3).
 *  - `onSendRaw`: a probe awaited BEFORE an `eth_sendRawTransaction` is forwarded (the test checks
 *    that the ledger row of that hash already exists at the moment of the broadcast).
 *  - a log of every request in one test-wide `Timeline` (monotonic sequence shared with the Redis
 *    MONITOR), so ordering across processes is asserted on one clock.
 *  - `aborted`: a parked request whose client gave up (viem's 10-s HTTP timeout) is recorded; the
 *    test fails on it instead of silently racing a retried request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { keccak256, type Hex } from 'viem';

export interface TimelineEvent {
  seq: number;
  at: number;
  source: string;
  kind: string;
  detail: Record<string, unknown>;
}

/** One ordered log for every observer of a test (proxies, Redis MONITOR, child stdout). */
export class Timeline {
  readonly events: TimelineEvent[] = [];
  private seq = 0;
  push(source: string, kind: string, detail: Record<string, unknown> = {}): TimelineEvent {
    const e = { seq: ++this.seq, at: Date.now(), source, kind, detail };
    this.events.push(e);
    return e;
  }
  find(pred: (e: TimelineEvent) => boolean, fromSeq = 0): TimelineEvent | undefined {
    return this.events.find((e) => e.seq > fromSeq && pred(e));
  }
  filter(pred: (e: TimelineEvent) => boolean, fromSeq = 0): TimelineEvent[] {
    return this.events.filter((e) => e.seq > fromSeq && pred(e));
  }
  get last(): number {
    return this.seq;
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown[];
}

export interface Hold {
  readonly method: string;
  /** Resolves with the timeline event of the parked request. */
  readonly reached: Promise<TimelineEvent>;
  isReached(): boolean;
  release(): void;
}

type Rewriter = (method: string, params: unknown[], result: unknown) => unknown | undefined;

export interface SendRawProbe {
  hash: Hex;
  /** Whatever the probe returned (e.g. "ledger row present"). */
  verdict: unknown;
}

export class RpcBarrierProxy {
  private server: Server | null = null;
  private holds: Array<{ method: string; when?: (params: unknown[]) => boolean; reached: (e: TimelineEvent) => void; released: Promise<void>; hit: boolean }> = [];
  private rewriters = new Set<Rewriter>();
  readonly sendRaws: SendRawProbe[] = [];
  readonly aborted: TimelineEvent[] = [];
  /** Awaited before every eth_sendRawTransaction is forwarded. */
  onSendRaw: ((raw: Hex, hash: Hex) => Promise<unknown>) | null = null;
  url = '';

  constructor(
    readonly name: string,
    private readonly upstream: string,
    private readonly timeline: Timeline,
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.timeline.push(this.name, 'proxy-error', { error: (err as Error)?.message ?? String(err) });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `proxy: ${(err as Error)?.message}` } }));
      });
    });
    this.server.keepAliveTimeout = 1_000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const h of this.holds) h.hit = true;
    this.holds = [];
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Parks the NEXT request of `method` (optionally matching `when`) until `release()`. One shot. */
  hold(method: string, when?: (params: unknown[]) => boolean): Hold {
    let reached!: (e: TimelineEvent) => void;
    let release!: () => void;
    const reachedP = new Promise<TimelineEvent>((r) => (reached = r));
    const released = new Promise<void>((r) => (release = r));
    let isReached = false;
    const entry = { method, ...(when ? { when } : {}), reached: (e: TimelineEvent) => ((isReached = true), reached(e)), released, hit: false };
    this.holds.push(entry);
    return {
      method,
      reached: reachedP,
      isReached: () => isReached,
      release: () => {
        entry.hit = true;
        this.holds = this.holds.filter((h) => h !== entry);
        release();
      },
    };
  }

  /** Adds a result rewriter; returns its remover. */
  rewrite(fn: Rewriter): () => void {
    this.rewriters.add(fn);
    return () => this.rewriters.delete(fn);
  }

  count(method: string, fromSeq = 0): number {
    return this.timeline.filter((e) => e.source === this.name && e.kind === 'request' && e.detail['method'] === method, fromSeq).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
    const calls = Array.isArray(body) ? body : [body];
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    const events = calls.map((c) => this.timeline.push(this.name, 'request', { method: c.method, params: c.params ?? [] }));
    // Barrier: the first armed hold that matches any call of this request parks the whole request.
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const hold = this.holds.find((h) => !h.hit && h.method === call.method && (!h.when || h.when(call.params ?? [])));
      if (hold) {
        hold.hit = true;
        const e = this.timeline.push(this.name, 'held', { method: call.method, requestSeq: events[i]!.seq });
        hold.reached(e);
        await hold.released;
        this.timeline.push(this.name, 'released', { method: call.method });
        if (clientGone) {
          const a = this.timeline.push(this.name, 'client-aborted-while-held', { method: call.method });
          this.aborted.push(a);
          return; // never forward a request its client already gave up on
        }
        break;
      }
    }

    for (const call of calls) {
      if (call.method === 'eth_sendRawTransaction') {
        const rawTx = (call.params?.[0] ?? '0x') as Hex;
        const hash = keccak256(rawTx).toLowerCase() as Hex;
        const verdict = this.onSendRaw ? await this.onSendRaw(rawTx, hash) : null;
        this.sendRaws.push({ hash, verdict });
        this.timeline.push(this.name, 'send-raw', { hash, verdict });
      }
    }

    const upstream = await fetch(this.upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    const text = await upstream.text();
    let out: unknown = JSON.parse(text);
    if (this.rewriters.size > 0) {
      const results = Array.isArray(out) ? (out as Array<{ id: unknown; result?: unknown }>) : [out as { id: unknown; result?: unknown }];
      for (const r of results) {
        const call = calls.find((c) => c.id === r.id);
        if (!call || r.result === undefined) continue;
        for (const fn of this.rewriters) {
          const next = fn(call.method, call.params ?? [], r.result);
          if (next !== undefined) {
            this.timeline.push(this.name, 'rewritten', { method: call.method, from: r.result, to: next });
            r.result = next;
          }
        }
      }
      out = Array.isArray(out) ? results : results[0];
    }
    if (clientGone) {
      this.aborted.push(this.timeline.push(this.name, 'client-aborted', { methods: calls.map((c) => c.method) }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  }
}
