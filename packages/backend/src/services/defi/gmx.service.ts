/**
 * GMX V2 Perpetuals Service
 *
 * Interfaces with GMX V2 Synthetics contracts on Arbitrum for perpetual
 * position management. GMX V2 uses an order-based system: create an order,
 * keeper executes it after price feed update.
 *
 * Contracts: https://github.com/gmx-io/gmx-synthetics
 * Docs: https://docs.gmx.io/docs/api/contracts-v2
 */

import { createPublicClient, http, type Address, formatUnits, keccak256, toHex } from 'viem';
import { arbitrum } from 'viem/chains';
import { getPrimaryRpcUrl } from '../../config/chains.js';

// GMX V2 contract addresses — Arbitrum One only for now. exchangeRouter /
// router / orderVault must equal config/contracts.ts (which carries their
// sources and the S7 notes; pinned by __tests__/contracts.addresses.test.ts).
// dataStore, depositVault, withdrawalVault: gmx-io/gmx-synthetics@a85ea34
// deployments/arbitrum/*.json. reader: an older GMX Reader (current one:
// 0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789); its getMarket() still answers
// for the DataStore on 2026-10-14.
export const GMX_CONTRACTS: Record<number, {
  exchangeRouter: Address;
  router: Address;
  orderVault: Address;
  dataStore: Address;
  reader: Address;
  depositVault: Address;
  withdrawalVault: Address;
}> = {
  42161: {
    exchangeRouter: '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
    router: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
    orderVault: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
    dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    reader: '0xf60becbba223EEA9495Da3f606753867eC10d139',
    depositVault: '0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55',
    withdrawalVault: '0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55',
  },
};

// GMX V2 Reader ABI — for fetching market prices and position info
const READER_ABI = [
  {
    name: 'getMarket',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'dataStore', type: 'address' },
      { name: 'marketToken', type: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'marketToken', type: 'address' },
          { name: 'indexToken', type: 'address' },
          { name: 'longToken', type: 'address' },
          { name: 'shortToken', type: 'address' },
        ],
      },
    ],
  },
] as const;

// DataStore ABI — for reading execution fee
const DATASTORE_ABI = [
  {
    name: 'getUint',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'key', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface GmxMarketInfo {
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
}

export interface GmxExecutionFeeResult {
  executionFee: string;
  executionFeeWei: bigint;
}

// Well-known GMX V2 markets on Arbitrum — gmx-io/gmx-interface@8974a1f
// sdk/src/configs/markets.ts ([WETH-USDC], [WBTC.e-USDC], [ARB-USDC],
// [SOL-USDC], [LINK-USDC]); each one's Reader.getMarket(DataStore) returned
// it on 2026-10-14. S7: BTC/USD was 0x47c031236e19d024b42f8ae6da7a02043640408d
// (invalid EIP-55, no code, unknown to the DataStore).
export const GMX_MARKETS: Record<string, { marketToken: Address; label: string }> = {
  'ETH/USD': { marketToken: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', label: 'ETH/USD' },
  'BTC/USD': { marketToken: '0x47c031236e19d024b42f8AE6780E44A573170703', label: 'BTC/USD' },
  'ARB/USD': { marketToken: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407', label: 'ARB/USD' },
  'SOL/USD': { marketToken: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9', label: 'SOL/USD' },
  'LINK/USD': { marketToken: '0x7f1fa204bb700853D36994DA19F830b6Ad18455C', label: 'LINK/USD' },
};

export class GmxService {
  private getClient(chainId: number) {
    const url = getPrimaryRpcUrl(chainId);
    return createPublicClient({ chain: arbitrum, transport: http(url) });
  }

  private getContracts(chainId: number) {
    const contracts = GMX_CONTRACTS[chainId];
    if (!contracts) throw new Error(`GMX V2 not available on chain ${chainId}`);
    return contracts;
  }

  async getMarketInfo(params: {
    chainId: number;
    marketToken: Address;
  }): Promise<GmxMarketInfo> {
    const client = this.getClient(params.chainId);
    const contracts = this.getContracts(params.chainId);

    const result = await client.readContract({
      address: contracts.reader,
      abi: READER_ABI,
      functionName: 'getMarket',
      args: [contracts.dataStore, params.marketToken],
    });

    return {
      marketToken: result.marketToken,
      indexToken: result.indexToken,
      longToken: result.longToken,
      shortToken: result.shortToken,
    };
  }

  async getExecutionFee(params: {
    chainId: number;
    orderType: 'increase' | 'decrease';
  }): Promise<GmxExecutionFeeResult> {
    const client = this.getClient(params.chainId);
    const contracts = this.getContracts(params.chainId);

    // GMX V2 DataStore keys are keccak256 hashes of the key string
    const gasLimitKey = params.orderType === 'increase'
      ? keccak256(toHex('INCREASE_ORDER_GAS_LIMIT'))
      : keccak256(toHex('DECREASE_ORDER_GAS_LIMIT'));

    try {
      const gasLimit = await client.readContract({
        address: contracts.dataStore,
        abi: DATASTORE_ABI,
        functionName: 'getUint',
        args: [gasLimitKey as `0x${string}`],
      });

      const gasPrice = await client.getGasPrice();
      const executionFeeWei = gasLimit * gasPrice * 2n; // 2x buffer for keeper
      return {
        executionFee: formatUnits(executionFeeWei, 18),
        executionFeeWei,
      };
    } catch {
      // Fallback: reasonable default for Arbitrum (~0.001 ETH)
      const fallback = 1000000000000000n; // 0.001 ETH
      return {
        executionFee: formatUnits(fallback, 18),
        executionFeeWei: fallback,
      };
    }
  }

  resolveMarket(marketLabel: string): Address | undefined {
    const upper = marketLabel.toUpperCase().replace(/\s+/g, '');
    return GMX_MARKETS[upper]?.marketToken;
  }

  listMarkets(): Array<{ label: string; marketToken: Address }> {
    return Object.values(GMX_MARKETS);
  }
}

export const gmxService = new GmxService();
