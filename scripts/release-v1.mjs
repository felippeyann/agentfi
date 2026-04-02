#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const IGNORE_DIRTY_PREFIXES = ['.claude/', 'docs/railway_logs/'];

function quoteArg(arg) {
  if (/^[a-zA-Z0-9_/:.=,@-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function buildCommandLine(command, args) {
  return [command, ...args.map(quoteArg)].join(' ');
}

function run(command, args, options = {}) {
  const printable = buildCommandLine(command, args);
  console.log(`\n$ ${printable}`);
  const result = spawnSync(printable, {
    stdio: 'inherit',
    shell: true,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${printable}`);
  }
}

function runCapture(command, args) {
  const commandLine = buildCommandLine(command, args);
  const result = spawnSync(commandLine, {
    encoding: 'utf8',
    shell: true,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new Error(stderr || `Command failed: ${command} ${args.join(' ')}`);
  }

  return (result.stdout ?? '').trim();
}

function getDirtyPaths() {
  const status = runCapture('git', ['status', '--porcelain']);
  if (!status) return [];

  return status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => !IGNORE_DIRTY_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

function parseVersion(raw) {
  if (!raw || !/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error('Version must be semver in the form X.Y.Z (example: 1.0.0)');
  }
  return raw;
}

function hasEnv(name) {
  return Boolean(process.env[name] && process.env[name].trim().length > 0);
}

function printUsage() {
  console.log(`
Usage:
  node scripts/release-v1.mjs check
  node scripts/release-v1.mjs tag <X.Y.Z> [--push] [--skip-check]

Examples:
  npm run release:v1:check
  npm run release:v1:tag -- 1.0.0
  npm run release:v1:tag -- 1.0.0 --push
`);
}

function runReleaseChecks() {
  console.log('Running V1 release checks...');

  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
  run('npm', ['run', 'preflight:deploy-scenarios']);

  const hasTestnetEnv =
    hasEnv('E2E_TESTNET_RPC_URL') &&
    hasEnv('E2E_TESTNET_POLICY_MODULE_ADDRESS') &&
    hasEnv('E2E_TESTNET_EXECUTOR_ADDRESS');

  if (hasTestnetEnv) {
    run('npm', ['--workspace', 'packages/backend', 'run', 'test:e2e:testnet']);
  } else {
    console.log(
      '\n[warn] Skipping testnet smoke: set E2E_TESTNET_RPC_URL, ' +
        'E2E_TESTNET_POLICY_MODULE_ADDRESS, and E2E_TESTNET_EXECUTOR_ADDRESS to enable it.',
    );
  }

  const hasDeployEnv =
    hasEnv('RAILWAY_TOKEN') &&
    hasEnv('RAILWAY_PROJECT_ID') &&
    hasEnv('RAILWAY_PRODUCTION_ENVIRONMENT');

  if (hasDeployEnv) {
    run('node', ['scripts/check-production-deploy-env.mjs']);
  } else {
    console.log(
      '\n[warn] Skipping deploy env preflight: set RAILWAY_TOKEN, RAILWAY_PROJECT_ID, ' +
        'and RAILWAY_PRODUCTION_ENVIRONMENT to validate production deploy wiring locally.',
    );
  }

  console.log('\nRelease checks passed.');
}

function tagRelease(args) {
  const version = parseVersion(args[0]);
  const push = args.includes('--push');
  const skipCheck = args.includes('--skip-check');
  const tag = `v${version}`;

  const dirtyPaths = getDirtyPaths();
  if (dirtyPaths.length > 0) {
    throw new Error(
      'Refusing to tag with uncommitted changes:\n' +
        dirtyPaths.map((p) => `  - ${p}`).join('\n'),
    );
  }

  const currentBranch = runCapture('git', ['branch', '--show-current']);
  if (currentBranch !== 'develop') {
    console.log(`[warn] Tagging from branch "${currentBranch}" (expected "develop").`);
  }

  if (!skipCheck) {
    runReleaseChecks();
  }

  const existingTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    stdio: 'ignore',
  });
  if (existingTag.status === 0) {
    throw new Error(`Tag already exists: ${tag}`);
  }

  run('git', ['tag', '-a', tag, '-m', `AgentFi V1 self-hosted release ${tag}`]);
  console.log(`\nCreated tag ${tag}`);

  if (push) {
    run('git', ['push', 'origin', tag]);
    console.log(`Pushed tag ${tag} to origin.`);
  } else {
    console.log(`\nNext step:\n  git push origin ${tag}`);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'check') {
    runReleaseChecks();
    return;
  }

  if (command === 'tag') {
    tagRelease(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[release-v1] ${message}`);
  process.exit(1);
}
