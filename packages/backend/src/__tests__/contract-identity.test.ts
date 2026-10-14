/**
 * Unit tests — S9 code identity (`config/contract-identity.ts`) and the
 * generated expected code (`abi/contract-code.generated.ts`).
 *
 * The checks against real deployments (our build, an EOA, a foreign contract,
 * a lookalike, a legacy build) run on Anvil in `contract-identity.*.anvil.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_CONTRACT_CODE, EXPECTED_CONTRACT_CODE_VERSION } from '../abi/contract-code.generated.js';
import { codeIdentityProblem, maskImmutables } from '../config/contract-identity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = ['AgentPolicyModule', 'AgentExecutor', 'AgentJobEscrow', 'ReputationHook'] as const;

/** `runtime` with every immutable range filled with `byte`. */
function withImmutables(name: (typeof NAMES)[number], byte: string): string {
  const { runtime, immutables } = EXPECTED_CONTRACT_CODE[name];
  const hex = runtime.slice(2).split('');
  for (const { start, length } of immutables) {
    for (let i = start * 2; i < (start + length) * 2; i++) hex[i] = byte;
  }
  return `0x${hex.join('')}`;
}

/** Flips one nibble at `byteIndex` (hex digit `byteIndex * 2`). */
function flip(code: string, byteIndex: number): string {
  const i = 2 + byteIndex * 2;
  const digit = code[i] === 'f' ? 'e' : 'f';
  return `${code.slice(0, i)}${digit}${code.slice(i + 1)}`;
}

function outsideImmutables(name: (typeof NAMES)[number]): number {
  const { runtime, immutables } = EXPECTED_CONTRACT_CODE[name];
  const covered = (b: number) => immutables.some(({ start, length }) => b >= start && b < start + length);
  for (let b = 0; b < (runtime.length - 2) / 2; b++) if (!covered(b)) return b;
  throw new Error('no byte outside the immutables');
}

describe('generated expected code', () => {
  it('has the four contracts, each with immutable ranges inside its runtime, built without a CBOR trailer', () => {
    expect(Object.keys(EXPECTED_CONTRACT_CODE).sort()).toEqual([...NAMES].sort());
    expect(EXPECTED_CONTRACT_CODE_VERSION).toMatch(/^[0-9a-f]{64}$/);
    for (const name of NAMES) {
      const { runtime, immutables } = EXPECTED_CONTRACT_CODE[name];
      expect(runtime).toMatch(/^0x[0-9a-f]+$/);
      expect(immutables.length, name).toBeGreaterThan(0);
      for (const { start, length } of immutables) {
        expect(start + length).toBeLessThanOrEqual((runtime.length - 2) / 2);
        // The compiler leaves immutable slots zeroed in the runtime object.
        expect(runtime.slice(2 + start * 2, 2 + (start + length) * 2)).toMatch(/^0+$/);
      }
      // bytecode_hash = "none" + cbor_metadata = false: no `a2 64 'ipfs' 58 22` metadata trailer.
      expect(runtime).not.toContain('a264697066735822');
    }
  });

  it('matches the Foundry artifacts when they are built locally (CI: npm run contracts:code:check)', () => {
    for (const name of NAMES) {
      const artifact = path.resolve(here, `../../../contracts/out/${name}.sol/${name}.json`);
      if (!existsSync(artifact)) continue;
      const json = JSON.parse(readFileSync(artifact, 'utf8')) as { deployedBytecode: { object: string } };
      expect(json.deployedBytecode.object.toLowerCase(), `${name}: run forge build + npm run contracts:code`).toBe(EXPECTED_CONTRACT_CODE[name].runtime);
    }
  });
});

describe('codeIdentityProblem', () => {
  it.each(NAMES)('%s: this build with its immutables filled in is ours', (name) => {
    expect(codeIdentityProblem(name, EXPECTED_CONTRACT_CODE[name].runtime)).toBeNull();
    expect(codeIdentityProblem(name, withImmutables(name, 'a'))).toBeNull();
    expect(codeIdentityProblem(name, withImmutables(name, 'F').toUpperCase().replace('0X', '0x'))).toBeNull(); // hex case is not identity
  });

  it('no code (EOA, typo, wrong chain) is refused', () => {
    expect(codeIdentityProblem('AgentExecutor', undefined)).toMatch(/no code at the address/);
    expect(codeIdentityProblem('AgentExecutor', '0x')).toMatch(/no code at the address/);
    expect(codeIdentityProblem('AgentExecutor', null)).toMatch(/no code at the address/);
  });

  it('another size (another contract, a proxy, an EIP-7702 delegation, a legacy build) is refused', () => {
    expect(codeIdentityProblem('AgentExecutor', `${EXPECTED_CONTRACT_CODE.AgentExecutor.runtime}00`)).toMatch(/runtime code is \d+ bytes/);
    expect(codeIdentityProblem('AgentExecutor', EXPECTED_CONTRACT_CODE.AgentPolicyModule.runtime)).toMatch(/runtime code is \d+ bytes/);
    // EIP-1167 minimal proxy and an EIP-7702 delegation designator.
    expect(codeIdentityProblem('AgentPolicyModule', '0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3')).toMatch(/bytes/);
    expect(codeIdentityProblem('AgentPolicyModule', '0xef0100bebebebebebebebebebebebebebebebebebebebe')).toMatch(/bytes/);
  });

  it.each(NAMES)('%s: one byte changed OUTSIDE the immutables is refused (same size, different logic)', (name) => {
    const changed = flip(EXPECTED_CONTRACT_CODE[name].runtime, outsideImmutables(name));
    expect(codeIdentityProblem(name, changed)).toMatch(/is not this build's/);
  });

  it('maskImmutables zeroes exactly the declared ranges', () => {
    const { runtime, immutables } = EXPECTED_CONTRACT_CODE.AgentExecutor;
    expect(maskImmutables(withImmutables('AgentExecutor', '9'), immutables)).toBe(runtime);
  });
});
