#!/usr/bin/env node
/**
 * Regenerates the backend's AgentExecutor ABI from the Foundry source so the
 * TypeScript encoder can never drift from `packages/contracts/src/AgentExecutor.sol`.
 *
 * Usage (repo root, `forge` in PATH):
 *   node scripts/gen-executor-abi.mjs
 *   npm run abi:executor
 *
 * Output: packages/backend/src/abi/AgentExecutor.abi.ts (checked in — commit it
 * together with any Solidity change that touches the ABI).
 *
 * `forge inspect` compiles the contract if needed, so no separate `forge build`
 * is required.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACTS_DIR = join(ROOT, 'packages', 'contracts');
const OUT_FILE = join(ROOT, 'packages', 'backend', 'src', 'abi', 'AgentExecutor.abi.ts');

// Windows: spell out the .exe so PATH lookup works without a shell.
const FORGE = process.platform === 'win32' ? 'forge.exe' : 'forge';

const raw = execFileSync(FORGE, ['inspect', 'AgentExecutor', 'abi', '--json'], {
  cwd: CONTRACTS_DIR,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const abi = JSON.parse(raw);
if (!Array.isArray(abi) || abi.length === 0) {
  throw new Error('forge inspect returned an empty ABI');
}

const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source: packages/contracts/src/AgentExecutor.sol
 * Regenerate: node scripts/gen-executor-abi.mjs  (or: npm run abi:executor)
 *
 * The \`Action\` struct is (target, value, token, data). Contracts compiled from
 * the pre-October-2026 struct (target, value, data) expose different selectors
 * and must be redeployed before the backend routes through them — see
 * docs/operations/contract-deployment.md ("ABI versioning").
 */

`;

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(
  OUT_FILE,
  `${header}export const AGENT_EXECUTOR_ABI = ${JSON.stringify(abi, null, 2)} as const;\n`,
);

console.log(`Wrote ${relative(ROOT, OUT_FILE)} (${abi.length} ABI entries)`);
