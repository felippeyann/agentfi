# ERC-8004 (Trustless Agents) — integration design

> Draft for owner review (task R1 of the [execution plan](../project/execution-plan-2026-10.md)). Written 2026-10-06 from the EIP text (last revision 2026-01-25) and the official contracts repository. ERC-8004 is a **Draft** EIP; the Validation Registry is still being revised with the TEE community and is out of scope here.

Sources: [eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004) · [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) · `agent0-sdk` ([agent0lab/agent0-ts](https://github.com/agent0lab/agent0-ts)) · arXiv 2606.26028 (empirical study of Sybil feedback).

## 1. Registries and addresses

| Registry | Ethereum mainnet / Base (8453) | Sepolia / Base Sepolia (84532) |
|---|---|---|
| Identity (ERC-721) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Validation | not listed in the README (unverified) | not listed |

CREATE2 deterministic addresses, UUPS proxies. Verify on Basescan before first use and pin the implementation hash in `config/contracts.ts`.

## 2. Identity Registry (what AgentFi writes)

```solidity
function register(string agentURI) external returns (uint256 agentId);
function setAgentURI(uint256 agentId, string calldata newURI) external;
function setMetadata(uint256 agentId, string memory key, bytes memory value) external;
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
```

Registration file (served by the backend at `GET /v1/agents/:id/erc8004.json`, `type: https://eips.ethereum.org/EIPS/eip-8004#registration-v1`): `name`, `description`, `image`, `services[]` (AgentFi manifest endpoint as `web`, the MCP endpoint as `MCP`, ENS name when present), `x402Support: true` once WS4 ships, `active`, `registrations[{agentId, agentRegistry: "eip155:8453:0x8004A169…"}]`, `supportedTrust: ["reputation"]`.

Proposal (plan §5.3): register on **opt-in or first funded job**, not at every registration, to avoid paying an ERC-721 mint for agents that never transact. Store `erc8004AgentId` on `Agent` (migration 0015). Owner of the NFT = the agent's Safe; `setAgentWallet` points to the same Safe.

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

- Identity is minted on the **first funded job** (plan D7); `erc8004AgentId` is set lazily in the fund flow. Because the hook verifies `ownerOf` / `getAgentWallet` against `job.provider`, the minted identity must be owned by (or have its agent wallet set to) the address that calls `submit`, i.e. the agent's Safe/EOA used as `provider`.
- Feedback writer = `ReputationHook` attached to every AgentFi job, as described in §4, gated on the trusted evaluator (D5), identity ownership and `minFeedbackBudget` (review R2, 2026-10-06).
- Revocation authority = `trustedEvaluator` (not the escrow `operator`): one key both writes and corrects, and the escrow operator keeps a pause-only role.
