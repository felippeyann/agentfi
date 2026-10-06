/**
 * Unit tests — AgentExecutor ABI + ExecutorService + token threading
 *
 * Guards the October-2026 ABI change: `AgentExecutor.Action` is
 * (target, value, token, data). Selectors are asserted against the values the
 * current Solidity source produces, and the checked-in ABI is compared with
 * the Foundry artifact whenever one has been built locally.
 *
 * No Prisma / Redis — pure encoding logic.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  toFunctionSelector,
  zeroAddress,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import { AGENT_EXECUTOR_ABI } from '../abi/AgentExecutor.abi.js';
import { ExecutorService, toExecutorAction } from '../services/transaction/executor.service.js';
import { TransactionBuilder } from '../services/transaction/builder.service.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const CHAIN_ID = 8453;
const EXECUTOR = '0x00000000000000000000000000000000000000E1' as Address;
const TARGET   = '0x1111111111111111111111111111111111111111' as Address;
const SAFE     = '0x2222222222222222222222222222222222222222' as Address;
const USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; // Base USDC
const WETH     = '0x4200000000000000000000000000000000000006' as Address; // Base WETH
const POOL     = '0x3333333333333333333333333333333333333333' as Address;
const VAULT    = '0x4444444444444444444444444444444444444444' as Address;

// Selectors the current AgentExecutor.sol produces. The pre-October-2026
// struct (target, value, data) yielded 0xa60e5271 / 0x34fcd5be instead.
const SELECTOR_EXECUTE_SINGLE = '0x596e8b81';
const SELECTOR_EXECUTE_BATCH  = '0x672093df';

function abiFunction(name: 'executeSingle' | 'executeBatch'): AbiFunction {
  const item = AGENT_EXECUTOR_ABI.find(
    (entry) => entry.type === 'function' && 'name' in entry && entry.name === name,
  );
  if (!item) throw new Error(`ABI item ${name} missing`);
  return item as AbiFunction;
}

// ── Generated ABI ──────────────────────────────────────────────────────────

describe('AgentExecutor ABI (generated from Solidity)', () => {
  it('executeSingle selector matches the token-aware Action struct', () => {
    expect(toFunctionSelector(abiFunction('executeSingle'))).toBe(SELECTOR_EXECUTE_SINGLE);
  });

  it('executeBatch selector matches the token-aware Action struct', () => {
    expect(toFunctionSelector(abiFunction('executeBatch'))).toBe(SELECTOR_EXECUTE_BATCH);
  });

  it('Action tuple is (target, value, token, data)', () => {
    for (const name of ['executeSingle', 'executeBatch'] as const) {
      const input = abiFunction(name).inputs[0] as
        | { components?: readonly { name?: string; type: string }[] }
        | undefined;
      expect(input?.components?.map((c) => `${c.name}:${c.type}`)).toEqual([
        'target:address',
        'value:uint256',
        'token:address',
        'data:bytes',
      ]);
    }
  });

  it('matches the Foundry artifact when one has been built locally', () => {
    // packages/backend/src/__tests__ -> packages/contracts/out
    const artifactPath = fileURLToPath(
      new URL('../../../contracts/out/AgentExecutor.sol/AgentExecutor.json', import.meta.url),
    );
    if (!existsSync(artifactPath)) {
      // `forge build` has not run here (e.g. the backend CI job) — nothing to compare.
      return;
    }
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: unknown };
    expect(AGENT_EXECUTOR_ABI).toEqual(artifact.abi);
  });
});

// ── toExecutorAction ───────────────────────────────────────────────────────

describe('toExecutorAction', () => {
  it('forwards the token when present', () => {
    expect(toExecutorAction({ to: TARGET, data: '0x', value: 1n, token: USDC })).toEqual({
      target: TARGET,
      value: 1n,
      token: USDC,
      data: '0x',
    });
  });

  it('defaults a missing token to the zero address (pure ETH / legacy callers)', () => {
    expect(toExecutorAction({ to: TARGET, data: '0x', value: 1n }).token).toBe(zeroAddress);
  });
});

// ── ExecutorService ────────────────────────────────────────────────────────

describe('ExecutorService', () => {
  const svc = new ExecutorService();
  const envKey = `EXECUTOR_ADDRESS_${CHAIN_ID}`;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[envKey];
    process.env[envKey] = EXECUTOR;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });

  describe('wrapSingle', () => {
    it('returns the tx unchanged when no executor is configured for the chain', () => {
      delete process.env[envKey];
      const tx = { to: TARGET, data: '0xdeadbeef' as Hex, value: 10_000n, token: USDC };
      expect(svc.wrapSingle(CHAIN_ID, tx)).toEqual({ ...tx, feeWei: 0n, routedViaExecutor: false });
    });

    it('does not wrap zero-value (ERC-20 only) txs', () => {
      const tx = { to: USDC, data: '0xdeadbeef' as Hex, value: 0n, token: USDC };
      expect(svc.wrapSingle(CHAIN_ID, tx)).toEqual({ ...tx, feeWei: 0n, routedViaExecutor: false });
    });

    it('encodes executeSingle with (target, value, token, data) and adds the fee', () => {
      const tx = { to: TARGET, data: '0xdeadbeef' as Hex, value: 10_000n, token: WETH };
      const wrapped = svc.wrapSingle(CHAIN_ID, tx);

      expect(wrapped.to).toBe(EXECUTOR);
      expect(wrapped.routedViaExecutor).toBe(true);
      expect(wrapped.feeWei).toBe(30n);          // 10_000 * 30 / 10_000
      expect(wrapped.value).toBe(10_030n);       // action value + fee
      expect(wrapped.data.slice(0, 10)).toBe(SELECTOR_EXECUTE_SINGLE);

      const decoded = decodeFunctionData({ abi: AGENT_EXECUTOR_ABI, data: wrapped.data });
      expect(decoded.functionName).toBe('executeSingle');
      expect(decoded.args).toEqual([{ target: TARGET, value: 10_000n, token: WETH, data: '0xdeadbeef' }]);
    });

    it('uses the zero address as token for pure-ETH actions', () => {
      const wrapped = svc.wrapSingle(CHAIN_ID, { to: TARGET, data: '0x', value: 1_000_000n });
      const decoded = decodeFunctionData({ abi: AGENT_EXECUTOR_ABI, data: wrapped.data });
      expect(decoded.args).toEqual([{ target: TARGET, value: 1_000_000n, token: zeroAddress, data: '0x' }]);
    });
  });

  describe('wrapBatch', () => {
    it('throws when no executor is configured', () => {
      delete process.env[envKey];
      expect(() => svc.wrapBatch(CHAIN_ID, [{ to: TARGET, data: '0x', value: 1n }])).toThrow(
        /No AgentExecutor deployed/,
      );
    });

    it('encodes executeBatch with a per-action token and fees the total value', () => {
      const txs = [
        { to: TARGET, data: '0x01' as Hex, value: 10_000n, token: USDC },
        { to: SAFE,   data: '0x'   as Hex, value: 20_000n },
      ];
      const wrapped = svc.wrapBatch(CHAIN_ID, txs);

      expect(wrapped.to).toBe(EXECUTOR);
      expect(wrapped.feeWei).toBe(90n);          // 30_000 * 30 / 10_000
      expect(wrapped.value).toBe(30_090n);
      expect(wrapped.data.slice(0, 10)).toBe(SELECTOR_EXECUTE_BATCH);

      const decoded = decodeFunctionData({ abi: AGENT_EXECUTOR_ABI, data: wrapped.data });
      expect(decoded.functionName).toBe('executeBatch');
      expect(decoded.args).toEqual([
        [
          { target: TARGET, value: 10_000n, token: USDC,        data: '0x01' },
          { target: SAFE,   value: 20_000n, token: zeroAddress, data: '0x'   },
        ],
      ]);
    });
  });

  it('estimateFee mirrors the on-chain 30 bps', () => {
    expect(svc.estimateFee(1_000_000n)).toBe(3_000n);
  });

  describe('legacy executor (pre-October-2026 Action struct)', () => {
    const LEGACY_EXECUTOR_8453 = '0x54415F0Bc61436193D2a8dD00e356eD9EBfd24b3';

    it('is treated as not configured: routes direct, never wraps, warns once per chain', () => {
      process.env[envKey] = LEGACY_EXECUTOR_8453;
      const warn = vi.fn();
      const legacySvc = new ExecutorService({ warn });
      const tx = { to: TARGET, data: '0xdeadbeef' as Hex, value: 10_000n, token: WETH };

      expect(legacySvc.getExecutorAddress(CHAIN_ID)).toBeNull();
      expect(legacySvc.wrapSingle(CHAIN_ID, tx)).toEqual({ ...tx, feeWei: 0n, routedViaExecutor: false });
      expect(() => legacySvc.wrapBatch(CHAIN_ID, [tx])).toThrow(/No AgentExecutor deployed/);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ chainId: CHAIN_ID, executor: LEGACY_EXECUTOR_8453 });
      expect(warn.mock.calls[0]![1]).toMatch(/pre-October-2026[\s\S]*DIRECTLY/);
    });

    it('the same legacy address on another chain is not legacy there', () => {
      const otherChain = 137;
      const otherKey = `EXECUTOR_ADDRESS_${otherChain}`;
      const prev = process.env[otherKey];
      process.env[otherKey] = LEGACY_EXECUTOR_8453;
      try {
        const warn = vi.fn();
        expect(new ExecutorService({ warn }).getExecutorAddress(otherChain)).toBe(LEGACY_EXECUTOR_8453);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env[otherKey];
        else process.env[otherKey] = prev;
      }
    });
  });
});

// ── TransactionBuilder token threading ─────────────────────────────────────

describe('TransactionBuilder tags TransactionData.token', () => {
  const builder = new TransactionBuilder();

  it('ETH transfer → zero address', () => {
    expect(builder.buildEthTransfer({ to: TARGET, amountEth: '0.5' }).token).toBe(zeroAddress);
  });

  it('ERC-20 transfer / approve → the token contract', () => {
    expect(
      builder.buildTokenTransfer({ tokenAddress: USDC, to: TARGET, amount: '1', decimals: 6 }).token,
    ).toBe(USDC);
    expect(builder.buildApprove({ tokenAddress: USDC, spender: TARGET, amount: 1n }).token).toBe(USDC);
  });

  it('Uniswap swap → tokenIn (also when tokenIn is WETH paid as native ETH)', () => {
    const erc20In = builder.buildUniswapSwap({
      chainId: CHAIN_ID, tokenIn: USDC, tokenOut: WETH, fee: 500,
      recipient: SAFE, amountIn: 1_000_000n, amountOutMinimum: 0n,
    });
    expect(erc20In.token).toBe(USDC);
    expect(erc20In.value).toBe(0n);

    const nativeIn = builder.buildUniswapSwap({
      chainId: CHAIN_ID, tokenIn: WETH, tokenOut: USDC, fee: 500,
      recipient: SAFE, amountIn: 1_000_000n, amountOutMinimum: 0n,
    });
    expect(nativeIn.token).toBe(WETH);
    expect(nativeIn.value).toBe(1_000_000n);
  });

  it('Aave / Compound supply & withdraw → the asset', () => {
    expect(builder.buildAaveSupply({ poolAddress: POOL, asset: USDC, amount: 1n, onBehalfOf: SAFE }).token).toBe(USDC);
    expect(builder.buildAaveWithdraw({ poolAddress: POOL, asset: USDC, amount: 1n, to: SAFE }).token).toBe(USDC);
    expect(builder.buildCompoundSupply({ cometAddress: POOL, asset: USDC, amount: 1n }).token).toBe(USDC);
    expect(builder.buildCompoundWithdraw({ cometAddress: POOL, asset: USDC, amount: 1n }).token).toBe(USDC);
  });

  it('ERC-4626 deposit / withdraw → the asset only when the caller supplies it', () => {
    const untagged = builder.buildErc4626Deposit({ vaultAddress: VAULT, assetAmount: 1n, receiver: SAFE });
    expect('token' in untagged).toBe(false);

    expect(
      builder.buildErc4626Deposit({ vaultAddress: VAULT, assetAmount: 1n, receiver: SAFE, asset: USDC }).token,
    ).toBe(USDC);
    expect(
      builder.buildErc4626Withdraw({ vaultAddress: VAULT, assetAmount: 1n, receiver: SAFE, owner: SAFE, asset: USDC }).token,
    ).toBe(USDC);
  });

  it('Curve exchange → tokenIn only when the caller supplies it', () => {
    const untagged = builder.buildCurveSwap({ poolAddress: POOL, i: 0n, j: 1n, amountIn: 1n, minAmountOut: 0n });
    expect('token' in untagged).toBe(false);

    expect(
      builder.buildCurveSwap({ poolAddress: POOL, i: 0n, j: 1n, amountIn: 1n, minAmountOut: 0n, tokenIn: USDC }).token,
    ).toBe(USDC);
  });

  it('GMX createOrder → the collateral token', () => {
    const tx = builder.buildGmxCreateOrder({
      exchangeRouter: TARGET,
      orderVault: POOL,
      market: VAULT,
      initialCollateralToken: USDC,
      sizeDeltaUsd: 1n,
      initialCollateralDeltaAmount: 1n,
      acceptablePrice: 1n,
      executionFee: 100n,
      isLong: true,
      orderType: 'MarketIncrease',
      receiver: SAFE,
    });
    expect(tx.token).toBe(USDC);
    expect(tx.value).toBe(100n);
  });
});
