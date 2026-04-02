import { describe, expect, it } from 'vitest';
import { createPublicClient, getAddress, http } from 'viem';
import { base } from 'viem/chains';

const ANVIL_RPC = process.env['E2E_ANVIL_RPC'] ?? 'http://127.0.0.1:8545';
const IS_FORK_MODE = process.env['E2E_ANVIL_MODE'] === 'fork';

const describeFork = IS_FORK_MODE ? describe : describe.skip;

describeFork('E2E Fork Smoke', () => {
  it('connects to forked Anvil and sees non-zero chain activity', async () => {
    const client = createPublicClient({
      chain: {
        ...base,
        rpcUrls: { default: { http: [ANVIL_RPC] }, public: { http: [ANVIL_RPC] } },
      },
      transport: http(ANVIL_RPC),
    });

    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);

    expect(chainId).toBe(8453);
    expect(blockNumber).toBeGreaterThan(0n);
  });

  it('deploys and exposes policy/executor metadata on fork mode', async () => {
    const policyAddress = process.env['POLICY_MODULE_ADDRESS_8453'];
    const executorAddress = process.env['EXECUTOR_ADDRESS_8453'];

    expect(policyAddress).toBeTruthy();
    expect(executorAddress).toBeTruthy();

    const client = createPublicClient({
      chain: {
        ...base,
        rpcUrls: { default: { http: [ANVIL_RPC] }, public: { http: [ANVIL_RPC] } },
      },
      transport: http(ANVIL_RPC),
    });

    const [policyCode, executorCode, operator, feeBps, policyModule] = await Promise.all([
      client.getBytecode({ address: getAddress(policyAddress!) }),
      client.getBytecode({ address: getAddress(executorAddress!) }),
      client.readContract({
        address: getAddress(policyAddress!),
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
        address: getAddress(executorAddress!),
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
        address: getAddress(executorAddress!),
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
    expect(getAddress(policyModule)).toBe(getAddress(policyAddress!));
  });
});
