import { Turnkey } from '@turnkey/sdk-server';
import { getAddress, type Address } from 'viem';
import { env } from '../../config/env.js';

export interface WalletInfo {
  walletId: string;
  address: Address;
}

export interface SignedTransaction {
  signedTransaction: string;
}

let turnkeyClient: Turnkey | null = null;

function getTurnkeyClient(): Turnkey {
  if (!turnkeyClient) {
    turnkeyClient = new Turnkey({
      apiBaseUrl: 'https://api.turnkey.com',
      apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
      apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
      defaultOrganizationId: env.TURNKEY_ORGANIZATION_ID,
    });
  }
  return turnkeyClient;
}

export class TurnkeyService {
  private client: Turnkey;

  constructor() {
    this.client = getTurnkeyClient();
  }

  /**
   * Provisions a new MPC wallet for an agent.
   * The private key is never exposed — only the public address is returned.
   */
  async createWallet(agentName: string): Promise<WalletInfo> {
    const apiClient = this.client.apiClient();

    const { walletId, addresses } = await apiClient.createWallet({
      walletName: `agentfi-${agentName}-${Date.now()}`,
      accounts: [
        {
          curve: 'CURVE_SECP256K1',
          pathFormat: 'PATH_FORMAT_BIP32',
          path: "m/44'/60'/0'/0/0",
          addressFormat: 'ADDRESS_FORMAT_ETHEREUM',
        },
      ],
    });

    const rawAddress = addresses[0];
    if (!rawAddress) {
      throw new Error('Turnkey returned no address for the new wallet');
    }

    return {
      walletId,
      address: getAddress(rawAddress),
    };
  }

  /**
   * Returns the public Ethereum address for a wallet.
   * Never exposes the private key.
   */
  async getWalletAddress(walletId: string): Promise<Address> {
    const apiClient = this.client.apiClient();

    const { accounts } = await apiClient.getWalletAccounts({
      organizationId: env.TURNKEY_ORGANIZATION_ID,
      walletId,
    });

    const account = accounts[0];
    if (!account?.address) {
      throw new Error(`No address found for wallet ${walletId}`);
    }

    return getAddress(account.address);
  }

  /**
   * Signs a raw transaction payload using the MPC wallet.
   * The private key shards never leave Turnkey's infrastructure.
   */
  async signTransaction(params: {
    walletId: string;
    unsignedTx: string;
    chainId: number;
  }): Promise<string> {
    const apiClient = this.client.apiClient();

    const address = await this.getWalletAddress(params.walletId);

    const { signedTransaction } = await apiClient.signTransaction({
      signWith: address,
      unsignedTransaction: params.unsignedTx,
      type: 'TRANSACTION_TYPE_ETHEREUM',
    });

    return signedTransaction;
  }

  /**
   * Lists all wallets for the organization.
   */
  async listWallets(): Promise<Array<{ walletId: string; walletName: string }>> {
    const apiClient = this.client.apiClient();
    const { wallets } = await apiClient.getWallets({
      organizationId: env.TURNKEY_ORGANIZATION_ID,
    });

    return wallets.map((w) => ({
      walletId: w.walletId,
      walletName: w.walletName,
    }));
  }

  /**
   * Verifies the Turnkey connection is healthy.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.listWallets();
      return true;
    } catch {
      return false;
    }
  }
}
