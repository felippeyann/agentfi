/**
 * Regression (S6, second adversarial review 2026-10-08): `POST
 * /v1/agents/me/sign-handshake` was a Safe owner-signature oracle.
 *
 * It signed `hashMessage(message)` (EIP-191 personal_sign) for any
 * agent-chosen string. When the string's UTF-8 bytes are a 32-byte digest
 * (every byte < 0x80 — reachable by grinding a Safe transaction's free fields,
 * ~2^32 keccak), that is exactly Safe's `eth_sign` owner signature over the
 * digest (v + 4): in Safe mode the agent key is the 1/1 owner, so the agent
 * could execute any Safe transaction past `AgentPolicyModule`, and get EIP-1271
 * signatures for the Safe through the fallback handler.
 *
 * The reviewer's proof (`zz-review.handshake-oracle.test.ts`) asserted the
 * attack; this file runs the same ground message through the REAL route with
 * a REAL LocalWalletService and asserts it no longer yields a signature any
 * of Safe's owner-signature checks accept — only the AgentFi envelope digest
 * recovers to the owner. verify-handshake no longer accepts a bare
 * personal_sign of the message either.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  const required: Array<[string, string]> = [
    ['NODE_ENV', 'test'],
    ['API_SECRET', 'test-api-secret-must-be-long-enough-12345'],
    ['ADMIN_SECRET', 'test-admin-secret-must-be-long-enough-1234'],
    ['ALCHEMY_API_KEY', 'test'],
    ['TURNKEY_API_PUBLIC_KEY', 'test'],
    ['TURNKEY_API_PRIVATE_KEY', 'test'],
    ['TURNKEY_ORGANIZATION_ID', 'test'],
    ['DATABASE_URL', 'postgres://localhost/test'],
    ['REDIS_URL', 'redis://localhost:6379'],
    ['OPERATOR_FEE_WALLET', '0x000000000000000000000000000000000000fEe1'],
  ];
  for (const [k, v] of required) {
    if (!process.env[k]) process.env[k] = v;
  }
});

const { mockDb, loggerMock, walletHolder, verifyHashCalls } = vi.hoisted(() => ({
  mockDb: { agent: { findUnique: vi.fn() } } as any,
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  walletHolder: { service: undefined as unknown },
  verifyHashCalls: [] as Array<{ address: string; hash: string }>,
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockDb) }));
vi.mock('../api/middleware/logger.js', () => ({ logger: loggerMock }));
// The real local wallet provider, created lazily (it logs through the mocked logger).
vi.mock('../services/wallet/index.js', async () => {
  const { LocalWalletService } = await import('../services/wallet/local.service.js');
  walletHolder.service = new LocalWalletService();
  return { getWalletService: () => walletHolder.service };
});
vi.mock('../services/wallet/safe.service.js', () => ({ SafeService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/identity/ens.service.js', () => ({
  EnsService: vi.fn().mockImplementation(() => ({ isConfigured: () => false })),
}));
vi.mock('../services/billing/pnl.service.js', () => ({ PnLService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('../services/policy/reputation.service.js', () => ({
  ReputationService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    // EIP-1271 fallback of verify-handshake: no contract at the target.
    createPublicClient: vi.fn(() => ({
      verifyHash: async (args: { address: string; hash: string }) => {
        verifyHashCalls.push({ address: args.address, hash: args.hash });
        return false;
      },
    })),
  };
});

import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  recoverAddress,
  recoverMessageAddress,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerErrorHandler } from '../api/errors/handler.js';
import type { LocalWalletService } from '../services/wallet/local.service.js';
import { buildHandshakeTypedData, handshakeDigest } from '../services/identity/handshake.js';

const AGENT_ID = 'cl00000000000000000agent01';
const SAFE = getAddress('0x2222222222222222222222222222222222222222');

let agentRoutes: typeof import('../api/routes/agents.js')['agentRoutes'];
let owner: { walletId: string; address: Address };

beforeAll(async () => {
  ({ agentRoutes } = await import('../api/routes/agents.js'));
  owner = await (walletHolder.service as LocalWalletService).createWallet('safe-owner');
});

beforeEach(() => {
  mockDb.agent.findUnique.mockReset();
  mockDb.agent.findUnique.mockResolvedValue({ walletId: owner.walletId, safeAddress: SAFE });
  verifyHashCalls.length = 0;
});

async function buildApp() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('preHandler', async (request: any) => {
    request.agentId = AGENT_ID;
    request.agentTier = 'FREE';
  });
  await app.register(agentRoutes);
  return app;
}

/** A stand-in for a ground safeTxHash / Safe message hash: 32 bytes, each < 0x80. */
function groundDigest(): Uint8Array {
  return Uint8Array.from(randomBytes(32), (b) => b & 0x7f);
}

/** Safe `checkNSignatures`, v > 30 branch: ecrecover(keccak256("\x19Ethereum Signed Message:\n32" ‖ dataHash), v - 4, r, s). */
function safeEthSignHash(digest: Uint8Array): Hex {
  return keccak256(concat([toBytes('\x19Ethereum Signed Message:\n32'), digest]));
}

/**
 * Would a 1/1 Safe owned by the agent key accept `signature` as its owner's
 * signature over `digest`? Safe `checkNSignatures` per signature type:
 *   - v > 30 (eth_sign): the attacker submits v + 4; the Safe runs
 *     ecrecover(keccak256("\x19Ethereum Signed Message:\n32" ‖ digest), v, r, s);
 *   - v = 27/28 (ECDSA): ecrecover(digest, v, r, s).
 * (v = 0 contract signatures and v = 1 approved hashes involve no ECDSA.)
 */
async function safeAcceptsAsOwner(signature: Hex, digest: Uint8Array, safeOwner: Address = owner.address): Promise<boolean> {
  const ethSignSigner = await recoverAddress({ hash: safeEthSignHash(digest), signature });
  const ecdsaSigner = await recoverAddress({ hash: toHex(digest), signature });
  return getAddress(ethSignSigner) === getAddress(safeOwner) || getAddress(ecdsaSigner) === getAddress(safeOwner);
}

describe('sign-handshake is no longer a Safe owner-signature oracle (S6)', () => {
  it("control (the reviewer's proof): the pre-S6 personal_sign of a ground message IS a Safe owner signature", async () => {
    const preS6Owner = privateKeyToAccount(generatePrivateKey());
    const digest = groundDigest();
    const message = String.fromCharCode(...digest);
    // What turnkey/local signMessage did before S6: hashMessage(message) -> sign.
    const signature = await preS6Owner.signMessage({ message });
    expect(await safeAcceptsAsOwner(signature, digest, preS6Owner.address)).toBe(true);
  });

  it('a message whose UTF-8 bytes equal a ground 32-byte digest does not yield a Safe-valid owner signature', async () => {
    const app = await buildApp();
    for (let i = 0; i < 8; i++) {
      const digest = groundDigest();
      const message = String.fromCharCode(...digest); // what the agent POSTs as `message`
      expect(new TextEncoder().encode(message)).toEqual(digest);
      // Before S6 this was the whole attack: hashMessage(message) IS Safe's eth_sign hash.
      expect(hashMessage(message)).toBe(safeEthSignHash(digest));

      const res = await app.inject({ method: 'POST', url: '/v1/agents/me/sign-handshake', payload: { message } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { signature: Hex; digest: Hex; issuedAt: number; address: string };

      // Neither of Safe's owner-signature checks accepts it…
      expect(await safeAcceptsAsOwner(body.signature, digest)).toBe(false);
      // …nor is it a personal_sign of the message any more…
      expect(getAddress(await recoverMessageAddress({ message, signature: body.signature }))).not.toBe(getAddress(owner.address));
      // …it recovers to the owner only over the AgentFi envelope digest.
      const envelope = handshakeDigest({ agent: owner.address, message, issuedAt: body.issuedAt });
      expect(body.digest).toBe(envelope);
      expect(getAddress(await recoverAddress({ hash: envelope, signature: body.signature }))).toBe(getAddress(owner.address));
    }
    await app.close();
  });

  it('a message equal to the hex text of a ground Safe EIP-1271 message hash yields nothing the fallback handler accepts', async () => {
    // CompatibilityFallbackHandler.isValidSignature(dataHash): checkSignatures over
    // keccak256(0x1901 ‖ domainSeparator(chainId, safe) ‖ keccak256(SAFE_MSG_TYPEHASH ‖ keccak256(abi.encode(dataHash)))).
    const dataHash = keccak256(toBytes('permit2 order the attacker wants the Safe to sign'));
    const safeMessageHash = hashTypedData({
      domain: { chainId: 8453, verifyingContract: SAFE },
      types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
      primaryType: 'SafeMessage',
      message: { message: encodeAbiParameters([{ type: 'bytes32' }], [dataHash]) },
    });
    const app = await buildApp();

    for (const message of [safeMessageHash, safeMessageHash.slice(2)]) {
      const res = await app.inject({ method: 'POST', url: '/v1/agents/me/sign-handshake', payload: { message } });
      expect(res.statusCode).toBe(200);
      const { signature } = res.json() as { signature: Hex };
      expect(await safeAcceptsAsOwner(signature, toBytes(safeMessageHash))).toBe(false);
    }
    await app.close();
  });

  it('the wallet is only ever asked for the envelope: the signed typed data is the AgentFi handshake', async () => {
    const svc = walletHolder.service as LocalWalletService;
    const spy = vi.spyOn(svc, 'signTypedData');
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/v1/agents/me/sign-handshake', payload: { message: 'hello peer' } });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const typedData = spy.mock.calls[0]![0].typedData as unknown as ReturnType<typeof buildHandshakeTypedData>;
    expect(typedData.domain).toEqual({ name: 'AgentFi Handshake', version: '1' });
    expect(typedData.primaryType).toBe('AgentFiHandshake');
    expect(typedData.message.agent).toBe(getAddress(owner.address));
    expect(typedData.message.message).toBe('hello peer');
    spy.mockRestore();
    await app.close();
  });
});

describe('verify-handshake checks the same envelope (S6)', () => {
  const PEER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

  it('round trip: what sign-handshake returns verifies against the signing address', async () => {
    const app = await buildApp();
    const signed = (await app.inject({ method: 'POST', url: '/v1/agents/me/sign-handshake', payload: { message: 'deal #42' } })).json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message: signed.message, issuedAt: signed.issuedAt, signature: signed.signature, address: signed.address },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, address: getAddress(owner.address), verifiedVia: 'ecdsa' });
    await app.close();
  });

  it('a bare personal_sign of the message is not a handshake any more', async () => {
    const app = await buildApp();
    const message = 'deal #42';
    const signature = await PEER.signMessage({ message });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message, issuedAt: 1_791_417_600, signature, address: PEER.address },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: false, address: PEER.address });
    // The EIP-1271 fallback was asked about the envelope digest, never the EIP-191 hash.
    expect(verifyHashCalls).toEqual([
      { address: PEER.address, hash: handshakeDigest({ agent: PEER.address, message, issuedAt: 1_791_417_600 }) },
    ]);
    await app.close();
  });

  it('the envelope signed by an EOA verifies; a different issuedAt does not', async () => {
    const app = await buildApp();
    const message = 'hello from agent B';
    const signature = await PEER.signTypedData(buildHandshakeTypedData({ agent: PEER.address, message, issuedAt: 1_791_417_600 }));

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message, issuedAt: 1_791_417_600, signature, address: PEER.address },
    });
    expect(ok.json()).toEqual({ valid: true, address: PEER.address, verifiedVia: 'ecdsa' });

    const replayedLater = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message, issuedAt: 1_791_417_601, signature, address: PEER.address },
    });
    expect(replayedLater.json()).toMatchObject({ valid: false });
    await app.close();
  });

  it('issuedAt is required', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/verify-handshake',
      payload: { message: 'x', signature: '0x00', address: PEER.address },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
