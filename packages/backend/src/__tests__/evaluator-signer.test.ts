/**
 * ERC-8183 evaluator signer — explicit gas limit (C5a regression).
 *
 * The C5a fork rehearsal settled a job with viem's default gas (the bare
 * `eth_estimateGas`): the escrow paid out, but the ReputationHook's
 * `giveFeedback` ran out of gas inside its try/catch and the hook emitted
 * `FeedbackFailed(jobId, "")` — feedback silently lost on every settlement.
 * The estimate is the cheapest limit at which the tx *succeeds*, and the
 * catch path succeeds with less gas than the feedback path. The signer now
 * sends `estimate + EVALUATOR_GAS_HEADROOM`; this test pins that every
 * evaluator write carries an explicit limit above the estimate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { publicClient, walletClient } = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  walletClient: { writeContract: vi.fn() },
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
  createEvaluatorSigner,
  evaluatorGasLimit,
} from '../services/escrow/evaluator-signer.js';

// Anvil test account 3 — the fork rehearsal's evaluator (public test key).
const EVALUATOR_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const ESCROW = '0x70449abF99B0b470F0280D5E3036265cB849d77C' as const;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;

/** Numbers measured on the fork (Base Sepolia block 47822000, Reputation Registry v2.0.0). */
const FORK_ESTIMATE = 246_770n; // eth_estimateGas for complete(): hook catch path → FeedbackFailed
const FORK_FULL_PATH = 340_231n; // gas used by the same complete() when giveFeedback succeeds

describe('evaluator signer gas limit (C5a regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicClient.simulateContract.mockImplementation(async (call: Record<string, unknown>) => ({
      request: { ...call, chain: { id: 84532 } },
    }));
    publicClient.estimateContractGas.mockResolvedValue(FORK_ESTIMATE);
    walletClient.writeContract.mockResolvedValue(TX_HASH);
  });

  it('adds the headroom to the estimate', () => {
    expect(evaluatorGasLimit(100_000n)).toBe(100_000n + EVALUATOR_GAS_HEADROOM);
    // The limit derived from the fork's estimate covers the measured feedback path.
    expect(evaluatorGasLimit(FORK_ESTIMATE)).toBeGreaterThan(FORK_FULL_PATH);
  });

  it('sends complete() with an explicit gas limit above eth_estimateGas', async () => {
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    const args = [1n, `0x${'00'.repeat(32)}`, '0x'] as const;

    const hash = await signer.writeContract({ address: ESCROW, abi: AGENT_JOB_ESCROW_ABI, functionName: 'complete', args });

    expect(hash).toBe(TX_HASH);
    expect(publicClient.simulateContract).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas).toHaveBeenCalledWith(
      expect.objectContaining({ address: ESCROW, functionName: 'complete', args }),
    );
    const sent = walletClient.writeContract.mock.calls[0]![0] as { gas?: bigint; functionName: string };
    expect(sent.functionName).toBe('complete');
    expect(sent.gas).toBe(FORK_ESTIMATE + EVALUATOR_GAS_HEADROOM);
    expect(sent.gas!).toBeGreaterThan(FORK_FULL_PATH);
  });

  it('never broadcasts when the simulation reverts', async () => {
    publicClient.simulateContract.mockRejectedValueOnce(new Error('InvalidStatus(1, 3)'));
    const signer = createEvaluatorSigner(84532, EVALUATOR_KEY);
    await expect(
      signer.writeContract({ address: ESCROW, abi: AGENT_JOB_ESCROW_ABI, functionName: 'reject', args: [1n, `0x${'00'.repeat(32)}`, '0x'] }),
    ).rejects.toThrow(/InvalidStatus/);
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });
});
