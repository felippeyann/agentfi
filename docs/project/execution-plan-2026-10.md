# Execution Plan — AgentFi reactivation (Q4 2026)

> **Live document.** This is the single source of truth for what is being done, in what order, and why, during the 90-day exploratory reactivation that started on 2026-10-06. Update the status columns as PRs merge. Background: [reactivation-2026-10.md](reactivation-2026-10.md) (review) and [market-signals-2026-10.md](market-signals-2026-10.md) (evidence). Both are in Portuguese; this plan is in English because it is the operational document for the repository and for coding agents.

**Last updated:** 2026-10-06 · **Phase:** Week 0 (housekeeping + safety fixes) · **Go/no-go date:** 2027-01-05

---

## 0. Decisions locked on 2026-10-06 (owner)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Positioning: trust layer, not wallet.** AgentFi = ERC-8183-compatible escrow + ERC-8004 reputation anchored in settled payments + MCP execution surface, running on top of third-party wallets and rails. | Generic spending-limit features are not extended. Wallet providers become adapters (Turnkey stays; CDP added; local for dev). |
| D2 | **Adopt the current Solidity source (Action struct with `token`) and redeploy.** Base Sepolia first (test gas), Base mainnet later with the owner's deployer key. | Backend ABI updated (A1). Existing Base/Base Sepolia deployments are legacy and must not be routed through. Addresses in STATE.md change after redeploy. |
| D3 | **README banner → "Reactivated (exploratory)" now.** The postmortem stays, collapsed. | Public signal; also lets us resubmit directory listings. |
| D4 | **Credentials the owner will put in local `.env`:** Base Sepolia deployer key with test ETH, Alchemy (Base + Base Sepolia), Turnkey, Tenderly. | Real-chain testnet flows are in scope. Values are never pasted in chat; the owner edits `.env`. |
| A1 | **Assumption (not a decision, flagged):** for the 90 days AgentFi stays **software only**: no custody by the maintainer, no fiat, no BRL on/off-ramp, no hosted production instance. This keeps it outside the PSAV/eFX perimeter of BCB Resolutions 519/520/561. The owner must revisit this before any hosted or custodial offering. | Nothing in this plan builds a hosted service or touches fiat. |

---

## 1. Goal and gates

**Goal (90 days):** prove, with one external operator, that "agents hiring agents with escrow + reputation + MCP" solves a real problem, on Base, with standards-compliant primitives, and that the repository is safe to point people at.

**Gates (checked on 2027-01-05):**

| Gate | Threshold | Evidence |
|---|---|---|
| G1 Safety | A1, A2, A3, S1 merged; `forge test`, backend unit tests and dev smoke green; no known P1 | CI + this file |
| G2 Standards | `EscrowModule` v2 passes an ERC-8183 conformance test; ERC-8004 feedback written on Base Sepolia from a settled job | Tx hashes in `docs/project/testnet-log.md` |
| G3 Demo | 3-minute screencast of Claude Code hiring an agent through AgentFi MCP with on-chain escrow and reputation | Link in README |
| G4 Demand | ≥ 3 operator interviews done; ≥ 2 report the same recurring problem with a concrete example; ≥ 1 operator runs the flow with their own funds (testnet acceptable) | `docs/project/interviews/` (anonymised) |
| G5 Signal | ≥ 10 escrow-settled jobs not created by the maintainer; ≥ 1 unsolicited feature request or issue from outside | GitHub + chain |

If G4 fails, stop development and return to archive (with a much better codebase). If G1–G3 pass but G5 is thin, extend validation by 30 days once, then decide.

---

## 2. Workstreams and tasks

Status legend: `todo` · `in-progress` · `pr` (open PR) · `done` · `blocked (reason)` · `owner` (only the owner can do it).

### WS0 — Housekeeping (Week 0)

| ID | Task | Status | Notes / PR |
|---|---|---|---|
| H1 | Unarchive GitHub repo | done | 2026-10-06, via owner account |
| H2 | Sync `package-lock.json` (npm ci was failing since May) | done | [#120](https://github.com/felippeyann/agentfi/pull/120) merged |
| H3 | Delete merged remote branches; sync `develop` mirror | done | 6 branches deleted; `develop` = `main` |
| H4 | Dependabot triage: merge patch/minor when green; majors become tasks (WS8) | in-progress | #126 merged; #108/109/111/112/121/122 rebased, merge when green |
| H5 | Fix `.claude/launch.json` (paths from previous machine) | done | relative paths |
| H6 | Move architecture PNGs to `docs/architecture/diagrams/`, reference from overview | done | |
| H7 | Remove empty worktree leftovers (`~/agentfi-fix-*`, `~/agentfi-gmx`, `~/agentfi-phase2-snapshots`) | done | local only |
| H8 | Install Foundry (1.7.1) and graphify on this machine; `forge test` = 100/100 | done | `~/.foundry/bin`; `%APPDATA%\Python\Python314\Scripts` |
| H9 | README banner → Reactivated (exploratory) | pr | docs PR |
| H10 | Rewrite HANDOFF §3 and roadmap to point here; fix STATE header; remove contradictions (D1 in review) | pr | docs PR |
| H11 | `graphify update .` after code PRs merge | todo | end of Week 0 |

### WS1 — Correctness and safety fixes (Week 0–1)

| ID | Task | Acceptance | Status | PR |
|---|---|---|---|---|
| A1 | Backend `AgentExecutor` ABI = Solidity source (`token` field); remove hard-coded legacy Sepolia addresses; mark mainnet addresses legacy | selector test `0x672093df`/`0x596e8b81`; typecheck; docs note | in-progress (agent) | |
| A2 | No mock simulation in production: `eth_call`/`estimateGas` fallback when Tenderly absent; routes reject `_isMock` in prod | 4 unit tests; smoke:dev still green | in-progress (agent) | |
| A3 | Worker re-validates agent/policy/tx status before signing; pause route stops claiming on-chain pause and can return `emergencyPause` calldata | 5 unit tests | in-progress (agent) | |
| S1 | Agent may only tighten its own policy; loosening requires operator credential; MCP tool description updated; OpenAPI updated | unit tests for each loosening rule; spec:check green | in-progress (agent) | |
| S2 | MCP tools: add `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) to all 31 tools; sanitize upstream errors (keep validation messages, strip internal URLs/secrets, add trace id) | tools/list shows annotations; unit test for error sanitizer | todo | |
| A5 | Fee model decision: either collect fee on ERC-20 flows (executor pulls fee in token) or document that fee applies to ETH-value flows only; align `FEE_BPS` with tiers | decision recorded here + code/docs aligned | todo (needs owner input on fee design) | |
| A4 | P&L: rename `profitable` semantics to on-chain margin; add optional `externalCostsUsd` input (inference/hosting) so breakeven can include them | tests; API doc | todo (after WS3) | |
| S3 | Delete legacy x402 v0.1 middleware (`requirePayment`, nonce replay) — superseded by WS4 | removed + CHANGELOG | todo | |

### WS2 — Contracts: ERC-8183 compatible escrow and redeploy (Days 1–30)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| C1 | `docs/architecture/erc-8183-mapping.md`: AgentFi `Job` lifecycle mapped onto the **published** ERC-8183 text (2026-03-13 revision): `Open → Funded → Submitted → Completed/Rejected/Expired`, roles client/provider/evaluator, hooks, data encoding, and the known inconsistencies between prose and embedded contract (`fund(jobId, expectedBudget, optParams)` wins). Evaluator default = the operator backend signer (open question §5.1) | drafted 2026-10-06; owner review | pr (docs PR) |
| C2 | `AgentJobEscrow.sol`: implements the published ERC-8183 interface (`createJob/setProvider/setBudget/fund/submit/complete/reject/claimRefund/getJob`, events, `IACPHook` before/after on the six hookable actions, `platformFeeBP` optional). **ERC-20 only (USDC first), as the standard requires**; native ETH jobs keep using the legacy `EscrowModule` until retired. Store `providerAgentId` (ERC-8004) per job as in the revised draft so outcomes attribute to an on-chain identity. Operator emergency path kept outside the standard surface | Foundry tests incl. fuzz; conformance test exercising every valid/invalid transition; 100% of critical functions | todo |
| C3 | Backend `escrow-onchain.service.ts` + `payment-finalizer.service.ts` speak the v2 interface; DB `Job` gains `onChainJobId`, `evaluator`, `budgetToken`, `budgetAmount`, `expiresAt` (migration 0014) | unit tests with mocked Prisma; smoke:dev green (no contract) | todo |
| C4 | Deploy `AgentPolicyModule`, `AgentExecutor` (new ABI), `AgentJobEscrow` on **Base Sepolia**; verify on Basescan; run `scripts/verify-deployment.sh`; record addresses in STATE.md and `docs/project/testnet-log.md` | addresses + tx hashes logged | owner (deployer key) + agent prepares the command |
| C5 | E2E on Base Sepolia: register two agents (local wallet provider is fine), create job with USDC budget, fund escrow, provider submits, evaluator completes, funds released; failure path refunds | script under `examples/escrow-erc8183/` runs end-to-end against testnet | todo |
| C6 | Base mainnet redeploy | owner decision after C5; gas cost noted | owner |

### WS3 — Reputation: ERC-8004 anchored in settled escrow (Days 15–45)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| R1 | `docs/architecture/erc-8004-integration.md`: registries and addresses on Base / Base Sepolia (Identity `0x8004A169…a432` / `0x8004A818…BD9e`, Reputation `0x8004BAa1…9b63` / `0x8004B663…8713`), current `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` (the 2025 `feedbackAuth` was removed in the 2026-01-25 revision), anti-self-feedback gate, how consumers filter by `clientAddresses`, and the feedback-file format with `proofOfPayment` | drafted 2026-10-06; owner review | pr (docs PR) |
| R2 | Identity: optional registration of an AgentFi agent in the ERC-8004 Identity Registry at creation (`agentURI` → AgentFi registration JSON with `services[]` incl. MCP endpoint, `x402Support`); store `erc8004AgentId` on `Agent` (migration 0015) | unit tests; registration on Base Sepolia logged | todo (opt-in default pending §5.3) |
| R3 | **`ReputationHook.sol`** (ERC-8183 `IACPHook`): on `afterAction` for `complete`/`reject`, call `giveFeedback(providerAgentId, value, 0, "agentfi.job", <status>, "", feedbackURI, keccak256(file))` so the write is atomic with settlement and the hook is the canonical `clientAddress`; backend serves `feedbackURI` (`/v1/jobs/:id/feedback.json`) with `jobId`, escrow contract, chain, fund tx hash. No feedback on `claimRefund` (not hookable). Backend keeps an idempotent off-chain mirror | Foundry tests for the hook; testnet tx logged | todo |
| R4 | Trust report reads aggregated ERC-8004 reputation alongside AgentFi's internal score; MCP `get_agent_trust_report` exposes both | API + MCP tests | todo |

### WS4 — Payments client: pay for 402 resources inside a job budget (Days 15–45)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| P1 | Add `@x402/core`, `@x402/fetch`, `@x402/evm` (2.28.x line; **not** the legacy `x402-fetch` v1) to the backend; build `services/payments/x402-client.service.ts` using `x402Client.fromConfig` with `spendControls.maxAmountPerPayment` and `allowedNetworks` from the job budget; signer = the agent's wallet provider account (viem `LocalAccount`) | unit tests against a local x402 server with a fake facilitator (reuse the approach from `~/agentfi-lab`) | todo |
| P2 | `POST /v1/jobs/:id/pay-resource` + MCP tool `pay_for_resource`: pays a 402 URL within the job's remaining budget, records a `ResourcePayment` row (migration 0016) with payment id, settlement tx, receipt; uses `payment-identifier` for idempotent retries and verifies `offer-receipt` when the server provides it | tests for: budget exceeded → refused before payment; same id retry → no second payment; receipt mismatch → marked unverified | todo |
| P3 | Facilitator config per chain: CDP facilitator (needs CDP key) for Base; x402.org for Base Sepolia; Circle as optional | env + docs | todo |
| P4 | Optional second dialect: `mppx` `evm` method (Base / Base Sepolia USDC) behind the same tool, feature-flagged | one test | todo (after P2) |
| P5 | Port the durable budget ledger semantics from `~/agentfi-lab/ledger.mjs` (reserve → pending → settled/unknown; no automatic retry on unknown) into the `ResourcePayment` state machine | tests mirroring the 14 lab cases that apply | todo |

### WS5 — Wallet providers as adapters (Days 30–60)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| W1 | Formalize `WalletProvider` interface (createWallet, getAddress, signTransaction, signMessage, signTypedData, healthCheck) and make Turnkey/local implement it; `toViemAccount()` helper | typecheck; existing tests green | todo |
| W2 | `CdpWalletService` using `@coinbase/cdp-sdk` (`getOrCreateAccount` + `toAccount`), env `WALLET_PROVIDER=cdp` with `CDP_API_KEY_ID/SECRET`, `CDP_WALLET_SECRET`; apply a CDP account policy restricting `signEvmTypedData` to USDC and `ethValue` to the agent's `maxValuePerTx` | unit tests with mocked SDK; Base Sepolia faucet flow documented | todo |
| W3 | Document MetaMask Agent Wallet as a **client-side** option (agent brings its own wallet; AgentFi only sees addresses) rather than a server signer | docs | todo |

### WS6 — Demo and distribution (Days 45–60)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| X1 | `examples/escrow-erc8183/`: two-agent flow with real USDC on Base Sepolia (fund → submit → complete → release → ERC-8004 feedback) | runs with documented env | todo |
| X2 | Screencast (3 min): Claude Code + AgentFi MCP: discover, hire, escrow, deliver, settle, reputation, P&L | link in README | owner records; agent prepares script + prompts |
| X3 | Publish `@agent_fi/mcp-server` 0.6.0 (new tools: `pay_for_resource`, ERC-8004 trust fields); update Glama; resubmit awesome-mcp-servers (entry was pruned after archive); fix mcp.so (404) | listings live | todo |
| X4 | Refresh `docs/agents/quickstart.md`, `docs/demos/claude-desktop-mcp.md`, OpenAPI | spec:check green | todo |

### WS7 — Demand validation (owner, Days 1–30, continues)

| ID | Task | Status |
|---|---|---|
| V1 | Three interviews with operators whose agents already spend money (x402 buyers, AWS AgentCore Payments users, Coinbase Agentic Wallet / MetaMask Agent Wallet users with Claude Code). Script: `~/agentfi-notas/2026-09-08-agentfi-revisao-critica.md` §"Próximo experimento". Core question: "when your agent hires another agent or pays an API, how do you know you got what you paid for, and what happens when it goes wrong?" | owner |
| V2 | Log each interview (anonymised) under `docs/project/interviews/` with: problem, frequency, current tool, willingness to test | owner |
| V3 | Decide at Day 30 whether G4 is on track; if two of three say "not a problem", stop WS3–WS6 and reassess | owner |

### WS8 — Dependencies (rolling)

| Bump | Risk | Plan |
|---|---|---|
| `@aave/*` 1.38, `bullmq` 5.76.7, `lucide-react` 1.14, production patch group, GitHub Actions v7 | low | merge when CI green (H4) |
| `@turnkey/sdk-server` 1.7 → 6.0 | high (signing API) | own task after W1; test `signRawPayload` path |
| `prisma` 5.22 → 7.x | high (generator, client API) | own task after migrations 0014–0016 land |
| `typescript` 6 → 7 | medium | own task; check `openapi-typescript` pin |
| `eslint` 8 → 10 | low (lint not wired) | own task: add flat config, wire `npm run lint` |
| `@types/node` 20 → 26, `dotenv-cli` 7 → 11 | low | with the eslint task |

---

## 3. Calendar

| Window | Focus | Exit criteria |
|---|---|---|
| **Week 0** (Oct 6–12) | WS0 complete; WS1 A1/A2/A3/S1 merged; docs PR merged; graph updated | G1 except S2 |
| **Days 1–30** (Oct 13 – Nov 11) | C1–C5 on Base Sepolia; R1; P1–P3; owner: V1–V3 | escrow + payment flows on testnet; Day-30 demand checkpoint |
| **Days 31–60** (Nov 12 – Dec 11) | R2–R4; W1–W2; X1–X4; mcp-server 0.6.0 | G2, G3 |
| **Days 61–90** (Dec 12 – Jan 4) | External operator runs the flow; bug fixes only; C6 if owner wants mainnet | G4, G5 evidence |
| **2027-01-05** | Go/no-go | decision recorded in this file |

---

## 4. Working agreement

- One PR per task ID; branch `<type>/<id>-<slug>`; CI green before merge; `main` stays protected.
- Every PR that changes behaviour adds or updates tests. Backend unit tests use mocked Prisma (see `packages/backend/src/__tests__/policy.service.test.ts`); E2E needs Postgres/Redis/Anvil (`docker compose -f docker-compose.dev.yml`).
- Commit footer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` on AI-assisted commits; PR body footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- "Adoption signal gates code" (HANDOFF §6.1) still applies to anything **not** in this plan.
- Secrets never in chat or in git; `.env` only. Testnet first for anything that signs.
- Update this file's status columns in the same PR that completes a task; keep SESSION_NOTES.md for per-session detail.

---

## 5. Open questions (ask the owner, do not assume)

1. **Evaluator role (C1):** ERC-8183 requires one non-zero evaluator per job, who alone decides after `Submitted`. Default proposed: the operator backend signer (same trust model as today's operator-only release). Alternatives: the requester agent itself (allowed by the standard), or a third evaluator agent later. Which default?
2. **Fee model (A5):** ERC-8183 allows `platformFeeBP` + `evaluatorFeeBP` taken from the budget on `Completed`. Proposed: move the protocol fee to the escrow (`platformFeeBP`, in USDC, on settled jobs) and stop pretending the executor collects fees on ERC-20 flows. Confirm, and pick the bps (current tiers 30/15/5).
3. **ERC-8004 identity (R2):** register every AgentFi agent on-chain at creation (gas per agent, ~ERC-721 mint) or only on opt-in / first job?
4. **Mainnet redeploy (C6):** after C5, redeploy on Base mainnet, and with which fee wallet / operator / evaluator addresses?
5. **Brazil (A1 assumption):** confirm "software only, no custody, no fiat" for the 90 days.
6. **Native ETH jobs (C2):** ERC-8183 is ERC-20 only. Proposed: new jobs are USDC-only; the legacy `EscrowModule` (ETH + ERC-20, operator-settled) stays deployed but is not used for new jobs and is retired at the go/no-go. Confirm.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| ERC-8183 is a draft and may change | Implement behind an adapter; pin the EIP revision date in `erc-8183-mapping.md`; keep AgentFi's internal job model as the stable core |
| ERC-8004 reputation is Sybil-prone | Only write feedback backed by a settlement tx; expose the tx in the feedback payload; read with that filter |
| Demand does not materialise | WS7 runs from Day 1; Day-30 checkpoint can stop WS3–WS6 |
| Competitors (Kite, Agentum, Virtuals ACP v2) ship faster | Differentiate on MCP distribution for Claude/Codex and on proof-anchored reputation; interoperate rather than compete at the standard level |
| Solo-maintainer bandwidth | Tasks are sized for 1–3 days; coding agents run them in parallel worktrees; owner tasks are explicit |

---

## Appendix — Environment on the maintainer's machine (2026-10-06)

- Node 24.14.1 / npm 11.11 (CI uses Node 22; Dockerfiles use node:20-alpine — bump to 22 is part of WS8).
- Docker 29.8.1; `docker compose -f docker-compose.dev.yml up --build -d` → 5 services healthy; `npm run smoke:dev` and the three examples pass.
- Foundry 1.7.1 at `~/.foundry/bin` (`export PATH="$HOME/.foundry/bin:$PATH"` in Git Bash); `forge test` in `packages/contracts` → 100 passed.
- graphify at `%APPDATA%\Python\Python314\Scripts\graphify.exe`.
- `gh` has two accounts: `aawz-felippeyann` (push) and `felippeyann` (owner/admin). Admin actions need `gh auth switch --user felippeyann`.
