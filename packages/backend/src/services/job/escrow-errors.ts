/**
 * Errors shared by the ERC-8183 orchestrator (`escrow-erc8183.service.ts`)
 * and the A1 evaluator candidate ledger (`services/escrow/evaluator-ledger.ts`).
 *
 * They live in this small module (no imports) so the ledger can throw the
 * SAME classes the service catches without importing the service — the
 * service imports the ledger, and the cycle is gone. The service re-exports
 * both classes, so `instanceof` against either import path holds.
 */

/**
 * G1 review P3-2: thrown from the broadcast hook — nothing is sent — when the
 * conditional write of the signed hash finds the job changed since it was
 * read: another attempt recorded its own transaction, or (for a claimed
 * settlement) the row is no longer SETTLING. A1: the candidate insert of the
 * same database transaction is rolled back with it. Retried like any failure;
 * the retry reads the job again.
 */
export class SettlementSupersededError extends Error {
  constructor(readonly jobId: string) {
    super(`ERC-8183 settlement of job ${jobId} not sent: the job changed since it was read (another attempt, or the claim was handed back)`);
    this.name = 'SettlementSupersededError';
  }
}

/**
 * C3e item 1 / A1 §6.1: thrown INSTEAD of a new evaluator broadcast while a
 * transaction of the job may still mine (a live candidate of the ledger whose
 * nonce is not proven consumed, or — for a legacy row without a candidate —
 * the recorded `settleTxHash` still pending). The settlement is retried later
 * (BullMQ / recovery); only a chain proof clears it, never time.
 */
export class SettlementStillPendingError extends Error {
  constructor(
    readonly txHash: string,
    detail: string,
  ) {
    super(`ERC-8183 settlement ${txHash} may still mine (${detail}) — not signing another one`);
    this.name = 'SettlementStillPendingError';
  }
}
