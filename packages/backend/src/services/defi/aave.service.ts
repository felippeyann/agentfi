import { Pool } from '@aave/contract-helpers';
import { ethers } from 'ethers';
import { getPrimaryRpcUrl } from '../../config/chains.js';

export class AaveService {
  private getProvider(chainId: number) {
    const url = getPrimaryRpcUrl(chainId);
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
