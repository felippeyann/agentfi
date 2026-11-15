/**
 * Seller for the x402 fork demo: an x402 v2 resource server with the REAL
 * `@x402/evm` exact facilitator, which verifies the EIP-3009 signature and
 * submits `transferWithAuthorization` to the local fork (Anvil account 1 pays
 * gas). Routes, all $0.30 unless noted:
 *   /report          normal: settles, answers 200 + PAYMENT-RESPONSE
 *   /report-drop     settles on-chain, then destroys the socket (response lost)
 *   /report-hold     verifies the signature, never settles, destroys the socket
 *   /report-big      settles, answers 200 with a 70 KiB body (above the buyer's 64 KiB read limit)
 *   /report-premium  $0.60 (above the demo's per-payment limit)
 * It counts plain (402 probe) and paid requests per path: the demo's proof
 * that nothing was re-sent or re-fetched.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext, type RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { ExactEvmScheme as ExactEvmServerScheme } from '@x402/evm/exact/server';
import { declarePaymentIdentifierExtension, paymentIdentifierResourceServerExtension } from '@x402/extensions/payment-identifier';
import { createWalletClient, http, publicActions, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ANVIL_ACCOUNTS } from './escrow-fork.harness.js';

export const DEMO_NETWORK: Network = 'eip155:84532';
export const HOLD_WINDOW_SECONDS = 20;
export const BIG_BODY_BYTES = 70 * 1024;

export interface SellerCounts {
  plain: Record<string, number>;
  paid: Record<string, number>;
}

class NodeAdapter implements HTTPAdapter {
  private readonly url: URL;
  constructor(private readonly req: IncomingMessage, base: string) {
    this.url = new URL(req.url ?? '/', base);
  }
  getHeader(name: string) {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }
  getMethod() {
    return this.req.method ?? 'GET';
  }
  getPath() {
    return this.url.pathname;
  }
  getUrl() {
    return this.url.toString();
  }
  getAcceptHeader() {
    return this.getHeader('accept') ?? '';
  }
  getUserAgent() {
    return this.getHeader('user-agent') ?? '';
  }
}

export async function startDemoSeller(anvilRpc: string, payTo: Address) {
  const facilitatorAccount = privateKeyToAccount(ANVIL_ACCOUNTS.operator.privateKey);
  const client = createWalletClient({
    account: facilitatorAccount,
    chain: { ...baseSepolia, rpcUrls: { default: { http: [anvilRpc] } } },
    transport: http(anvilRpc),
  }).extend(publicActions);
  const signer = toFacilitatorEvmSigner(
    {
      address: facilitatorAccount.address as `0x${string}`,
      readContract: (args) => client.readContract(args as never),
      verifyTypedData: (args) => client.verifyTypedData(args as never),
      writeContract: (args) => client.writeContract(args as never),
      sendTransaction: (args) => client.sendTransaction(args),
      waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      getCode: (args) => client.getCode(args),
    },
    { confirmationTimeoutMs: 30_000 },
  );
  const facilitator = new x402Facilitator().register(DEMO_NETWORK, new ExactEvmFacilitatorScheme(signer));
  const facilitatorClient: FacilitatorClient = {
    getSupported: async () => facilitator.getSupported() as never,
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };

  const core = new x402ResourceServer(facilitatorClient).registerExtension(paymentIdentifierResourceServerExtension);
  core.register(DEMO_NETWORK, new ExactEvmServerScheme());
  const extensions = { 'payment-identifier': declarePaymentIdentifierExtension(false) };
  const route = (maxTimeoutSeconds: number, price = '$0.30') => ({
    accepts: [{ scheme: 'exact', network: DEMO_NETWORK, price, payTo, maxTimeoutSeconds }],
    extensions,
  });
  const routes: RoutesConfig = {
    'GET /report': route(120),
    'GET /report-drop': route(120),
    'GET /report-hold': route(HOLD_WINDOW_SECONDS),
    'GET /report-big': route(120),
    'GET /report-premium': route(120, '$0.60'),
  };
  const httpServer = new x402HTTPResourceServer(core, routes);
  await httpServer.initialize();

  const counts: SellerCounts = { plain: {}, paid: {} };
  let base = '';

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const adapter = new NodeAdapter(req, base);
    const path = adapter.getPath();
    const paymentHeader = adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment');
    const bucket = paymentHeader ? counts.paid : counts.plain;
    bucket[path] = (bucket[path] ?? 0) + 1;
    const context: HTTPRequestContext = {
      adapter,
      path,
      decodedPath: path,
      method: adapter.getMethod(),
      ...(paymentHeader !== undefined ? { paymentHeader } : {}),
    };
    const result = await httpServer.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      res.writeHead(result.response.status, result.response.headers);
      res.end(JSON.stringify(result.response.body ?? {}));
      return;
    }
    if (result.type === 'no-payment-required') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (path === '/report-hold') {
      req.socket.destroy();
      return;
    }
    const body =
      path === '/report-big'
        ? Buffer.alloc(BIG_BODY_BYTES, 0x61).toString('latin1')
        : JSON.stringify({ report: 'weekly-usage', rows: 3, generatedAt: new Date().toISOString() });
    const settle = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      extensions,
      { request: context, responseBody: Buffer.from(body), responseHeaders: { 'content-type': 'application/json' } },
      undefined,
      result.beforeHandlerSettlement,
    );
    if (!settle.success) {
      res.writeHead(settle.response.status, settle.response.headers);
      res.end(JSON.stringify(settle.response.body ?? {}));
      return;
    }
    if (path === '/report-drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { ...settle.headers, 'content-type': path === '/report-big' ? 'text/plain' : 'application/json' });
    res.end(body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('seller did not bind');
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    counts,
    facilitator: facilitatorAccount.address,
    paid: (path: string) => counts.paid[path] ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * JSON-RPC relay in front of Anvil that the demo can switch off: the
 * reconciliation worker reads its evidence through it, so "down" simulates an
 * unavailable evidence source (503 on every call) without touching the chain.
 */
export async function startRpcRelay(target: string) {
  let up = true;
  let refused = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!up) {
        refused++;
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('evidence source down (demo)');
        return;
      }
      fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        })
        .catch((e: unknown) => {
          res.writeHead(502);
          res.end(String(e));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    setUp: (value: boolean) => {
      up = value;
    },
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
