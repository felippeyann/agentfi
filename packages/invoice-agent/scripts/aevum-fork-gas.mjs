// Read-only gas measurement of the vault on QDay Aevum Testnet, through a LOCAL Anvil fork of the public RPC:
// the fork reads Aevum's state (the real tUSD8 FiatToken), every transaction is mined only inside the local fork,
// nothing is sent to Aevum. Uses Anvil's public development keys and impersonates tUSD8's masterMinter on the fork.
//
//   node scripts/aevum-fork-gas.mjs          (needs anvil; starts and stops its own fork on 127.0.0.1:8590)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createTestClient, createWalletClient, defineChain, getAddress, http, parseAbi, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { INVOICE_MANDATE_ABI, INVOICE_MANDATE_BYTECODE } from '../src/generated/invoice-mandate.ts';

const UPSTREAM = 'https://rpc-test.qday.info';
const PORT = 8590;
const RPC = `http://127.0.0.1:${PORT}`;
const TUSD8 = '0x456569838f1d43009A91ebA4263147Afd7233483';
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FIAT = parseAbi([
  'function masterMinter() view returns (address)',
  'function configureMinter(address,uint256) returns (bool)',
  'function mint(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
const home = join(homedir(), '.foundry', 'bin', exe);
const anvil = spawn(existsSync(home) ? home : exe, ['--fork-url', UPSTREAM, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
const stop = () => anvil.exitCode === null && anvil.kill();
process.on('exit', stop);

const chain = defineChain({ id: 44005, name: 'Aevum (LOCAL FORK)', nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 60_000 }) });
for (let i = 0; i < 200 && !(await pub.getChainId().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 250));
const forkBlock = await pub.getBlockNumber();
const wallet = (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC, { timeout: 60_000 }) });
const op = wallet(OPERATOR_KEY), agentW = wallet(AGENT_KEY);
const operator = op.account.address, agent = agentW.account.address;
const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
const fresh = (n) => getAddress(`0x${(0xe3e000 + n).toString(16).padStart(40, '0')}`);
const vendorKey = stringToHex('vendor-1', { size: 32 });

// tUSD8 on the fork: the masterMinter (impersonated, fork only) lets the operator mint.
const mm = await pub.readContract({ address: TUSD8, abi: FIAT, functionName: 'masterMinter' });
await test.impersonateAccount({ address: mm });
await test.setBalance({ address: mm, value: 10n ** 18n });
await wait(await createWalletClient({ account: mm, chain, transport: http(RPC) }).writeContract({ address: TUSD8, abi: FIAT, functionName: 'configureMinter', args: [operator, 1_000_000_000n] }));
await test.stopImpersonatingAccount({ address: mm });
await wait(await op.writeContract({ address: TUSD8, abi: FIAT, functionName: 'mint', args: [operator, 100_000_000n] }));

const deploy = await wait(await op.deployContract({ abi: INVOICE_MANDATE_ABI, bytecode: INVOICE_MANDATE_BYTECODE, args: [TUSD8] }));
const vault = deploy.contractAddress;
const deposit = await wait(await op.writeContract({ address: TUSD8, abi: FIAT, functionName: 'transfer', args: [vault, 10_000_000n] }));
const now = (await pub.getBlock()).timestamp;
const payTo = fresh(1);
const setMandate = await wait(await op.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [agent, vendorKey, payTo, 1_000_000, 5_000_000, Number(now + 86_400n)] }));
const pay = async (id, to = payTo) => {
  const args = [id, vendorKey, to, 1_000_000n];
  const estimate = await pub.estimateGas({ account: agent, to: vault, data: (await import('viem')).encodeFunctionData({ abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args }) });
  const r = await wait(await agentW.writeContract({ address: vault, abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args }));
  return { estimate, used: r.gasUsed, status: r.status };
};
const first = await pay('FORK-1'); // the vault's first payment, to an empty payee, first of the day
const second = await pay('FORK-2'); // steady state: the payee holds tUSD8, same day
const direct = await wait(await op.writeContract({ address: TUSD8, abi: FIAT, functionName: 'transfer', args: [payTo, 1_000_000n] }));
const directEmpty = await wait(await op.writeContract({ address: TUSD8, abi: FIAT, functionName: 'transfer', args: [fresh(2), 1_000_000n] }));
const fees = await pub.estimateFeesPerGas();
const withMargin = (g) => (g * 12n) / 10n;
const tq = (wei) => (Number(wei) / 1e18).toFixed(7);

console.log(`Aevum Testnet, LOCAL fork at block ${forkBlock} of ${UPSTREAM} (nothing sent to Aevum), real tUSD8 ${TUSD8}`);
console.log(`deploy ${deploy.gasUsed} · deposit (tUSD8 transfer to the vault) ${deposit.gasUsed} · setMandate (first) ${setMandate.gasUsed}`);
console.log(`payInvoice first (empty payee, new day): used ${first.used}, estimate ${first.estimate}, limit +20% ${withMargin(first.estimate)} [${first.status}]`);
console.log(`payInvoice steady (payee holds tUSD8):   used ${second.used}, estimate ${second.estimate}, limit +20% ${withMargin(second.estimate)} [${second.status}]`);
console.log(`direct tUSD8 transfer: to a holder ${direct.gasUsed}, to an empty address ${directEmpty.gasUsed}`);
console.log(`fork's fee estimate: maxFeePerGas ${fees.maxFeePerGas} wei → max cost first ${tq(withMargin(first.estimate) * fees.maxFeePerGas)} tQDAY, steady ${tq(withMargin(second.estimate) * fees.maxFeePerGas)} tQDAY`);
console.log(`at 1 gwei: first ${tq(withMargin(first.estimate) * 1_000_000_000n)} tQDAY, steady ${tq(withMargin(second.estimate) * 1_000_000_000n)} tQDAY`);
stop();
process.exit(0);
