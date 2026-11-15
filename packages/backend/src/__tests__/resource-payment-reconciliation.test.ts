/**
 * Unit tests — `examineRow` verdicts (first x402 delivery, 2026-11-15).
 * Each verdict must rest on chain evidence; anything short of proof is
 * reported, never concluded. The DB pass and the payment flow are covered by
 * `resource-payment.reconcile.db.test.ts`; FiatToken on a fork by the demo.
 */
import { describe, expect, it } from 'vitest';
import type { ResourcePayment } from '@prisma/client';
import { chainIdOfNetwork, examineRow } from '../services/payments/resource-payment-reconciliation.js';
import { fakeChain } from './helpers/fake-chain-evidence.js';

const PAYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NONCE = `0x${'ab'.repeat(32)}`;
const NOW = new Date('2026-11-15T12:00:00Z');
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

function row(overrides: Partial<ResourcePayment> = {}): ResourcePayment {
  return {
    id: 'rp1',
    jobId: 'job1',
    agentId: 'agent1',
    url: 'https://seller.example/paid',
    method: 'GET',
    network: 'eip155:84532',
    asset: USDC,
    amount: '400000',
    payTo: SELLER,
    paymentId: 'pay_0123456789abcdef',
    authorizationNonce: NONCE,
    authorizationValidBefore: new Date(NOW.getTime() + 300_000),
    reservedAt: new Date(NOW.getTime() - 3_600_000),
    status: 'unknown',
    receipt: null,
    receiptVerified: null,
    settlementTxHash: null,
    responseStatus: null,
    attemptId: null,
    payer: PAYER,
    authorizationMethod: 'eip3009',
    chainVerifiedAt: null,
    reconciledAt: null,
    reconcileNote: null,
    resourceSha256: null,
    resourceBytes: null,
    error: null,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    updatedAt: new Date(NOW.getTime() - 3_600_000),
    ...overrides,
  };
}

describe('examineRow — x402 reconciliation verdicts', () => {
  it('unknown + used on-chain with a matching Transfer → confirmed (with the chain tx)', async () => {
    const chain = fakeChain();
    const r = row();
    const tx = chain.use(r);
    const v = await examineRow(r, chain, { now: NOW });
    expect(v).toMatchObject({ kind: 'confirmed', txHash: tx });
    expect(chain.reads).toEqual(expect.arrayContaining([`authorizationState:${NONCE}`, `logs:used:${NONCE}`, `receipt:${tx}`]));
  });

  it('used on-chain but the tx moves a different amount or to another payee → mismatch, never confirmed', async () => {
    const chain = fakeChain();
    const r = row();
    chain.use(r, [{ from: PAYER, to: '0x3333333333333333333333333333333333333333', value: 400000n }]);
    expect((await examineRow(r, chain, { now: NOW })).kind).toBe('mismatch');
    const r2 = row({ id: 'rp2', authorizationNonce: `0x${'cd'.repeat(32)}` });
    chain.use(r2, [{ from: PAYER, to: SELLER, value: 1n }]);
    expect((await examineRow(r2, chain, { now: NOW })).kind).toBe('mismatch');
  });

  it('unused while the authorization is still valid → wait (the amount stays held), whatever the server said', async () => {
    const chain = fakeChain();
    chain.at(sec(NOW));
    for (const status of ['unknown', 'refused', 'settled', 'pending'] as const) {
      const v = await examineRow(row({ status }), chain, { now: NOW });
      expect(v.kind).toBe('wait');
    }
  });

  it('unused at a judged head ≥ validBefore + margin → expired (lapsed-unused); inside the margin → wait', async () => {
    const chain = fakeChain();
    const r = row();
    chain.at(sec(r.authorizationValidBefore!) + 59);
    expect((await examineRow(r, chain, { now: NOW })).kind).toBe('wait');
    chain.at(sec(r.authorizationValidBefore!) + 60);
    expect(await examineRow(r, chain, { now: NOW })).toMatchObject({ kind: 'expired', reason: 'lapsed-unused' });
    chain.at(sec(r.authorizationValidBefore!));
    expect(await examineRow(r, chain, { now: NOW, expiryMarginSeconds: 0 })).toMatchObject({ kind: 'expired' });
  });

  it('our clock past validBefore is NOT evidence: a chain head still before it → wait', async () => {
    const chain = fakeChain();
    const r = row({ authorizationValidBefore: new Date(NOW.getTime() - 60_000) });
    chain.at(sec(r.authorizationValidBefore!) - 1);
    expect((await examineRow(r, chain, { now: NOW })).kind).toBe('wait');
  });

  it('cancelled on-chain → expired (cancelled)', async () => {
    const chain = fakeChain();
    const r = row();
    chain.cancel(r);
    expect(await examineRow(r, chain, { now: NOW })).toMatchObject({ kind: 'expired', reason: 'cancelled' });
  });

  it('a server-reported settlement that the chain proves → confirmed; a different reported hash is noted', async () => {
    const chain = fakeChain();
    const r = row({ status: 'settled', settlementTxHash: `0x${'ff'.repeat(32)}` });
    const tx = chain.use(r);
    const v = await examineRow(r, chain, { now: NOW });
    expect(v).toMatchObject({ kind: 'confirmed', txHash: tx });
    expect(v.note).toContain('server had reported');
  });

  it('already proven, failed_before_signing and expired rows → nothing, without reading the chain', async () => {
    const chain = fakeChain();
    for (const r of [row({ status: 'settled', chainVerifiedAt: NOW }), row({ status: 'failed_before_signing' }), row({ status: 'expired' })]) {
      expect((await examineRow(r, chain, { now: NOW })).kind).toBe('nothing');
    }
    expect(chain.reads).toEqual([]);
  });

  it('reserved: in-flight while fresh, released once stale (never reads the chain)', async () => {
    const chain = fakeChain();
    const fresh = row({ status: 'reserved', authorizationNonce: null, payer: null, reservedAt: new Date(NOW.getTime() - 60_000) });
    expect((await examineRow(fresh, chain, { now: NOW })).kind).toBe('in-flight');
    const stale = row({ status: 'reserved', authorizationNonce: null, payer: null, reservedAt: new Date(NOW.getTime() - 16 * 60_000) });
    expect((await examineRow(stale, chain, { now: NOW })).kind).toBe('release-unsigned');
    expect((await examineRow({ ...stale, authorizationNonce: NONCE }, chain, { now: NOW })).kind).toBe('manual');
    expect(chain.reads).toEqual([]);
  });

  it('pending: in-flight while fresh; once stale it is judged on the chain like unknown', async () => {
    const chain = fakeChain();
    const fresh = row({ status: 'pending', updatedAt: new Date(NOW.getTime() - 60_000) });
    expect((await examineRow(fresh, chain, { now: NOW })).kind).toBe('in-flight');
    const stale = row({ status: 'pending' });
    chain.use(stale);
    expect((await examineRow(stale, chain, { now: NOW })).kind).toBe('confirmed');
  });

  it('no payer / Permit2 / no validBefore → manual (no guessing)', async () => {
    const chain = fakeChain();
    expect((await examineRow(row({ payer: null }), chain, { now: NOW })).kind).toBe('manual');
    expect((await examineRow(row({ authorizationMethod: 'permit2', authorizationNonce: '123' }), chain, { now: NOW })).kind).toBe('manual');
    expect((await examineRow(row({ authorizationValidBefore: null }), chain, { now: NOW })).kind).toBe('manual');
    expect(chain.reads).toEqual([]);
  });

  it('no authorizationMethod → manual even with a 32-byte nonce (never inferred: a Permit2 row would wrongly lapse)', async () => {
    const chain = fakeChain();
    const r = row({ authorizationMethod: null });
    expect((await examineRow(r, chain, { now: NOW })).kind).toBe('manual');
    expect(chain.reads).toEqual([]);
  });

  it('chainIdOfNetwork parses CAIP-2 eip155 only', () => {
    expect(chainIdOfNetwork('eip155:84532')).toBe(84532);
    expect(chainIdOfNetwork('solana:abc')).toBeNull();
  });
});
