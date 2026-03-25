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
