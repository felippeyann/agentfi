#!/usr/bin/env node
/**
 * Fails CI if the generated API types file would change after
 * re-running codegen from the current OpenAPI spec.
 *
 * Runs `npm run spec:types`, then compares the regenerated file to
 * what's checked in. If they differ, prints the diff and exits non-zero
 * so the author knows to re-run codegen locally and commit the update.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const TYPES_PATH = 'packages/mcp-server/src/api.generated.ts';

const original = (() => {
  try {
    return readFileSync(TYPES_PATH, 'utf8');
  } catch {
    console.error(`[spec:check] Expected generated types at ${TYPES_PATH} — run \`npm run spec:types\` first.`);
    process.exit(1);
  }
})();

// Resolve the openapi-typescript binary inside the repo and invoke it
// directly with node — avoids the shell:true DeprecationWarning and is
// portable between bash/PowerShell.
const require = createRequire(import.meta.url);
const pkgJson = require.resolve('openapi-typescript/package.json');
const pkgDir = pkgJson.replace(/[\\/]package\.json$/, '');
const { bin } = require(pkgJson);
const binRel = typeof bin === 'string' ? bin : bin['openapi-typescript'];
const binPath = `${pkgDir}/${binRel}`;

const gen = spawnSync(
  process.execPath,
  [binPath, 'docs/api/openapi.yaml', '-o', TYPES_PATH],
  { stdio: 'inherit' },
);
if (gen.status !== 0) {
  console.error('[spec:check] openapi-typescript failed.');
  process.exit(gen.status ?? 1);
}

const updated = readFileSync(TYPES_PATH, 'utf8');

if (original !== updated) {
  console.error(
    '\n[spec:check] Generated API types drifted from the OpenAPI spec.\n' +
      '  Run `npm run spec:types` locally and commit the updated file at:\n' +
      `    ${TYPES_PATH}\n`,
  );
  // Keep the regenerated file on disk so the caller can diff it.
  process.exit(1);
}

console.log('[spec:check] Generated types are up to date.');
