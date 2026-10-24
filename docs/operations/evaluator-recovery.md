# Evaluator recovery runbook (C3g-A1)

How the operator unblocks a **stuck ERC-8183 evaluator key**: one transaction of the key is not mined, and
every later evaluator transaction waits behind it. Those later transactions are settlements, cancellation
refunds and expiry claims of every job on the chain. The tool is `npm run evaluator:recover`
(`packages/backend/src/scripts/evaluator-recovery.ts`).

Status: implemented in the local A1 candidate; final review pending. Nothing here is automatic: the
backend never replaces or cancels an evaluator transaction on its own. Its only automatic action is the
**identical** rebroadcast of a lost send (the same signed bytes).

## 1. When to use it

Use it when one of these alerts fires:

| Alert | Meaning |
|---|---|
| `evaluator-stuck` | The key's head nonce has not moved for `EVALUATOR_STUCK_ALERT_AFTER_MS` (10 min), or a delivered job waiting on the key is within T of its `expiresAt` (T = `EVALUATOR_EARLY_ALERT_BEFORE_EXPIRY_SECONDS`, default `ESCROW_REVIEW_ALERT_BEFORE_EXPIRY_SECONDS` = 24 h). |
| `evaluator-send-lost` | A recorded transaction at the head is unknown to every RPC node, and the automatic identical rebroadcast was not possible or was refused. |
| `evaluator-nonce-foreign` | A nonce of the key was consumed by a transaction **not** in the ledger: a manual send, another environment using the same key, or a **compromised key**. Treat it as an incident first. |
| `evaluator-proof-uncertain` / `rpc-node-unhealthy` / `evaluator-proof-stalled` | The proofs cannot be closed: an RPC node disagrees, fails, or the `safe` head stopped. Fix or remove the node. A recovery does not fix this. |
| `evaluator-replaced` | A transaction the worker was waiting for was replaced in its nonce by one **not** recorded as a recovery operation: a manual send with the evaluator key or a second settlement worker. Treat it as an incident. (The script's own recorded replacement is reported as `evaluator-replaced-by-recovery`, informational — §3.3.) |

Do not use it to change a decision. An operator decision (D9: pay / refund / verdict) changes only
through `POST /admin/jobs/:id/resolve`, once the uncertainty has closed by proof.

## 2. Where and how

- Run it **where the evaluator key already is**:
  - C5 / pilot: the owner's machine;
  - hosted: a one-off command in the worker's service.
- It uses the backend's env, DB and Redis. The key is never copied, printed or logged.
- Always start with the dry-run (the default):

```bash
npm run evaluator:recover -- --chain 84532
```

The dry-run signs nothing new. **Every run first runs the reconciliation pass (spec §5.2), the same one the
worker runs on every tick.** In the worker that pass may send the **identical** bytes of a lost head again
(R2-P1-3: the head, the only live candidate at its nonce, unknown to every node, simulation passing). In the
script it runs before this process has verified the on-chain configuration (Q7), so its own rebroadcast is
refused there and a dry-run transmits nothing; use `--execute rebroadcast` for a lost head. The script then
verifies the configuration once (read-only) so the plan sees the real gate, and verifies it again after the
typed confirmation. It never signs a new transaction on a dry-run.

**The script's pass is a diagnostic, not a second alert source (P3-9, 24/10).** It writes the ledger as the
worker's pass does, but an alert about a condition that persists — `evaluator-send-lost`, `rpc-node-unhealthy`,
`evaluator-proof-stalled`, `evaluator-proof-uncertain`, a ledger conflict or a reorg deeper than the proof tag
with nothing written — is **printed** in the script's output (`! reconciliation (<kind>; shown here, not alerted —
the settlement worker alerts it): …`) and **not** delivered. The script never reads or writes those alerts'
"last alerted" marks, and it only **starts** the condition clocks the worker counts from: the first sight of a
lost head, the first proof-tag head, its own failed node reads. It never clears or moves them — a head its RPC
set still knows, a node answering on its side, a proof head that advanced there are not written (review P3-1).
Only the worker resets them. So running a dry-run neither consumes nor postpones the worker's alert, which still
fires on the worker's own threshold and interval. A lost head shows there with the reason this pass did not
rebroadcast it; `GATE_CLOSED` on that line is the script's own gate, read before its Q7 verification — the
plan's `config gate` line has the verified state, and the plan's `rebroadcast` line says whether `--execute
rebroadcast` is admitted.

A change the pass itself records is still **alerted** by the script, because the worker would not see it again:
a nonce consumed outside the ledger (`evaluator-nonce-foreign`), and an outcome proven only at `latest` that a
reorg took away — the pass puts its candidate back to live (`evaluator-reorg`). A reorg **deeper** than the proof
tag also uses the kind `evaluator-reorg`, but nothing is written for it: the script only **prints** it, and the
worker alerts it on its next pass.

**If the settlement worker is not running, nobody alerts these conditions.** The script's output is then the
only signal of a lost head, a failing node, a stalled proof head or a deep reorg: start the worker (or read
that output) before relying on the alerts.

The dry-run then shows:

- **Key and nonces:** the evaluator address and its balance; the `latest`, `pending` and proof-tag nonces.
- **The queue `[latest, pending)`**, for each nonce:
  - every candidate (hash, kind, origin, job, action, decision, `calldataHash`, gas, fees, status, age);
  - what each RPC node says about it ("known", "mined", "not found", error);
  - the job: DB and `getJob` status, decision, contest, `expiresAt`;
  - whether our calldata still simulates;
  - for speed-up, cancel and rebroadcast: admitted or refused (with the reason), the proposed fees or
    the refusal with the value that would be needed, the maximum cost and the reserve left;
  - the replacement count and interval;
  - the plan fingerprint. It covers the chain, the key, the nonce, the candidates of the nonce with
    their status, the job's on-chain status and the operation. It does **not** cover the fees (§3.3).
    It is **per nonce**: a candidate at another nonce (for example the worker's new transaction at N+1)
    does not change the fingerprint of N.
- **Head classification:**

  | Class | Action |
  |---|---|
  | `price-stuck` | speed-up |
  | `lost-send` | rebroadcast |
  | `known-not-mined` | speed-up, then check the sequencer / RPC |
  | `foreign` | incident; cancel only after acknowledgement |

- **The jobs waiting on the key** (delivered) and the other live jobs. The earliest delivered `expiresAt`
  is compared with the **latest block's timestamp**, which gives a posture:

  | Posture | Time left to that `expiresAt` |
  |---|---|
  | none | more than H |
  | ACT | within H (24 h) |
  | URGENT | within 6 h |
  | HAND-TO-OWNER | within 1 h |
  | EXPIRED | already passed |

- **The `claimRefund` warning and the cancel warning, verbatim** (§4).

## 3. Executing

```bash
npm run evaluator:recover -- --chain 84532 --execute speed-up    --nonce N   --operator <name> --note "<why>"
npm run evaluator:recover -- --chain 84532 --execute speed-up    --nonces N..M --operator <name> --note "<why>"
npm run evaluator:recover -- --chain 84532 --execute cancel      --nonce N   --operator <name> --note "<why>" [--acknowledge-foreign <hash>|nonce:<N>]
npm run evaluator:recover -- --chain 84532 --execute rebroadcast --nonce N   --operator <name> --note "<why>"
```

### 3.1 Refused before anything is signed

The run is refused, with the reason printed, in any of these cases:

- **Configuration and environment:**
  - no caps configured for the chain;
  - no TTY (stdin redirected);
  - the RPC answers another chain id;
  - the key is not the configured evaluator, or not the `Job.evaluator` of the live jobs;
  - the on-chain configuration cannot be verified (Q7).
- **Foreign transactions:** an `EXTERNAL` row that nobody acknowledged.
- **The nonce and the operation:**
  - the nonce is not the head (always the head first);
  - the operation is not admitted (§4);
  - a replacement limit, the fees, the budget or the reserve (§5).

### 3.2 The typed confirmation

Type the phrase exactly; no other answer is accepted:

| Operation | Phrase |
|---|---|
| speed-up | `SPEED-UP <chainId> NONCE <N> <ACTION> <jobId>` |
| speed-up range | `SPEED-UP <chainId> NONCES <N>-<M> <k> TXS` |
| cancel | `CANCEL <chainId> NONCE <N> DOES NOT SETTLE` |
| rebroadcast | `REBROADCAST <chainId> NONCE <N> <ACTION> <jobId>` |

After the job's `expiresAt`, the phrase ends with ` AFTER EXPIRY`.

### 3.3 After the confirmation

The plan printed before the phrase lists, per nonce, the **exact** `maxFeePerGas` and priority fee. Typing
the phrase consents to exactly those values. The script signs with them and never with a fee recomputed
later (final review F-P2-1).

1. It records any `--acknowledge-foreign` only now, after the phrase. A wrong phrase acknowledges
   nothing.
2. The script takes the per-chain recovery lock. A second operator stops here. Before each nonce it
   checks that the lock is still its own (the owner token); if not, it stops.
3. It verifies the on-chain configuration fully (Q7) again — the first verification ran before the plan —
   and opens (or reuses) the recovery incident.
4. For each nonce, from the head backwards, **inside the evaluator lane** (the worker shares the same lane):
   1. It re-reads everything and compares the fingerprint of that nonce. It aborts (exit 3, nothing
      sent; run the dry-run again) if the nonce left the queue, or if something **of that nonce**
      changed: a new or replaced candidate at N, a candidate's status at N, or the affected job's
      on-chain status.

      A candidate the worker signed meanwhile at **another** nonce (N+1, chosen from the ledger inside
      the same lane) does not change the fingerprint of N. The script goes on with N; this is safe,
      because the replacement only ever targets N. If those nonces are still pending at the end of the
      run, the incident stays open and the last line lists them (`stays open (queue: N, N+1)`).
   2. It checks Q7, the caps and the balance again, freshly read. It checks the **confirmed** fees:
      - it aborts (exit 3, nothing sent) if they no longer beat the most expensive live candidate of the
        nonce by the replacement bump on both fees, or if `maxFeePerGas` is below the current base fee;
      - it refuses (`evaluator-recovery-refused`) if they now exceed the fresh caps or the budget.

      A base fee that only moved by a block does not abort a confirmed speed-up.
   3. It signs with the explicit nonce and **the confirmed fees**.
   4. It records the SCRIPT candidate together with the job stamp. The operator and the note go only into
      that ledger row. The budget is re-checked under the ledger lock.
   5. It confirms the lease is still held, then sends. If the lease was lost, it sends nothing and
      exits with 3; the SCRIPT row stays SIGNED until the reconciliation proves it dead.
   6. Only after the send returned, it writes one **neutral** line into `Job.escrowError`, which the
      requester and the provider can read through the API: `evaluator recovery: <operation> sent at
      nonce <N>` when the node accepted the transaction (or already knew it), `… attempted at nonce <N>`
      for any other answer. It never carries the operator's name or note (D-i). A lost lease writes no
      line.
5. It waits for the receipt **outside** the lane, for at most `EVALUATOR_RECOVERY_RECEIPT_WAIT_SECONDS`
   (90 s).
6. It runs the reconciliation (the same diagnostic pass as at the start). The existing path settles the
   job from the chain.
7. It closes the incident once the queue is unblocked.

A range stops at the first deviation.

**What the worker reports when your replacement mines (P3-6, 24/10).** If the worker is waiting for the
receipt of the transaction you replaced, its wait ends with your transaction's receipt. The worker never
reads that receipt as the job's outcome (C3h D2): the next attempt reads the job on-chain. Because your
speed-up or cancel was recorded in the ledger before its send (origin `SCRIPT`, with the incident), the worker
reports it as the known operation it is: `evaluator-replaced-by-recovery`, `severity: info`, naming the
incident and the operator. Any other replacement of a worker transaction — no ledger row, another origin, no
incident, another nonce or key, or a ledger that cannot be read at that moment — stays
`evaluator-replaced`, an incident alert: a manual send with the evaluator key or a second settlement worker.
Treat that one as an incident.

**On Telegram and Discord both arrive as "ESCROW_ALERT"**: those channels show neither the `kind` nor the
`severity`, only the text — read it (the notice names the recovery incident; the incident alert names a manual
send or a second worker). The generic webhook (`OPERATOR_NOTIFICATION_WEBHOOK`) carries `metadata.kind` and
`metadata.severity` (`info` / `alert`) for routing.

## 4. Speed-up ≠ cancel

| | Speed-up | Cancel |
|---|---|---|
| What | Same nonce, **same calldata**, both fees above every live candidate (+12.5 %) | Same nonce, 0 ETH to the key itself, 21 000 gas, no data |
| Effect | The decision already taken happens **now** | **Nothing is settled.** The job stays Submitted; its decision is re-signed later with a **new** nonce behind every queued evaluator transaction |
| When admitted | Ours, the job not terminal, the simulation passes | Only when the speed-up is impossible: the simulation reverts, the job is already terminal on-chain, or the head is foreign (after `--acknowledge-foreign`). Refused within 1 h of a delivered job's `expiresAt` when a "pay" is affected |

> CANCEL does not settle the job. It stays Submitted; its decision will be re-sent later with a new nonce
> behind every queued evaluator transaction. Use SPEED-UP to settle it now.

**A cancel never cancels a "pay" decision.** The worker re-signs the recorded decision once the cancel's
nonce is proven consumed. To not pay, change the decision with `resolve` after that proof.

**Rebroadcast** sends the identical recorded bytes again: the same nonce, fees and decision. It is
allowed only when the transaction is the head, is the only live candidate at its nonce, is unknown to
every node, and its simulation passes. The worker does the same by itself on every tick when it can.

## 5. Caps (the owner sets them in `.env`)

There are **no defaults in code**. With no caps configured for a chain, or caps that are incomplete, the
script only runs the dry-run. A malformed value refuses the boot. The variables are:

- **Per chain** (`<NAME>_<chainId>`):
  - `EVALUATOR_RECOVERY_MAX_GAS_LIMIT` (P1);
  - `EVALUATOR_RECOVERY_MAX_FEE_PER_GAS_WEI` (P2);
  - `EVALUATOR_RECOVERY_MAX_PRIORITY_FEE_PER_GAS_WEI` (P3);
  - `EVALUATOR_RECOVERY_MIN_PRIORITY_FEE_PER_GAS_WEI` (the P7 floor);
  - `EVALUATOR_RECOVERY_MAX_COST_WEI` (P11, per tx);
  - `EVALUATOR_RECOVERY_MAX_INCIDENT_COST_WEI` (P12);
  - `EVALUATOR_RECOVERY_MAX_DAILY_COST_WEI` (P13, rolling 24 h);
  - `EVALUATOR_RECOVERY_RESERVE_WEI` (P14);
  - `EVALUATOR_RECOVERY_L1_MARGIN_WEI` (P15).
- **For every chain:**
  - `EVALUATOR_RECOVERY_BASE_FEE_MULTIPLIERS` (P4, e.g. `3,6,12`);
  - `EVALUATOR_RECOVERY_MAX_BASE_FEE_MULTIPLE` (P5);
  - `EVALUATOR_RECOVERY_REPLACEMENT_BUMP_BPS` (P6);
  - `EVALUATOR_RECOVERY_MAX_REPLACEMENTS_PER_NONCE` (P8);
  - `EVALUATOR_RECOVERY_MIN_INTERVAL_SECONDS` (P9);
  - `EVALUATOR_RECOVERY_MAX_RANGE_NONCES` (P16).

`.env.example` lists the plan's **Base Sepolia proposal** as commented examples. Those values are
**a proposal, not authorised for the pilot or mainnet**. The effective fee cap is
`min(P2, P5 × base fee + P3)`. A proposal above it is refused, never clipped.

The proposed fee per attempt is:

```
maxFee = max(previous × (1 + bump), base × m_attempt + priority)
priority = max(previous × (1 + bump), p90, floor)
```

The budget counts, per nonce, the most expensive SCRIPT candidate: once for the incident and once for
the rolling 24 h. The balance must keep `reserve + L1 margin` after everything reserved. These checks are
read from the ledger, so they hold across restarts and across two operators.

## 6. When a limit is reached

The script refuses `--execute`, prints the value that would be needed (for example "would need X wei,
cap Y wei") and raises `evaluator-recovery-refused`. Nothing is retried. Then:

1. **Escalate to the owner.** Only the owner raises a cap: edit the env, then run again with a note.
   Never raise a cap in the middle of an incident without a recorded decision.
2. If the key needs funds (`RESERVE_BREACHED`), fund it.
3. In C5, escalating means **stopping the run** (A0 from that point) and recording the decision.

## 7. Deadlines and third parties

> After expiresAt anyone can call claimRefund on a Funded or Submitted job and refund the requester in
> full, also for work already delivered; the provider is then unpaid. complete/reject are still valid
> after expiresAt only while the job is still Submitted (first mined wins).

What to do at each posture of the earliest delivered job waiting on the key:

| Posture | Operator action |
|---|---|
| none (> 24 h) | You may wait for the fee to fall; repeat the dry-run at each re-alert. |
| ACT (≤ 24 h) | Speed up the head now. |
| URGENT (≤ 6 h) | The same; a range if the queue has more than one nonce. |
| HAND-TO-OWNER (≤ 1 h) | The owner decides (raise a cap, or accept losing the race). Cancel is refused when a "pay" is affected. |
| EXPIRED | A pure race: speed-up only, while `getJob` is still Submitted and the simulation passes, with the `AFTER EXPIRY` phrase. |

Deliveries close to `expiresAt` (the 2-minute clamp) are **not** protected by the 10-minute alert; the
early alert helps only with an operator on call.

The backend never signs a `claimRefund` against a recorded "pay" (C3h D1). A third party still can, and
the contract cannot reverse it. When it happens, the job is mirrored as EXPIRED, the alert
`provider-unpaid` fires, and any compensation of the provider is an off-chain decision.

## 8. Proof tag

`EVALUATOR_PROOF_TAG` sets the depth at which an outcome counts as proven (owner decision D-g; the spec
recommends `safe` on Base). The following wait for it:

- contest;
- resolve with another decision;
- the backend's `claimRefund` / cancellation reject;
- the DB finalization of a settled job.

On Base, `safe` lags `latest` by minutes. Re-signing the same decision needs only `latest`. On an Anvil
node (local or fork), set `EVALUATOR_PROOF_TAG=latest` explicitly: the backend refuses to boot with the
implicit `safe` default there.

## 9. RPC nodes

Every proof needs **every** configured RPC node of the chain to answer. Nothing is concluded by
majority. An unstable public node blocks the proofs: gates answer 503 / `unverifiable` and you get
`rpc-node-unhealthy`. In production and the pilot, configure only reliable nodes and remove the public
RPC from the candidates.
