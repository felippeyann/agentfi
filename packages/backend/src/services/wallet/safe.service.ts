import * as SafeModule from '@safe-global/protocol-kit';
import type { SafeAccountConfig } from '@safe-global/protocol-kit';
import { createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createChainPublicClient, getChain, getPrimaryRpcUrl } from '../../config/chains.js';
import { getContracts } from '../../config/contracts.js';

export interface DeployedSafe {
  safeAddress: Address;
  deployTxHash: string;
}

type SafeProtocolKit = {
  getAddress(): Promise<string>;
  createSafeDeploymentTransaction(): Promise<{ to: string; value: string; data: string }>;
  createEnableModuleTx(moduleAddress: string): Promise<unknown>;
  signTransaction(safeTransaction: unknown): Promise<unknown>;
  executeTransaction(safeTransaction: unknown): Promise<unknown>;
};

type SafeInitConfig =
  | {
      provider: string;
      signer: string;
      predictedSafe: { safeAccountConfig: SafeAccountConfig };
      safeAddress?: never;
    }
  | {
      provider: string;
      signer: string;
      safeAddress: Address;
      predictedSafe?: never;
    };

const Safe = (
  SafeModule as unknown as {
    default: { init(config: SafeInitConfig): Promise<SafeProtocolKit> };
  }
).default;

export class SafeService {
  /**
   * Deploys a Safe smart wallet with the AgentPolicyModule installed.
   * The Turnkey EOA address is set as the sole owner (1/1 threshold).
   */
  async deploySafeForAgent(params: {
    ownerAddress: Address;
    chainId: number;
    signerPrivateKey: string; // funding wallet private key for deployment gas
  }): Promise<DeployedSafe> {
    const { ownerAddress, chainId, signerPrivateKey } = params;
    const contracts = getContracts(chainId);
    const rpcUrl = getPrimaryRpcUrl(chainId);

    const safeAccountConfig: SafeAccountConfig = {
      owners: [ownerAddress],
      threshold: 1,
    };

    const safeSdk = await Safe.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
      predictedSafe: { safeAccountConfig },
    });
    const safeAddress = getAddress(await safeSdk.getAddress());

    const deploymentTx = await safeSdk.createSafeDeploymentTransaction();
    const account = privateKeyToAccount(signerPrivateKey as Hex);
    const walletClient = createWalletClient({
      account,
      chain: getChain(chainId),
      transport: http(rpcUrl),
    });

    const deployTxHash = await walletClient.sendTransaction({
      to: getAddress(deploymentTx.to),
      value: BigInt(deploymentTx.value),
      data: deploymentTx.data as Hex,
    });

    const publicClient = createChainPublicClient(chainId);
    await publicClient.waitForTransactionReceipt({ hash: deployTxHash });

    const deployedSafeSdk = await this.loadSafe({
      safeAddress,
      chainId,
      signerPrivateKey,
    });

    // If AgentPolicyModule is deployed, enable it on the Safe
    if (contracts.policyModule) {
      await this.enableModule(deployedSafeSdk, contracts.policyModule);
    }

    return {
      safeAddress,
      deployTxHash,
    };
  }

  /**
   * Enables a module on an existing Safe.
   */
  private async enableModule(safeSdk: SafeProtocolKit, moduleAddress: Address): Promise<void> {
    const enableModuleTx = await safeSdk.createEnableModuleTx(moduleAddress);
    const signedTx = await safeSdk.signTransaction(enableModuleTx);
    await safeSdk.executeTransaction(signedTx);
  }

  /**
   * Loads an existing Safe for transaction execution.
   */
  async loadSafe(params: {
    safeAddress: Address;
    chainId: number;
    signerPrivateKey: string;
  }): Promise<SafeProtocolKit> {
    const rpcUrl = getPrimaryRpcUrl(params.chainId);

    return Safe.init({
      provider: rpcUrl,
      signer: params.signerPrivateKey,
      safeAddress: params.safeAddress,
    });
  }

  /**
   * Returns whether a module is enabled on a Safe.
   */
  async isModuleEnabled(params: {
    safeAddress: Address;
    moduleAddress: Address;
    chainId: number;
  }): Promise<boolean> {
    const publicClient = createChainPublicClient(params.chainId);

    // Safe ABI for isModuleEnabled
    const result = await publicClient.readContract({
      address: params.safeAddress,
      abi: [
        {
          name: 'isModuleEnabled',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'module', type: 'address' }],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'isModuleEnabled',
      args: [params.moduleAddress],
    });

    return result;
  }

  /**
   * Gets the ETH balance of a Safe.
   */
  async getSafeBalance(params: { safeAddress: Address; chainId: number }): Promise<bigint> {
    const publicClient = createChainPublicClient(params.chainId);

    return publicClient.getBalance({ address: params.safeAddress });
  }
}
