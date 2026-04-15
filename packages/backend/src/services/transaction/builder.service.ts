/**
 * Transaction Builder — constructs typed calldata for DeFi operations.
 * Agents never deal with ABI encoding directly; this service abstracts it.
 */

import {
  encodeFunctionData,
  parseUnits,
  parseEther,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { getContracts } from '../../config/contracts.js';

// WETH addresses per chain — when swapping FROM these, send ETH as msg.value
const WETH_ADDRESSES: Record<number, string> = {
  1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum
  8453:  '0x4200000000000000000000000000000000000006', // Base
  84532: '0x4200000000000000000000000000000000000006', // Base Sepolia
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum
  137:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // Polygon
};

function isNativeWeth(chainId: number, address: string): boolean {
  return WETH_ADDRESSES[chainId]?.toLowerCase() === address.toLowerCase();
}

export interface TransactionData {
  to: Address;
  data: Hex;
  value: bigint;
}

// ERC-20 ABI (minimal)
const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// Aave V3 Pool ABI (minimal)
const AAVE_POOL_ABI = [
  {
    name: 'supply',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// Compound V3 (Comet) ABI � single-asset market contracts.
// supply(asset, amount): supplies collateral OR base asset to the Comet market.
// withdraw(asset, amount): withdraws base asset (or collateral) back to msg.sender.
const COMPOUND_COMET_ABI = [
  {
    name: 'supply',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// ERC-4626 Tokenized Vault Standard ABI — any compliant vault (Yearn, Morpho,
// Beefy, ERC4626-wrapped strategies). Four functions cover the full lifecycle.
const ERC4626_VAULT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
  {
    name: 'asset',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

// Curve StableSwap (classic) ABI — single function for token-to-token swaps
// within a pool. Works for 3pool, tricrypto, and all classic stable pools.
// The `i` and `j` params are int128 by Curve convention (always non-negative).
const CURVE_STABLESWAP_ABI = [
  {
    name: 'exchange',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'i', type: 'int128' },
      { name: 'j', type: 'int128' },
      { name: 'dx', type: 'uint256' },
      { name: 'min_dy', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// Uniswap V3 SwapRouter02 ABI — exactInputSingle WITHOUT deadline.
// SwapRouter02 moves deadline to the multicall wrapper level.
// Deployed at 0x2626664c2603336E57B271c5C0b26F421741e481 on Base/Arbitrum/Polygon.
const UNISWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'recipient',         type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'amountOutMinimum',  type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export class TransactionBuilder {
  /**
   * Builds a native ETH transfer.
   */
  buildEthTransfer(params: { to: Address; amountEth: string }): TransactionData {
    return {
      to: getAddress(params.to),
      data: '0x',
      value: parseEther(params.amountEth),
    };
  }

  /**
   * Builds an ERC-20 transfer.
   */
  buildTokenTransfer(params: {
    tokenAddress: Address;
    to: Address;
    amount: string;
    decimals: number;
  }): TransactionData {
    return {
      to: getAddress(params.tokenAddress),
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [getAddress(params.to), parseUnits(params.amount, params.decimals)],
      }),
      value: 0n,
    };
  }

  /**
   * Builds a Uniswap V3 exactInputSingle swap.
   */
  buildUniswapSwap(params: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    fee: 500 | 3000 | 10000;
    recipient: Address;
    amountIn: bigint;
    amountOutMinimum: bigint;
  }): TransactionData {
    const contracts = getContracts(params.chainId);

    return {
      to: contracts.uniswapV3Router,
      data: encodeFunctionData({
        abi: UNISWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn:           params.tokenIn,
            tokenOut:          params.tokenOut,
            fee:               params.fee,
            recipient:         params.recipient,
            amountIn:          params.amountIn,
            amountOutMinimum:  params.amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
      // SwapRouter02 wraps native ETH automatically when tokenIn is WETH
      value: isNativeWeth(params.chainId, params.tokenIn) ? params.amountIn : 0n,
    };
  }

  /**
   * Builds an Aave V3 supply (deposit) transaction.
   */
  buildAaveSupply(params: {
    poolAddress: Address;
    asset: Address;
    amount: bigint;
    onBehalfOf: Address;
  }): TransactionData {
    return {
      to: params.poolAddress,
      data: encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: 'supply',
        args: [params.asset, params.amount, params.onBehalfOf, 0], // referralCode = 0
      }),
      value: 0n,
    };
  }

  /**
   * Builds an Aave V3 withdraw transaction.
   */
  buildAaveWithdraw(params: {
    poolAddress: Address;
    asset: Address;
    amount: bigint; // use MaxUint256 to withdraw all
    to: Address;
  }): TransactionData {
    return {
      to: params.poolAddress,
      data: encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: 'withdraw',
        args: [params.asset, params.amount, params.to],
      }),
      value: 0n,
    };
  }

  /**
   * Builds a Compound V3 (Comet) supply transaction.
   * Each Comet market is single-asset (e.g. cUSDCv3 on Base).
   */
  buildCompoundSupply(params: {
    cometAddress: Address;
    asset: Address;
    amount: bigint;
  }): TransactionData {
    return {
      to: params.cometAddress,
      data: encodeFunctionData({
        abi: COMPOUND_COMET_ABI,
        functionName: 'supply',
        args: [params.asset, params.amount],
      }),
      value: 0n,
    };
  }

  /**
   * Builds a Compound V3 (Comet) withdraw transaction.
   * Use MaxUint256 to withdraw the full balance.
   */
  buildCompoundWithdraw(params: {
    cometAddress: Address;
    asset: Address;
    amount: bigint;
  }): TransactionData {
    return {
      to: params.cometAddress,
      data: encodeFunctionData({
        abi: COMPOUND_COMET_ABI,
        functionName: 'withdraw',
        args: [params.asset, params.amount],
      }),
      value: 0n,
    };
  }

  /**
   * Builds an ERC-4626 vault deposit.
   * The vault internally converts assets to shares; receiver gets the shares.
   */
  buildErc4626Deposit(params: {
    vaultAddress: Address;
    assetAmount: bigint;
    receiver: Address;
  }): TransactionData {
    return {
      to: params.vaultAddress,
      data: encodeFunctionData({
        abi: ERC4626_VAULT_ABI,
        functionName: 'deposit',
        args: [params.assetAmount, params.receiver],
      }),
      value: 0n,
    };
  }

  /**
   * Builds an ERC-4626 vault withdraw (assets-denominated).
   * Use `redeem` if you want to burn a specific share amount instead.
   */
  buildErc4626Withdraw(params: {
    vaultAddress: Address;
    assetAmount: bigint;
    receiver: Address;
    owner: Address;
  }): TransactionData {
    return {
      to: params.vaultAddress,
      data: encodeFunctionData({
        abi: ERC4626_VAULT_ABI,
        functionName: 'withdraw',
        args: [params.assetAmount, params.receiver, params.owner],
      }),
      value: 0n,
    };
  }

  /**
   * Builds a Curve StableSwap exchange transaction.
   * Works with classic StableSwap pools (3pool, DAI/USDC/USDT, etc.).
   * The pool address is caller-supplied, allowing any Curve pool to be used.
   *
   * Caller must approve the pool to spend `amountIn` of the input token before
   * calling this. Simulation will fail clearly if approval is missing.
   */
  buildCurveSwap(params: {
    poolAddress: Address;
    i: bigint; // from token index (int128, non-negative)
    j: bigint; // to token index
    amountIn: bigint;
    minAmountOut: bigint;
  }): TransactionData {
    return {
      to: params.poolAddress,
      data: encodeFunctionData({
        abi: CURVE_STABLESWAP_ABI,
        functionName: 'exchange',
        args: [params.i, params.j, params.amountIn, params.minAmountOut],
      }),
      value: 0n, // Curve pools never receive ETH
    };
  }

  /**
   * Builds an ERC-20 approval.
   */
  buildApprove(params: {
    tokenAddress: Address;
    spender: Address;
    amount: bigint;
  }): TransactionData {
    return {
      to: getAddress(params.tokenAddress),
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [params.spender, params.amount],
      }),
      value: 0n,
    };
  }
}
