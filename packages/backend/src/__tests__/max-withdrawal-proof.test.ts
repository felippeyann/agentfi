/**
 * §5-7 — the proof that a "max" withdrawal returns everything to the agent's
 * own wallet and does nothing else (`services/policy/max-withdrawal-proof.ts`).
 * Unit level: strict decoding, adversarial calldata, the trusted-target
 * resolution. The routes are covered on Postgres in
 * `max-withdrawal.routes.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { concatHex, encodeFunctionData, getAddress, maxUint256, padHex, type Address, type Hex } from 'viem';
import {
  AAVE_V3_WITHDRAW_SELECTOR,
  COMET_WITHDRAW_SELECTOR,
  maxWithdrawalPricing,
  proveMaxWithdrawalToSelf,
  resolveTrustedWithdrawTargets,
  type TrustedWithdrawTarget,
} from '../services/policy/max-withdrawal-proof.js';
import { AGENT_EXECUTOR_ABI } from '../abi/AgentExecutor.abi.js';

const AGENT = getAddress('0x7a7a00000000000000000000000000000000a9e1');
const ATTACKER = getAddress('0x000000000000000000000000000000000000bad0');
const POOL = getAddress('0x00000000000000000000000000000000000000ab');
const COMET = getAddress('0x00000000000000000000000000000000000000a7');
const VAULT = getAddress('0x0000000000000000000000000000000000004626');
const EXECUTOR = getAddress('0x00000000000000000000000000000000000e8ec0');
const USDC = getAddress('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
const TRUSTED: TrustedWithdrawTarget[] = [
  { protocol: 'aave-v3', address: POOL },
  { protocol: 'compound-v3', address: COMET },
];

const fn = (name: string, inputs: Array<{ name: string; type: string }>) => [{ name, type: 'function', stateMutability: 'nonpayable', inputs, outputs: [] }] as const;
const AAVE = fn('withdraw', [
  { name: 'asset', type: 'address' },
  { name: 'amount', type: 'uint256' },
  { name: 'to', type: 'address' },
]);
const COMET_ABI = fn('withdraw', [
  { name: 'asset', type: 'address' },
  { name: 'amount', type: 'uint256' },
]);
const aave = (to: Address, amount = maxUint256, asset: Address = USDC) =>
  encodeFunctionData({ abi: AAVE, functionName: 'withdraw', args: [asset, amount, to] as never });
const comet = (amount = maxUint256, asset: Address = USDC) =>
  encodeFunctionData({ abi: COMET_ABI, functionName: 'withdraw', args: [asset, amount] as never });

function prove(to: string, data: string, value: bigint | string = 0n, from: string = AGENT, trusted = TRUSTED) {
  return proveMaxWithdrawalToSelf({ from, tx: { to, data, value }, trusted });
}

describe('proveMaxWithdrawalToSelf — what is proven', () => {
  it('Aave V3: withdraw(asset, max, sender) to the trusted pool → proven, recipient = sender', () => {
    expect(AAVE_V3_WITHDRAW_SELECTOR).toBe('0x69328dec');
    expect(prove(POOL, aave(AGENT))).toEqual({
      proven: true,
      exemption: { rule: 'max-withdrawal-to-own-wallet', protocol: 'aave-v3', target: POOL, asset: USDC, recipient: AGENT },
    });
  });

  it('Compound V3: withdraw(asset, max) to the trusted Comet → proven, recipient = sender (Comet withdraws from and to msg.sender)', () => {
    expect(COMET_WITHDRAW_SELECTOR).toBe('0xf3fef3a3');
    expect(prove(COMET, comet())).toEqual({
      proven: true,
      exemption: { rule: 'max-withdrawal-to-own-wallet', protocol: 'compound-v3', target: COMET, asset: USDC, recipient: AGENT },
    });
  });

  it('address and hex case carry no meaning: lowercase target / sender, uppercase calldata digits → still proven', () => {
    const upper = `0x${aave(AGENT).slice(2).toUpperCase()}`;
    expect(prove(POOL.toLowerCase(), upper, 0n, AGENT.toLowerCase()).proven).toBe(true);
    expect(prove(POOL, aave(AGENT), '0').proven).toBe(true);
  });
});

describe('proveMaxWithdrawalToSelf — refused', () => {
  const refused = (r: ReturnType<typeof prove>, reason: RegExp) => {
    expect(r.proven).toBe(false);
    if (!r.proven) expect(r.reason).toMatch(reason);
  };

  it('an external recipient', () => refused(prove(POOL, aave(ATTACKER)), /sent to .*not to the sender/));
  it('the zero address as recipient', () => refused(prove(POOL, aave('0x0000000000000000000000000000000000000000')), /not to the sender/));
  it('an explicit amount (not max)', () => {
    refused(prove(POOL, aave(AGENT, 10n ** 6n)), /not max/);
    refused(prove(COMET, comet(maxUint256 - 1n)), /not max/);
  });
  it('native value (bigint, string, unparsable)', () => {
    refused(prove(POOL, aave(AGENT), 1n), /native value/);
    refused(prove(POOL, aave(AGENT), '1'), /native value/);
    refused(prove(POOL, aave(AGENT), 'one'), /native value/);
  });
  it('a target that is not a trusted protocol contract (an agent-chosen vault)', () => refused(prove(VAULT, aave(AGENT)), /not a trusted protocol contract/));
  it('no trusted target on the chain at all', () => refused(prove(POOL, aave(AGENT), 0n, AGENT, []), /not a trusted protocol contract/));
  it('a target configured for two protocols (ambiguous)', () =>
    refused(prove(POOL, aave(AGENT), 0n, AGENT, [{ protocol: 'aave-v3', address: POOL }, { protocol: 'compound-v3', address: POOL }]), /more than one protocol/));

  it('the other protocol\'s calldata on a trusted target (Comet withdraw to the Aave pool, Aave withdraw to the Comet)', () => {
    refused(prove(POOL, comet()), /not exactly Aave V3/);
    refused(prove(COMET, aave(AGENT)), /not exactly Compound V3/);
  });

  it('ERC-4626 withdraw(max, sender, sender) aimed at a trusted address', () => {
    const erc4626 = encodeFunctionData({
      abi: fn('withdraw', [
        { name: 'assets', type: 'uint256' },
        { name: 'receiver', type: 'address' },
        { name: 'owner', type: 'address' },
      ]),
      functionName: 'withdraw',
      args: [maxUint256, AGENT, AGENT] as never,
    });
    refused(prove(POOL, erc4626), /not exactly Aave V3/);
    refused(prove(COMET, erc4626), /not exactly Compound V3/);
  });

  it('Comet withdrawTo(to, asset, max) and withdrawFrom(src, to, asset, max)', () => {
    const withdrawTo = encodeFunctionData({
      abi: fn('withdrawTo', [
        { name: 'to', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]),
      functionName: 'withdrawTo',
      args: [AGENT, USDC, maxUint256] as never,
    });
    const withdrawFrom = encodeFunctionData({
      abi: fn('withdrawFrom', [
        { name: 'src', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]),
      functionName: 'withdrawFrom',
      args: [AGENT, AGENT, USDC, maxUint256] as never,
    });
    refused(prove(COMET, withdrawTo), /not exactly Compound V3/);
    refused(prove(COMET, withdrawFrom), /not exactly Compound V3/);
  });

  it('an approve to a trusted target', () => {
    const approve = encodeFunctionData({
      abi: fn('approve', [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]),
      functionName: 'approve',
      args: [ATTACKER, maxUint256] as never,
    });
    refused(prove(COMET, approve), /not exactly Compound V3/);
  });

  it('a batched shape: the withdrawal wrapped in AgentExecutor.executeBatch (the executor is not a trusted withdraw target)', () => {
    const batch = encodeFunctionData({
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeBatch',
      args: [[{ target: POOL, value: 0n, token: USDC, data: aave(AGENT) }]] as never,
    });
    refused(prove(EXECUTOR, batch), /not a trusted protocol contract/);
    refused(prove(POOL, batch), /not exactly Aave V3/);
  });

  it('trailing bytes (a second payload after the call)', () => {
    refused(prove(POOL, concatHex([aave(AGENT), padHex('0x01', { size: 32 })])), /not exactly Aave V3/);
    refused(prove(COMET, `${comet()}00`), /not exactly Compound V3/);
  });

  it('truncated calldata', () => {
    refused(prove(POOL, aave(AGENT).slice(0, -2)), /not exactly Aave V3/);
    refused(prove(COMET, comet().slice(0, 10 + 64)), /not exactly Compound V3/);
  });

  it('dirty address padding: an attacker in the high bytes of the recipient word that a lenient decoder drops is refused', () => {
    const data = aave(AGENT);
    // Words: [selector][asset][amount][to]. Put junk in the 12 padding bytes of `to`.
    const toWordStart = 10 + 64 * 2;
    const dirty = (data.slice(0, toWordStart) + 'deadbeefdeadbeefdeadbeef' + data.slice(toWordStart + 24)) as Hex;
    refused(prove(POOL, dirty), /not canonically encoded|does not decode/);
  });

  it('dirty padding in the asset word (Comet)', () => {
    const data = comet();
    const dirty = (data.slice(0, 10) + 'ff'.repeat(12) + data.slice(10 + 24)) as Hex;
    refused(prove(COMET, dirty), /not canonically encoded|does not decode/);
  });

  it('the zero asset', () => {
    refused(prove(POOL, aave(AGENT, maxUint256, '0x0000000000000000000000000000000000000000')), /zero address/);
    refused(prove(COMET, comet(maxUint256, '0x0000000000000000000000000000000000000000')), /zero address/);
  });

  it('a malformed or zero sender, non-hex calldata, an invalid target', () => {
    refused(prove(POOL, aave(AGENT), 0n, 'not-an-address'), /sender/);
    refused(prove(POOL, aave('0x0000000000000000000000000000000000000000'), 0n, '0x0000000000000000000000000000000000000000'), /sender/);
    refused(prove(POOL, 'withdraw everything'), /not hex/);
    refused(prove('0x1234', aave(AGENT)), /target is not a valid address/);
  });
});

describe('resolveTrustedWithdrawTargets — from config/contracts.ts only', () => {
  it('a mainnet chain: the configured Comet and the pool its configured Aave provider reports', async () => {
    const asked: string[] = [];
    const trusted = await resolveTrustedWithdrawTargets(1, async (_chainId, provider) => {
      asked.push(provider);
      return POOL;
    });
    expect(asked).toEqual([getAddress('0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e')]);
    expect(trusted).toEqual([
      { protocol: 'compound-v3', address: getAddress('0xc3d688B66703497DAA19211EEdff47f25384cdc3') },
      { protocol: 'aave-v3', address: POOL },
    ]);
  });

  it('Base Sepolia: no Comet and a zero Aave provider → nothing trusted, the provider is never read', async () => {
    let read = false;
    expect(await resolveTrustedWithdrawTargets(84532, async () => {
      read = true;
      return POOL;
    })).toEqual([]);
    expect(read).toBe(false);
  });

  it('an unreadable provider, a zero or malformed pool → only the Comet', async () => {
    const comet = [{ protocol: 'compound-v3', address: getAddress('0xc3d688B66703497DAA19211EEdff47f25384cdc3') }];
    expect(await resolveTrustedWithdrawTargets(1, async () => {
      throw new Error('RPC down');
    })).toEqual(comet);
    expect(await resolveTrustedWithdrawTargets(1, async () => '0x0000000000000000000000000000000000000000')).toEqual(comet);
    expect(await resolveTrustedWithdrawTargets(1, async () => '0x1234')).toEqual(comet);
  });

  it('an unknown chain → nothing trusted', async () => {
    expect(await resolveTrustedWithdrawTargets(999_999, async () => POOL)).toEqual([]);
  });
});

describe('maxWithdrawalPricing', () => {
  it('proven → nothing to count (zero) plus the marker', async () => {
    const r = await maxWithdrawalPricing({ chainId: 1, from: AGENT, tx: { to: POOL, data: aave(AGENT), value: 0n } }, async () => POOL);
    expect(r.pricing).toEqual({ status: 'zero' });
    expect(r.exemption).toMatchObject({ protocol: 'aave-v3', recipient: AGENT });
  });

  it('not proven → unpriced (D15 refuses it under a daily limit), with the reason', async () => {
    const r = await maxWithdrawalPricing({ chainId: 1, from: AGENT, tx: { to: POOL, data: aave(ATTACKER), value: 0n } }, async () => POOL);
    expect(r.exemption).toBeNull();
    expect(r.pricing.status).toBe('unpriced');
    if (r.pricing.status === 'unpriced') expect(r.pricing.reason).toMatch(/"max" withdrawal.*not proven.*not to the sender/);
  });
});
