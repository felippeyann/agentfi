// The demo's keys are Anvil's public development keys: the agent must refuse them off a local chain.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { isPublicAnvilKey, loadConfig } from '../src/config.js';
import { ruleFor } from '../src/finality.js';
import { Ledger } from '../src/ledger.js';
import { loadMandate, saveMandate } from '../src/mandate.js';

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
  const keys = ['INVOICE_MANDATE', 'INVOICE_LEDGER', 'INVOICE_RPC_URL', 'INVOICE_PAYER_KEY', 'INVOICE_FAIL_AT', 'INVOICE_CONFIRMATION', 'INVOICE_EXPLORER_URL', 'INVOICE_LOGS_FROM_BLOCK', 'INVOICE_MAX_GAS_COST'];
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

test('a mandate with limits that are not plain decimals, or an invalid expiry, is refused on save and on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'invoice-agent-mandate-'));
  const good = {
    chainId: 31337, token: '0x456569838f1d43009A91ebA4263147Afd7233483', payer: privateKeyToAccount(ANVIL_PAYER).address,
    vendor: { id: 'acme', name: 'Acme', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
    maxPerInvoice: '10', maxPerDay: '50', expiresAt: null, approvedBy: 'test', approvedAt: new Date().toISOString(),
  };
  for (const patch of [{ maxPerInvoice: '1e1' }, { maxPerDay: '5e1' }, { maxPerInvoice: '0' }, { maxPerDay: '' }, { expiresAt: 'tomorrow' }]) {
    assert.throws(() => saveMandate(join(dir, 'm.json'), { ...good, ...patch }), /invalid mandate/, JSON.stringify(patch));
    writeFileSync(join(dir, 'hand.json'), JSON.stringify({ ...good, ...patch }));
    assert.throws(() => loadMandate(join(dir, 'hand.json')), /invalid mandate/, JSON.stringify(patch));
  }
  saveMandate(join(dir, 'ok.json'), { ...good, maxPerInvoice: '2.5', expiresAt: '2027-01-01T00:00:00Z' });
  assert.equal(loadMandate(join(dir, 'ok.json')).maxPerInvoice, '2.5');
});

test('a ledger is bound to its chain, token and payer; limits may change', () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'invoice-agent-ctx-')), 'ledger.sqlite'));
  const ctx = { chainId: 31337, token: '0x456569838f1d43009A91ebA4263147Afd7233483', payer: privateKeyToAccount(ANVIL_PAYER).address };
  ledger.bindContext(ctx);
  ledger.bindContext({ ...ctx, token: ctx.token.toLowerCase() });
  assert.throws(() => ledger.bindContext({ ...ctx, chainId: 44005 }), /written for chainId 31337/);
  assert.throws(() => ledger.bindContext({ ...ctx, token: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }), /new ledger file/);
  assert.throws(() => ledger.bindContext({ ...ctx, payer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }), /payer/);
  ledger.close();
});

test('simulated crashes (INVOICE_FAIL_AT) are refused off chain 31337', () => {
  withMandate(44005, { INVOICE_FAIL_AT: 'after-broadcast' }, () => assert.throws(() => loadConfig(), /simulated crashes/));
});

test('confirmation: inclusion is refused off chain 31337; Aevum defaults to "finalized" with the official explorer', () => {
  withMandate(44005, { INVOICE_CONFIRMATION: 'inclusion' }, () => assert.throws(() => loadConfig(), /one block is not a confirmation/));
  withMandate(44005, {}, () => {
    const c = loadConfig();
    assert.equal(ruleFor(c.chain).kind, 'finalized');
    assert.equal(c.chain.explorerUrl, 'https://explorer-test.qday.info');
  });
  withMandate(44005, { INVOICE_CONFIRMATION: 'depth:30' }, () => assert.deepEqual(loadConfig().chain.confirm, { kind: 'depth', blocks: 30 }));
  withMandate(31337, {}, () => assert.equal(ruleFor(loadConfig().chain).kind, 'inclusion'));
});

test('the agent on a public chain needs an explicit gas ceiling; it parses to exact wei', () => {
  const fresh = generatePrivateKey();
  withMandate(44005, { INVOICE_PAYER_KEY: fresh }, () => assert.throws(() => loadConfig(), /INVOICE_MAX_GAS_COST is required/));
  withMandate(44005, { INVOICE_PAYER_KEY: fresh, INVOICE_MAX_GAS_COST: '0.0001' }, () => assert.equal(loadConfig().chain.maxGasCostWei, 100_000_000_000_000n));
  withMandate(44005, { INVOICE_PAYER_KEY: fresh, INVOICE_MAX_GAS_COST: '1e-4' }, () => assert.throws(() => loadConfig(), /plain decimal/));
  withMandate(44005, {}, () => assert.equal(loadConfig().chain.maxGasCostWei, undefined, 'ops (no key) does not need it'));
  withMandate(31337, { INVOICE_PAYER_KEY: ANVIL_PAYER }, () => assert.equal(loadConfig().chain.maxGasCostWei, undefined, 'the local demo keeps no ceiling'));
});
