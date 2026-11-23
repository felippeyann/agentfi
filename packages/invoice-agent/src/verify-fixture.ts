/**
 * `npm run verify:fixture`: the static verification page (verify/) against a LOCAL chain, to try it in a browser.
 * Starts Anvil (31337) and keeps it running, deploys the local test token and an InvoiceMandate vault, has the real
 * agent pay two fictitious invoices through the vault (INV-001 finalized, INV-002 settled but not finalized yet),
 * serves verify/ on 127.0.0.1 (static files, read-only), and prints the page URLs. Ctrl+C stops everything.
 * Touches no public network; uses Anvil's public development keys. Publishing the page is a separate decision.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain } from './chain.js';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from './generated/invoice-mandate.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from './generated/local-test-usd8.js';
import { Ledger } from './ledger.js';
import { InvoicePayer } from './payer.js';
import { vendorKey } from './vault.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_DIR = join(PKG, 'verify');
const ANVIL_PORT = Number(process.env['FIXTURE_ANVIL_PORT'] ?? 8571);
const PAGE_PORT = Number(process.env['FIXTURE_PAGE_PORT'] ?? 8572);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DIR = join(PKG, '.sessions', 'verify-fixture');
const KEYS = { operator: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex, agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex };
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function main() {
  const busy = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true, () => false);
  if (busy) throw new Error(`port ${ANVIL_PORT} already answers; set FIXTURE_ANVIL_PORT`);
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  const anvil = spawn(existsSync(home) ? home : exe, ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  process.on('exit', () => anvil.kill());
  process.on('SIGINT', () => process.exit(0));
  const chain = makeChain({ rpcUrl: RPC, chainId: 31337, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; i < 100 && !(await pub.getChainId().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const op = createWalletClient({ account: privateKeyToAccount(KEYS.operator), chain, transport: http(RPC) });
  const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
  const token = getAddress((await wait(await op.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }))).contractAddress!);
  const vault = getAddress((await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [token] }))).contractAddress!);
  await wait(await op.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [vault, 100_000_000n] }));
  const agentAddr = getAddress(privateKeyToAccount(KEYS.agent).address);
  const now = (await pub.getBlock()).timestamp;
  await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [agentAddr, vendorKey('acme'), VENDOR, 10_000_000, 50_000_000, Number(now + 7n * 86_400n)] }));
  const mandate = { chainId: 31337, token, payer: agentAddr, vendor: { id: 'acme', name: 'Acme Data Ltd', address: VENDOR }, vault, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'fixture', approvedAt: new Date().toISOString() };
  const agent = new InvoicePayer({ ledger: new Ledger(join(DIR, 'ledger.sqlite')), chain: { rpcUrl: RPC, chainId: 31337, token, vault, vaultVendorId: 'acme', confirm: { kind: 'finalized' } }, mandate, payerKey: KEYS.agent, receiptTimeoutMs: 3_000 });
  const inv = (id: string, amount: string) => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' as const });
  await agent.submit(inv('INV-001', '8'));
  await pub.request({ method: 'anvil_mine' as never, params: ['0x50'] as never }); // Anvil: finalized = head − 64
  await agent.submit(inv('INV-002', '3')); // settled, not finalized

  createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^([/\\])+/, '') || 'index.html';
    const file = join(PAGE_DIR, path);
    if (!file.startsWith(PAGE_DIR) || !existsSync(file) || !TYPES[file.slice(file.lastIndexOf('.'))]) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))]!, 'cache-control': 'no-store' }).end(readFileSync(file));
  }).listen(PAGE_PORT, '127.0.0.1');
  const url = (id: string) => `http://127.0.0.1:${PAGE_PORT}/?vault=${vault}&invoice=${id}&rpc=${encodeURIComponent(RPC)}&chain=31337&explorer=`;
  console.log(`LOCAL fixture ready: Anvil ${RPC} (chain 31337), vault ${vault}, local test token ${token}.`);
  console.log(`  INV-001 (finalized): ${url('INV-001')}`);
  console.log(`  INV-002 (settled, not finalized): ${url('INV-002')}`);
  console.log(`  INV-404 (never paid): ${url('INV-404')}`);
  console.log('Ctrl+C stops the chain and the page server.');
  console.log('READY');
  await new Promise(() => undefined);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
