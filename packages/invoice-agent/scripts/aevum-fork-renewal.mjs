// Read-only rehearsal of a second public session on the REAL Aevum vault, through a LOCAL Anvil fork of the public RPC.
// The fork reads Aevum's state (the vault 0xA0Bf…D7A3, its settlement of QDAY-2026-11-24-001, the real tUSD8, the
// operator's and agent's balances); every transaction below is mined ONLY inside the local fork, by impersonating the
// operator and the agent there (no key is used or needed). Nothing is sent to Aevum.
//
//   node --import tsx scripts/aevum-fork-renewal.mjs [--port 8845] [--days 30] [--invoice QDAY-2026-11-27-001]
//
// It measures the owner's operations in order (deposit, setMandate renewal, payInvoice of a new invoice) and the
// vault's answers (eth_estimateGas / eth_call) to the scenarios a judge may ask about, before and after each step.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, decodeErrorResult, defineChain, encodeFunctionData, getAddress, http, parseAbi, stringToHex } from 'viem';
import { INVOICE_MANDATE_ABI } from '../src/generated/invoice-mandate.ts';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const UPSTREAM = 'https://rpc-test.qday.info';
const PORT = Number(opt('port', '8845'));
const DAYS = BigInt(opt('days', '30'));
const NEW_ID = opt('invoice', 'QDAY-2026-11-27-001');
const OLD_ID = 'QDAY-2026-11-24-001';
const RPC = `http://127.0.0.1:${PORT}`;
const TUSD8 = getAddress('0x456569838f1d43009A91ebA4263147Afd7233483');
const VAULT = getAddress('0xA0BfD474378bB8F7Ee96294313a3832B26f4D7A3');
const OPERATOR = getAddress('0x87ba9E8e20E9D4cFB64f65Da1b82160c3910Bdf7');
const AGENT = getAddress('0x7CA8B7704a214b9c129c166c80b5eDB28500DbC8');
const PAYTO = getAddress('0x46fbCbbA2b425AdFB958507F5F341FCc4932C530');
const OTHER = getAddress('0x00000000000000000000000000000000000E3e01');
const VENDOR = stringToHex('vendor-1', { size: 32 });
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
const home = join(homedir(), '.foundry', 'bin', exe);
const anvil = spawn(existsSync(home) ? home : exe, ['--fork-url', UPSTREAM, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
const stop = () => anvil.exitCode === null && anvil.kill();
process.on('exit', stop);

const chain = defineChain({ id: 44005, name: 'Aevum (LOCAL FORK)', nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC, { timeout: 60_000 }) });
for (let i = 0; i < 200 && !(await pub.getChainId().then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 250));
const forkBlock = await pub.getBlock();
const as = (account) => createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000 }) });
await test.impersonateAccount({ address: OPERATOR });
await test.impersonateAccount({ address: AGENT });
const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
const tq = (wei) => (Number(wei) / 1e18).toFixed(7);
const u6 = (x) => (Number(x) / 1e6).toString();
const log = (s = '') => console.log(s);

/** What the vault answers to payInvoice from `from`: the gas estimate, or the revert (decoded). Nothing is sent. */
async function ask(label, args, from = AGENT) {
  const data = encodeFunctionData({ abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args });
  try {
    const gas = await pub.estimateGas({ account: from, to: VAULT, data });
    log(`  ${label}: would succeed, estimate ${gas} gas`);
    return gas;
  } catch (e) {
    const raw = e?.cause?.data ?? e?.cause?.cause?.data ?? e?.details ?? '';
    const hex = typeof raw === 'string' && raw.startsWith('0x') ? raw : (String(e?.message ?? '').match(/0x[0-9a-fA-F]{8,}/) ?? [''])[0];
    let why;
    try {
      const d = decodeErrorResult({ abi: INVOICE_MANDATE_ABI, data: hex });
      why = `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
    } catch {
      why = `revert ${hex || String(e?.shortMessage ?? e?.message).split('\n')[0]}`;
    }
    log(`  ${label}: REVERTS ${why}`);
    return null;
  }
}
const pay = (id, amount = 1_000_000n, payTo = PAYTO) => [id, VENDOR, payTo, amount];
const state = async (title) => {
  const m = await pub.readContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'mandate' });
  const [bal, rem, agentEth, opEth] = await Promise.all([
    pub.readContract({ address: TUSD8, abi: ERC20, functionName: 'balanceOf', args: [VAULT] }),
    pub.readContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'remainingToday' }),
    pub.getBalance({ address: AGENT }),
    pub.getBalance({ address: OPERATOR }),
  ]);
  log(`${title}: vault ${u6(bal)} tUSD8 · mandate agent ${m[0]}, expires ${new Date(Number(m[1]) * 1000).toISOString()}, paused ${m[2]}, payTo ${m[3]}, cap ${u6(m[4])}, daily ${u6(m[5])} · remainingToday ${u6(rem)} · agent ${tq(agentEth)} tQDAY · operator ${tq(opEth)} tQDAY`);
};

log(`LOCAL Anvil fork of ${UPSTREAM} at block ${forkBlock.number} (${new Date(Number(forkBlock.timestamp) * 1000).toISOString()}), port ${PORT}. Nothing is sent to Aevum.`);
await state('0. as on Aevum now');
await ask(`payInvoice("${OLD_ID}") from the agent`, pay(OLD_ID));
await ask(`payInvoice("${NEW_ID}") from the agent`, pay(NEW_ID));

log('\n1. Operator: deposit 1 tUSD8 (a plain tUSD8 transfer to the vault)');
const dep = await wait(await as(OPERATOR).writeContract({ address: TUSD8, abi: ERC20, functionName: 'transfer', args: [VAULT, 1_000_000n] }));
log(`  status ${dep.status}, gas used ${dep.gasUsed}, effective price ${dep.effectiveGasPrice} wei, cost ${tq(dep.gasUsed * dep.effectiveGasPrice)} tQDAY`);

log(`\n2. Operator: setMandate(agent, vendor-1, payTo, 1 tUSD8 per invoice, 1 per UTC day, ${DAYS} days)`);
const now = (await pub.getBlock()).timestamp;
const sm = await wait(await as(OPERATOR).writeContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'setMandate', args: [AGENT, VENDOR, PAYTO, 1_000_000, 1_000_000, Number(now + DAYS * 86_400n)] }));
log(`  status ${sm.status}, gas used ${sm.gasUsed}, cost ${tq(sm.gasUsed * sm.effectiveGasPrice)} tQDAY`);
await state('  after the renewal');

log('\n3. What the vault answers now (eth_estimateGas, nothing sent):');
await ask(`resend of the paid "${OLD_ID}" (agent, 1 tUSD8)`, pay(OLD_ID));
await ask(`"${NEW_ID}" for 2 tUSD8 (above the cap)`, pay(NEW_ID, 2_000_000n));
await ask(`"${NEW_ID}" to another payee`, pay(NEW_ID, 1_000_000n, OTHER));
await ask(`"${NEW_ID}" from the operator (not the agent)`, pay(NEW_ID), OPERATOR);
const est = await ask(`"${NEW_ID}" for 1 tUSD8 (the new invoice)`, pay(NEW_ID));

log('\n4. Preflight of the agent against this fork (read-only, the same code as the session):');
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const pf = spawnSync(process.execPath, ['--import', 'tsx', 'src/preflight.ts', '--rpc', RPC, '--chain-id', '44005', '--token', TUSD8, '--explorer', 'none', '--vault', VAULT, '--payer', AGENT, '--vendor', PAYTO, '--amount', '1', '--invoice', NEW_ID, '--max-gas-cost', '0.0002', '--max-priority-fee-gwei', '1', '--max-finalized-lag-min', '150'], { cwd: PKG, encoding: 'utf8' });
for (const l of `${pf.stdout}`.trimEnd().split('\n')) log(`  | ${l}`);
log(`  (preflight exit ${pf.status})`);

log(`\n5. Agent: payInvoice("${NEW_ID}", 1 tUSD8), gas limit = estimate + 20%, tip 1 gwei (as the agent signs it)`);
const gas = (est * 12n) / 10n;
const base = (await pub.getBlock()).baseFeePerGas ?? 0n;
const p = await wait(await as(AGENT).writeContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'payInvoice', args: pay(NEW_ID), gas, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: (base * 12n) / 10n + 1_000_000_000n }));
log(`  status ${p.status}, gas used ${p.gasUsed} (limit ${gas}), effective price ${p.effectiveGasPrice} wei, cost ${tq(p.gasUsed * p.effectiveGasPrice)} tQDAY; max authorized ${tq(gas * ((base * 12n) / 10n + 1_000_000_000n))} tQDAY; logs ${p.logs.length}`);
const s = await pub.readContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'settlementOf', args: [NEW_ID, VENDOR] });
log(`  settlementOf("${NEW_ID}"): settled ${s[0]}, ${u6(s[1])} tUSD8, block ${s[2]}, agent ${s[3]}`);
await state('  after the payment');

log('\n6. What the vault answers after the payment (nothing sent):');
await ask(`resend of "${NEW_ID}"`, pay(NEW_ID));
await ask(`resend of "${OLD_ID}"`, pay(OLD_ID));
await ask('a third invoice the same UTC day (daily limit spent; the vault is also empty)', pay('QDAY-FORK-003'));
const wd = await pub.estimateGas({ account: OPERATOR, to: VAULT, data: encodeFunctionData({ abi: INVOICE_MANDATE_ABI, functionName: 'withdraw', args: [1n] }) }).then((g) => `would succeed, ${g} gas`, () => 'REVERTS (nothing left to withdraw)');
log(`  withdraw(1 unit) by the operator: ${wd}`);

log('\n7. Optional operator closings, measured on the fork (each one more operator signature):');
const snap = await test.snapshot();
const pz = await wait(await as(OPERATOR).writeContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'pause' }));
log(`  pause(): gas used ${pz.gasUsed}`);
await ask('  then a new invoice', pay('QDAY-FORK-004'));
await test.revert({ id: snap });
const rv = await wait(await as(OPERATOR).writeContract({ address: VAULT, abi: INVOICE_MANDATE_ABI, functionName: 'revokeAgent' }));
log(`  revokeAgent(): gas used ${rv.gasUsed}`);
await ask('  then a new invoice', pay('QDAY-FORK-004'));
log('\nDone (fork only; stopped).');
stop();
process.exit(0);
