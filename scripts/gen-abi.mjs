#!/usr/bin/env node
/**
 * Regenerates the backend's contract ABIs from the Foundry source so the
 * TypeScript encoders/decoders can never drift from `packages/contracts/src`.
 *
 * Usage (repo root, `forge` in PATH):
 *   node scripts/gen-abi.mjs                      # every contract in the table
 *   node scripts/gen-abi.mjs AgentExecutor        # one or more by name
 *   npm run abi            # all
 *   npm run abi:executor   # AgentExecutor only
 *   npm run abi:escrow     # AgentJobEscrow + ReputationHook
 *
 * Output: packages/backend/src/abi/<Contract>.abi.ts (checked in — commit it
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
const OUT_DIR = join(ROOT, 'packages', 'backend', 'src', 'abi');

// Windows: spell out the .exe so PATH lookup works without a shell.
const FORGE = process.platform === 'win32' ? 'forge.exe' : 'forge';

/** Contract → exported constant + a header note that explains what the ABI is for. */
const CONTRACTS = {
  AgentExecutor: {
    exportName: 'AGENT_EXECUTOR_ABI',
    note:
      'The `Action` struct is (target, value, token, data). Contracts compiled from\n' +
      ' * the pre-October-2026 struct (target, value, data) expose different selectors\n' +
      ' * and must be redeployed before the backend routes through them — see\n' +
      ' * docs/operations/contract-deployment.md ("ABI versioning").',
  },
  AgentJobEscrow: {
    exportName: 'AGENT_JOB_ESCROW_ABI',
    note:
      'ERC-8183 (Agentic Commerce) job escrow, USDC only. The backend encodes\n' +
      ' * createJob/setBudget/fund/submit (agent wallets), complete/reject/claimRefund\n' +
      ' * (evaluator signer) and decodes JobCreated/JobFunded/JobSubmitted/\n' +
      ' * JobCompleted/JobRejected/JobExpired/PaymentReleased/PlatformFeeAccrued/Refunded —\n' +
      ' * see docs/architecture/erc-8183-mapping.md §6.',
  },
  ReputationHook: {
    exportName: 'REPUTATION_HOOK_ABI',
    note:
      'ERC-8183 IACPHook that writes ERC-8004 feedback in the settlement tx. The\n' +
      ' * backend only decodes its FeedbackWritten/FeedbackSkipped/FeedbackFailed events\n' +
      ' * from the complete/reject receipt — see docs/architecture/erc-8004-integration.md §4.',
  },
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(CONTRACTS);
for (const name of names) {
  if (!CONTRACTS[name]) {
    console.error(`Unknown contract "${name}". Known: ${Object.keys(CONTRACTS).join(', ')}`);
    process.exit(1);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

for (const name of names) {
  const { exportName, note } = CONTRACTS[name];
  const raw = execFileSync(FORGE, ['inspect', name, 'abi', '--json'], {
    cwd: CONTRACTS_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const abi = JSON.parse(raw);
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new Error(`forge inspect returned an empty ABI for ${name}`);
  }

  const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source: packages/contracts/src/${name}.sol
 * Regenerate: node scripts/gen-abi.mjs ${name}  (or: npm run abi)
 *
 * ${note}
 */

`;

  const outFile = join(OUT_DIR, `${name}.abi.ts`);
  writeFileSync(outFile, `${header}export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`);
  console.log(`Wrote ${relative(ROOT, outFile)} (${abi.length} ABI entries)`);
}
