import { describe, expect, it } from 'vitest';
import { destructivePostgresProblem, destructiveRedisProblem } from './e2e/destructive-guard.js';

describe('destructive harness guard', () => {
  it('accepts private loopback test targets', () => {
    expect(destructivePostgresProblem('postgresql://a:b@localhost:5432/agentfi_e2e_x402', {})).toBeNull();
    expect(destructivePostgresProblem('postgresql://a:b@[::1]:5432/x_demo', {})).toBeNull();
    expect(destructiveRedisProblem('redis://127.0.0.1:6379/14', {})).toBeNull();
  });
  it('refuses a remote host unless X402_DEMO_ALLOW_REMOTE=1', () => {
    expect(destructivePostgresProblem('postgresql://a:b@db.example.com/agentfi_e2e_x', {})).toMatch(/not loopback/);
    expect(destructivePostgresProblem('postgresql://a:b@db.example.com/agentfi_e2e_x', { X402_DEMO_ALLOW_REMOTE: '1' })).toBeNull();
    expect(destructiveRedisProblem('redis://cache.example.com:6379/3', {})).toMatch(/not loopback/);
  });
  it('refuses the dev database, a non-test database name and Redis DB 0', () => {
    expect(destructivePostgresProblem('postgresql://a:b@localhost/agentfi', {})).toMatch(/dev database/);
    expect(destructivePostgresProblem('postgresql://a:b@localhost/production', {})).toMatch(/e2e, demo or test/);
    expect(destructiveRedisProblem('redis://localhost:6379/0', {})).toMatch(/logical DB 0/);
    expect(destructiveRedisProblem('redis://localhost:6379', {})).toMatch(/logical DB 0/);
  });
});
