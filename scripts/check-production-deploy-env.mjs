#!/usr/bin/env node

function fail(message) {
  console.error(`::error::${message}`);
}

function warn(message) {
  console.warn(`::warning::${message}`);
}

function info(message) {
  console.log(`[deploy-preflight] ${message}`);
}

const required = [
  'RAILWAY_TOKEN',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_PRODUCTION_ENVIRONMENT',
  'RAILWAY_PRODUCTION_SERVICE',
];

const values = Object.fromEntries(required.map((key) => [key, process.env[key] ?? '']));

const missing = required.filter((key) => values[key].trim().length === 0);

if (missing.length > 0) {
  for (const key of missing) {
    fail(`Missing required production deploy variable: ${key}`);
  }
  process.exit(1);
}

const placeholderFragments = ['your-', 'change-me', 'example', 'todo'];
for (const [key, value] of Object.entries(values)) {
  const lowered = value.toLowerCase();
  if (placeholderFragments.some((frag) => lowered.includes(frag))) {
    fail(`${key} appears to use a placeholder value`);
    process.exit(1);
  }
}

const workerService = (process.env['RAILWAY_PRODUCTION_WORKER_SERVICE'] ?? '').trim();
if (workerService.length > 0 && workerService === values['RAILWAY_PRODUCTION_SERVICE']) {
  fail('RAILWAY_PRODUCTION_WORKER_SERVICE must not equal RAILWAY_PRODUCTION_SERVICE');
  process.exit(1);
}

if (workerService.length === 0) {
  warn('RAILWAY_PRODUCTION_WORKER_SERVICE is not set; only the primary production service will be deployed');
}

info('Production deploy config preflight passed');
