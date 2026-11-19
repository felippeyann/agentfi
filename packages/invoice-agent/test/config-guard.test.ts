// The demo's keys are Anvil's public development keys: the agent must refuse them off a local chain.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { isPublicAnvilKey, loadConfig } from '../src/config.js';
import { saveMandate } from '../src/mandate.js';

const ANVIL_PAYER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

function withMandate(chainId: number, env: Record<string, string>, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-agent-cfg-'));
  const path = join(dir, 'mandate.json');
  saveMandate(path, {
    chainId,
    token: '0x456569838f1d43009A91ebA4263147Afd7233483',
    payer: privateKeyToAccount(ANVIL_PAYER).address,
    vendor: { id: 'acme', name: 'Acme', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
    maxPerInvoice: '10',
    maxPerDay: '50',
    expiresAt: null,
    approvedBy: 'test',
    approvedAt: new Date().toISOString(),
  });
  const keys = ['INVOICE_MANDATE', 'INVOICE_LEDGER', 'INVOICE_RPC_URL', 'INVOICE_PAYER_KEY', 'INVOICE_FAIL_AT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { INVOICE_MANDATE: path, INVOICE_LEDGER: join(dir, 'l.sqlite'), INVOICE_RPC_URL: 'http://127.0.0.1:1' }, env);
  try {
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('Anvil development keys are recognized; a fresh key is not', () => {
  assert.equal(isPublicAnvilKey(ANVIL_PAYER), true);
  assert.equal(isPublicAnvilKey(generatePrivateKey()), false);
});

test('a public Anvil key is refused off chain 31337 (e.g. Aevum 44005), accepted on 31337', () => {
  withMandate(44005, { INVOICE_PAYER_KEY: ANVIL_PAYER }, () => assert.throws(() => loadConfig(), /public development keys/));
  withMandate(31337, { INVOICE_PAYER_KEY: ANVIL_PAYER }, () => assert.equal(loadConfig().payerKey, ANVIL_PAYER));
});

test('simulated crashes (INVOICE_FAIL_AT) are refused off chain 31337', () => {
  withMandate(44005, { INVOICE_FAIL_AT: 'after-broadcast' }, () => assert.throws(() => loadConfig(), /simulated crashes/));
});
