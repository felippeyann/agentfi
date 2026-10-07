/**
 * Unit tests — the checked-in ERC-8004 Identity Registry ABI and the registry
 * configuration (R2).
 *
 * The ABI file is copied from the official repository, not generated from our
 * two-function `IIdentityRegistry.sol`; these tests pin the facts the backend
 * relies on (verified on 2026-10-07 against the Base Sepolia deployment, see
 * docs/architecture/erc-8004-integration.md §2):
 *  - three `register` overloads with the selectors the deployed bytecode exposes
 *  - `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
 *  - a real Base Sepolia `Registered` log's topics decode to agentId 9598 and
 *    its owner (= the tx sender = ownerOf = getAgentWallet on-chain)
 *  - the escrow's `setProviderAgentId(uint256,uint256)` the bind step calls
 *  - `resolveIdentityRegistry`: official defaults for Base / Base Sepolia,
 *    env override, blank = default, no default elsewhere
 */
import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  toEventSelector,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
  type Log,
} from 'viem';
import { IDENTITY_REGISTRY_ABI } from '../abi/IdentityRegistry.abi.js';
import { AGENT_JOB_ESCROW_ABI } from '../abi/AgentJobEscrow.abi.js';
import { DEFAULT_IDENTITY_REGISTRIES, resolveIdentityRegistry } from '../config/contracts.js';
import { parseRegisteredEvent } from '../services/job/erc8004-identity.service.js';

const BASE_SEPOLIA_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

describe('IdentityRegistry ABI (official, checked in)', () => {
  it('has exactly the three register overloads deployed on Base / Base Sepolia', () => {
    const overloads = IDENTITY_REGISTRY_ABI.filter((item) => item.type === 'function' && item.name === 'register') as AbiFunction[];
    const selectors = overloads.map((fn) => toFunctionSelector(fn)).sort();
    // register() / register(string,(string,bytes)[]) / register(string) — each present in implementation 0x7274e874…9c02.
    expect(selectors).toEqual(['0x1aa3a008', '0x8ea42286', '0xf2c298be']);
    for (const fn of overloads) expect(fn.outputs).toEqual([expect.objectContaining({ type: 'uint256' })]);
  });

  it('encodes register(agentURI) with the single-string overload', () => {
    const data = encodeFunctionData({ abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: ['https://x.test/a.json'] });
    expect(data.slice(0, 10)).toBe('0xf2c298be');
  });

  it('declares Registered(uint256 indexed agentId, string agentURI, address indexed owner)', () => {
    const event = getAbiItem({ abi: IDENTITY_REGISTRY_ABI, name: 'Registered' });
    expect(event).toMatchObject({
      type: 'event',
      inputs: [
        { name: 'agentId', type: 'uint256', indexed: true },
        { name: 'agentURI', type: 'string', indexed: false },
        { name: 'owner', type: 'address', indexed: true },
      ],
    });
    expect(toEventSelector('Registered(uint256,string,address)')).toBe('0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a');
  });

  it('exposes the identity views the ReputationHook gate reads and setAgentWallet', () => {
    const names = IDENTITY_REGISTRY_ABI.filter((item) => item.type === 'function').map((item) => (item as AbiFunction).name);
    expect(names).toEqual(expect.arrayContaining(['ownerOf', 'getAgentWallet', 'setAgentWallet', 'unsetAgentWallet', 'setAgentURI', 'tokenURI', 'getVersion']));
  });

  it('decodes the topics of a real Base Sepolia Registered log (tx 0x8c74d39e…7718, block 47809026)', () => {
    // topics copied from eth_getLogs on https://sepolia.base.org; data replaced by a
    // short agentURI (the original is a long base64 data: URI owned by a third party).
    const log = {
      address: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
      topics: [
        '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
        '0x000000000000000000000000000000000000000000000000000000000000257e',
        '0x000000000000000000000000260f054b6c4386c929e8674973ba5ad16e85592f',
      ],
      data: encodeAbiParameters([{ type: 'string' }], ['data:application/json;base64,e30=']),
      blockNumber: 47809026n,
      transactionHash: '0x8c74d39eb896cf1de15d441e7038dec38dd5ec4709ae7989f22b9893940e7718' as Hex,
      logIndex: 20,
    } as unknown as Log;

    expect(parseRegisteredEvent([log], BASE_SEPOLIA_REGISTRY)).toEqual({
      agentId: 9598n,
      owner: '0x260F054b6c4386C929e8674973BA5Ad16e85592f',
      agentURI: 'data:application/json;base64,e30=',
    });
    // Filtered by emitter: the same log from another address is ignored.
    expect(parseRegisteredEvent([{ ...log, address: '0x0000000000000000000000000000000000000001' } as Log], BASE_SEPOLIA_REGISTRY)).toBeNull();
  });

  it('AgentJobEscrow exposes setProviderAgentId(uint256 jobId, uint256 agentId) for the bind step', () => {
    const fn = getAbiItem({ abi: AGENT_JOB_ESCROW_ABI, name: 'setProviderAgentId' }) as AbiFunction;
    expect(fn.inputs.map((i) => i.type)).toEqual(['uint256', 'uint256']);
    expect(toFunctionSelector(fn)).toBe(toFunctionSelector('setProviderAgentId(uint256,uint256)'));
  });
});

describe('resolveIdentityRegistry', () => {
  it('defaults to the official deployments on Base and Base Sepolia (same as DeployEscrow.s.sol)', () => {
    expect(DEFAULT_IDENTITY_REGISTRIES).toEqual({
      8453: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      84532: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    });
    expect(resolveIdentityRegistry(8453, {})).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(resolveIdentityRegistry(84532, {})).toBe(BASE_SEPOLIA_REGISTRY);
  });

  it('IDENTITY_REGISTRY_ADDRESS_<chainId> overrides; blank means default; no default elsewhere', () => {
    const custom = '0x000000000000000000000000000000000000c0de';
    expect(resolveIdentityRegistry(84532, { IDENTITY_REGISTRY_ADDRESS_84532: custom })).toBe(custom);
    expect(resolveIdentityRegistry(84532, { IDENTITY_REGISTRY_ADDRESS_84532: '' })).toBe(BASE_SEPOLIA_REGISTRY);
    expect(resolveIdentityRegistry(42161, {})).toBeUndefined();
    expect(resolveIdentityRegistry(42161, { IDENTITY_REGISTRY_ADDRESS_42161: custom })).toBe(custom);
  });
});
