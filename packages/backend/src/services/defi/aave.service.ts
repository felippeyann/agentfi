import { Pool } from '@aave/contract-helpers';
import { createPublicClient, http } from 'viem';
import { mainnet, base, arbitrum, polygon } from 'viem/chains';
import { ethers } from 'ethers';

const CHAINS: Record<number, any> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon
};

export class AaveService {
  private getProvider(chainId: number) {
    const alchemyKey = process.env['ALCHEMY_API_KEY'];
    const rpcUrls: Record<number, string> = {
      1:     alchemyKey ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://cloudflare-eth.com',
      8453:  alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://mainnet.base.org',
      42161: alchemyKey ? `https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://arb1.arbitrum.io/rpc',
      137:   alchemyKey ? `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}` : 'https://polygon-rpc.com',
    };
    const url = rpcUrls[chainId] ?? rpcUrls[1]!;
    return new ethers.providers.JsonRpcProvider(url);
  }

  /**
   * Generates calldata for supplying an asset to Aave V3.
   */
  async getSupplyCalldata(
    asset: string,
    amount: string, // in base units
    onBehalfOf: string,
    chainId: number
  ): Promise<{ target: string; value: string; data: string }> {
    const provider = this.getProvider(chainId);
    const pool = new Pool(provider, {
      POOL: process.env.AAVE_POOL_ADDRESS || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' // Mainnet V3 by default
    });

    const txs = await pool.supply({
      user: onBehalfOf,
      reserve: asset,
      amount,
      onBehalfOf
    });

    // Extract the primary supply transaction (usually the last or only one if no approve needed inline)
    const supplyTx = txs.find((t: any) => t.txType === 'ERC20_APPROVAL' || t.txType === 'DLP_ACTION' || t.__type === 'Supply') as any;
    // Simplified return mapping
    if (!supplyTx) throw new Error('Could not generate supply calldata');

    return {
      target: (supplyTx.to as string) || '',
      value: (supplyTx.value as string) || '0',
      data: (supplyTx.data as string) || ''
    };
  }

  /**
   * Generates calldata for withdrawing an asset from Aave V3.
   */
  async getWithdrawCalldata(
    asset: string,
    amount: string, // in base units or "max" (-1)
    to: string,
    chainId: number
  ): Promise<{ target: string; value: string; data: string }> {
    const provider = this.getProvider(chainId);
    const pool = new Pool(provider, {
      POOL: process.env.AAVE_POOL_ADDRESS || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
    });

    const txs = await pool.withdraw({
      user: to,
      reserve: asset,
      amount: amount === 'max' ? '-1' : amount,
      onBehalfOf: to,
      aTokenAddress: '' // Automatically resolved by SDK or requires lookup in real impl
    });

    const withdrawTx = txs[0] as any;
    if (!withdrawTx) throw new Error('Could not generate withdraw calldata');

    return {
      target: (withdrawTx.to as string) || '',
      value: (withdrawTx.value as string) || '0',
      data: (withdrawTx.data as string) || ''
    };
  }
}

export const aaveService = new AaveService();
