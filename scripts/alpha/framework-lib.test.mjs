import assert from 'node:assert/strict';
import test from 'node:test';
import { PAYER_SAFE_TOOLS, checkAllowed, checkBlocked, pairTrace, parseEnvFile, terminationPlan } from './framework-lib.mjs';

const SELLER = '0x00000000000000000000000000000000000000AA';
const AGENT = '0x00000000000000000000000000000000000000BB';
const JOB = 'job_big';
const SMALL = 'job_small';
const TX = '0x' + 'ab'.repeat(32);

const snapshot = (over = {}) => ({
  agentWallet: AGENT, seller: SELLER, agentUsdc: '5000000', sellerUsdc: '0',
  sellerCounts: { plain: {}, paid: {} }, transfers: [], ledger: [], ...over,
});
const allowedResult = (pid = 'fw-allowed-0000000000000001') => ({
  exposedTools: [...PAYER_SAFE_TOOLS],
  trace: [
    { call: 'pay_for_resource', arguments: JSON.stringify({ job_id: JOB, url: 'http://127.0.0.1:1/report', payment_id: pid }) },
    { result: { payment: { status: 'settled' } } },
  ],
});
const goodAllowed = () => {
  const pid = 'fw-allowed-0000000000000001';
  return {
    result: allowedResult(pid),
    before: snapshot(),
    after: snapshot({
      agentUsdc: '4700000', sellerUsdc: '300000', sellerCounts: { plain: { '/report': 1 }, paid: { '/report': 1 } },
      transfers: [{ tx: TX, from: AGENT, to: SELLER, value: '300000' }],
      ledger: [{ jobId: JOB, paymentId: pid, status: 'settled', amount: '300000', payTo: SELLER, authorizationNonce: '0x1', settlementTxHash: TX, chainVerifiedAt: 'now', responseStatus: 200 }],
    }),
    statusText: `Job ${JOB}  [ACCEPTED] budget 5 · committed 0.3 (proven 0.3, reported 0, open 0) · remaining 4.7\n  - ${pid} settled 0.3 USDC money:proven delivery:delivered (HTTP 200)`,
    jobId: JOB,
  };
};

test('parseEnvFile reads KEY=VALUE, skips comments, keeps = inside values', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\r\n\nB=x=y\n'), { A: '1', B: 'x=y' });
  assert.throws(() => parseEnvFile('nonsense'));
});

test('pairTrace pairs each call with its result', () => {
  const calls = pairTrace(allowedResult());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].result.payment.status, 'settled');
});

test('checkAllowed passes on a consistent run', () => {
  const { checks, txHash } = checkAllowed(goodAllowed());
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(txHash, TX);
});

test('checkAllowed fails when an admin tool leaks into the allowlist', () => {
  const input = goodAllowed();
  input.result.exposedTools = [...PAYER_SAFE_TOOLS, 'update_policy'];
  assert.ok(checkAllowed(input).checks.some((c) => !c.ok && /payer-safe four/.test(c.what)));
});

test('checkAllowed fails on a wrong amount, a missing transfer, missing proof, or a different tx', () => {
  const mutations = [
    (i) => { i.after.agentUsdc = '4600000'; },
    (i) => { i.after.transfers = []; },
    (i) => { i.after.ledger[0].chainVerifiedAt = null; },
    (i) => { i.after.ledger[0].settlementTxHash = '0x' + 'cd'.repeat(32); },
    (i) => { i.after.sellerCounts.paid['/report'] = 2; },
    (i) => { i.statusText = 'nothing'; },
  ];
  for (const mutate of mutations) {
    const input = goodAllowed();
    mutate(input);
    assert.ok(checkAllowed(input).checks.some((c) => !c.ok), String(mutate));
  }
});

const goodBlocked = () => {
  const a = 'fw-overbudget-0000000000000001';
  const b = 'fw-overpolicy-0000000000000001';
  const row = (jobId, paymentId) => ({ jobId, paymentId, status: 'failed_before_signing', amount: '300000', payTo: SELLER, authorizationNonce: null, settlementTxHash: null, chainVerifiedAt: null, responseStatus: null });
  const base = snapshot({ agentUsdc: '4700000', sellerUsdc: '300000', sellerCounts: { plain: { '/report': 1 }, paid: { '/report': 1 } }, transfers: [{ tx: TX, from: AGENT, to: SELLER, value: '300000' }] });
  return {
    result: {
      exposedTools: [...PAYER_SAFE_TOOLS],
      trace: [
        { call: 'pay_for_resource', arguments: JSON.stringify({ job_id: SMALL, url: 'x/report', payment_id: a }) },
        { result: { paid: false, httpStatus: 402, code: 'BUDGET_EXCEEDED' } },
        { call: 'pay_for_resource', arguments: JSON.stringify({ job_id: JOB, url: 'x/report-premium', payment_id: b }) },
        { result: { paid: false, httpStatus: 403, code: 'POLICY_VIOLATION', rule: 'maxValuePerTxUsd' } },
      ],
    },
    before: base,
    after: { ...base, transfers: [...base.transfers], sellerCounts: { plain: { '/report': 2, '/report-premium': 1 }, paid: { '/report': 1 } }, ledger: [row(SMALL, a), row(JOB, b)] },
    statusText: `- ${a} failed_before_signing 0.3 USDC money:not-moved [not counted]\n- ${b} failed_before_signing 0.6 USDC money:not-moved [not counted]`,
    smallJobId: SMALL, jobId: JOB,
  };
};

test('checkBlocked passes when nothing was signed, moved or paid', () => {
  assert.deepEqual(checkBlocked(goodBlocked()).checks.filter((c) => !c.ok), []);
});

test('checkBlocked fails if a nonce exists, money moved, a paid request arrived, or the status line is missing', () => {
  const mutations = [
    (i) => { i.after.ledger[0].authorizationNonce = '0x1'; },
    (i) => { i.after.agentUsdc = '4400000'; },
    (i) => { i.after.sellerCounts.paid['/report-premium'] = 1; },
    (i) => { i.after.transfers.push({ tx: '0x' + '11'.repeat(32), from: AGENT, to: SELLER, value: '1' }); },
    (i) => { i.statusText = ''; },
    (i) => { i.result.trace[1].result.code = 'PAYMENT_REFUSED'; },
  ];
  for (const mutate of mutations) {
    const input = goodBlocked();
    mutate(input);
    assert.ok(checkBlocked(input).checks.some((c) => !c.ok), String(mutate));
  }
});

test('terminationPlan: taskkill tree on win32, process-group SIGTERM then SIGKILL on POSIX', () => {
  const win = terminationPlan('win32', 123);
  assert.equal(win.detached, false);
  assert.deepEqual(win.steps, [{ kind: 'command', command: 'taskkill', args: ['/pid', '123', '/T', '/F'] }]);
  for (const platform of ['linux', 'darwin']) {
    const posix = terminationPlan(platform, 123, 500);
    assert.equal(posix.detached, true);
    assert.deepEqual(posix.steps.map((s) => [s.signal, s.target, s.waitMs]), [['SIGTERM', -123, 500], ['SIGKILL', -123, 0]]);
  }
  assert.throws(() => terminationPlan('linux', 0));
  assert.throws(() => terminationPlan('linux', -5));
});
