/**
 * Generated ABI contract — `abi/AgentJobEscrow.abi.ts` / `abi/ReputationHook.abi.ts`.
 *
 * The backend encodes calls and decodes events from these generated files
 * (`npm run abi:escrow`). This pins the function selectors the orchestrator
 * relies on to the published ERC-8183 signatures and checks every event the
 * settlement parser reads exists, so a regenerated ABI from a changed
 * contract fails here instead of reverting on-chain. When the Foundry
 * artifact is present locally, the checked-in file is also diffed against it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getAbiItem,
  keccak256,
  toBytes,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
} from 'viem';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { REPUTATION_HOOK_ABI } from '../abi/ReputationHook.abi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Widened to `Abi` so `getAbiItem` can take a runtime `name` without exploding the literal types.
const ESCROW_ABI = AGENT_JOB_ESCROW_ABI as unknown as Abi;
const HOOK_ABI = REPUTATION_HOOK_ABI as unknown as Abi;
const ARTIFACTS = {
  AgentJobEscrow: path.resolve(here, '../../../contracts/out/AgentJobEscrow.sol/AgentJobEscrow.json'),
  ReputationHook: path.resolve(here, '../../../contracts/out/ReputationHook.sol/ReputationHook.json'),
};

/** ERC-8183 function signatures (published EIP text, 2026-03-13 revision). */
const ESCROW_FUNCTIONS = {
  createJob: 'createJob(address,address,uint256,string,address)',
  setBudget: 'setBudget(uint256,uint256,bytes)',
  fund: 'fund(uint256,uint256,bytes)',
  submit: 'submit(uint256,bytes32,bytes)',
  complete: 'complete(uint256,bytes32,bytes)',
  reject: 'reject(uint256,bytes32,bytes)',
  claimRefund: 'claimRefund(uint256)',
  getJob: 'getJob(uint256)',
  token: 'token()',
} as const;

const ESCROW_EVENTS = [
  'JobCreated',
  'JobFunded',
  'JobSubmitted',
  'JobCompleted',
  'JobRejected',
  'JobExpired',
  'PaymentReleased',
  'PlatformFeeAccrued',
  'Refunded',
] as const;

const HOOK_EVENTS = ['FeedbackWritten', 'FeedbackSkipped', 'FeedbackFailed'] as const;

describe('AgentJobEscrow ABI', () => {
  it.each(Object.entries(ESCROW_FUNCTIONS))('%s has the ERC-8183 selector of %s', (name, signature) => {
    const item = getAbiItem({ abi: ESCROW_ABI, name }) as AbiFunction | undefined;
    expect(item, `${name} missing from the generated ABI`).toBeDefined();
    expect(toFunctionSelector(item!)).toBe(toFunctionSelector(signature));
  });

  it('pins the selectors the orchestrator encodes', () => {
    // Computed from the signatures above; a drift in any argument type changes these.
    expect(toFunctionSelector(ESCROW_FUNCTIONS.createJob)).toBe('0x41528812');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.setBudget)).toBe('0xdd4ae9d4');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.fund)).toBe('0xd2e13f50');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.submit)).toBe('0x9e63798d');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.complete)).toBe('0xd75bbdf3');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.reject)).toBe('0x41dd26f5');
    expect(toFunctionSelector(ESCROW_FUNCTIONS.claimRefund)).toBe('0x5b7baf64');
  });

  it.each(ESCROW_EVENTS)('declares the %s event', (name) => {
    const item = getAbiItem({ abi: ESCROW_ABI, name }) as AbiEvent | undefined;
    expect(item?.type).toBe('event');
  });

  it('JobCreated(uint256 indexed jobId, …) is the event the create step parses', () => {
    const item = getAbiItem({ abi: ESCROW_ABI, name: 'JobCreated' }) as AbiEvent;
    expect(item.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`)).toEqual([
      'uint256 indexed jobId',
      'address indexed client',
      'address indexed provider',
      'address evaluator',
      'uint256 expiredAt',
      'address hook',
    ]);
    expect(toEventSelector(item)).toBe(toEventSelector('JobCreated(uint256,address,address,address,uint256,address)'));
  });

  it('getJob returns the ERC-8183 Job struct with `status` as the enum slot the worker reads', () => {
    const item = getAbiItem({ abi: ESCROW_ABI, name: 'getJob' }) as AbiFunction;
    const output = item.outputs[0] as { type: string; components?: Array<{ name: string; type: string }> };
    expect(output.type).toBe('tuple');
    expect(output.components?.map((c) => c.name)).toEqual([
      'id',
      'client',
      'provider',
      'evaluator',
      'description',
      'budget',
      'expiredAt',
      'status',
      'hook',
    ]);
    expect(output.components?.find((c) => c.name === 'status')?.type).toBe('uint8');
  });
});

describe('ReputationHook ABI', () => {
  it.each(HOOK_EVENTS)('declares the %s event', (name) => {
    const item = getAbiItem({ abi: HOOK_ABI, name }) as AbiEvent | undefined;
    expect(item?.type).toBe('event');
  });

  it('FeedbackSkipped carries a bytes32 reason (decoded to "skipped:<reason>" by the settlement parser)', () => {
    const item = getAbiItem({ abi: HOOK_ABI, name: 'FeedbackSkipped' }) as AbiEvent;
    expect(item.inputs.map((i) => i.type)).toEqual(['uint256', 'bytes32']);
  });

  it('declares the R3c gas guard error and the gas-limit getters read by the post-deploy checks', () => {
    const error = getAbiItem({ abi: HOOK_ABI, name: 'InsufficientGasForFeedback' }) as
      | { type: string; inputs: ReadonlyArray<{ type: string; name?: string }> }
      | undefined;
    expect(error?.type).toBe('error');
    expect(error!.inputs.map((i) => `${i.type} ${i.name}`)).toEqual(['uint256 available', 'uint256 required']);
    for (const name of ['feedbackGasLimit', 'identityCallGasLimit', 'feedbackGasRequirement', 'canonicalBindGasRequirement']) {
      const item = getAbiItem({ abi: HOOK_ABI, name }) as AbiFunction | undefined;
      expect(item?.type, `${name} missing from the generated ABI`).toBe('function');
      expect(item?.outputs.map((o) => o.type)).toEqual(['uint256']);
    }
  });

  it('exposes the D9 verdict reason: the only reject reason that writes negative feedback (C2b)', () => {
    const item = getAbiItem({ abi: HOOK_ABI, name: 'REASON_QUALITY_REJECTED' }) as AbiFunction | undefined;
    expect(item?.type).toBe('function');
    expect(item?.outputs.map((o) => o.type)).toEqual(['bytes32']);
    // The value the evaluator must send as `reject(jobId, reason, …)` for a quality verdict (C3d).
    expect(keccak256(toBytes('agentfi.quality-rejected'))).toBe(
      '0x0ec256357691b70fc22a1ea701b9b2c298924a0f2ba5275b8d2d638dbc64e281',
    );
    // A contest is not a verdict: its reason is distinct and writes nothing (FeedbackSkipped "not-verdict").
    expect(keccak256(toBytes('agentfi.contested'))).not.toBe(keccak256(toBytes('agentfi.quality-rejected')));
  });

  it('declares the C2b canonical-identity and penalty surface', () => {
    const events: Record<string, string[]> = {
      CanonicalAgentIdSet: ['address indexed provider', 'uint256 indexed agentId', 'uint256 indexed jobId'],
      AgentIdNotVerified: ['uint256 indexed jobId', 'address indexed provider', 'uint256 indexed agentId'],
      AgentPenalized: ['uint256 indexed agentId', 'uint256 indexed jobId', 'uint256 penalties'],
      PenaltiesCleared: ['uint256 indexed agentId', 'uint256 cleared'],
    };
    for (const [name, inputs] of Object.entries(events)) {
      const item = getAbiItem({ abi: HOOK_ABI, name }) as AbiEvent | undefined;
      expect(item?.type, `${name} missing from the generated ABI`).toBe('event');
      expect(item!.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`)).toEqual(inputs);
    }
    const functions: Record<string, string> = {
      canonicalAgentId: 'canonicalAgentId(address)',
      penalties: 'penalties(uint256)',
      clearPenalties: 'clearPenalties(uint256)',
    };
    for (const [name, signature] of Object.entries(functions)) {
      const item = getAbiItem({ abi: HOOK_ABI, name }) as AbiFunction | undefined;
      expect(item?.type, `${name} missing from the generated ABI`).toBe('function');
      expect(toFunctionSelector(item!)).toBe(toFunctionSelector(signature));
    }
  });
});

describe('generated ABI files match the Foundry artifacts (when built locally)', () => {
  it.each(Object.entries(ARTIFACTS))('%s', (name, artifactPath) => {
    if (!existsSync(artifactPath)) return; // CI without `forge build` — the generator is the source of truth there
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: unknown[] };
    const checkedIn = name === 'AgentJobEscrow' ? AGENT_JOB_ESCROW_ABI : REPUTATION_HOOK_ABI;
    expect(JSON.stringify(checkedIn)).toBe(JSON.stringify(artifact.abi));
  });
});
