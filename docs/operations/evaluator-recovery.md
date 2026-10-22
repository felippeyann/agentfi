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
worker runs on every tick.** That pass may send the **identical** bytes of a lost head again (R2-P1-3:
the head, the only live candidate at its nonce, unknown to every node, simulation passing), so even a
dry-run can rebroadcast an already recorded transaction. It never signs a new one. The dry-run then shows:

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
3. It verifies the on-chain configuration fully (Q7) and opens (or reuses) the recovery incident.
4. For each nonce, from the head backwards, **inside the evaluator lane** (the worker shares the same lane):
   1. It re-reads everything and compares the fingerprint. If the plan changed (a new candidate, a
      status, the job on-chain), it aborts, nothing is sent, and you run the dry-run again.
   2. It checks Q7, the caps and the balance again, freshly read. It checks the **confirmed** fees:
      - it aborts (exit 3, nothing sent) if they no longer beat the most expensive live candidate of the
        nonce by the replacement bump on both fees, or if `maxFeePerGas` is below the current base fee;
      - it refuses (`evaluator-recovery-refused`) if they now exceed the fresh caps or the budget.

      A base fee that only moved by a block does not abort a confirmed speed-up.
   3. It signs with the explicit nonce and **the confirmed fees**.
   4. It records the SCRIPT candidate together with the job stamp. The operator and the note go only into
      that ledger row. The budget is re-checked under the ledger lock.
   5. It writes one **neutral** line into `Job.escrowError`, which the requester and the provider can
      read through the API: `evaluator recovery: <operation> sent at nonce <N>`. It never carries the
      operator's name or note (D-i).
   6. It confirms the lease is still held, then sends.
5. It waits for the receipt **outside** the lane, for at most `EVALUATOR_RECOVERY_RECEIPT_WAIT_SECONDS`
   (90 s).
6. It runs the reconciliation. The existing path settles the job from the chain.
7. It closes the incident once the queue is unblocked.

A range stops at the first deviation.

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
