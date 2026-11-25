/**
 * `npm run mcp:fixture`: a LOCAL, synthetic world to ask Claude "was invoice INV-001 paid?".
 * Starts Anvil (31337) and keeps it running, deploys the local test token, and has the real agent code
 * pay two fictitious invoices under the rule depth:3: INV-001 (confirmed) and INV-002 (in a block, not
 * confirmed yet). INV-003 is refused. Writes `.sessions/mcp-fixture/mcp.json`, a Claude Code MCP config
 * for the read-only server (`src/mcp.ts`), and prints how to use it. Ctrl+C stops Anvil: ask again
 * and the answer must be "cannot verify now". Touches no public network; uses Anvil's public keys.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeChain } from './chain.js';
import { LOCAL_TEST_USD8_ABI, LOCAL_TEST_USD8_BYTECODE } from './generated/local-test-usd8.js';
import { Ledger } from './ledger.js';
import { saveMandate } from './mandate.js';
import { InvoicePayer } from './payer.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['FIXTURE_ANVIL_PORT'] ?? 8569);
const RPC = `http://127.0.0.1:${PORT}`;
const DIR = join(PKG, '.sessions', 'mcp-fixture');
const KEYS = { deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex, payer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex };
const VENDOR = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

async function main() {
  const busy = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then(() => true, () => false);
  if (busy) throw new Error(`port ${PORT} already answers; set FIXTURE_ANVIL_PORT`);
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe);
  const anvil = spawn(existsSync(home) ? home : exe, ['--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  process.on('exit', () => anvil.kill());
  process.on('SIGINT', () => process.exit(0));
  const chain = makeChain({ rpcUrl: RPC, chainId: 31337, token: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; i < 100 && !(await pub.getChainId().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const deployer = createWalletClient({ account: privateKeyToAccount(KEYS.deployer), chain, transport: http(RPC) });
  const token = getAddress((await pub.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi: LOCAL_TEST_USD8_ABI, bytecode: LOCAL_TEST_USD8_BYTECODE }) })).contractAddress!);
  const payer = getAddress(privateKeyToAccount(KEYS.payer).address);
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: token, abi: LOCAL_TEST_USD8_ABI, functionName: 'mint', args: [payer, 100_000_000n] }) });
  const ledgerPath = join(DIR, 'ledger.sqlite');
  const mandatePath = join(DIR, 'mandate.json');
  const mandate = { chainId: 31337, token, payer, vendor: { id: 'acme', name: 'Acme Data Ltd', address: VENDOR }, maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'fixture', approvedAt: new Date().toISOString() };
  saveMandate(mandatePath, mandate);
  const agent = new InvoicePayer({ ledger: new Ledger(ledgerPath), chain: { rpcUrl: RPC, chainId: 31337, token, confirm: { kind: 'depth', blocks: 3 } }, mandate, payerKey: KEYS.payer, receiptTimeoutMs: 3_000 });
  const inv = (id: string, amount: string) => ({ id, vendorId: 'acme', payTo: VENDOR, amount, currency: 'tUSD8' as const, description: `fictitious invoice ${id}` });
  await agent.submit(inv('INV-001', '8'));
  await pub.request({ method: 'anvil_mine' as never, params: ['0x3'] as never });
  await agent.submit(inv('INV-001', '8')); // confirmed now
  await agent.submit(inv('INV-002', '3')); // in a block, 1 of 3 confirmations
  await agent.submit(inv('INV-003', '12')); // refused: above 10 per invoice
  const config = {
    mcpServers: {
      invoice: {
        command: process.execPath,
        // Absolute loader path: works whatever directory Claude Code is started from.
        args: ['--import', import.meta.resolve('tsx'), join(PKG, 'src', 'mcp.ts')],
        env: { INVOICE_RPC_URL: RPC, INVOICE_MANDATE: mandatePath, INVOICE_LEDGER: ledgerPath, INVOICE_CONFIRMATION: 'depth:3' },
      },
    },
  };
  writeFileSync(join(DIR, 'mcp.json'), JSON.stringify(config, null, 2));
  console.log(`LOCAL fixture ready (Anvil ${RPC}, chain 31337, local test token ${token}; fictitious invoices INV-001 confirmed, INV-002 pending, INV-003 refused).`);
  console.log(`MCP config: ${join(DIR, 'mcp.json')}`);
  console.log(`Ask Claude Code (another terminal, from ${PKG}):`);
  console.log(`  claude --mcp-config "${join(DIR, 'mcp.json')}" --allowedTools mcp__invoice__invoice_status mcp__invoice__list_invoices`);
  console.log('  then: "Was invoice INV-001 paid? And INV-002?"   ·   Ctrl+C here stops the chain: ask again.');
  // The same read-only answers without Claude Code: `ops` needs the same environment as the MCP server.
  const env = config.mcpServers.invoice.env;
  console.log(`Or from the shell (another terminal, from ${PKG}; same answer as the MCP tool):`);
  // Single-quoted in both shells (a path may hold spaces or a quote: ' becomes '\'' in bash, '' in PowerShell).
  console.log(`  bash:       export ${Object.entries(env).map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`).join(' ')}`);
  console.log(`  PowerShell: ${Object.entries(env).map(([k, v]) => `$env:${k}='${v.replaceAll("'", "''")}'`).join('; ')}`);
  console.log('  then: npm run ops -- ask INV-001   ·   npm run ops -- ask INV-002   ·   npm run ops -- status');
  console.log('READY');
  await new Promise(() => undefined);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
