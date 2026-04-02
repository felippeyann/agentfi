import Safe, { SafeFactory } from '@safe-global/protocol-kit';
import type { SafeAccountConfig } from '@safe-global/protocol-kit';
import { getAddress, type Address } from 'viem';
import { createChainPublicClient, getPrimaryRpcUrl } from '../../config/chains.js';
import { getContracts } from '../../config/contracts.js';

export interface DeployedSafe {
  safeAddress: Address;
  deployTxHash: string;
}

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

    const safeFactory = await SafeFactory.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
    });

    const safeAccountConfig: SafeAccountConfig = {
      owners: [ownerAddress],
      threshold: 1,
    };

    // Deploy Safe — modules are installed post-deployment via execTransaction
    const safeSdk = await safeFactory.deploySafe({ safeAccountConfig });
    const safeAddress = getAddress(await safeSdk.getAddress());

    // If AgentPolicyModule is deployed, enable it on the Safe
    if (contracts.policyModule) {
      await this.enableModule(safeSdk, contracts.policyModule);
    }

    return {
      safeAddress,
      deployTxHash: safeAddress, // Safe deployment address serves as identifier
    };
  }

  /**
   * Enables a module on an existing Safe.
   */
  private async enableModule(safeSdk: Awaited<ReturnType<InstanceType<typeof SafeFactory>['deploySafe']>>, moduleAddress: Address): Promise<void> {
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
  }): Promise<Awaited<ReturnType<InstanceType<typeof SafeFactory>['deploySafe']>>> {
    const rpcUrl = getPrimaryRpcUrl(params.chainId);

    // Safe.init is a static method; cast needed due to CJS/ESM interop under NodeNext
    return (Safe as any).init({
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
