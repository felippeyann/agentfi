#!/usr/bin/env node
/**
 * S9 (owner decision 2026-10-14, "bytecode of the repo build") — embeds the
 * expected RUNTIME bytecode of the contracts the backend grants authority to
 * or sends value through, generated from this repository's Foundry build.
 *
 * The backend compares it byte for byte with `eth_getCode` at the configured
 * addresses, masking only the immutable ranges the compiler declares
 * (`immutableReferences`), before any of those contracts is used
 * (`packages/backend/src/config/contract-identity.ts`).
 *
 * Usage (repo root, after `forge build` in packages/contracts):
 *   node scripts/gen-contract-code.mjs           # write the generated file
 *   node scripts/gen-contract-code.mjs --check   # exit 1 when it drifted from the artifacts (CI)
 *   npm run contracts:code / npm run contracts:code:check
 *
 * Refuses an artifact built WITH compiler metadata (`bytecode_hash` other than
 * "none" or a CBOR trailer): its code would depend on comments and paths, and
 * an identical contract rebuilt from an edited file would stop verifying.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'packages', 'contracts', 'out');
const TARGET = join(ROOT, 'packages', 'backend', 'src', 'abi', 'contract-code.generated.ts');

/** The contracts the backend verifies by code (owner decision: these four). */
const CONTRACTS = ['AgentPolicyModule', 'AgentExecutor', 'AgentJobEscrow', 'ReputationHook'];

function load(name) {
  const path = join(OUT_DIR, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    console.error(`[contracts:code] ${relative(ROOT, path)} is missing — run \`forge build\` in packages/contracts first`);
    process.exit(2);
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const bytecodeHash = artifact.metadata?.settings?.metadata?.bytecodeHash;
  if (bytecodeHash !== 'none') {
    console.error(
      `[contracts:code] ${name} was built with metadata.bytecodeHash = ${JSON.stringify(bytecodeHash)}; ` +
        'packages/contracts/foundry.toml must set bytecode_hash = "none" and cbor_metadata = false (rebuild after changing it)',
    );
    process.exit(2);
  }
  const runtime = String(artifact.deployedBytecode?.object ?? '').toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(runtime) || runtime.length < 4) {
    console.error(`[contracts:code] ${name}: no runtime bytecode in the artifact`);
    process.exit(2);
  }
  const ranges = Object.values(artifact.deployedBytecode.immutableReferences ?? {})
    .flat()
    .map(({ start, length }) => ({ start, length }))
    .sort((a, b) => a.start - b.start);
  return { runtime, ranges };
}

const entries = CONTRACTS.map((name) => [name, load(name)]);
const version = createHash('sha256')
  .update(JSON.stringify(entries))
  .digest('hex');

const body = entries
  .map(([name, { runtime, ranges }]) => {
    const immutables = ranges.map((r) => `{ start: ${r.start}, length: ${r.length} }`).join(', ');
    return `  ${name}: {\n    runtime: '${runtime}',\n    immutables: [${immutables}],\n  },`;
  })
  .join('\n');

const content = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Expected RUNTIME bytecode of ${CONTRACTS.join(', ')},
 * from this repository's Foundry build (packages/contracts/out, compiled without metadata:
 * foundry.toml bytecode_hash = "none", cbor_metadata = false). Immutable slots are zero here;
 * \`immutables\` lists their byte ranges (the compiler's immutableReferences).
 *
 * Regenerate: forge build (packages/contracts), then \`npm run contracts:code\`.
 * CI: \`npm run contracts:code:check\` fails when this file drifts from the artifacts.
 * Used by packages/backend/src/config/contract-identity.ts (S9).
 */

export interface ExpectedContractCode {
  readonly runtime: \`0x\${string}\`;
  readonly immutables: ReadonlyArray<{ readonly start: number; readonly length: number }>;
}

/** sha256 of the entries below: binds a verification to the build it checked against. */
export const EXPECTED_CONTRACT_CODE_VERSION = '${version}';

export const EXPECTED_CONTRACT_CODE = {
${body}
} as const satisfies Record<string, ExpectedContractCode>;

export type VerifiedContractName = keyof typeof EXPECTED_CONTRACT_CODE;
`;

if (process.argv.includes('--check')) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== content) {
    console.error(
      `[contracts:code] ${relative(ROOT, TARGET)} does not match the current Foundry artifacts. ` +
        'A contract (or foundry.toml) changed: run `forge build` and `npm run contracts:code`, and commit the result. ' +
        'Deployed contracts verify only against the build they were deployed from.',
    );
    process.exit(1);
  }
  console.log(`[contracts:code] ${relative(ROOT, TARGET)} matches the artifacts (version ${version.slice(0, 12)}).`);
} else {
  writeFileSync(TARGET, content);
  console.log(`[contracts:code] wrote ${relative(ROOT, TARGET)} (version ${version.slice(0, 12)})`);
}
