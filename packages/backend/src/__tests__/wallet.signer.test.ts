/**
 * Unit tests — EIP-712 signing through the wallet providers and the
 * `toClientSigner` adapter used by the x402 client.
 *
 *  - LocalWalletService signs with the in-memory viem account.
 *  - TurnkeyService hashes locally (`hashTypedData`) and sends the digest to
 *    `signRawPayload` with HASH_FUNCTION_NO_OP; the SDK is mocked with an
 *    ephemeral key that signs exactly the digest it receives, so the test
 *    exercises the real digest + r||s||v assembly code.
 *
 * Both providers import config/env (which process.exit()s on missing
 * variables) and the pino logger, so those modules are replaced wholesale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashTypedData, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

const { envState, turnkeyMock } = vi.hoisted(() => {
  const signingKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  return {
    envState: {
      env: {
        NODE_ENV: 'test',
        WALLET_PROVIDER: 'turnkey',
        TURNKEY_API_PUBLIC_KEY: 'pub',
        TURNKEY_API_PRIVATE_KEY: 'priv',
        TURNKEY_ORGANIZATION_ID: 'org',
      },
    },
    turnkeyMock: {
      signingKey,
      calls: [] as Array<Record<string, unknown>>,
      /** How the mocked Turnkey encodes `v`: documented "00"/"01", or already-offset "1b"/"1c". */
      vFormat: 'yParity' as 'yParity' | 'recid27',
      /** When set, returned verbatim as `v` (garbage-in cases). */
      vOverride: undefined as string | undefined,
    },
  };
});

vi.mock('../config/env.js', () => ({ env: envState.env }));
vi.mock('../api/middleware/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@turnkey/sdk-server', () => {
  const account = privateKeyToAccount(turnkeyMock.signingKey);
  class Turnkey {
    apiClient() {
      return {
        getWalletAccounts: async () => ({ accounts: [{ address: account.address }] }),
        signRawPayload: async (params: Record<string, unknown>) => {
          turnkeyMock.calls.push(params);
          // Turnkey's wire format: r and s as bare 64-hex strings, v as "00"/"01"
          // (recovery id) — "1b"/"1c" has been observed too, hence the toggle.
          const signature = await sign({ hash: params['payload'] as `0x${string}`, privateKey: turnkeyMock.signingKey });
          const yParity = signature.yParity === 1 ? 1 : 0;
          return {
            r: signature.r.slice(2),
            s: signature.s.slice(2),
            v:
              turnkeyMock.vOverride ??
              (turnkeyMock.vFormat === 'recid27' ? (27 + yParity).toString(16) : yParity.toString(16).padStart(2, '0')),
          };
        },
      };
    }
  }
  return { Turnkey };
});

import { LocalWalletService, __clearLocalWallets } from '../services/wallet/local.service.js';
import { TurnkeyService } from '../services/wallet/turnkey.service.js';
import { toClientSigner, type Eip712TypedData } from '../services/wallet/signer.js';

/** An ERC-3009 `TransferWithAuthorization` payload, as x402 "exact" signs it. */
const typedData: Eip712TypedData = {
  domain: {
    name: 'USDC',
    version: '2',
    chainId: 84532,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: 400000n,
    validAfter: 0n,
    validBefore: 1_900_000_000n,
    nonce: '0x' + 'ab'.repeat(32),
  },
};

const asViem = typedData as unknown as TypedDataDefinition;

/**
 * The last byte must be 27/28 (`1b`/`1c`): viem's `recoverTypedDataAddress`
 * also accepts 0/1, but USDC's `transferWithAuthorization` runs `ecrecover`
 * on-chain, which does not — a 0/1 signature recovers here and fails there.
 */
function expectEcrecoverV(signature: `0x${string}`): void {
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(signature.slice(-2)).toMatch(/^1[bc]$/);
}

describe('LocalWalletService.signTypedData', () => {
  beforeEach(() => __clearLocalWallets());

  it('produces a signature that recovers to the wallet address', async () => {
    const svc = new LocalWalletService();
    const { walletId, address } = await svc.createWallet('alice');

    const { signature, address: signer } = await svc.signTypedData({ walletId, typedData });
    const recovered = await recoverTypedDataAddress({ ...asViem, signature });

    expect(signer).toBe(address);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
    expectEcrecoverV(signature);
  });

  it('throws for an unknown walletId', async () => {
    const svc = new LocalWalletService();
    await expect(svc.signTypedData({ walletId: 'local-missing', typedData })).rejects.toThrow(/not found/);
  });
});

// The Turnkey mock is module-level state shared by every describe below.
beforeEach(() => {
  turnkeyMock.calls.length = 0;
  turnkeyMock.vFormat = 'yParity';
  turnkeyMock.vOverride = undefined;
});

describe('TurnkeyService.signTypedData', () => {

  it('sends the EIP-712 digest with HASH_FUNCTION_NO_OP and assembles a recoverable signature', async () => {
    const svc = new TurnkeyService();
    const expectedSigner = privateKeyToAccount(turnkeyMock.signingKey).address;

    const { signature, address } = await svc.signTypedData({ walletId: 'wallet-1', typedData });

    expect(address).toBe(expectedSigner);
    expect(turnkeyMock.calls).toHaveLength(1);
    expect(turnkeyMock.calls[0]).toMatchObject({
      signWith: expectedSigner,
      payload: hashTypedData(asViem),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    });
    expectEcrecoverV(signature);

    const recovered = await recoverTypedDataAddress({ ...asViem, signature });
    expect(recovered.toLowerCase()).toBe(expectedSigner.toLowerCase());
  });

  it('does not offset v twice when Turnkey already returns "1b"/"1c"', async () => {
    turnkeyMock.vFormat = 'recid27';
    const svc = new TurnkeyService();
    const expectedSigner = privateKeyToAccount(turnkeyMock.signingKey).address;

    const { signature } = await svc.signTypedData({ walletId: 'wallet-1', typedData });

    expectEcrecoverV(signature);
    const recovered = await recoverTypedDataAddress({ ...asViem, signature });
    expect(recovered.toLowerCase()).toBe(expectedSigner.toLowerCase());
  });

  it('rejects a recovery id outside {0, 1, 27, 28}', async () => {
    turnkeyMock.vOverride = '05';
    const svc = new TurnkeyService();

    await expect(svc.signTypedData({ walletId: 'wallet-1', typedData })).rejects.toThrow(/unexpected recovery id/);
  });
});

describe('toClientSigner', () => {
  beforeEach(() => __clearLocalWallets());

  it('binds a local wallet into an x402-compatible { address, signTypedData }', async () => {
    const svc = new LocalWalletService();
    const { walletId, address } = await svc.createWallet('alice');

    const signer = await toClientSigner(svc, walletId);
    expect(signer.address).toBe(address);

    const signature = await signer.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...asViem, signature });
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
    expectEcrecoverV(signature);
  });

  it('binds a Turnkey wallet the same way', async () => {
    const signer = await toClientSigner(new TurnkeyService(), 'wallet-1');
    const expectedSigner = privateKeyToAccount(turnkeyMock.signingKey).address;

    expect(signer.address).toBe(expectedSigner);
    const signature = await signer.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...asViem, signature });
    expect(recovered.toLowerCase()).toBe(expectedSigner.toLowerCase());
    expectEcrecoverV(signature);
  });

  it('rejects a provider that returns a non-address', async () => {
    const broken = {
      getWalletAddress: async () => 'not-an-address' as `0x${string}`,
      signTypedData: async () => ({ signature: '0x' as const, address: '0x' as `0x${string}` }),
    };
    await expect(toClientSigner(broken, 'w')).rejects.toThrow(/invalid address/);
  });
});
