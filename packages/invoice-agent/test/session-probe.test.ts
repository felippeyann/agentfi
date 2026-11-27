/**
 * `npm run session -- --rehearse --vault --probe-paid ID`: before the new invoice, an invoice the vault has already settled
 * is resent to an agent whose ledger does not know it; it must be refused by the chain (vault:AlreadySettled) with nothing
 * signed, and the session then pays the new invoice exactly once. Also the guards that stop before anything is signed.
 *
 * Run: npm test (in packages/invoice-agent). Needs `anvil` on PATH or in ~/.foundry/bin. Own ports, own temp dir.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { freePort } from './fixtures/free-port.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
// Ports the OS reports free (test files run in parallel, each with its own Anvil): see fixtures/free-port.ts.
const base = await freePort();
const agentPort = await freePort();

function session(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/session.ts', ...args], { cwd: PKG, env: { ...process.env, INVOICE_PAYER_KEY: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout!.on('data', (d) => (out += d));
    c.stderr!.on('data', (d) => (out += d));
    c.on('exit', (code) => res({ code, out }));
  });
}

describe('session --probe-paid', () => {
  it('is refused without --vault, and when it names the session invoice, before any chain is started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-guard-'));
    const a = await session(['--rehearse', '--probe-paid', 'QDAY-OLD', '--anvil-port', String(base), '--agent-port', String(agentPort), '--dir', join(dir, 'a')]);
    assert.equal(a.code, 3);
    assert.match(a.out, /--probe-paid needs --vault/);
    const b = await session(['--rehearse', '--vault', '--invoice', 'QDAY-X', '--probe-paid', 'QDAY-X', '--anvil-port', String(base), '--agent-port', String(agentPort), '--dir', join(dir, 'b')]);
    assert.equal(b.code, 3);
    assert.match(b.out, /other than this session's QDAY-X/);
  });

  it('never sends a probe the vault has not settled (it would be paid): stops before the agent starts, nothing signed', { timeout: 120_000 }, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'probe-unsettled-')), 's');
    const r = await session(['--rehearse', '--vault', '--max-gas-cost', '0.0002', '--probe-paid', 'QDAY-TYPO-001', '--invoice', 'QDAY-2026-11-27-001', '--anvil-port', String(base), '--agent-port', String(agentPort), '--dir', dir], { SESSION_REHEARSE_SKIP_PROBE_HISTORY: '1' });
    const t = readFileSync(join(dir, 'transcript.txt'), 'utf8');
    assert.equal(r.code, 3, t);
    assert.match(t, /STOP: the vault shows QDAY-TYPO-001 as NOT settled under vendor-1: no probe is sent/);
    assert.doesNotMatch(t, /agent →/);
    assert.doesNotMatch(t, /\n3\. Invoice/);
  });

  it('rehearses the second session: the old invoice refused by the vault with nothing signed, then the new one paid once', { timeout: 240_000 }, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'probe-run-')), 's');
    const r = await session(['--rehearse', '--vault', '--max-gas-cost', '0.0002', '--max-priority-fee-gwei', '1', '--probe-paid', 'QDAY-2026-11-24-001', '--invoice', 'QDAY-2026-11-27-001', '--anvil-port', String(base), '--agent-port', String(agentPort), '--dir', dir]);
    const t = readFileSync(join(dir, 'transcript.txt'), 'utf8');
    assert.equal(r.code, 0, t);
    assert.match(t, /settlementOf\("QDAY-2026-11-24-001"\): settled, 1 tUSD8/);
    assert.match(t, /agent → REFUSED \[vault:AlreadySettled\]/);
    assert.match(t, /ledger row: refused, tx hash none · events refused-by-vault · agent nonce \(pending\) (\d+) → \1/);
    assert.match(t, /Transfer logs vault → vendor since block \d+: 1 /);
    assert.match(t, /InvoiceSettled events of the vault since block \d+: 1 \("QDAY-2026-11-27-001"/);
    assert.match(t, /vault 0 tUSD8/);
    assert.match(t, /OK: one invoice, one transfer, one receipt/);
  });
});
