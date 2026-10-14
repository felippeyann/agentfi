/**
 * Unit tests — Q9 batch calldata classification (`services/policy/batch-calldata.ts`).
 */
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import {
  ERC20_TRANSFER_FROM_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  classifyBatchCalldata,
  decodeStrictErc20Transfer,
} from '../services/policy/batch-calldata.js';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TO = '0x00000000000000000000000000000000000000b0';
const FROM = '0x00000000000000000000000000000000000000c1';
const POLICY_MODULE = '0x00000000000000000000000000000000000000Aa';

const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TO, 25_000_000n] });
const transferFrom = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [FROM, TO, 7n] });
const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TO, 2n ** 256n - 1n] });

describe('decodeStrictErc20Transfer', () => {
  it('selectors are the ERC-20 ones', () => {
    expect(ERC20_TRANSFER_SELECTOR).toBe('0xa9059cbb');
    expect(ERC20_TRANSFER_FROM_SELECTOR).toBe('0x23b872dd');
  });

  it('decodes canonical transfer and transferFrom', () => {
    expect(decodeStrictErc20Transfer(transfer)).toEqual({ fn: 'transfer', to: getAddress(TO), amount: 25_000_000n });
    expect(decodeStrictErc20Transfer(transferFrom)).toEqual({ fn: 'transferFrom', from: getAddress(FROM), to: getAddress(TO), amount: 7n });
    expect(decodeStrictErc20Transfer(transfer.toUpperCase().replace('0X', '0x') as Hex)).toMatchObject({ fn: 'transfer' });
  });

  it('refuses trailing bytes, a truncated payload and dirty address padding (non-canonical encodings)', () => {
    expect(decodeStrictErc20Transfer(`${transfer}00` as Hex)).toBeNull();
    expect(decodeStrictErc20Transfer(`${transfer}${'00'.repeat(32)}` as Hex)).toBeNull();
    expect(decodeStrictErc20Transfer(transfer.slice(0, -2) as Hex)).toBeNull();
    // The upper 12 bytes of the address word must be zero (viem would read only the low 20 bytes).
    const dirty = `${transfer.slice(0, 10)}ff${transfer.slice(12)}` as Hex;
    expect(dirty.length).toBe(transfer.length);
    expect(decodeStrictErc20Transfer(dirty)).toBeNull();
  });

  it('anything else is not a transfer', () => {
    expect(decodeStrictErc20Transfer(approve)).toBeNull();
    expect(decodeStrictErc20Transfer('0x12345678')).toBeNull();
    expect(decodeStrictErc20Transfer('0x')).toBeNull();
  });
});

describe('classifyBatchCalldata', () => {
  it('no calldata → none', () => {
    expect(classifyBatchCalldata({ to: TOKEN, data: '0x' })).toEqual({ kind: 'none' });
  });

  it('S8: the policy module gets no exemption class any more (the route refuses it as a target before classifying)', () => {
    expect(classifyBatchCalldata({ to: POLICY_MODULE.toLowerCase(), data: '0xdeadbeef' })).toEqual({ kind: 'other', selector: '0xdeadbeef' });
    // A non-canonical transfer encoding sent to it is not laundered as a "sync" either.
    expect(classifyBatchCalldata({ to: POLICY_MODULE, data: `${transfer}00` })).toMatchObject({ kind: 'non-canonical-erc20' });
  });

  it('an ERC-20 transfer: the token is the target', () => {
    expect(classifyBatchCalldata({ to: TOKEN.toLowerCase(), data: transfer })).toEqual({
      kind: 'erc20-transfer',
      fn: 'transfer',
      token: TOKEN,
      to: getAddress(TO),
      amount: 25_000_000n,
    });
    expect(classifyBatchCalldata({ to: TOKEN, data: transferFrom })).toMatchObject({ kind: 'erc20-transfer', fn: 'transferFrom', amount: 7n });
  });

  it('approve / unknown → other, with the selector', () => {
    expect(classifyBatchCalldata({ to: TOKEN, data: approve })).toEqual({ kind: 'other', selector: '0x095ea7b3' });
    expect(classifyBatchCalldata({ to: TOKEN, data: '0x12345678abcd' })).toEqual({ kind: 'other', selector: '0x12345678' });
  });

  it('G1 review P3-4: a transfer / transferFrom selector that fails strict decoding is non-canonical — never "other" (it would pass uncounted)', () => {
    const dirty = `${transfer.slice(0, 10)}ff${transfer.slice(12)}` as Hex;
    const cases: Array<[Hex, 'transfer' | 'transferFrom']> = [
      [`${transfer}00` as Hex, 'transfer'], // trailing byte
      [`${transfer}${'00'.repeat(32)}` as Hex, 'transfer'], // trailing word
      [transfer.slice(0, -2) as Hex, 'transfer'], // truncated
      [dirty, 'transfer'], // dirty address padding
      [ERC20_TRANSFER_SELECTOR, 'transfer'], // bare selector
      [`${transferFrom}ab` as Hex, 'transferFrom'],
      [`${transferFrom.slice(0, 10)}${'ff'.repeat(12)}${transferFrom.slice(34)}` as Hex, 'transferFrom'],
      [`${transfer.toUpperCase().replace('0X', '0x')}00` as Hex, 'transfer'], // case does not hide it
    ];
    for (const [data, fn] of cases) {
      expect(classifyBatchCalldata({ to: TOKEN, data }), data).toEqual({
        kind: 'non-canonical-erc20',
        fn,
        selector: fn === 'transfer' ? ERC20_TRANSFER_SELECTOR : ERC20_TRANSFER_FROM_SELECTOR,
      });
    }
    // The canonical encodings are unchanged.
    expect(classifyBatchCalldata({ to: TOKEN, data: transfer })).toMatchObject({ kind: 'erc20-transfer' });
  });
});
