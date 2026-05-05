# Issue #71 — A2A Revenue Integrity (Execution Plan)

**Issue:** [#71 — Critical: Inconsistent Revenue Calculation & Ghost Completions in A2A Jobs](https://github.com/felippeyann/agentfi/issues/71)
**Status:** Phase 1 in progress (this plan opened 2026-05-03)
**Owner:** felippeyann (root cause attributed to Gemini CLI analysis on the issue)

This doc preserves the full investigation and 3-phase plan so any future agent
picks up where we left off. Update the status table at the bottom as phases ship.

---

## 1. Bug surface (what's broken today)

Three coupled bugs in the A2A job lifecycle that together produce
"ghost revenue" in the PnL dashboard — money the protocol reports as earned
that was never actually received on-chain.

### 1.1 Ghost completions — fire-and-forget payment

[`packages/backend/src/api/routes/jobs.ts`](../../packages/backend/src/api/routes/jobs.ts)
in the `PATCH /v1/jobs/:id` handler:

```ts
// Lines 188-207 (pre-fix)
executeA2APayment({...})
  .then((result) => { logger.info(...) })
  .catch((err) => { logger.error(..., 'manual resolution required') });
```

The job is updated to `COMPLETED` *before* this fire-and-forget call. If the
on-chain transfer fails, the job stays `COMPLETED` in the DB but no funds
arrived in the provider's wallet. The error log says "manual resolution
required" — meaning the design accepts that operators must reconcile by hand.

Side effects in the same path that compound the bug:

- `reputationService.recordJobOutcome(job.providerId, true)` — provider
  earns reputation for a failed payment.
- `markEscrowReleased(job.id)` — escrow accounting marks funds as paid out
  before any payment was attempted.

### 1.2 Silent zero from price oracle

[`packages/backend/src/services/transaction/price.service.ts`](../../packages/backend/src/services/transaction/price.service.ts)
returns `0` as a fallback on **any** error (timeout, unknown token, network
failure, rate limit). `PnLService` consumes that `0` as if it were a real
USD price → historical revenue silently disappears when the oracle is down
during dashboard rendering.

### 1.3 Real-time price (no historical snapshot)

PnL is computed at read time using *current* market prices, not the price
at job-completion time. A token dropping 90% retroactively erases the
agent's historical earnings. Financial history is volatile by design,
which is wrong.

---

## 2. The 3-phase plan

Phases are independent and can ship as separate PRs. Phase 1 unblocks
Phase 3 (PnL can lean on the new state model), but Phase 2 can be done
in parallel.

### Phase 1 — Robust status transitions (this PR: `fix/a2a-revenue-integrity`)

**Goal:** stop reporting revenue for failed payments. Job only reaches
`COMPLETED` after the on-chain transfer confirms.

**Approach chosen:** two-phase status with an intermediate `PAYMENT_PENDING`
state, **not** synchronous `await` on the payment.

Why not just `await executeA2APayment(...)` in the request handler?
On-chain confirmation can take 10–30+ seconds (and longer on congested L1).
Blocking the HTTP response that long causes proxy timeouts, breaks SDK
clients with default 10s timeouts, and ties up Fastify worker threads
during gas spikes. The async-with-state-machine pattern is the standard
Web3 fix and matches how the rest of the codebase already handles
transactions.

**State machine:**

```
PENDING ──provider ACK───────► ACCEPTED
ACCEPTED ──PATCH COMPLETED (no reward)─────► COMPLETED
ACCEPTED ──PATCH COMPLETED (with reward)───► PAYMENT_PENDING
PAYMENT_PENDING ──executeA2APayment ok─────► COMPLETED  (system)
PAYMENT_PENDING ──executeA2APayment fail───► PAYMENT_FAILED  (system)
ACCEPTED ──PATCH FAILED────────────────────► FAILED
{PENDING, ACCEPTED} ──PATCH CANCELLED──────► CANCELLED
```

API contract: `VALID_TRANSITIONS` keeps exposing only `COMPLETED` /
`FAILED` / `CANCELLED` to providers — the new states (`PAYMENT_PENDING`,
`PAYMENT_FAILED`) are system-only and never accepted as input on the
PATCH endpoint.

**Side-effect placement (the real fix):**

| Action                         | Old position                         | New position                                  |
| ------------------------------ | ------------------------------------ | --------------------------------------------- |
| `reputationService.record(...)` | Before payment fired                 | Inside `.then()` after payment confirms       |
| `markEscrowReleased(jobId)`     | Before payment fired                 | Inside `.then()` after payment confirms       |
| `releaseJobEscrow(jobId)` (refund) | Only on `FAILED`/`CANCELLED`      | Also inside `.catch()` of payment failure     |
| Status `COMPLETED`              | Set immediately on PATCH             | Set inside `.then()` after payment confirms   |
| Status `PAYMENT_PENDING`        | n/a                                  | Set immediately on PATCH for paid jobs        |
| Status `PAYMENT_FAILED`         | n/a                                  | Set inside `.catch()` of payment failure      |

**Files touched:**

- `packages/backend/src/db/schema.prisma` — add `PAYMENT_PENDING` and
  `PAYMENT_FAILED` to the `JobStatus` enum.
- `packages/backend/src/db/migrations/0008_job_payment_status/migration.sql`
  — hand-written `ALTER TYPE ... ADD VALUE` (Postgres requires these
  outside a transaction in older server versions; we ship them as
  separate statements).
- `packages/backend/src/api/routes/jobs.ts` — split the `COMPLETED`
  branch into rewarded vs. non-rewarded paths; move side effects into
  the payment promise's `.then` / `.catch`.
- Regenerate the Prisma client after schema edit (per `HANDOFF.md` §7):
  `npx prisma generate --schema=packages/backend/src/db/schema.prisma`.

**What this PR explicitly does *not* fix:**

- **Server crash recovery** — if the backend dies between
  `PAYMENT_PENDING` and the `.then()` resolving, the job stays
  `PAYMENT_PENDING` forever. Needs a BullMQ recovery worker that scans
  for stale `PAYMENT_PENDING` rows and re-checks tx status. Listed as
  follow-up below.
- **Dashboard surfacing** — the admin dashboard doesn't yet have a
  `PAYMENT_PENDING` / `PAYMENT_FAILED` filter or column. Operators can
  query directly until that ships.
- **Payment service idempotency** — Phase 2 will need
  `executeA2APayment` to be safely retryable.

### Phase 1.5 — Worker-driven Job finalization (issue #81, branch `fix/issue-81-payment-lifecycle`)

**What we discovered:** end-to-end validation on Fly.io after Phase 1
shipped revealed that the Phase 1 fix is **incomplete**. With a stub
Alchemy URL guaranteeing on-chain failure (`HttpRequestError` from
`estimateGas`), the test job still finalized as `COMPLETED` with
`reservationStatus = RELEASED`, and Telegram fired
`TRANSACTION_CONFIRMED` instead of `TRANSACTION_FAILED`.

**Root cause:** `executeA2APayment` (in `api/routes/transactions.ts`)
resolves its promise after **queueing** the tx into BullMQ, not after
on-chain confirmation. The `.then(...)` in `jobs.ts` ran immediately
after enqueue, finalizing the Job before the worker had even
broadcast. Phase 1 only protected against synchronous failures
(auth/policy/sim), not against async on-chain failures from the
worker.

**Fix:** make the Transaction worker the single source of truth for
A2A Job finalization.

- New module `services/job/payment-finalizer.service.ts` —
  `finalizeA2APaymentJob({ jobId, transactionId, outcome, reason })`,
  idempotent (no-op when Job is not in `PAYMENT_PENDING`).
- `queues/transaction.queue.ts`:
  - After `monitor.waitForConfirmation` resolves, inspect
    `tx.metadata.a2aPayment` + `metadata.jobId`. CONFIRMED → finalize
    as `COMPLETED`; REVERTED / timeout-FAILED → finalize as
    `PAYMENT_FAILED`.
  - In `worker.on('failed')` (broadcast retries exhausted), do the
    same finalization with outcome `FAILED` so the Job doesn't sit in
    `PAYMENT_PENDING` forever.
- `api/routes/jobs.ts`:
  - Drop the `.then(...)` chain — Job state must NOT be touched at
    queue-resolution time.
  - Keep a `.catch(...)` that calls the finalizer with `outcome:
    'FAILED'` and `transactionId: null` for synchronous pre-queue
    failures (the worker will never run for these).

**Why this slipped past CI/Phase 1 review:** Phase 1 was reviewed
under the assumption that `executeA2APayment` resolves on
confirmation. We didn't run a real E2E with a guaranteed-failing tx
until the Fly deploy. Same lesson as HANDOFF §6.2 — CI green ≠
functionally validated.

**Knock-on effect on follow-ups:**

- #73 (recovery worker) becomes simpler — the worker is now the
  canonical source for state, so the recovery worker just re-fires
  the finalizer for stale `PAYMENT_PENDING` rows.
- #74 (idempotency via `txIntentId`) is unchanged in scope but
  benefits: the finalizer is already idempotent on the Job side, so
  combining it with intent-keyed broadcast closes the
  retry-double-spend gap fully.

### Phase 2 — Revenue snapshots (separate PR)

**Goal:** PnL history stops being volatile. The reward USD value is
captured at the moment of completion, not recomputed at read time.

**Schema additions** to the `Job` model:

```prisma
rewardUsd                String?    // Decimal as string, USD value at completion
rewardPriceAtCompletion  String?    // Token price in USD at completion time
rewardPriceSource        String?    // "alchemy" | "coingecko" | etc — for audit
rewardPriceCapturedAt    DateTime?  // When the price was locked in
```

**Trigger:** when Phase 1's `.then()` runs (payment confirmed), call
`PriceService` once, persist the snapshot atomically with the
`COMPLETED` status update. If price resolution fails, persist `NULL`
+ keep status `PAYMENT_PENDING` until a retry succeeds, OR mark
`COMPLETED` with a flag → operator decides via setting
`PNL_REQUIRE_PRICE_FOR_COMPLETION` (recommend default false to
avoid blocking on oracle outages).

**Migration:** `0009_job_revenue_snapshot/migration.sql`.

### Phase 3 — PnLService refactor (separate PR)

**Goal:** stop silent zeros. Always prefer the snapshot. Surface oracle
failures explicitly.

**Changes:**

- `PnLService.computeRevenue(...)` — for each `COMPLETED` job, prefer
  `job.rewardUsd` if non-null. Fall back to live price *only* for
  jobs predating Phase 2 schema (no snapshot available); flag those
  rows so the dashboard can show "estimated, pre-2026-XX-XX".
- `PriceService.getUsdPrice(...)` — instead of returning `0` on error,
  throw `OracleUnavailableError`. Callers decide how to recover. PnL
  callers catch + record a `priceUnavailable` flag in the breakdown.
- Dashboard: add an explicit "X jobs have unresolved USD value"
  warning banner so silent zeros become visible.

---

## 3. Acceptance criteria per phase

### Phase 1
- [ ] Job with reward + payment success → final status `COMPLETED`
- [ ] Job with reward + payment failure → final status `PAYMENT_FAILED`
      and reservation refunded via `releaseJobEscrow`
- [ ] Job without reward → still completes synchronously (no behavior
      change for free jobs)
- [ ] Provider reputation only increments on actual `COMPLETED`
- [ ] PnL queries (`status: 'COMPLETED'` filter) automatically exclude
      ghost rows — no PnL code changes needed in this phase
- [ ] `npm run typecheck --workspaces --if-present` passes
- [ ] Backend tests pass (existing) + new unit test for the
      ACCEPTED→PAYMENT_PENDING→COMPLETED path

### Phase 2
- [ ] Migration `0009` ships, applied cleanly to a fresh dev DB
- [ ] New paid job: `rewardUsd` populated within X seconds of `COMPLETED`
- [ ] Operator can disable price-blocking via env var

### Phase 3
- [ ] Dashboard shows count of jobs with `rewardUsd = NULL`
- [ ] Snapshot used when available; live price only as fallback for
      pre-Phase-2 rows
- [ ] No code path returns `0` silently — every zero must be either a
      real recorded value or accompanied by `priceUnavailable: true`

---

## 4. Follow-up tickets to file

These came out of the investigation but are scope creep for the
3-phase plan. File as separate issues *after* Phase 1 ships.

1. **Stale `PAYMENT_PENDING` recovery worker** — BullMQ job that scans
   every N minutes for jobs stuck in `PAYMENT_PENDING` longer than
   the chain's typical confirmation window, re-checks tx receipt,
   transitions to `COMPLETED` or `PAYMENT_FAILED` accordingly. Critical
   for production safety.
2. **`executeA2APayment` idempotency** — current implementation
   re-broadcasts on retry, which can double-spend. Needs a
   `txIntentId` keyed at the call site so retries collapse.
3. **Admin dashboard: payment status filter + reconcile UI** — surface
   `PAYMENT_PENDING` / `PAYMENT_FAILED` as first-class queues with a
   "force complete" / "force fail" override for operators.

---

## 5. Status

| Phase | Status      | PR  | Notes |
| ----- | ----------- | --- | ----- |
| 1     | shipped     | #72 | branch `fix/a2a-revenue-integrity` (merged) |
| 1.5   | shipped     | #83 | branch `fix/issue-81-payment-lifecycle` (merged) — closed #81 |
| #74   | shipped     | #84 | branch `fix/issue-74-tx-idempotency` (merged) — `Transaction.intentId` |
| #85   | shipped     | #85 | branch `fix/notification-visibility-and-finalizer-order` (merged) — surfaces silent notify failures + fixes finalizer write race |
| #73   | in progress | TBD | branch `fix/issue-73-payment-recovery-worker` — BullMQ scan reconciles stale `PAYMENT_PENDING` |
| 2     | not started | —   | depends on Phase 1 schema being merged |
| 3     | not started | —   | depends on Phase 2 snapshot fields |
