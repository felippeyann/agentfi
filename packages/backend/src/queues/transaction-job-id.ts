/**
 * The BullMQ job id of a Transaction row's job (A6b): one job per row.
 *
 * Every site that adds an ordinary transaction to the queue (the transaction
 * routes through `enqueueOrFail`, the operator approval, the legacy A2A
 * payment, the admin batch) passes it as `jobId`. BullMQ does not add a job
 * whose id already exists, so the stranded-QUEUED sweep
 * (`services/transaction/stranded-queued.ts`) can look the row's job up and
 * re-add a missing one without ever creating a duplicate delivery.
 *
 * BullMQ refuses custom ids containing ':' (and integer ids), hence the dash.
 * A leaf module, so the routes import it without the processor's graph.
 */
export function transactionJobId(transactionId: string): string {
  return `tx-${transactionId}`;
}
