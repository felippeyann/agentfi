/**
 * On-Chain Escrow Service (v3)
 *
 * Wraps EscrowModule.sol for the backend. When the EscrowModule contract is
 * deployed on a chain (ESCROW_MODULE_ADDRESS_<chainId> set), this service
 * builds lock/release/refund transactions and routes them through the
 * standard transaction queue.
 *
 * Falls back to the existing database-only escrow (escrow.service.ts) when
 * the contract is not deployed — zero behavior change for chains without it.
 */

import { encodeFunctionData, type Address, type Hex, keccak256, toHex } from 'viem';
import { getContracts } from '../../config/contracts.js';

export interface EscrowLockTx {
  to: Address;
  data: Hex;
  value: bigint;
}

const ESCROW_MODULE_ABI = [
  {
    name: 'lock',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'provider', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'release',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'refund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'getEscrowStatus',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export class OnChainEscrowService {
  jobIdToBytes32(jobId: string): `0x${string}` {
    return keccak256(toHex(jobId));
  }

  isAvailable(chainId: number): boolean {
    try {
      const contracts = getContracts(chainId);
      return !!contracts.escrowModule;
    } catch {
      return false;
    }
  }

  getAddress(chainId: number): Address {
    const contracts = getContracts(chainId);
    if (!contracts.escrowModule) {
      throw new Error(`EscrowModule not deployed on chain ${chainId}`);
    }
    return contracts.escrowModule;
  }

  buildLockEth(params: {
    chainId: number;
    jobId: string;
    provider: Address;
    amountWei: bigint;
  }): EscrowLockTx {
    const escrowAddr = this.getAddress(params.chainId);
    const jobIdBytes = this.jobIdToBytes32(params.jobId);

    return {
      to: escrowAddr,
      data: encodeFunctionData({
        abi: ESCROW_MODULE_ABI,
        functionName: 'lock',
        args: [
          jobIdBytes,
          params.provider,
          '0x0000000000000000000000000000000000000000' as Address,
          params.amountWei,
        ],
      }),
      value: params.amountWei,
    };
  }

  buildLockToken(params: {
    chainId: number;
    jobId: string;
    provider: Address;
    token: Address;
    amount: bigint;
  }): EscrowLockTx {
    const escrowAddr = this.getAddress(params.chainId);
    const jobIdBytes = this.jobIdToBytes32(params.jobId);

    return {
      to: escrowAddr,
      data: encodeFunctionData({
        abi: ESCROW_MODULE_ABI,
        functionName: 'lock',
        args: [jobIdBytes, params.provider, params.token, params.amount],
      }),
      value: 0n,
    };
  }

  buildRelease(params: { chainId: number; jobId: string }): { to: Address; data: Hex } {
    const escrowAddr = this.getAddress(params.chainId);
    const jobIdBytes = this.jobIdToBytes32(params.jobId);

    return {
      to: escrowAddr,
      data: encodeFunctionData({
        abi: ESCROW_MODULE_ABI,
        functionName: 'release',
        args: [jobIdBytes],
      }),
    };
  }

  buildRefund(params: { chainId: number; jobId: string }): { to: Address; data: Hex } {
    const escrowAddr = this.getAddress(params.chainId);
    const jobIdBytes = this.jobIdToBytes32(params.jobId);

    return {
      to: escrowAddr,
      data: encodeFunctionData({
        abi: ESCROW_MODULE_ABI,
        functionName: 'refund',
        args: [jobIdBytes],
      }),
    };
  }
}

export const onChainEscrowService = new OnChainEscrowService();
