/**
 * Unit tests — S9: `SafeService.deploySafeForAgent` enables the configured
 * AgentPolicyModule as a Safe MODULE (which may then move everything the
 * Safe holds). Nothing is deployed unless this process verified that module
 * against this build (`policyStackGate`). The real Safe contracts path (an
 * Anvil fork of Base Sepolia) is in `contract-identity.safe.anvil.ts`.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  init: vi.fn(),
  policyModule: '0x00000000000000000000000000000000000A0D01' as string | undefined,
}));

vi.mock('@safe-global/protocol-kit', () => ({ default: { init: h.init } }));
vi.mock('../config/policy-stack-verification.runtime.js', () => ({ policyStackGate: h.gate }));
vi.mock('../config/contracts.js', () => ({ getContracts: () => ({ policyModule: h.policyModule }) }));
vi.mock('../config/chains.js', () => ({
  getPrimaryRpcUrl: () => 'http://127.0.0.1:1',
  getChain: () => ({ id: 84532 }),
  createChainPublicClient: () => ({}),
}));

import { beforeEach, describe, expect, it } from 'vitest';
import { SafeService } from '../services/wallet/safe.service.js';

const params = {
  ownerAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const,
  chainId: 84532,
  signerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.policyModule = '0x00000000000000000000000000000000000A0D01';
  h.init.mockRejectedValue(new Error('reached protocol-kit (would deploy)'));
});

describe('SafeService.deploySafeForAgent — S9 gate', () => {
  it.each(['not-verified-yet', 'unverified', 'mismatch', 'expired', 'config-changed'] as const)(
    'gate %s → refused BEFORE anything is deployed (no orphaned Safe, no module enabled)',
    async (block) => {
      h.gate.mockReturnValue({ allowed: false, chainId: 84532, block, reason: `module ${block}`, retryAfterSeconds: 120 });
      await expect(new SafeService().deploySafeForAgent(params)).rejects.toThrow(/Safe not deployed: the AgentPolicyModule of chain 84532 is not verified/);
      expect(h.gate).toHaveBeenCalledWith(84532);
      expect(h.init).not.toHaveBeenCalled();
    },
  );

  it('a verified module lets the deployment go on (here it reaches protocol-kit)', async () => {
    h.gate.mockReturnValue({ allowed: true, chainId: 84532, verifiedAt: new Date(), validUntil: new Date(Date.now() + 600_000) });
    await expect(new SafeService().deploySafeForAgent(params)).rejects.toThrow(/reached protocol-kit/);
    expect(h.init).toHaveBeenCalledTimes(1);
  });

  it('no module configured: no module is enabled, so the gate is not consulted', async () => {
    h.policyModule = undefined;
    await expect(new SafeService().deploySafeForAgent(params)).rejects.toThrow(/reached protocol-kit/);
    expect(h.gate).not.toHaveBeenCalled();
  });
});
