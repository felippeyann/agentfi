/**
 * §5-7 on the REAL protocol contracts — an Anvil fork of Ethereum mainnet.
 *
 * `max-withdrawal-proof.ts` exempts a "max" withdrawal from the daily count
 * when its calldata is exactly Aave V3 `Pool.withdraw(asset, max, sender)` to
 * the pool the configured provider reports, or Compound V3
 * `Comet.withdraw(asset, max)` to the configured Comet. That is sound only if
 * those deployed contracts, given that calldata, move the sender's whole
 * position to the sender and nothing anywhere else. This suite checks it on
 * the deployed bytecode: the calldata comes from the backend's own
 * `TransactionBuilder`, the trusted targets from `resolveTrustedWithdrawTargets`
 * (config/contracts.ts for chain 1, the provider read on the fork), the proof
 * from `proveMaxWithdrawalToSelf`; then the transaction is sent from the agent
 * and its receipt is read: every token Transfer goes to the agent or is a
 * burn of the agent's position, nothing leaves the agent, no Approval is
 * emitted, the position is empty afterwards (and Comet left no borrow). As a
 * control, the same pool with another recipient really pays that recipient —
 * the argument the proof refuses is the one that decides.
 *
 * Opt-in (network): `MAX_WITHDRAWAL_FORK_URL=<Ethereum mainnet RPC, read-only>`
 * (optional `MAX_WITHDRAWAL_FORK_BLOCK`), Foundry's `anvil` installed. Skipped
 * otherwise. Nothing is sent to the real network: Anvil reads state lazily.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { mainnet } from 'viem/chains';
import { TransactionBuilder } from '../services/transaction/builder.service.js';
import { getContracts } from '../config/contracts.js';
import { proveMaxWithdrawalToSelf, resolveTrustedWithdrawTargets } from '../services/policy/max-withdrawal-proof.js';

const FORK_URL = process.env['MAX_WITHDRAWAL_FORK_URL'] ?? '';
const FORK_BLOCK = process.env['MAX_WITHDRAWAL_FORK_BLOCK'] ?? '';
const PORT = Number(process.env['MAX_WITHDRAWAL_ANVIL_PORT'] || 8549);
const RPC = `http://127.0.0.1:${PORT}`;
const describeFork = FORK_URL ? describe : describe.skip;

const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
/** FiatToken v2: `balanceAndBlacklistStates` mapping. */
const FIAT_TOKEN_BALANCE_SLOT = 9n;
const SUPPLIED = 1_000n * 10n ** 6n;
const ZERO = '0x0000000000000000000000000000000000000000';

const POOL_ABI = parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
const COMET_ABI = parseAbi([
  'function supply(address asset, uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function borrowBalanceOf(address account) view returns (uint256)',
]);
const EVENTS_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

function anvilBin(): string {
  for (const candidate of [join(homedir(), '.foundry', 'bin', 'anvil.exe'), join(homedir(), '.foundry', 'bin', 'anvil')]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'anvil';
}

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const chain = { ...mainnet, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC) });

async function send(from: Address, to: Address, data: Hex) {
  // Dry-run first so a revert names its reason instead of a bare "reverted".
  await pub.call({ account: from, to, data }).catch((err: Error) => {
    throw new Error(`call to ${to} (${data.slice(0, 10)}) from ${from} reverts: ${(err as { shortMessage?: string }).shortMessage ?? err.message}`);
  });
  // Explicit gas: an estimate taken on the pending block can fall short once mined (seen on the fork for Aave withdraw).
  const hash = await wallet.sendTransaction({ account: from, to, data, value: 0n, gas: 3_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status, `${to} ${data.slice(0, 10)} mined in block ${receipt.blockNumber}`).toBe('success');
  return receipt;
}

/** A fresh, code-less account the fork lets us send from, with gas and `usdc` USDC. */
async function freshAgent(usdc: bigint): Promise<Address> {
  const agent = getAddress(`0x${randomBytes(20).toString('hex')}`);
  await rpc('anvil_impersonateAccount', [agent]);
  await rpc('anvil_setBalance', [agent, numberToHex(10n ** 19n)]);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [agent, FIAT_TOKEN_BALANCE_SLOT]));
  await rpc('anvil_setStorageAt', [USDC, slot, numberToHex(usdc, { size: 32 })]);
  expect(await usdcOf(agent)).toBe(usdc);
  return agent;
}

const usdcOf = (who: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

/** Every Transfer / Approval in the receipt, decoded (other events skipped). */
function tokenEvents(logs: Log[]) {
  const out: Array<{ token: Address; name: 'Transfer' | 'Approval'; a: Address; b: Address; value: bigint }> = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: EVENTS_ABI, data: log.data, topics: log.topics });
      const args = ev.args as { from?: Address; to?: Address; owner?: Address; spender?: Address; value: bigint };
      out.push(
        ev.eventName === 'Transfer'
          ? { token: getAddress(log.address), name: 'Transfer', a: getAddress(args.from!), b: getAddress(args.to!), value: args.value }
          : { token: getAddress(log.address), name: 'Approval', a: getAddress(args.owner!), b: getAddress(args.spender!), value: args.value },
      );
    } catch {
      // not a Transfer / Approval
    }
  }
  return out;
}

/** Nothing leaves the agent except burns of its own position; everything received goes to the agent; no Approval. */
function expectOnlyReturnsToAgent(events: ReturnType<typeof tokenEvents>, agent: Address): bigint {
  expect(events.filter((e) => e.name === 'Approval')).toEqual([]);
  let usdcIn = 0n;
  for (const e of events.filter((ev) => ev.name === 'Transfer' && ev.value > 0n)) {
    if (e.a === agent) expect(e.b, `a transfer out of the agent that is not a burn: ${JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`).toBe(ZERO);
    if (e.token === USDC) {
      expect(e.b, 'USDC moved to someone other than the agent').toBe(agent);
      usdcIn += e.value;
    }
  }
  return usdcIn;
}

describeFork('§5-7 on an Anvil fork of Ethereum mainnet — what the proven calldata does on the deployed contracts', () => {
  let anvil: ChildProcess | null = null;
  const builder = new TransactionBuilder();
  let pool: Address;
  let comet: Address;

  beforeAll(async () => {
    const args = ['--port', String(PORT), '--chain-id', '1', '--silent', '--fork-url', FORK_URL];
    if (FORK_BLOCK) args.push('--fork-block-number', FORK_BLOCK);
    anvil = spawn(anvilBin(), args, { stdio: 'ignore' });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await rpc('eth_chainId');
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('anvil did not start');
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const trusted = await resolveTrustedWithdrawTargets(1, (_chainId, provider) =>
      pub.readContract({ address: provider, abi: parseAbi(['function getPool() view returns (address)']), functionName: 'getPool' }),
    );
    pool = trusted.find((t) => t.protocol === 'aave-v3')!.address;
    comet = trusted.find((t) => t.protocol === 'compound-v3')!.address;
    expect(comet).toBe(getAddress(getContracts(1).compoundCometUsdc!));
  }, 120_000);

  afterAll(() => {
    anvil?.kill('SIGTERM');
  });

  // Each test starts from the fork block's state (an earlier test's time warp
  // accrues interest and can push the pool to its supply cap).
  let snapshot: string | null = null;
  beforeEach(async () => {
    if (snapshot) await rpc('evm_revert', [snapshot]);
    snapshot = await rpc<string>('evm_snapshot');
  });

  it('Aave V3: Pool.withdraw(USDC, max, agent) as the backend builds it — proven, and on-chain everything returns to the agent, nothing else moves', async () => {
    const agent = await freshAgent(SUPPLIED);
    await send(agent, USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, SUPPLIED] }));
    await send(agent, pool, encodeFunctionData({ abi: POOL_ABI, functionName: 'supply', args: [USDC, SUPPLIED, agent, 0] }));
    expect(await usdcOf(agent)).toBe(0n);
    await rpc('evm_increaseTime', [30 * 86_400]);
    await rpc('evm_mine');

    const tx = builder.buildAaveWithdraw({ poolAddress: pool, asset: USDC, amount: maxUint256, to: agent });
    const trusted = [{ protocol: 'aave-v3' as const, address: pool }, { protocol: 'compound-v3' as const, address: comet }];
    expect(proveMaxWithdrawalToSelf({ from: agent, tx, trusted })).toMatchObject({ proven: true, exemption: { recipient: agent, target: pool } });

    const receipt = await send(agent, tx.to, tx.data);
    const usdcIn = expectOnlyReturnsToAgent(tokenEvents(receipt.logs), agent);
    expect(usdcIn).toBeGreaterThan(SUPPLIED); // the whole position, interest included
    expect(await usdcOf(agent)).toBe(usdcIn);
    // Everything was withdrawn: a second max withdrawal has nothing left (Aave refuses a zero amount).
    await expect(pub.call({ account: agent, to: tx.to, data: tx.data })).rejects.toThrow();
  }, 180_000);

  it('Compound V3: Comet.withdraw(USDC, max) as the backend builds it — proven, and on-chain the whole supply returns to the agent, no borrow opened', async () => {
    const agent = await freshAgent(SUPPLIED);
    await send(agent, USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [comet, SUPPLIED] }));
    await send(agent, comet, encodeFunctionData({ abi: COMET_ABI, functionName: 'supply', args: [USDC, SUPPLIED] }));
    await rpc('evm_increaseTime', [30 * 86_400]);
    await rpc('evm_mine');
    const position = await pub.readContract({ address: comet, abi: COMET_ABI, functionName: 'balanceOf', args: [agent] });
    expect(position).toBeGreaterThan(SUPPLIED - 2n);

    const tx = builder.buildCompoundWithdraw({ cometAddress: comet, asset: USDC, amount: maxUint256 });
    const trusted = [{ protocol: 'aave-v3' as const, address: pool }, { protocol: 'compound-v3' as const, address: comet }];
    expect(proveMaxWithdrawalToSelf({ from: agent, tx, trusted })).toMatchObject({ proven: true, exemption: { recipient: agent, target: comet } });

    const receipt = await send(agent, tx.to, tx.data);
    const usdcIn = expectOnlyReturnsToAgent(tokenEvents(receipt.logs), agent);
    expect(usdcIn).toBeGreaterThanOrEqual(position);
    expect(await usdcOf(agent)).toBe(usdcIn);
    expect(await pub.readContract({ address: comet, abi: COMET_ABI, functionName: 'balanceOf', args: [agent] })).toBe(0n);
    expect(await pub.readContract({ address: comet, abi: COMET_ABI, functionName: 'borrowBalanceOf', args: [agent] })).toBe(0n);
  }, 180_000);

  it('control: the same pool with another recipient pays that recipient — the refused argument is the one that decides (proof refuses it)', async () => {
    const agent = await freshAgent(SUPPLIED);
    const other = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await send(agent, USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, SUPPLIED] }));
    await send(agent, pool, encodeFunctionData({ abi: POOL_ABI, functionName: 'supply', args: [USDC, SUPPLIED, agent, 0] }));

    const tx = builder.buildAaveWithdraw({ poolAddress: pool, asset: USDC, amount: maxUint256, to: other });
    const trusted = [{ protocol: 'aave-v3' as const, address: pool }];
    expect(proveMaxWithdrawalToSelf({ from: agent, tx, trusted })).toMatchObject({ proven: false });

    await send(agent, tx.to, tx.data);
    expect(await usdcOf(other)).toBeGreaterThanOrEqual(SUPPLIED - 2n); // Aave rounds the scaled balance down by a unit or so
    expect(await usdcOf(agent)).toBe(0n);
  }, 180_000);
});
