import { describe, expect, it } from 'vitest';
import { destructivePostgresProblem, destructiveRedisProblem, maskUrl } from './e2e/destructive-guard.js';

describe('destructive harness guard', () => {
  it('accepts private loopback test targets, including bracketed IPv6', () => {
    expect(destructivePostgresProblem('postgresql://a:b@localhost:5432/agentfi_e2e_x402', {})).toBeNull();
    expect(destructivePostgresProblem('postgresql://u:p@[::1]:5432/x_e2e', {})).toBeNull();
    expect(destructiveRedisProblem('redis://[::1]:6379/14', {})).toBeNull();
    expect(destructiveRedisProblem('redis://127.0.0.1:6379/14', {})).toBeNull();
    for (const name of ['agentfi_e2e_escrow', 'agentfi_e2e', 'agentfi_you_e2e', 'agentfi_test']) {
      expect(destructivePostgresProblem(`postgresql://a:b@localhost/${name}`, {}), name).toBeNull();
    }
  });
  it('refuses a remote host unless X402_DEMO_ALLOW_REMOTE=1', () => {
    expect(destructivePostgresProblem('postgresql://a:b@db.example.com/agentfi_e2e_x', {})).toMatch(/not loopback/);
    expect(destructivePostgresProblem('postgresql://a:b@db.example.com/agentfi_e2e_x', { X402_DEMO_ALLOW_REMOTE: '1' })).toBeNull();
    expect(destructiveRedisProblem('redis://cache.example.com:6379/3', {})).toMatch(/not loopback/);
  });
  it('refuses URL parameters that redirect the Postgres connection', () => {
    for (const q of ['host=evil.com', 'hostaddr=10.0.0.5', 'service=prod', 'options=-c%20x%3D1', 'application_name=x']) {
      expect(destructivePostgresProblem(`postgresql://a:b@localhost/x_e2e?${q}`, {}), q).toMatch(/URL parameter/);
    }
    expect(destructivePostgresProblem('postgresql://a:b@localhost/x_e2e?schema=public&sslmode=disable', {})).toBeNull();
  });
  it('refuses the dev databases, substring-only names and Redis DB 0', () => {
    for (const name of ['agentfi', 'agentfi_c5', 'agentfi_alpha', 'latest', 'contest', 'attestation', 'production']) {
      expect(destructivePostgresProblem(`postgresql://a:b@localhost/${name}`, {}), name).not.toBeNull();
    }
    expect(destructiveRedisProblem('redis://localhost:6379/0', {})).toMatch(/logical DB 0/);
    expect(destructiveRedisProblem('redis://localhost:6379', {})).toMatch(/logical DB 0/);
  });
  it('masks credentials in messages', () => {
    expect(maskUrl('redis://user:secret@localhost:6379/3')).toBe('redis://***@localhost:6379/3');
  });
});
