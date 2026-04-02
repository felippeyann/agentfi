#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preflightScriptPath = fileURLToPath(new URL('./check-production-deploy-env.mjs', import.meta.url));

function runPreflightScenario(name, envOverrides, expectSuccess) {
  const env = { ...process.env };

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === null) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = spawnSync(process.execPath, [preflightScriptPath], {
    env,
    encoding: 'utf8',
  });

  const success = result.status === 0;
  const passedExpectation = expectSuccess ? success : !success;

  const symbol = passedExpectation ? 'PASS' : 'FAIL';
  console.log(`[${symbol}] ${name}`);

  if (!passedExpectation) {
    if (result.stdout) {
      console.log('  stdout:');
      console.log(result.stdout.trim());
    }
    if (result.stderr) {
      console.log('  stderr:');
      console.log(result.stderr.trim());
    }
    console.log(`  exitCode: ${result.status ?? 'null'}`);
  }

  return passedExpectation;
}

const scenarios = [
  {
    name: 'pass path',
    expectSuccess: true,
    envOverrides: {
      RAILWAY_TOKEN: 'ci-token',
      RAILWAY_PROJECT_ID: 'ci-project-id',
      RAILWAY_PRODUCTION_ENVIRONMENT: 'ci-production-env',
      RAILWAY_PRODUCTION_SERVICE: 'backend',
      RAILWAY_PRODUCTION_WORKER_SERVICE: 'worker',
    },
  },
  {
    name: 'missing required variable fails',
    expectSuccess: false,
    envOverrides: {
      RAILWAY_TOKEN: 'ci-token',
      RAILWAY_PROJECT_ID: 'ci-project-id',
      RAILWAY_PRODUCTION_ENVIRONMENT: null,
      RAILWAY_PRODUCTION_SERVICE: 'backend',
      RAILWAY_PRODUCTION_WORKER_SERVICE: null,
    },
  },
  {
    name: 'placeholder value fails',
    expectSuccess: false,
    envOverrides: {
      RAILWAY_TOKEN: 'your-token',
      RAILWAY_PROJECT_ID: 'ci-project-id',
      RAILWAY_PRODUCTION_ENVIRONMENT: 'ci-production-env',
      RAILWAY_PRODUCTION_SERVICE: 'backend',
      RAILWAY_PRODUCTION_WORKER_SERVICE: null,
    },
  },
  {
    name: 'duplicate service names fail',
    expectSuccess: false,
    envOverrides: {
      RAILWAY_TOKEN: 'ci-token',
      RAILWAY_PROJECT_ID: 'ci-project-id',
      RAILWAY_PRODUCTION_ENVIRONMENT: 'ci-production-env',
      RAILWAY_PRODUCTION_SERVICE: 'backend',
      RAILWAY_PRODUCTION_WORKER_SERVICE: 'backend',
    },
  },
];

console.log('Deploy preflight local scenario runner');
console.log('====================================');

let allPassed = true;
for (const scenario of scenarios) {
  const passed = runPreflightScenario(
    scenario.name,
    scenario.envOverrides,
    scenario.expectSuccess,
  );
  allPassed = allPassed && passed;
}

console.log('------------------------------------');
if (allPassed) {
  console.log('All deploy-preflight scenarios behaved as expected.');
  process.exit(0);
}

console.error('One or more deploy-preflight scenarios did not match expected outcomes.');
process.exit(1);
