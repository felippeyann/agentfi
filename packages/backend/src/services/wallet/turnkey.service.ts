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
    // Defense in depth — env.ts already enforces this when
    // WALLET_PROVIDER=turnkey, but TurnkeyService should refuse to
    // construct a client with undefined credentials regardless of how
    // it got instantiated.
    const {
      TURNKEY_API_PUBLIC_KEY,
      TURNKEY_API_PRIVATE_KEY,
      TURNKEY_ORGANIZATION_ID,
    } = env;
    if (
      !TURNKEY_API_PUBLIC_KEY ||
      !TURNKEY_API_PRIVATE_KEY ||
      !TURNKEY_ORGANIZATION_ID
    ) {
      throw new Error(
        'TurnkeyService requires TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID. ' +
          'Either set them or use WALLET_PROVIDER=local (development only).',
      );
    }
    turnkeyClient = new Turnkey({
      apiBaseUrl: 'https://api.turnkey.com',
      apiPublicKey: TURNKEY_API_PUBLIC_KEY,
      apiPrivateKey: TURNKEY_API_PRIVATE_KEY,
      defaultOrganizationId: TURNKEY_ORGANIZATION_ID,
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
      organizationId: env.TURNKEY_ORGANIZATION_ID!,
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
   * Signs an arbitrary string message with EIP-191 personal_sign format.
   * Used for A2A handshake identity proofs.
   *
   * Implementation: hash the message with viem's `hashMessage` (which
   * applies the standard `\x19Ethereum Signed Message:\n<len><msg>` prefix),
   * then sign the hash via Turnkey's `signRawPayload` with
   * `HASH_FUNCTION_NO_OP` (we pre-hashed). Assemble the r||s||v
   * 65-byte signature that viem's `verifyMessage` / `recoverMessageAddress`
   * accepts.
   */
  async signMessage(params: {
    walletId: string;
    message: string;
  }): Promise<{ signature: `0x${string}`; address: Address }> {
    const apiClient = this.client.apiClient();
    const address = await this.getWalletAddress(params.walletId);

    // EIP-191 personal_sign prefix + keccak256
    const { hashMessage } = await import('viem');
    const digest = hashMessage(params.message);

    const { r, s, v } = await apiClient.signRawPayload({
      signWith: address,
      payload: digest,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    });

    // Turnkey returns r, s as 64-hex strings and v as "00"/"01". Assemble
    // a standard 65-byte Ethereum signature (r || s || v+27).
    const vByte = (parseInt(v, 16) + 27).toString(16).padStart(2, '0');
    const signature = `0x${r.padStart(64, '0')}${s.padStart(64, '0')}${vByte}` as `0x${string}`;

    return { signature, address };
  }

  /**
   * Lists all wallets for the organization.
   */
  async listWallets(): Promise<Array<{ walletId: string; walletName: string }>> {
    const apiClient = this.client.apiClient();
    const { wallets } = await apiClient.getWallets({
      organizationId: env.TURNKEY_ORGANIZATION_ID!,
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
