// `npm run alpha:test` — the destructive-target guard refuses what it must.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL, destructiveProblems, isDefaultTarget } from './guard.mjs';

const ok = { databaseUrl: DEFAULT_DATABASE_URL, redisUrl: DEFAULT_REDIS_URL };
test('the documented defaults are accepted', () => {
  assert.deepEqual(destructiveProblems(ok), []);
  assert.equal(isDefaultTarget(ok.databaseUrl, ok.redisUrl), true);
});
test('a remote Postgres host is refused unless X402_DEMO_ALLOW_REMOTE', () => {
  const remote = { ...ok, databaseUrl: 'postgresql://u:p@db.example.com:5432/agentfi_e2e_x402' };
  assert.match(destructiveProblems(remote).join('\n'), /not loopback/);
  assert.deepEqual(destructiveProblems({ ...remote, allowRemote: true }), []);
});
test('a remote Redis host is refused', () => {
  assert.match(destructiveProblems({ ...ok, redisUrl: 'redis://cache.example.com:6379/14' }).join('\n'), /Redis host/);
});
test('a database name that is not a test name, and the dev database, are refused', () => {
  assert.match(destructiveProblems({ ...ok, databaseUrl: 'postgresql://a:b@localhost:5432/production' }).join('\n'), /does not contain e2e, demo or test/);
  assert.match(destructiveProblems({ ...ok, databaseUrl: 'postgresql://a:b@localhost:5432/agentfi' }).join('\n'), /dev database/);
});
test('Redis DB 0 (or none) is refused', () => {
  assert.match(destructiveProblems({ ...ok, redisUrl: 'redis://localhost:6379/0' }).join('\n'), /logical DB 0/);
  assert.match(destructiveProblems({ ...ok, redisUrl: 'redis://localhost:6379' }).join('\n'), /logical DB 0/);
});
test('loopback spellings are accepted', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    assert.deepEqual(destructiveProblems({ databaseUrl: `postgresql://a:b@${host}:5432/x_demo`, redisUrl: `redis://${host}:6379/3` }), []);
  }
});
