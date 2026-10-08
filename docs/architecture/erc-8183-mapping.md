# ERC-8183 (Agentic Commerce) — mapping to AgentFi jobs

> Draft for owner review (task C1 of the [execution plan](../project/execution-plan-2026-10.md)). Written 2026-10-06 from the **published** EIP text (last revision 2026-03-13) and the reference repositories. ERC-8183 is a **Draft** EIP; this document pins the revision we implement against and lists what may change.

Sources: [eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183) · [Magicians thread](https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902) · [erc-8183/base-contracts](https://github.com/erc-8183/base-contracts) · [erc-8183/hook-contracts](https://github.com/erc-8183/hook-contracts) · Virtuals `acp-node-v2` (`AgenticCommerceV3`).

## 1. What the standard defines

One atomic unit, the **Job**, with three roles and a fixed state machine.

```solidity
enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

struct Job {
    uint256 id; address client; address provider; address evaluator;
    string description; uint256 budget; uint256 expiredAt;
    JobStatus status; address hook;
}

function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook) external returns (uint256);
function setProvider(uint256 jobId, address provider_) external;
function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;
function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external; // see §4
function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
function claimRefund(uint256 jobId) external;
function getJob(uint256 jobId) external view returns (Job memory);

interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
```

Events: `JobCreated, ProviderSet, BudgetSet, JobFunded, JobSubmitted, JobCompleted, JobRejected, JobExpired, PaymentReleased, EvaluatorFeePaid, Refunded`.

**Transitions (the only valid ones):** `Open → Funded` (client `fund`), `Open → Rejected` (client), `Funded → Submitted` (provider), `Funded → Rejected` (evaluator), `Submitted → Completed | Rejected` (evaluator only), `Funded | Submitted → Expired` (`claimRefund` by anyone after `expiredAt`).

**Roles.** Client creates and funds; may reject only while `Open`. Provider may be `address(0)` at creation (`setProvider` before `fund`), proposes the budget, calls `submit`. Evaluator is one non-zero address per job (may be the client or a contract) and is the only party that decides after `Submitted`.

**Funding.** Single ERC-20 token per contract (or per job at creation), pulled with `safeTransferFrom(client, this, budget)` after approval. **Native ETH is not in the standard.** Release is all-or-nothing minus optional `platformFeeBP` and `evaluatorFeeBP` (only on `Completed`). Rejection in `Funded`/`Submitted` and expiry refund the client in full.

**Hooks.** Optional, one per job, fixed at `createJob`. Hookable: `setProvider, setBudget, fund, submit, complete, reject`. `claimRefund` must not be hookable. `beforeAction` may revert (gating); `afterAction` runs after transfers in the same tx. Data encoding: `setProvider → abi.encode(address, bytes)`, `setBudget → abi.encode(uint256, bytes)`, `fund → optParams`, `submit → abi.encode(bytes32, bytes)`, `complete/reject → abi.encode(bytes32 reason, bytes)`. Hooks should be non-upgradeable, restricted to the escrow (`onlyACP`), and ERC-165 detectable.

## 2. Mapping AgentFi → ERC-8183

| AgentFi today (`Job` model, `jobs.ts`, `escrow.service.ts`) | ERC-8183 | Notes |
|---|---|---|
| `requesterId` | `client` = requester's wallet address | The Safe/EOA that funds |
| `providerId` | `provider` | Known at creation in AgentFi; standard also allows late `setProvider` |
| operator backend (release/refund today) | `evaluator` | **Default proposed:** operator signer. Alternative: requester wallet (standard allows client = evaluator). Open question §5.1 of the plan |
| `reward { amount, token }` | `budget` + the contract's ERC-20 | USDC on Base; ETH rewards are not representable (§4) |
| `PENDING` | `Open` | created, not funded |
| escrow v2 reservation (`reservationStatus = PENDING`) + `ESCROW_LOCK` tx | `Funded` | `fund(jobId, expectedBudget)` replaces `lock(jobId, provider, token, amount)` |
| `ACCEPTED` | no state | acceptance is off-chain; the standard moves straight to `Submitted` when the provider delivers |
| `COMPLETED` by provider → `PAYMENT_PENDING` | `Submitted` (`submit(jobId, deliverable)`) | `deliverable` = keccak256 of the result JSON stored by the backend |
| `finalizeA2APaymentJob` CONFIRMED (release) | `Completed` (`complete` by evaluator) → `PaymentReleased` | atomic; no separate payment tx |
| `FAILED` / `PAYMENT_FAILED` (refund) | `Rejected` (evaluator) → `Refunded` | |
| `CANCELLED` by requester before work | `Rejected` by client while `Open`, or `claimRefund` after expiry | |
| stale `ACCEPTED` cleanup (never built) | `Expired` via `claimRefund` after `expiredAt` | solved by the standard |
| `payload` (task JSON) | `description` (string) or hash | keep full payload off-chain; put a URI/hash on-chain |
| `result` | `deliverable` (bytes32) | hash of result JSON |
| `reason` field on job updates | `reason` (bytes32) on `complete`/`reject` | hash of the human-readable reason |

## 3. Contract: `AgentJobEscrow.sol` (as implemented, review R2 applied 2026-10-06)

- Implements the interface above verbatim (so third-party ERC-8183 tooling and indexers work). `IACPHook is IERC165` as in the reference; interface id `0x7ff6bc9e` unchanged.
- `token` = USDC per contract (constructor); fee-on-transfer tokens rejected (as in base-contracts). Native ETH is not supported (§4).
- **Single provider assignment.** `setProvider` follows the published text literally: it reverts (`ProviderAlreadySet`) when `job.provider != address(0)`, so a provider is assigned exactly once, either at `createJob` or by one `setProvider` while `Open`. A provider can never be swapped after being named.
- Stores `providerAgentId` (ERC-8004 id) per job in a side mapping, set with the extension function `setProviderAgentId(jobId, agentId)` by the **provider only** while `Open`/`Funded`, and emitted as `ProviderAgentIdSet`. **Extension change in C2b (second adversarial review, 2026-10-08):** the client could also call it, so it could set `0` after the provider had bound its id and before `submit`, and `complete` skipped the feedback (`no-agent-id`). The identity belongs to the provider, so only the provider presents it (AgentFi's backend binds it through the provider's own wallet, R2); since nobody can set it while `provider == address(0)`, `setProvider` no longer has anything to clear. The selector `setProviderAgentId(uint256,uint256)` and the event are unchanged; none of this touches the ERC-8183 surface. The escrow does not validate the id: `ReputationHook` checks it against the Identity Registry on the provider's first `submit` and keeps one canonical id per provider address (see [erc-8004-integration.md](erc-8004-integration.md) §4).
- **Fees are pull-based.** `complete` pays `budget − platformFee − evaluatorFee` to the provider, pushes `evaluatorFee` to the evaluator (AgentFi default 0 bps) and **accrues** `platformFee` in `pendingPlatformFees` (`PlatformFeeAccrued`). `withdrawPlatformFees()` (callable by `feeWallet` or the operator) sweeps the accrual to the *current* `feeWallet`, which the operator can rotate with `setFeeWallet` (`FeeWalletUpdated`). A frozen or lost fee wallet therefore never blocks `complete`. The evaluator fee stays push-paid because the evaluator is the operator signer; if a non-zero evaluator fee is ever configured and that address cannot receive USDC, `complete` reverts and `reject`/`claimRefund` are the exits (documented liveness caveat). Fee math uses a split multiplication and never overflows for any `uint256` budget.
- **Blacklisted parties (no escape hatch, on purpose).** Refunds are pushed to `job.client`: if the client is blacklisted by the token, `reject` (after funding) and `claimRefund` revert and `complete` is the only exit; funds stay in the escrow until the client is cleared. If the provider is blacklisted, `complete` reverts and the evaluator unwinds with `reject(jobId, REASON_PAYOUT_BLOCKED, …)` (the hook then writes no negative feedback) or anyone calls `claimRefund` after expiry. The operator can never redirect escrowed budgets, which is the point.
- **Expiry race (spec-permitted).** Once `block.timestamp >= expiredAt`, a `Submitted` job can still be settled by the evaluator (`complete`/`reject`) *and* expired by anyone (`claimRefund`); the first transaction mined wins and the other reverts with `InvalidStatus`. The backend evaluator must settle before `expiredAt`; the reference implementations behave the same way.
- **Hook detection is strict.** At `createJob` the escrow requires `supportsInterface(0x7ff6bc9e)` to return exactly `true` and `supportsInterface(0xffffffff)` to return exactly `false` (one 32-byte word each, gas-capped static calls). "Yes-man" contracts, garbage words, reverts and oversized returns are rejected with `UnsupportedHook` instead of panicking.
- Operator **emergency path** (pause `createJob`/`fund`; settlement and refunds never pausable; no ability to redirect funds) kept outside the standard surface.
- Hook per job = AgentFi's `ReputationHook` by default; any strict ERC-165 `IACPHook` accepted.
- Non-upgradeable for the validation period (simpler audit surface); base-contracts' UUPS is not adopted. The only mutable parameter is `feeWallet`.

## 4. Known pitfalls and version drift

1. **Two texts exist.** The published EIP (2026-03-13) is canonical. A revised draft in `erc-8183/base-contracts/eip.md` (2026-06-30) adds claim settlement (`submitClaim/settleClaim/approveClaim/rejectClaim`), `fund(jobId, expectedToken, expectedBudget)`, per-job token, `providerAgentId`, a 1-hour evaluation grace period and `Open → Expired`. It has not (verifiably) been submitted upstream. **We implement the published text and reserve storage for the draft fields.**
2. **`fund` signature.** The prose says `fund(jobId, expectedBudget, optParams)` with a revert when `job.budget != expectedBudget` (front-running guard); the embedded example contract omits `expectedBudget`. Virtuals' production `AgenticCommerceV3` uses the prose form. **Follow the prose.**
3. **`setBudget` caller.** Prose: client or provider. Embedded contract: provider only. Follow the prose; hook data encoding `abi.encode(uint256 amount, bytes optParams)` (the table), not `abi.encode(msg.sender, amount, optParams)`.
4. **No native ETH.** New jobs are USDC-only (plan §5.6). The legacy `EscrowModule` stays deployed for ETH until retired.
5. **Reference deployments to interoperate/test against:** Virtuals ACP Base `0x238E541BfefD82238730D00a2208E5497F1832E0`, Base Sepolia `0x0b93793923CD5De81850aF8604a233f3f24d461e` (from `acp-node-v2/src/core/constants.ts`; hook addresses differ between changelog and code, unverified).

## 5. Decisions (owner, 2026-10-06)

- Evaluator default = operator/backend signer (plan D5).
- Protocol fee = `platformFeeBP` in USDC on `Completed`, default 30 bps (plan D6).
- New jobs are USDC-only; legacy `EscrowModule` kept for ETH until retired (plan D8).
- Fee bps tiering during validation is still open (plan §5.3).

## 6. Backend flow (as implemented, task C3)

Code: `packages/backend/src/services/job/escrow-erc8183.service.ts` (pure orchestrator, injected deps), `escrow-erc8183.runtime.ts` (real wiring), `services/escrow/evaluator-signer.ts`, `queues/escrow-settlement.queue.ts`, `api/routes/jobs.ts`. ABIs are generated from the Foundry source into `packages/backend/src/abi/AgentJobEscrow.abi.ts` and `ReputationHook.abi.ts` (`npm run abi:escrow`). Migration `0014_erc8183_escrow` adds the `Job` columns below.

### 6.1 Enablement

A chain is ERC-8183-enabled when `AGENT_JOB_ESCROW_ADDRESS_<chainId>` **and** `ESCROW_EVALUATOR_PRIVATE_KEY` are set (`isErc8183Enabled(chainId)`). `REPUTATION_HOOK_ADDRESS_<chainId>` is optional (zero hook when absent). Only **paid** jobs (`reward.amount`) on an enabled chain use the escrow; free jobs and paid jobs on other chains keep the legacy path (DB reservation + optional `EscrowModule` lock) unchanged. The reward must be USDC — symbol `USDC` or the escrow's `token()` address, case-insensitive — otherwise `400 ERC8183_USDC_ONLY` (D8). The escrow token is read once per chain from `token()` and cached (registry fallback when the RPC fails).

### 6.2 Step chain and who signs

```
POST /v1/jobs (USDC reward, enabled chain)
  │  DB reservation (DailyVolume) as before; Job.escrowKind = "erc8183", onChainStatus = CREATING
  ▼
requester wallet  ── createJob(provider, evaluator, now+TTL, "<BACKEND_PUBLIC_URL>/v1/jobs/<id>", hook) ──► OPEN   (JobCreated.jobId → Job.onChainJobId)
requester wallet  ── setBudget(jobId, budget, "0x") ───────────────────────────────────────────────────► BUDGET_SET
requester wallet  ── USDC.approve(escrow, budget) ─────────────────────────────────────────────────────► APPROVED
requester wallet  ── fund(jobId, budget, "0x") ────────────────────────────────────────────────────────► FUNDED      ← provider may PATCH ACCEPTED only now (409 ESCROW_NOT_FUNDED before)
                       │ R2 (chain with a ReputationHook): providerAgentIdStatus = BINDING
provider wallet   ── [register(agentURI) on the ERC-8004 Identity Registry — first funded job only (D7)]
provider wallet   ── setProviderAgentId(jobId, erc8004AgentId) ───────────────────────────────────────► (still FUNDED)  providerAgentIdStatus = BOUND (FAILED / SKIPPED never block)
provider wallet   ── submit(jobId, keccak256(JSON.stringify(result ?? {})), "0x") ──────────────────────► SUBMITTED   (PATCH COMPLETED → Job PAYMENT_PENDING;
                                                                                                                         while BINDING the submit is deferred and sent when the binding ends)
                       │ ESCROW_EVALUATION_DELAY_SECONDS (requester may POST /v1/jobs/:id/contest)
evaluator signer  ── complete(jobId, keccak("agentfi.completed"), abi.encode(feedbackURI, feedbackHash)) ► COMPLETED → finalizer CONFIRMED → Job COMPLETED
               or ── reject(jobId,   keccak("agentfi.contested"), abi.encode(feedbackURI, feedbackHash)) ► REJECTED  → finalizer FAILED    → Job PAYMENT_FAILED (refunded on-chain; since C2b the hook writes nothing: "not-verdict")
```

- **Requester and provider steps** are ordinary `Transaction` rows (`type = ESCROW_LOCK` for the four funding steps, `ESCROW_SUBMIT` for `submit`, `metadata = { erc8183: true, escrowStep, jobId }`) signed by the agent's wallet provider through the transaction queue, so the pre-submit guard, policy pause, retries and dead-lettering apply as to any other transaction. The orchestrator advances the chain from the worker's post-confirmation hook, the permanent-failure handler and the guard's fail path (`onEscrowTxOutcome`). Before enqueuing the next step it re-reads the Job and stops if it is no longer `PENDING`/`ACCEPTED`.
- **Provider identity steps (R2)**: when `fund` confirms on a chain with a `ReputationHook`, the provider's wallet binds its ERC-8004 identity to the job with `setProviderAgentId` — after minting it with `register(agentURI)` if this is its first funded job on the chain (decision D7) — so the hook can write feedback at settlement. Same transaction queue, `type = ERC8004_IDENTITY`, `metadata.escrowStep = register | bindAgent`. `setProviderAgentId` is only valid while the job is `Open`/`Funded` and is signed by the same wallet as `submit`, so a `PATCH COMPLETED` that arrives while the binding is `BINDING` **defers** the `submit` (`Job.deferredSubmitAt`); the orchestrator sends it when the binding is `BOUND`, `FAILED` or `SKIPPED`. A failed or skipped binding never blocks payment — the hook just skips feedback. Full flow: [erc-8004-integration.md](erc-8004-integration.md) §7.
- **Evaluator steps** (`complete`, `reject`, `claimRefund`) are signed by the operator key `ESCROW_EVALUATOR_PRIVATE_KEY` (its address is logged at boot as `escrowEvaluatorAddress` and must be the hook's `TRUSTED_EVALUATOR`). The evaluator is not an `Agent` row, so it never goes through the transaction queue; it has its own BullMQ queue `escrow-settlement` (3 attempts, exponential backoff, one job per `<action>-<jobId>`). Every settlement reads `getJob(onChainJobId).status` first and, when the chain is already terminal, reconciles the DB without sending anything — a crash after broadcast, a redelivery or the expiry race are therefore harmless. Evaluator transactions carry an explicit gas limit, `eth_estimateGas` + 400 000 (`EVALUATOR_GAS_HEADROOM`): the estimate is the cheapest limit at which `complete`/`reject` succeed, which is the path where the hook's `giveFeedback` runs out of gas inside its try/catch and the feedback is lost (`FeedbackFailed(jobId, "")`) — measured on the C5a fork: estimate 246 770, full path 340 231. Since R3c the hook itself prevents this (gas-capped registry calls and an `InsufficientGasForFeedback` revert when the caller's gas cannot cover them, see [erc-8004-integration.md §4](erc-8004-integration.md#4-agentfi-design-feedback-written-by-the-escrow-hook)), so the estimate already includes the feedback path; the headroom stays as insurance against estimate/inclusion drift.
- `Job.onChainStatus` always records the last **confirmed** step; `SETTLING` marks a claimed settlement (contests are refused from then on); `EXPIRED_UNFUNDED` (C3c) closes a job that expired while still `Open` on-chain (nothing was ever locked and `fund` is closed). Every step advance is a conditional write from the expected previous value (§6.7), so the effects of a confirmation (next step, ERC-8004 binding, settlement) happen once however many observers report it.

### 6.3 Settlement, feedback file and contest

Before `complete`/`reject` the worker generates the ERC-8004 feedback file **once** ([erc-8004-integration.md](erc-8004-integration.md) §4: `jobId`, `escrow`, `proofOfPayment` = the `fund` tx, `outcome`, `deliverableHash`, `evaluator`, `issuedAt`), stores it in `Job.feedbackFile`, and commits `feedbackHash = keccak256(canonicalJSON(file))` in `optParams = abi.encode(string feedbackURI, bytes32 feedbackHash)` with `feedbackURI = <BACKEND_PUBLIC_URL>/v1/jobs/<id>/feedback.json`. The file is served byte-for-byte by that public endpoint; "canonical" means recursively sorted keys, because the `jsonb` column does not preserve key order. The file is rebuilt only when a contest changed the outcome after an earlier (reverted, hence unmined) attempt; the on-chain status read that precedes every settlement guarantees nothing with the old hash was mined.

From the receipt the worker stores `settleTxHash`, `platformFeeAmount` (`PlatformFeeAccrued`), `feedbackStatus` (`written` / `skipped:<reason>` / `failed` from the hook events) and the terminal `onChainStatus`, then calls `finalizeA2APaymentJob` (`CONFIRMED` for `complete`, `FAILED` for `reject`), which keeps doing the DB reservation, reputation, USD snapshot and notifications but skips the legacy `EscrowModule` release/refund for `escrowKind = "erc8183"`.

A reverted or unmined settlement throws so BullMQ retries against a fresh on-chain read; after the last attempt the Job stays `PAYMENT_PENDING` with `onChainStatus = SUBMITTED` and `escrowError` — it is **never** refunded in the DB because the USDC is on-chain. The payment-recovery scan re-enqueues the settlement for such jobs (and never calls the FAILED finalizer for them).

`POST /v1/jobs/:id/contest` (requester, while `PAYMENT_PENDING` + `SUBMITTED`, before the worker claims the settlement) sets `contestedAt`/`contestReason`; the evaluator then sends `reject` with reason `keccak256("agentfi.contested")`. The claim is a conditional update (`SUBMITTED → SETTLING`), so exactly one of contest/settle wins. **Since C2b (decision D9) the hook writes negative feedback only for `reject` with `REASON_QUALITY_REJECTED = keccak256("agentfi.quality-rejected")`**, the operator's explicit verdict: this automatic contest reject refunds the requester and writes nothing (`FeedbackSkipped("not-verdict")`, `feedbackStatus = skipped:not-verdict`). Task C3d replaces it with an operator review (contest → held job → admin resolves by paying the provider or rejecting with the verdict reason).

### 6.4 Failure, cancellation and expiry

| Event | On-chain | Backend |
|---|---|---|
| Any step before `FUNDED` reverts / is blocked / exhausts retries / is dropped | **C3c: `getJob` decides first.** Funded or Submitted on-chain (a `fund` whose monitor timed out but mined, a retried `fund` that reverted because the first broadcast mined) → the job advances from the chain; Open with the budget set / the allowance granted → that `setBudget` / `approve` mined, advance; chain unreadable → nothing unwound, `escrowError` says so and the reconciliation retries | Only when the chain is really behind: `onChainStatus = FAILED`, `escrowError`, Job `FAILED`, DB reservation released, the requester's funding lane moves on. No on-chain `reject` is sent: it would cost the requester gas to close a job nobody can fund. A dropped `fund` that mines afterwards is caught by the reconciliation (refund through the evaluator) or, at the latest, by the expiry sweep. |
| `submit` reverts / is blocked / exhausts retries / is dropped | `getJob` first (C3c): Submitted → the job advances to `SUBMITTED` and is settled; still `Funded` → | Job back to `ACCEPTED` with `escrowError` — only when no other `submit` of the job is queued, broadcast or confirmed; the provider retries `PATCH COMPLETED` (a retry gets a fresh `intentId`). The reservation stays. |
| Requester `CANCELLED` or provider `FAILED` while the budget is locked (`FUNDED`) | evaluator `reject(jobId, keccak("agentfi.cancelled" \| "agentfi.provider-failed"), "0x")` → full refund | Job status flips immediately (as today) and the DB reservation is released immediately (as today): the reservation is spending-limit accounting, the requester's decision is final and the funds are not spent — holding it until the refund confirms would only lock daily volume on an evaluator outage. `onChainStatus = REJECTED` on confirmation. |
| Cancellation while the chain is still running | the chain stops before the next step; a `fund` that confirms *after* the cancellation triggers the same `reject`. C3c: the route schedules the `reject` for every job that exists on-chain and is not final — the reject reads `getJob`, so a `fund` whose monitor was lost (DB `APPROVED`, chain `Funded`) is refunded now instead of at expiry | |
| Cancellation of a job **Submitted** on-chain (the DB lagged: it said `ACCEPTED`) | **refused** (C3c): the provider's deliverable is on-chain, a cancellation must not hand the requester the result and the refund | `onChainStatus = SUBMITTED`, `escrowError = "Cancellation refused …"`, `ESCROW_ALERT` to the operator; nothing is sent. Settlement or the operator resolves it; at `expiresAt` the expiry sweep refunds the requester. |
| A cancellation refund never ran (settlement queue down, evaluator outage, retries exhausted) | still `Funded` | The reconciliation re-enqueues the evaluator `reject` for `CANCELLED`/`FAILED` jobs whose chain state is `Funded` (§6.7). |
| `expiresAt` passed while `FUNDED`/`SUBMITTED` | repeatable sweep (every `PAYMENT_RECOVERY_INTERVAL_SEC`) enqueues `claimRefund(jobId)` (anyone may call; the evaluator does) for **every job with an `onChainJobId` that is not final in the DB** (C3c — not only DB `FUNDED`/`SUBMITTED`: a lost `fund` monitor leaves the DB at `APPROVED`); the claim reads `getJob`: Funded/Submitted → refund, Open → `EXPIRED_UNFUNDED`, terminal → mirrored | `onChainStatus = EXPIRED`; a `PAYMENT_PENDING` job is finalized `FAILED` (→ `PAYMENT_FAILED`), a `PENDING`/`ACCEPTED` one becomes `FAILED`; reservation released. The evaluator must settle before `expiresAt` (§3, expiry race); both paths reconcile from the chain. |

### 6.5 Idempotency keys

| What | Key |
|---|---|
| Agent-signed step | `Transaction.intentId = "erc8183:<create\|setBudget\|approve\|fund\|submit\|bindAgent>:<jobId>"` (retried `submit`: `…#<timestamp>`) |
| ERC-8004 mint (R2) | `Transaction.intentId = "erc8004:register:<agentId>:<chainId>"` (retry after a FAILED mint: `…#<timestamp>`) + unique `AgentIdentity(agentId, chainId)` |
| Settlement job | BullMQ `jobId = "<settle\|reject\|claimRefund>-<jobId>"` (a hyphen: BullMQ 5 rejects custom ids with `:`, found by the C5a fork rehearsal); completed/failed entries are removed before a re-add |
| Expiry sweep | BullMQ repeatable `jobId = "escrow-expiry-sweep"` |
| On-chain job | `@@unique([escrowContract, onChainJobId])` on `Job` |
| Feedback file | generated once per job; hash recomputed from the stored file |

### 6.6 Environment and API surface

Env: `AGENT_JOB_ESCROW_ADDRESS_<chainId>`, `REPUTATION_HOOK_ADDRESS_<chainId>`, `ESCROW_EVALUATOR_PRIVATE_KEY` (required in staging/production when an escrow address is set), `ESCROW_JOB_TTL_SECONDS` (default 604800), `ESCROW_EVALUATION_DELAY_SECONDS` (default 0), `BACKEND_PUBLIC_URL` (default `http://localhost:3000`). API: `Job.escrow` object on every job response (`kind, chainId, contract, onChainJobId, onChainStatus, evaluator, budgetAmount, budgetToken, expiresAt, deliverableHash, settleTxHash, platformFeeAmount, feedbackStatus, contestedAt, contestReason, escrowError`), `POST /v1/jobs/:id/contest`, public `GET /v1/jobs/:id/feedback.json`; error codes `ERC8183_USDC_ONLY`, `ERC8183_PROVIDER_IS_REQUESTER`, `ERC8183_PROVIDER_IS_EVALUATOR`, `ERC8183_START_FAILED`, `ESCROW_NOT_FUNDED`, `ESCROW_SUBMIT_FAILED`, `CONTEST_NOT_ALLOWED`, `NOT_ESCROW_JOB`.

R2 adds `IDENTITY_REGISTRY_ADDRESS_<chainId>` (blank = official Base / Base Sepolia registry), `MCP_PUBLIC_URL`, the `escrow` fields `providerAgentId, providerAgentIdStatus, providerAgentIdError, deferredSubmitAt`, `erc8004` on agent responses and the public `GET /v1/agents/:id/erc8004.json` ([erc-8004-integration.md](erc-8004-integration.md) §7).

Not in C3: the platform-fee sweep (`withdrawPlatformFees`, plan C3b), `setProviderAgentId` (done in R2 — before it the hook skipped feedback with `no-agent-id`), MCP tools (X3/X4), and the testnet E2E (C5).

### 6.7 Chain as the source of truth: reconciliation, lanes, recovery (C3c)

The second adversarial review (2026-10-08) showed the backend trusting the `Transaction` row: the confirmation monitor is a promise inside the worker process (a restart or `process.exit` loses it), it marked a transaction FAILED after ~7.5 minutes without a receipt, and a retry after a lost RPC answer signed a second transaction that reverted once the first mined. A `fund` "FAILED" while mined failed the job and released the reservation with the USDC locked and no refund path; a lost `fund` monitor left the job `APPROVED` forever (provider `409`, no cancellation refund, ignored by the expiry sweep); a lost `submit` monitor got the provider refunded away at expiry; a lost identity monitor blocked the provider's binding lane. Code: `escrow-erc8183.service.ts` (`handleStepFailure`, `advanceToFunded`/`advanceToSubmitted`, `pumpFunding`, `reconcileEscrowJob(s)`), `queues/transaction.processor.ts` (`runPostConfirmation`, `repollSubmittedTransactions`), `services/transaction/monitor.service.ts`, `submitter.service.ts`, `wallet-lane.ts`, `queues/payment-recovery.queue.ts`, `worker-process.ts`.

**Receipts, exactly once.** A receipt is recorded with a conditional `SUBMITTED → CONFIRMED | REVERTED` write and only the observer that made it runs the outcome (`runPostConfirmation`). The monitor no longer marks anything FAILED: out of attempts it leaves the row `SUBMITTED`. `repollSubmittedTransactions` is the second observer — at every boot of `worker.ts` / of an API with the worker (all `SUBMITTED` rows) and on every payment-recovery tick (rows older than `TX_REPOLL_STALE_SEC`, default 600 s): it records a receipt nobody recorded and replays the outcome (fees and daily volume rebuilt from `metadata.queuePayload`); without a receipt it waits while any node knows the hash, and declares the transaction dropped (`FAILED`) only after `TX_DROP_AFTER_SEC` (default 1800 s) with no node knowing it. A shutdown waits up to 10 s for running monitors.

**Never unwind from the row.** Every failed step outcome reads `getJob(onChainJobId)` first and follows the chain (§6.4 table); an unreadable chain unwinds nothing. Step advances are conditional (`create` on `onChainJobId IS NULL`, `setBudget` from `OPEN`, `approve` from `BUDGET_SET`, `fund` from any pre-`FUNDED` value incl. `FAILED`, `submit` from pre-`SUBMITTED`), so a replay is harmless. `settle` acts on a job Submitted on-chain even when the DB says `ACCEPTED` or `FUNDED` (it reconciles the DB to `PAYMENT_PENDING` / `SUBMITTED` first); a `CANCELLED`/`FAILED` job Submitted on-chain is an operator alert, not an automatic settlement or refund.

**Reconciliation (payment-recovery tick).** `reconcileEscrowJobs` picks, oldest first and at most `PAYMENT_RECOVERY_PER_TICK_LIMIT` of each, ERC-8183 jobs whose row has not moved for `ESCROW_RECONCILE_STALE_SEC` (default 600 s): live jobs before `FUNDED` (a step whose outcome was lost is replayed, a step never enqueued is enqueued, a job waiting for the funding lane is pumped, a job past `expiresAt` still `Open` is closed `EXPIRED_UNFUNDED`), `CANCELLED`/`FAILED` jobs the DB believes may hold a budget (`APPROVED`/`FUNDED`, or `FAILED` after a dropped `fund` until `expiresAt`) — the evaluator `reject` is re-enqueued when the chain is Funded —, `ACCEPTED` jobs with an attempted `submit` that is Submitted on-chain (settled), and stuck ERC-8004 bindings (`resumeBinding`). A job left as it was goes to the back of the queue. Stale `PAYMENT_PENDING` jobs keep `recoverErc8183Job`, which now hands a job back to `ACCEPTED` only when the chain still says Funded.

**Lanes (absorbs N1).**

| Lane | Key | What it serializes | Why this design |
|---|---|---|---|
| Broadcast | Redis lock `agentfi:lane:<chainId>:<from>` (SET NX PX 120 s, compare-and-delete release, 120 s wait then BullMQ retries) | `SubmitterService.submit` from the nonce read to the broadcast; the nonce is `max(getTransactionCount(pending), last nonce this lane broadcast + 1)` (the last nonce is remembered 60 s, `agentfi:lane-nonce:*`) | The worker runs with concurrency > 1 and on several processes; a per-wallet BullMQ queue would need dynamic queues/workers per wallet (BullMQ groups are a Pro feature) and would serialize the whole job, simulation included, while the collision window is only nonce-read → broadcast. The lock is held for seconds, never across confirmations; `pending` plus the remembered nonce survives a load-balanced RPC that has not seen the previous broadcast yet; the memory expires so a dropped transaction cannot leave a permanent nonce gap. Redis only — no DB row locks, so no lock-order interaction with the pay-resource reservation (P6). |
| Funding | DB state + Redis lock `agentfi:lane:funding:<chainId>:<requesterId>` around the check-and-claim | A requester's `approve` → `fund` on one chain, one job at a time: busy while a live job of the requester is `APPROVED` or any of its `approve`/`fund` transactions is pending; waiting jobs sit in `BUDGET_SET`, oldest first (`pumpFunding`, called on every lane exit and by the reconciliation) | `approve(escrow, budget)` **sets** the allowance: approve(A), approve(B), fund(A), fund(B) leaves one `fund` short. Serializing approve→fund keeps exact per-job approvals (no standing or cumulative allowance on the escrow) and costs only latency for a requester funding several jobs at once; `create`/`setBudget` still run in parallel. |
| Identity (R2) | DB (`pumpBindings`) | one ERC-8004 identity transaction per provider wallet | unchanged; a lost monitor no longer blocks it (the re-poll resolves the row) |

An agent that is both requester and provider, a provider's bind next to a `submit` of another job, or two retried submits all share the broadcast lane of their wallet and get consecutive nonces.

**Submitter.** When both RPCs throw on `sendRawTransaction`, the locally computed hash is looked up before failing; a node that knows it means the broadcast went through and the submit succeeds with that hash, so no second (reverting) transaction is signed.

**Recovery topology.** `worker.ts` (`worker-process.ts`) starts payment recovery and schedules it; `index.ts` keeps doing so when it runs the worker (`TRANSACTION_WORKER_ENABLED=true`). The repeatable job id `payment-recovery-scan` makes the schedule one per Redis; BullMQ gives each tick to one worker. Operator alerts (`ESCROW_ALERT` notifications): a refused cancellation, a `CANCELLED`/`FAILED` job Submitted on-chain, and the evaluator's native balance below `ESCROW_EVALUATOR_MIN_BALANCE_WEI` (default 0.0005 ETH, checked before each evaluator transaction, at most once per 15 minutes per chain).
