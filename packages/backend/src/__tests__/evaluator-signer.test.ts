/**
 * ERC-8183 evaluator signer — explicit gas limit (C5a regression) and the
 * sign → record → send order (G1 review P3-2).
 *
 * The C5a fork rehearsal settled a job with viem's default gas (the bare
 * `eth_estimateGas`): the escrow paid out, but the ReputationHook's
 * `giveFeedback` ran out of gas inside its try/catch and the hook emitted
 * `FeedbackFailed(jobId, "")` — feedback silently lost on every settlement.
 * The estimate is the cheapest limit at which the tx *succeeds*, and the
 * catch path succeeds with less gas than the feedback path. The signer now
 * sends `estimate + EVALUATOR_GAS_HEADROOM`; this test pins that every
 * evaluator write carries an explicit limit above the estimate.
 *
 * P3-2: the evaluator is a local key, so the transaction is signed first and
 * `onBeforeBroadcast` receives the SIGNED hash before the raw transaction is
 * sent — the orchestrator records it, and a send that throws afterwards is
 * resolved from that hash. The signing here is real (Anvil test key 3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const { publicClient, walletClient } = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  walletClient: { prepareTransactionRequest: vi.fn(), signTransaction: vi.fn(), sendRawTransaction: vi.fn() },
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => publicClient),
    createWalletClient: vi.fn(() => walletClient),
  };
});

vi.mock('../config/chains.js', () => ({
  getChain: vi.fn(() => ({ id: 84532, name: 'Base Sepolia' })),
  getPrimaryRpcUrl: vi.fn(() => 'http://127.0.0.1:8546'),
}));

import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import {
  EVALUATOR_GAS_HEADROOM,
  EvaluatorNonceChoiceError,
  classifySendRawError,
  createEvaluatorSigner,
  evaluatorGasLimit,
  type PreparedEvaluatorTx,
} from '../services/escrow/evaluator-signer.js';
import { LeaseLostError, type LaneLease } from '../services/transaction/wallet-lane.js';

// Anvil test account 3 — the fork rehearsal's evaluator (public test key).
const EVALUATOR_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const ESCROW = '0x70449abF99B0b470F0280D5E3036265cB849d77C' as const;
const ACCOUNT = privateKeyToAccount(EVALUATOR_KEY);

/** Numbers measured on the fork (Base Sepolia block 47822000, Reputation Registry v2.0.0). */
const FORK_ESTIMATE = 246_770n; // eth_estimateGas for complete(): hook catch path → FeedbackFailed
const FORK_FULL_PATH = 340_231n; // gas used by the same complete() when giveFeedback succeeds

const args = [1n, `0x${'00'.repeat(32)}`, '0x'] as const;
const complete = { address: ESCROW, abi: AGENT_JOB_ESCROW_ABI, functionName: 'complete', args } as const;

describe('evaluator signer (C5a gas limit, P3-2 sign → record → send)', () => {
  let signed: Hex[];
  beforeEach(() => {
    vi.clearAllMocks();
    signed = [];
    publicClient.simulateContract.mockImplementation(async (call: Record<string, unknown>) => ({
      request: { ...call, chain: { id: 84532 } },
    }));
    publicClient.estimateContractGas.mockResolvedValue(FORK_ESTIMATE);
    // What prepareTransactionRequest fills in (nonce, fees, type, chainId) around the caller's fields.
    walletClient.prepareTransactionRequest.mockImplementation(async (req: Record<string, unknown>) => ({
      to: req['to'],
      data: req['data'],
      gas: req['gas'],
      nonce: (req['nonce'] as number | undefined) ?? 3, // the node's pending, unless the caller fixed it (A1 chooseNonce)
      chainId: 84532,
      type: 'eip1559',
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    }));
    // Real local signature with the evaluator key.
    walletClient.signTransaction.mockImplementation(async (req: Record<string, unknown>) => {
      const raw = await ACCOUNT.signTransaction(req as never);
      signed.push(raw);
      return raw;
    });
    walletClient.sendRawTransaction.mockImplementation(async ({ serializedTransaction }: { serializedTransaction: Hex }) => keccak256(serializedTransaction));
  });

  it('adds the headroom to the estimate', () => {
    expect(evaluatorGasLimit(100_000n)).toBe(100_000n + EVALUATOR_GAS_HEADROOM);
    // The limit derived from the fork's estimate covers the measured feedback path.
    expect(evaluatorGasLimit(FORK_ESTIMATE)).toBeGreaterThan(FORK_FULL_PATH);
  });

  it('signs complete() with an explicit gas limit above eth_estimateGas and returns the signed hash', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const hash = await signer.writeContract(complete);

    expect(publicClient.simulateContract).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({ address: ESCROW, functionName: 'complete', args }));
    const prepared = walletClient.prepareTransactionRequest.mock.calls[0]![0] as { gas?: bigint; to: string; data: Hex };
    expect(prepared.to).toBe(ESCROW);
    expect(decodeFunctionData({ abi: AGENT_JOB_ESCROW_ABI, data: prepared.data })).toMatchObject({ functionName: 'complete', args: [...args] });
    expect(prepared.gas).toBe(FORK_ESTIMATE + EVALUATOR_GAS_HEADROOM);
    expect(prepared.gas!).toBeGreaterThan(FORK_FULL_PATH);
    expect(signed).toHaveLength(1);
    expect(walletClient.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: signed[0] });
    expect(hash).toBe(keccak256(signed[0]!));
  });

  it('never signs nor broadcasts when the simulation reverts', async () => {
    publicClient.simulateContract.mockRejectedValueOnce(new Error('InvalidStatus(1, 3)'));
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await expect(signer.writeContract({ ...complete, functionName: 'reject' })).rejects.toThrow(/InvalidStatus/);
    expect(walletClient.signTransaction).not.toHaveBeenCalled();
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('P3-2: onBeforeBroadcast receives the signed hash after the simulation and before the send; a simulation revert never reaches it; its throw aborts the send', async () => {
    const order: string[] = [];
    publicClient.simulateContract.mockImplementationOnce(async (call: Record<string, unknown>) => {
      order.push('simulate');
      return { request: { ...call } };
    });
    walletClient.sendRawTransaction.mockImplementationOnce(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      order.push('send');
      return keccak256(serializedTransaction);
    });
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    let recorded: Hex | null = null;
    const hash = await signer.writeContract(complete, {
      onBeforeBroadcast: async (signedTxHash) => {
        order.push('stamp');
        recorded = signedTxHash;
      },
    });
    expect(order).toEqual(['simulate', 'stamp', 'send']);
    expect(recorded).toBe(hash);
    expect(recorded).toBe(keccak256(signed[0]!));

    const stamp = vi.fn();
    publicClient.simulateContract.mockRejectedValueOnce(new Error('TransferFailed (provider blacklisted)'));
    await expect(signer.writeContract(complete, { onBeforeBroadcast: stamp })).rejects.toThrow();
    expect(stamp).not.toHaveBeenCalled(); // the payout-blocked path never stamps

    walletClient.sendRawTransaction.mockClear();
    await expect(
      signer.writeContract(complete, {
        onBeforeBroadcast: async () => {
          throw new Error('database down');
        },
      }),
    ).rejects.toThrow(/database down/);
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('P3-2: a send that throws after the hook surfaces to the caller, which already holds the signed hash', async () => {
    walletClient.sendRawTransaction.mockRejectedValueOnce(new Error('insufficient funds for gas * price + value'));
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const hook = vi.fn(async (_hash: Hex) => undefined);
    await expect(signer.writeContract(complete, { onBeforeBroadcast: hook })).rejects.toThrow(/insufficient funds/);
    expect(hook).toHaveBeenCalledWith(keccak256(signed[0]!), expect.objectContaining({ hash: keccak256(signed[0]!), raw: signed[0] }));
  });

  it("C3h D2: the receipt wait keeps viem's replacement detection and marks a replacement's receipt (the caller compares the hash)", async () => {
    const MINE = `0x${'11'.repeat(32)}` as Hex;
    const OTHER = `0x${'22'.repeat(32)}` as Hex;
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);

    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [], transactionHash: MINE });
    expect(await signer.waitForTransactionReceipt(MINE)).toEqual({ status: 'success', logs: [], transactionHash: MINE });
    const params = publicClient.waitForTransactionReceipt.mock.calls[0]![0] as { hash: Hex; checkReplacement?: boolean; onReplaced?: unknown };
    expect(params).toMatchObject({ hash: MINE });
    expect(params.checkReplacement).toBeUndefined(); // viem's default (true): a replacement resolves the wait
    expect(typeof params.onReplaced).toBe('function');

    publicClient.waitForTransactionReceipt.mockImplementationOnce(async (p: { onReplaced: (r: { reason: string }) => void }) => {
      p.onReplaced({ reason: 'cancelled' });
      return { status: 'success', logs: [], transactionHash: OTHER };
    });
    expect(await signer.waitForTransactionReceipt(MINE)).toEqual({ status: 'success', logs: [], transactionHash: OTHER, replacedReason: 'cancelled' });
  });
});

/** A lease double: `assertHeld` answers from `held()` and logs into `order`. */
function fakeLease(order: string[], held: () => boolean = () => true): LaneLease {
  return {
    key: '84532:0xevaluator',
    token: 'tok',
    acquiredAt: Date.now(),
    assertHeld: vi.fn(async (min: number) => {
      order.push(`assert:${min}`);
      if (!held()) throw new LeaseLostError('84532:0xevaluator', 'not-held', null, min);
    }),
    release: vi.fn(async () => undefined),
  };
}

describe('evaluator signer — A1 (prepared tx, lease, nonce choice, explicit signing, identical rebroadcast)', () => {
  let signed: Hex[];
  let order: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    signed = [];
    order = [];
    publicClient.simulateContract.mockImplementation(async () => {
      order.push('simulate');
      return { request: {} };
    });
    publicClient.estimateContractGas.mockResolvedValue(FORK_ESTIMATE);
    walletClient.prepareTransactionRequest.mockImplementation(async (req: Record<string, unknown>) => {
      order.push(`prepare:${String(req['nonce'] ?? 'auto')}`);
      return {
        to: req['to'],
        data: req['data'],
        gas: req['gas'],
        nonce: (req['nonce'] as number | undefined) ?? 3,
        chainId: 84532,
        type: 'eip1559',
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      };
    });
    walletClient.signTransaction.mockImplementation(async (req: Record<string, unknown>) => {
      const raw = await ACCOUNT.signTransaction(req as never);
      signed.push(raw);
      order.push('sign');
      return raw;
    });
    walletClient.sendRawTransaction.mockImplementation(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      order.push('send');
      return keccak256(serializedTransaction);
    });
  });

  it('onBeforeBroadcast receives the hash and the full prepared tx read back from the signed bytes (raw included)', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    let seen: PreparedEvaluatorTx | null = null;
    const hash = await signer.writeContract(complete, {
      onBeforeBroadcast: async (h, tx) => {
        order.push('hook');
        expect(h).toBe(tx.hash);
        seen = tx;
      },
    });
    expect(order).toEqual(['simulate', 'prepare:auto', 'sign', 'hook', 'send']);
    expect(seen).toEqual({
      hash,
      raw: signed[0],
      nonce: 3,
      gas: FORK_ESTIMATE + EVALUATOR_GAS_HEADROOM,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      to: ESCROW,
      data: (walletClient.prepareTransactionRequest.mock.calls[0]![0] as { data: Hex }).data,
      value: 0n,
      chainId: 84532,
      from: ACCOUNT.address,
    });
    expect(hash).toBe(keccak256(signed[0]!));
    expect((walletClient.prepareTransactionRequest.mock.calls[0]![0] as { type?: string }).type).toBe('eip1559');
  });

  it('asserts the lease (with the margin) before the hook and IMMEDIATELY before the send', async () => {
    const lease = fakeLease(order);
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await signer.writeContract(complete, { lease, minLeaseMs: 30_000, onBeforeBroadcast: async () => void order.push('hook') });
    expect(order).toEqual(['simulate', 'prepare:auto', 'sign', 'assert:30000', 'hook', 'assert:30000', 'send']);
  });

  it('a lease lost during the hook aborts the send (LeaseLostError, nothing broadcast)', async () => {
    let held = true;
    const lease = fakeLease(order, () => held);
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await expect(
      signer.writeContract(complete, {
        lease,
        minLeaseMs: 30_000,
        onBeforeBroadcast: async () => {
          held = false; // e.g. the DB transaction outlived the lane's TTL
        },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a lease already lost records nothing (the hook never runs) and sends nothing', async () => {
    const lease = fakeLease(order, () => false);
    const hook = vi.fn(async () => undefined);
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await expect(signer.writeContract(complete, { lease, minLeaseMs: 1, onBeforeBroadcast: hook })).rejects.toBeInstanceOf(LeaseLostError);
    expect(hook).not.toHaveBeenCalled();
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a lease without minLeaseMs is refused before anything is simulated or signed', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await expect(signer.writeContract(complete, { lease: fakeLease(order) })).rejects.toThrow(/minLeaseMs/);
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(walletClient.signTransaction).not.toHaveBeenCalled();
  });

  it('R2-P2-3 chooseNonce: a higher nonce re-prepares with that explicit nonce; the same one does not; lower or fractional is refused', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const choose = vi.fn(async (pending: number) => {
      expect(pending).toBe(3);
      return 7;
    });
    let tx: PreparedEvaluatorTx | null = null;
    await signer.writeContract(complete, { chooseNonce: choose, onBeforeBroadcast: async (_h, t) => void (tx = t) });
    expect(order).toEqual(['simulate', 'prepare:auto', 'prepare:7', 'sign', 'send']);
    expect(tx!.nonce).toBe(7);
    expect((walletClient.prepareTransactionRequest.mock.calls[1]![0] as { gas: bigint }).gas).toBe(FORK_ESTIMATE + EVALUATOR_GAS_HEADROOM);

    order.length = 0;
    await signer.writeContract(complete, { chooseNonce: async (p) => p });
    expect(order).toEqual(['simulate', 'prepare:auto', 'sign', 'send']);

    for (const bad of [2, 3.5, Number.NaN]) {
      walletClient.signTransaction.mockClear();
      walletClient.sendRawTransaction.mockClear();
      await expect(signer.writeContract(complete, { chooseNonce: async () => bad })).rejects.toBeInstanceOf(EvaluatorNonceChoiceError);
      expect(walletClient.signTransaction).not.toHaveBeenCalled();
      expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
    }
  });

  it('signExplicit signs exactly the given fields with no RPC call; invalid fields are refused', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const input = {
      to: ACCOUNT.address,
      data: '0x' as Hex,
      value: 0n,
      nonce: 11,
      gas: 21_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 2_000_000n,
    };
    const tx = await signer.signExplicit(input);
    expect(tx).toMatchObject({ ...input, chainId: 84532, from: ACCOUNT.address });
    expect(tx.hash).toBe(keccak256(tx.raw));
    expect(await signer.signExplicit(input)).toEqual(tx); // deterministic: identical bytes
    expect(publicClient.simulateContract).not.toHaveBeenCalled();
    expect(walletClient.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();

    await expect(signer.signExplicit({ ...input, nonce: -1 })).rejects.toThrow(/nonce/);
    await expect(signer.signExplicit({ ...input, gas: 0n })).rejects.toThrow(/gas/);
    await expect(signer.signExplicit({ ...input, maxPriorityFeePerGas: input.maxFeePerGas + 1n })).rejects.toThrow(/maxPriorityFeePerGas/);
  });

  it('sendRaw: lease asserted first; the expected node answers come back as typed outcomes (sanitized), never throws', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const tx = await signer.signExplicit({
      to: ACCOUNT.address,
      data: '0x',
      value: 0n,
      nonce: 1,
      gas: 21_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 2_000_000n,
    });
    const lease = fakeLease(order);
    expect(await signer.sendRaw(tx.raw, { lease, minLeaseMs: 30_000 })).toEqual({ kind: 'accepted', hash: tx.hash });
    expect(order).toEqual(['assert:30000', 'send']);
    expect(walletClient.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: tx.raw });

    const nodeError = (details: string) => Object.assign(new Error(`RPC Request failed.\n\nURL: https://base-sepolia.g.alchemy.com/v2/sk_live_KEY123456789\nDetails: ${details}`), { name: 'RpcRequestError', details, shortMessage: 'RPC Request failed.' });
    const cases: Array<[unknown, string]> = [
      [nodeError('already known'), 'already-known'],
      [nodeError('nonce too low'), 'nonce-too-low'],
      [nodeError('replacement transaction underpriced'), 'underpriced'],
      [Object.assign(new Error('HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/sk_live_KEY123456789'), { name: 'HttpRequestError' }), 'transport'],
      [nodeError('insufficient funds for gas * price + value'), 'rejected'],
    ];
    for (const [err, kind] of cases) {
      walletClient.sendRawTransaction.mockRejectedValueOnce(err);
      const outcome = await signer.sendRaw(tx.raw, { lease, minLeaseMs: 30_000 });
      expect(outcome).toMatchObject({ kind, hash: tx.hash });
      expect((outcome as { message: string }).message).not.toMatch(/sk_live_KEY123456789|alchemy\.com\/v2/);
    }
  });

  it('sendRaw: a lost lease throws LeaseLostError and sends nothing; a missing lease is refused', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const raw = (await signer.signExplicit({ to: ACCOUNT.address, data: '0x', value: 0n, nonce: 1, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })).raw;
    await expect(signer.sendRaw(raw, { lease: fakeLease(order, () => false), minLeaseMs: 1 })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(signer.sendRaw(raw, { lease: undefined as never, minLeaseMs: 1 })).rejects.toThrow(/lease is required/);
    expect(walletClient.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('classifySendRawError knows the geth / anvil / provider wordings', () => {
    expect(classifySendRawError(new Error('transaction already imported'))).toBe('already-known');
    expect(classifySendRawError({ details: 'ALREADY_EXISTS: already known' })).toBe('already-known');
    expect(classifySendRawError(new Error('nonce too low: next nonce 5, tx nonce 4'))).toBe('nonce-too-low');
    expect(classifySendRawError(new Error('max fee per gas less than block base fee: address 0x…'))).toBe('underpriced');
    expect(classifySendRawError(new Error('transaction underpriced'))).toBe('underpriced');
    expect(classifySendRawError(Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' }))).toBe('transport');
    expect(classifySendRawError(new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8545') }))).toBe('transport');
    expect(classifySendRawError(new Error('execution reverted'))).toBe('rejected');
  });
});
