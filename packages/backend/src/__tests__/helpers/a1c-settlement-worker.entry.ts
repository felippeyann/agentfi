/**
 * A1 row 9 — process W: the REAL escrow settlement worker in its own OS process.
 *
 * Exactly the escrow part of `startWorkerProcess` (`src/worker-process.ts`): the boot deployment
 * check (`runEscrowBootCheck('worker')`, which opens this process's Q7 gate), then
 * `startEscrowSettlementWorker(erc8183Deps)` — the BullMQ worker (concurrency 1) whose body is
 * `processSettlementJob` with the production deps (Prisma ledger, Redis lane lock, the evaluator
 * signer, per-node reads at the proof tag). Not started here, on purpose: the transaction worker,
 * payment recovery and the repeatable expiry sweep — they would enqueue settlements on their own
 * schedule and make the scenarios timing-dependent. The settlement jobs are enqueued by the test
 * (`addSettlementJob`, the API's own path).
 *
 * Prints `A1C-WORKER-READY` once the worker is connected; exits on SIGTERM / stdin close.
 */
import { runEscrowBootCheck } from '../../config/escrow-boot.runtime.js';
import { startEscrowSettlementWorker } from '../../queues/escrow-settlement.queue.js';
import { erc8183Deps } from '../../services/job/escrow-erc8183.runtime.js';
import { closeWalletLanes } from '../../services/transaction/wallet-lane.runtime.js';
import { escrowConfigGate } from '../../config/escrow-verification.runtime.js';

const chainId = Number(process.env['A1C_CHAIN_ID'] ?? '84532');
await runEscrowBootCheck('worker');
const gate = escrowConfigGate(chainId);
console.log(`A1C-WORKER-GATE ${JSON.stringify(gate)}`);
const worker = startEscrowSettlementWorker(erc8183Deps);
worker.on('completed', (job, result) => console.log(`A1C-WORKER-COMPLETED ${job.data.action} ${job.data.jobId} ${JSON.stringify(result)}`));
worker.on('failed', (job, err) => console.log(`A1C-WORKER-FAILED ${job?.data.action} ${job?.data.jobId} attempt ${job?.attemptsMade} ${err?.name}: ${err?.message}`));
await worker.waitUntilReady();
console.log('A1C-WORKER-READY');

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await worker.close().catch(() => undefined);
  await closeWalletLanes();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdin.on('end', () => void stop());
process.stdin.resume();
