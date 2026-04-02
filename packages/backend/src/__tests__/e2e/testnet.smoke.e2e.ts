import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const RPC_URL = process.env['E2E_TESTNET_RPC_URL'];
const POLICY_MODULE_ADDRESS = process.env['E2E_TESTNET_POLICY_MODULE_ADDRESS'];
const EXECUTOR_ADDRESS = process.env['E2E_TESTNET_EXECUTOR_ADDRESS'];

const HAS_TESTNET_ENV = Boolean(
  RPC_URL && POLICY_MODULE_ADDRESS && EXECUTOR_ADDRESS,
);

const describeTestnet = HAS_TESTNET_ENV ? describe : describe.skip;

describeTestnet('E2E Testnet Smoke (Base Sepolia)', () => {
  it('connects and confirms chain liveness', async () => {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC_URL!),
    });

    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);

    expect(chainId).toBe(baseSepolia.id);
    expect(blockNumber).toBeGreaterThan(0n);
  });

  it('verifies deployed contracts and basic metadata', async () => {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC_URL!),
    });

    const policyAddress = getAddress(POLICY_MODULE_ADDRESS!);
    const executorAddress = getAddress(EXECUTOR_ADDRESS!);

    const [policyCode, executorCode, operator, feeBps, policyModule] = await Promise.all([
      client.getBytecode({ address: policyAddress }),
      client.getBytecode({ address: executorAddress }),
      client.readContract({
        address: policyAddress,
        abi: [
          {
            name: 'operator',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ name: '', type: 'address' }],
          },
        ] as const,
        functionName: 'operator',
      }),
      client.readContract({
        address: executorAddress,
        abi: [
          {
            name: 'feeBps',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ] as const,
        functionName: 'feeBps',
      }),
      client.readContract({
        address: executorAddress,
        abi: [
          {
            name: 'policyModule',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ name: '', type: 'address' }],
          },
        ] as const,
        functionName: 'policyModule',
      }),
    ]);

    expect(policyCode).not.toBe('0x');
    expect(executorCode).not.toBe('0x');
    expect(getAddress(operator)).toBeTruthy();
    expect(feeBps).toBeGreaterThanOrEqual(0n);
    expect(getAddress(policyModule)).toBe(policyAddress);
  });
});
