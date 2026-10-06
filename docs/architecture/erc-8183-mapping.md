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

## 3. Proposed contract: `AgentJobEscrow.sol`

- Implements the interface above verbatim (so third-party ERC-8183 tooling and indexers work).
- `token` = USDC per contract (constructor), with an allowlist for later tokens; fee-on-transfer tokens rejected (as in base-contracts).
- Stores `providerAgentId` (ERC-8004 id) per job in a side mapping, set via `optParams` on `setProvider`/`fund`, as in the revised draft (see §4). Emitted in `JobCreated`/`ProviderSet` extension events.
- `platformFeeBP` optional and immutable; fee goes to `feeWallet` on `Completed` only (replaces the executor's ETH-only fee for A2A flows if the owner agrees, plan §5.2).
- Operator **emergency path** (pause new jobs; no ability to redirect funds) kept outside the standard surface.
- Hook per job = AgentFi's `ReputationHook` (see [erc-8004-integration.md](erc-8004-integration.md)) by default; any ERC-165 `IACPHook` accepted.
- Non-upgradeable for the validation period (simpler audit surface); base-contracts' UUPS is not adopted.

## 4. Known pitfalls and version drift

1. **Two texts exist.** The published EIP (2026-03-13) is canonical. A revised draft in `erc-8183/base-contracts/eip.md` (2026-06-30) adds claim settlement (`submitClaim/settleClaim/approveClaim/rejectClaim`), `fund(jobId, expectedToken, expectedBudget)`, per-job token, `providerAgentId`, a 1-hour evaluation grace period and `Open → Expired`. It has not (verifiably) been submitted upstream. **We implement the published text and reserve storage for the draft fields.**
2. **`fund` signature.** The prose says `fund(jobId, expectedBudget, optParams)` with a revert when `job.budget != expectedBudget` (front-running guard); the embedded example contract omits `expectedBudget`. Virtuals' production `AgenticCommerceV3` uses the prose form. **Follow the prose.**
3. **`setBudget` caller.** Prose: client or provider. Embedded contract: provider only. Follow the prose; hook data encoding `abi.encode(uint256 amount, bytes optParams)` (the table), not `abi.encode(msg.sender, amount, optParams)`.
4. **No native ETH.** New jobs are USDC-only (plan §5.6). The legacy `EscrowModule` stays deployed for ETH until retired.
5. **Reference deployments to interoperate/test against:** Virtuals ACP Base `0x238E541BfefD82238730D00a2208E5497F1832E0`, Base Sepolia `0x0b93793923CD5De81850aF8604a233f3f24d461e` (from `acp-node-v2/src/core/constants.ts`; hook addresses differ between changelog and code, unverified).

## 5. Decisions needed before C2 starts

See execution plan §5: evaluator default (1), fee model (2), native ETH policy (6).
