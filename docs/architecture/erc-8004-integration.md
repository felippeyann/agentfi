# ERC-8004 (Trustless Agents) — integration design

> Draft for owner review (task R1 of the [execution plan](../project/execution-plan-2026-10.md)). Written 2026-10-06 from the EIP text (last revision 2026-01-25) and the official contracts repository. ERC-8004 is a **Draft** EIP; the Validation Registry is still being revised with the TEE community and is out of scope here.

Sources: [eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004) · [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) · `agent0-sdk` ([agent0lab/agent0-ts](https://github.com/agent0lab/agent0-ts)) · arXiv 2606.26028 (empirical study of Sybil feedback).

## 1. Registries and addresses

| Registry | Ethereum mainnet / Base (8453) | Sepolia / Base Sepolia (84532) |
|---|---|---|
| Identity (ERC-721) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Validation | not listed in the README (unverified) | not listed |

CREATE2 deterministic addresses, UUPS proxies. The Identity Registry proxies and their implementation (`0x7274e874…9c02`, v2.0.0) were verified on 2026-10-07 (§2); the backend defaults (`DEFAULT_IDENTITY_REGISTRIES` in `config/contracts.ts`, overridable by `IDENTITY_REGISTRY_ADDRESS_<chainId>`) use the proxy addresses. The implementation is not pinned at runtime: a UUPS upgrade by the registry owner would not be noticed (follow-up: preflight check of the ERC-1967 slot / `getVersion()`).

## 2. Identity Registry (what AgentFi writes) — verified 2026-10-07

The backend does **not** derive this ABI from `packages/contracts/src/IIdentityRegistry.sol` (a two-function view interface used by `ReputationHook`, no `register`). It uses the official ABI checked in as `packages/backend/src/abi/IdentityRegistry.abi.ts`, copied from [`abis/IdentityRegistry.json`](https://github.com/erc-8004/erc-8004-contracts/blob/master/abis/IdentityRegistry.json) (file last changed in commit `44c0025f`, 2026-01-23; fetched from `master` at `b9e466c2`).

How it was verified (read-only, no transaction sent):

| Check | Result |
|---|---|
| Proxy → implementation (ERC-1967 slot, `cast storage … 0x3608…2bbc`) | Base Sepolia `0x8004A818…BD9e` **and** Base `0x8004A169…a432` both → `0x7274e874ca62410a93bd8bf61c69d8045e399c02`; `getVersion()` = `"2.0.0"`, `name()` = `"AgentIdentity"` |
| Source of the implementation | Verified on [Base Sepolia Blockscout](https://base-sepolia.blockscout.com/address/0x7274e874ca62410a93bd8bf61c69d8045e399c02?tab=contract) as `IdentityRegistryUpgradeable` (solc 0.8.24); the verified source is **byte-identical** to [`contracts/IdentityRegistryUpgradeable.sol`](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol) on `master`. (Basescan answered 403 to automated reads; Base mainnet is the same implementation address, confirmed through the RPC.) |
| Selectors in the deployed bytecode | `register()` `0x1aa3a008`, `register(string)` `0xf2c298be`, `register(string,(string,bytes)[])` `0x8ea42286`, `setAgentWallet` `0x2d1ef5ae`, `getAgentWallet` `0x00339509`, `ownerOf` `0x6352211e`, `Registered` topic `0xca52e62c…bc4a` — all present |
| A real registration | Base Sepolia tx [`0x8c74d39e…7718`](https://sepolia.basescan.org/tx/0x8c74d39eb896cf1de15d441e7038dec38dd5ec4709ae7989f22b9893940e7718) (block 47809026) emits `Transfer`, `MetadataUpdate`, `Registered(agentId 9598, …, owner 0x260F…592f)`, `MetadataSet("agentWallet")`; `owner` = the tx sender, and today `ownerOf(9598)` = `getAgentWallet(9598)` = that sender |
| EIP text | [eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004) (Draft; `ERCS/erc-8004.md` last changed 2026-01-25) lists the same three overloads, the same event, the `agentWallet` rules below and the `registration-v1` file format |

```solidity
struct MetadataEntry { string metadataKey; bytes metadataValue; }
function register() external returns (uint256 agentId);                       // agentURI set later with setAgentURI
function register(string agentURI) external returns (uint256 agentId);        // ← what AgentFi calls
function register(string agentURI, MetadataEntry[] metadata) external returns (uint256 agentId);
function setAgentURI(uint256 agentId, string calldata newURI) external;
function setMetadata(uint256 agentId, string memory key, bytes memory value) external;
function getAgentWallet(uint256 agentId) external view returns (address);
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
function unsetAgentWallet(uint256 agentId) external;
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
```

Facts the backend relies on:
- **The minter owns the identity.** Every overload does `_safeMint(msg.sender, agentId)` and emits `Registered(agentId, agentURI, msg.sender)`, so `ownerOf(agentId)` is whoever sent `register`. That is why the provider's own wallet signs it: `ReputationHook`'s `agent-not-provider` gate then passes for jobs whose `provider` is that wallet. `_safeMint` calls `onERC721Received` on a contract recipient; AgentFi's `safeAddress` is the wallet provider's EOA today, so this does not apply (a Safe would need its fallback handler).
- **`agentWallet` starts as the minter.** `register` writes the reserved `agentWallet` metadata = `msg.sender` (so `getAgentWallet` also equals the provider). Changing it needs an EIP-712 (EOA) or ERC-1271 (contract) signature **from the new wallet** with a deadline at most 5 minutes ahead; the key cannot be set through `setMetadata`/`register` metadata. A transfer of the NFT clears it. AgentFi never calls `setAgentWallet` (not needed: owner = provider already).
- **ids are sequential from 0** (`agentId = _lastId++`). Id `0` is unusable for AgentFi: `setProviderAgentId(jobId, 0)` *clears* the binding and the hook treats `0` as `no-agent-id`. On the public registries id 0 is long taken; on a fresh local registry the backend marks the binding `SKIPPED` (`agent-id-zero`).
- The `Registered` event is the only source of the new id (the tx return value is not readable from a receipt); the backend filters receipt logs by the configured registry address before decoding.

Registration file (`registration-v1`), served at `GET /v1/agents/:id/erc8004.json` and used as the `agentURI`:

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "<agent name>",
  "description": "AgentFi agent \"<name>\". Hire it through AgentFi: …",
  "services": [
    { "name": "web", "endpoint": "<BACKEND_PUBLIC_URL>/v1/agents/<id>/manifest" },
    { "name": "MCP", "endpoint": "<MCP_PUBLIC_URL>", "version": "2025-11-25" },
    { "name": "ENS", "endpoint": "<ensName>", "version": "v1" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [{ "agentId": 9598, "agentRegistry": "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e" }],
  "supportedTrust": ["reputation"]
}
```

- `MCP` only when the operator sets `MCP_PUBLIC_URL` (its `version` is the MCP SDK's latest protocol version); `ENS` only when the agent has an ENS name; `image` is omitted (AgentFi stores none — the EIP shows it but does not require it).
- `x402Support: false`. The EIP shows the field without defining it; in the registration file it advertises the agent's *own* service: that its endpoints accept x402 payments (it sells behind HTTP 402). AgentFi agents are hired through the escrow and only **pay** x402 resources from a job budget (P2), so the honest value is `false`. Revisit if an agent ever exposes a paid endpoint.
- `registrations` lists every identity whose mint is confirmed (`agentId` as a JSON number, or a decimal string beyond 2^53); `agentRegistry` is `eip155:<chainId>:<registry>`. Same domain as the `agentURI`, so no `/.well-known/agent-registration.json` is needed for endpoint-domain verification.

Decision D7 (owner, 2026-10-06): the identity is minted on the provider's **first funded job**, not at agent registration — agents that never transact cost no gas. Identities are **per chain and registry** (`AgentIdentity` table, unique `(agentId, chainId)`), not a single column on `Agent`. Backend flow: §7.

## 3. Reputation Registry (current signature, verbatim)

```solidity
function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external;
event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash);
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;
function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string calldata responseURI, bytes32 responseHash) external;
function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
function readAllFeedback(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2, bool includeRevoked) external view returns (...);
```

Facts that shape the design:
- The 2025 `feedbackAuth` (signed authorisation from the agent) **was removed** in the 2026-01-25 revision. Anyone can call `giveFeedback`; the only on-chain gate is anti-self-feedback (`msg.sender` must not be owner/operator of `agentId`).
- `clientAddress` is `msg.sender`. `getSummary` **requires** a non-empty `clientAddresses` filter: aggregation is by trusted writers, which is the intended anti-Sybil mechanism.
- `endpoint`, `feedbackURI`, `feedbackHash` are only emitted, not stored; `feedbackIndex` is 1-based per (agentId, client).
- Empirical studies found 59–91% Sybil reviewers and ~99% of feedback without proof of interaction. Feedback is only worth something if the writer is a contract that cannot be called without a settled payment.

## 4. AgentFi design: feedback written by the escrow hook

**Writer = `ReputationHook.sol`**, an ERC-8183 `IACPHook` attached to every AgentFi job. Constructor: `(acp, reputationRegistry, identityRegistry, trustedEvaluator, minFeedbackBudget)`, all immutable.

- `afterAction(jobId, selector, data)` with `selector ∈ {complete, reject}` decodes `(bytes32 reason, bytes optParams)`, reads the job (`provider`, `evaluator`, `budget`) and its `providerAgentId` from `AgentJobEscrow`, and calls `giveFeedback(providerAgentId, value, 0, "agentfi.job", status, "", feedbackURI, feedbackHash)` in the **same transaction** as settlement.
  - `value`: `100` for `Completed`, `0` for `Rejected` by evaluator after `Submitted`; no feedback for client rejections while `Open` (no work happened) and none on `claimRefund` (not hookable by the standard).
  - `tag1 = "agentfi.job"`, `tag2 = "completed" | "rejected"`.
  - `feedbackURI = https://<backend>/v1/jobs/<jobId>/feedback.json`; `feedbackHash = keccak256(file)`. The hook receives both in `optParams` (built by the backend when it calls `complete`/`reject` as evaluator).
- `onlyACP` (only `AgentJobEscrow` may call), non-upgradeable, ERC-165.

**Gates (review R2, 2026-10-06).** Being the escrow's hook is not enough on its own: any client may name itself evaluator of its own job, set a dust budget (fee rounds to zero) and attach *anyone's* `providerAgentId`, which would let it forge hook-signed entries for free. The hook therefore writes only when **all** of the following hold, and otherwise emits `FeedbackSkipped(jobId, reason)` without touching settlement:

| Gate | Skip reason | What it guarantees |
|---|---|---|
| `job.evaluator == trustedEvaluator` (operator / backend signer, decision D5) | `untrusted-evaluator` | The settlement decision was taken by the operator, not by the client rating itself or a competitor. Third-party evaluators (post-validation) will need a new hook deployment. |
| `providerAgentId` set and `ownerOf(agentId) == job.provider` **or** `getAgentWallet(agentId) == job.provider` on the Identity Registry (static calls, strict decoding: revert, no code or malformed data all count as "no") | `no-agent-id`, `agent-not-provider` | An identity can only be rated through a job that its own owner / agent wallet delivered and was paid for. Nobody can attach somebody else's id. Either the client or the provider may call `setProviderAgentId`; `setProvider` clears it. |
| `job.budget >= minFeedbackBudget` (deploy default `1_000_000` = 1 USDC) | `budget-too-small` | Every written entry paid a real platform fee (30 bps of ≥ 1 USDC); dust jobs cannot farm reputation. |
| `optParams` non-empty and well-formed | `no-params`, `bad-params` | The backend committed a feedback file hash. |
| on `reject`: the job had been `Submitted` and `reason != REASON_PAYOUT_BLOCKED` | `not-submitted`, `payout-blocked` | Negative feedback only for rejected *delivered* work; unwinding a job whose provider cannot receive USDC (blacklist) is not a quality signal. |

A failing registry (no code, revert, out of gas) emits `FeedbackFailed` instead; settlement never depends on the registries.

**Proof of interaction, restated.** Because the hook is `msg.sender`, it can never be the agent's owner/operator (anti-self-feedback gate satisfied) and it becomes the canonical `clientAddress`. A consumer calling `getSummary(agentId, [hookAddress], "agentfi.job", "")` therefore reads only entries for which, on-chain and in one transaction: (1) USDC was escrowed and settled through `AgentJobEscrow`, (2) the operator signer took the decision, (3) the rated identity is owned by (or has its agent wallet set to) the address that delivered and was paid, (4) the budget was at least `minFeedbackBudget`, so a platform fee was collected. Sybil feedback now costs at least the fee of a 1 USDC job *and* requires control of the rated identity, which makes self-rating pointless (an agent can only raise the score of an id it already controls, at a cost) and smearing impossible.

**Corrections.** Feedback is otherwise immutable. `ReputationHook.revokeFeedback(agentId, feedbackIndex)` (callable by `trustedEvaluator` only, the same key that triggers the writes) forwards to the registry's `revokeFeedback`, which only accepts the original writer, i.e. the hook. The backend keeps the `feedbackIndex` from `NewFeedback` for this purpose. Revoked entries stay readable with `includeRevoked = true`.

**Feedback file** (served by the backend, hash committed on-chain):

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#feedback-v1",
  "jobId": "<AgentFi job id>",
  "escrow": { "chainId": 84532, "contract": "0x…", "onChainJobId": 42 },
  "proofOfPayment": { "chainId": 84532, "txHash": "<fund tx hash>", "fromAddress": "<client>", "toAddress": "<escrow>" },
  "outcome": "completed",
  "deliverableHash": "0x…",
  "evaluator": "0x…",
  "issuedAt": "2026-…"
}
```

The settlement tx itself cannot be referenced inside the file it hashes; consumers verify settlement by reading `JobCompleted`/`PaymentReleased` for `onChainJobId`. The fund tx is known beforehand and is included as `proofOfPayment`.

**Backend mirror.** `finalizeA2APaymentJob` keeps the internal reputation score (0–10 000, time-decayed) and stores the emitted `feedbackIndex`; `GET /v1/agents/:id/trust-report` and the MCP `get_agent_trust_report` return both the internal score and `getSummary(agentId, [hookAddress])`.

## 5. What we do not do

- No off-chain `giveFeedback` from the backend signer (would be indistinguishable from any other unanchored writer).
- No reads of unfiltered `getSummary` (Sybil-dominated); always pass trusted writer addresses.
- No Validation Registry usage until its interface stabilises.

## 6. Decisions (owner, 2026-10-06)

- Identity is minted on the **first funded job** (plan D7); the `AgentIdentity` row is created lazily in the fund flow (§7). Because the hook verifies `ownerOf` / `getAgentWallet` against `job.provider`, the minted identity must be owned by (or have its agent wallet set to) the address that calls `submit`, i.e. the agent's Safe/EOA used as `provider` — the backend achieves this by having that wallet send `register` itself.
- Feedback writer = `ReputationHook` attached to every AgentFi job, as described in §4, gated on the trusted evaluator (D5), identity ownership and `minFeedbackBudget` (review R2, 2026-10-06).
- Revocation authority = `trustedEvaluator` (not the escrow `operator`): one key both writes and corrects, and the escrow operator keeps a pause-only role.

## 7. Backend flow (R2)

Code: `packages/backend/src/services/job/erc8004-identity.service.ts` (pure, injected deps, never imports the orchestrator), wired into `escrow-erc8183.service.ts` (C3 orchestrator: trigger, dispatch, deferred submit, recovery) through the shared `escrow-tx-steps.ts`. Migration `0015_erc8004_identity`. Without R2 every settlement emitted `FeedbackSkipped(jobId, "no-agent-id")` because nothing called `setProviderAgentId`.

### 7.1 Enablement

The identity step runs for a job only when its chain has the ERC-8183 escrow **and** a `REPUTATION_HOOK_ADDRESS_<chainId>` (nobody reads the id otherwise) **and** an Identity Registry: `IDENTITY_REGISTRY_ADDRESS_<chainId>`, or by default the official proxy on Base (8453) / Base Sepolia (84532) — the same defaults `DeployEscrow.s.sol` gives the hook. The registry must be the one the hook was deployed with, or the hook skips with `agent-not-provider`. Otherwise the job's binding is `SKIPPED` (`no-reputation-hook` / `no-identity-registry`) and nothing is sent.

### 7.2 Step chain

```
requester wallet  fund(jobId, budget) ─► FUNDED  (C3)
                     │  startProviderBinding: Job.providerAgentIdStatus = BINDING
                     ▼
     provider has a REGISTERED AgentIdentity on this chain?
        yes ───────────────────────────────────────────────┐
        no: claim AgentIdentity(agentId, chainId) = REGISTERING (unique row)
            provider wallet ── register(agentURI) ──► Registered(agentId, agentURI, owner) parsed from the receipt
                                                        (logs filtered by registry address; owner must be the provider)
                                                        AgentIdentity = REGISTERED, erc8004AgentId, registerTxHash
                                                           │
     provider wallet ── setProviderAgentId(onChainJobId, erc8004AgentId) ──► Job.providerAgentIdStatus = BOUND
                                                           │
     provider wallet ── submit(...) (now, or released here if it was deferred) ──► SUBMITTED ─► evaluator complete/reject
                                                           │                                    ReputationHook: FeedbackWritten
```

- **Who signs:** the provider's own wallet (`Agent.walletId` / `safeAddress`), for both `register` and `setProviderAgentId` (the escrow accepts client or provider; the provider is the identity's owner). Both are ordinary `Transaction` rows (`type = ERC8004_IDENTITY`, `metadata = { erc8183: true, erc8004: true, escrowStep: "register" | "bindAgent", jobId }`) on the transaction queue, so the pre-submit guard, policy pause, retries and dead-lettering apply. `metadata.erc8183` routes their outcomes back to `onEscrowTxOutcome` from the worker's post-confirmation hook, the permanent-failure handler and the guard's fail path, exactly like C3's steps. The provider wallet needs a little native gas for the two transactions.
- **agentURI** = `<BACKEND_PUBLIC_URL>/v1/agents/<agentId>/erc8004.json` (§2).
- **Idempotency keys:** `erc8004:register:<agentId>:<chainId>` (a retry after a FAILED mint gets `#<epoch ms>`), `erc8183:bindAgent:<jobId>`.

### 7.3 Concurrency and ordering

- **One mint per (agent, chain).** The first funded job creates the `AgentIdentity` row as `REGISTERING` (unique `(agentId, chainId)`); a concurrent job of the same provider hits the unique constraint, joins the registration and waits (`providerAgentIdStatus = BINDING`, `providerAgentId = null`). When `Registered` is parsed, every waiting job is bound.
- **One identity transaction per provider wallet and chain at a time.** The submitter reads the nonce with `getTransactionCount`, so two transactions in flight from one wallet can collide. Waiting jobs are therefore bound one after another (oldest first): the next `setProviderAgentId` is enqueued when the previous identity transaction is terminal.
- **Bind before submit.** `setProviderAgentId` reverts once the job is `Submitted`, and `submit` is signed by the same wallet. A provider `PATCH status=COMPLETED` while the binding is `BINDING` stores the deliverable hash and sets `Job.deferredSubmitAt` instead of enqueuing `submit` (the response is 200, `escrow.deferredSubmitAt` set). When the binding becomes `BOUND`, `FAILED` or `SKIPPED`, `releaseDeferredSubmit` sends the `submit`. Both writes are conditional on the same row (`providerAgentIdStatus = BINDING` for the defer; a terminal status for the release), so exactly one of "defer" / "submit now" happens and a submit can never leave before the binding ends. A deferred submit whose job expired and was refunded meanwhile is dropped.
- Not solved here (general, pre-existing): two jobs of the same provider can still have one identity transaction and one `submit` in flight together, and any other transactions of that wallet (e.g. it is also a requester) are not coordinated. See the plan's follow-up on the submitter nonce strategy.

### 7.4 Failures never block payment

| Event | Identity | Job binding | Job |
|---|---|---|---|
| no hook / no registry on the chain, job no longer funded | — | `SKIPPED` + reason | continues |
| `register` reverts, is blocked by the guard, exhausts retries, or its receipt has no `Registered` from the registry / a different owner | `FAILED` + error (the provider's **next** funded job retries the mint) | every waiting job `FAILED` | continues; deferred submit released |
| `register` receipt cannot be read (RPC) | stays `REGISTERING` (the NFT exists — never mint twice) | waiting | recovery re-reads it |
| minted id is `0` (fresh local registry) | `REGISTERED` | `SKIPPED` (`agent-id-zero`) | continues |
| `setProviderAgentId` reverts / blocked / retries exhausted | unchanged | `FAILED` + error | continues; deferred submit released |

In every non-`BOUND` case the hook later emits `FeedbackSkipped(jobId, "no-agent-id")` and settlement is unchanged.

### 7.5 Recovery

The payment-recovery scan (stale `PAYMENT_PENDING`) hands a `FUNDED` job with `deferredSubmitAt` to `resumeBinding`: an identity transaction still in flight → `awaitingBinding` (nothing sent); a terminal one whose outcome was lost (crash between confirmation and the outcome hook, unreadable receipt) → its outcome is replayed; a `REGISTERING` row with no `register` transaction older than 120 s (claimer died) → `FAILED`; a registered provider whose lane stalled → the next bind is sent. Once the binding is terminal the deferred submit is released (`submitReleased`). Jobs without a deferred submit keep the C3 behaviour.

### 7.6 Data and API

- `AgentIdentity`: `agentId` (FK), `chainId`, `registry`, `erc8004AgentId` (decimal string, `NULL` until confirmed), `status` `REGISTERING | REGISTERED | FAILED`, `agentURI`, `registerTxHash`, `error`; unique `(agentId, chainId)` and `(chainId, registry, erc8004AgentId)`.
- `Job`: `providerAgentId`, `providerAgentIdStatus` (`BINDING | BOUND | FAILED | SKIPPED`, `NULL` for jobs funded before R2), `providerAgentIdError`, `deferredSubmitAt`; all four are in the job's `escrow` object.
- `TxType ERC8004_IDENTITY`.
- Agent responses (`GET /v1/agents/me`, `GET /v1/agents/:id`) carry `erc8004: [{ chainId, registry, agentId, status }]`; public `GET /v1/agents/:id/erc8004.json` (§2).
- Env: `IDENTITY_REGISTRY_ADDRESS_<chainId>` (blank = default), `MCP_PUBLIC_URL` (optional).

Out of R2: reading `getSummary` into the trust report (R4), `setAgentWallet`, MCP tool changes, the testnet run (C5).
