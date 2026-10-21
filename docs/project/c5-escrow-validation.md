# C5 — escrow validation on Base Sepolia: plan, runner and acceptance

> Prepared on 2026-10-15 for the owner's approval. **No deploy, funding or transaction has been
> sent to a real network**: on Base Sepolia only read-only RPC calls were made while preparing it
> (chain id, gas price, blocks, the preflight against non-build addresses, the RPC head age; §2).
> The authorisation package to approve is the first section of
> [c4-c5-checklist.md](c4-c5-checklist.md); this file holds the detail behind it. Gate **G2** stays
> pending until the run below is executed and verified on Base Sepolia.

## 1. Scope

| In | Out |
|---|---|
| Base Sepolia (chain 84532) only | mainnet, Base mainnet values, the mainnet contest window (plan §5-9 stays open) |
| `AgentJobEscrow` + `ReputationHook` (ERC-8183 escrow, ERC-8004 feedback) | GMX, swaps, Polygon, vault withdrawals, any other integration |
| two fresh agents (requester, provider) with Turnkey wallets in **EOA mode** | Safe mode (refused, D19), the policy module / executor path (not exercised by escrow jobs) |
| faucet funds only | any ordinary outflow: both agents keep `maxOutflowPerTxUsd = null` (D17), so transfers, swaps, deposits and batches are refused |
| contest window **3600 s** (Q6 / D12) | any shorter window: the runner refuses another value outside the fork rehearsal |

Three scenarios:

1. **Completed work** — fund → ERC-8004 bind → submit → the window passes → the evaluator completes: payout to the provider, 30 bps fee kept in the escrow, feedback 100.
2. **Cancellation** — fund → the requester cancels → the evaluator rejects: full refund, no payment, no feedback (`skipped:no-params`).
3. **Contest** — fund → bind → submit → the requester contests → **automatic settlement blocked** past the window → the operator resolves (`refund` + `quality-rejected`): full refund, feedback 0 `rejected`. Neither agent can resolve it (§7.4).

## 2. Baseline

**Candidate commit (updated 2026-10-17):** the merge on `main` of the 2026-10-17 round. Its code
is the local integration branch `rc/2026-10-17` at **`38ddb4f`**; no PR was opened in that round
(no push). Every later commit of the round changes no file under `packages/`. **Gate before C4:**
`git diff 38ddb4f <merged main commit> -- packages` prints nothing; otherwise the rehearsal below
is repeated on the merged commit. The contracts are unchanged since `162cb06` (#182). The deploy,
the backend and the runner all run from that one commit, because S9 accepts only contracts whose
runtime code is this build's (D16).

The previous candidate `e6e93bd` is **superseded**. The round changed the evaluator's settlement
path (C3f items 1, 3, 4 and the review's P3-1 / P3-3), the runner's preflight (the worker's own Q7
report) and, outside the C5 path, the batch, transfer, allowances and `/mcp/sse` routes (A6d, X7,
S12). `git diff --stat e6e93bd 38ddb4f -- packages/contracts` is empty, and so is the migrations
directory: no contract, no migration, no dependency changed.

### 2.1 Rehearsed, candidate and re-checked commits

**Newest candidate: C3h round, code `67ba588`** (local branch `rc/2026-10-21b`, not on `main`). It is `51f00a6` plus the C3h settlement fixes (plan row C3h):
- D1: no backend refund against a recorded `pay`;
- D2: a result is recorded only from its own receipt and this job's event;
- D3: the `provider-unpaid` alert.

Contracts are unchanged (`ddc6936bc680`). Independent review: P3 only (owner note `2026-10-21-revisao-c3h.md`). **No evidence of `51f00a6` or `38ddb4f` is carried over**: everything below ran on `67ba588`, on 2026-10-21, locally.

| Evidence on `67ba588` | Result |
|---|---|
| backend unit | 1641 passed / 13 skipped. The first run had 4 `agent.search` failures, because the suite ran before its database was migrated (a script-order issue, not the code); rerun on the migrated database: green |
| real Postgres | 398 / 398 |
| Anvil with real contracts | 65 passed / 3 skipped, incl. the D2 replacement tests |
| E2E | 3 passed / 4 skipped (by design) |
| ERC-8183 fork suite | 7 / 7 |
| **C5 runner end to end** (fork, window 60 s, isolated Redis container and database, ports 8561 / 3171) | preflight all PASS. Completed 37 / 37, contest 39 / 39, cancel 22 / 22, reconcile 16 / 16. **0 wei unexplained**. Alerts: only the expected `contested` one; no `provider-unpaid`, `evaluator-replaced`, `settlement-unproven` or `delivery-held` on the happy, refund or cancel paths |
| Foundry; `contracts:code:check`; typecheck; `spec:lint` / `spec:check`; mcp | 356 / 0 / 2; `ddc6936bc680`; clean; OK (`spec:check` drift = line endings only); 163 |

The runner covers the paths that must stay unchanged. The defects themselves are proven by their own tests: real Postgres for D1 and D3, Anvil with the real escrow for D2. Evidence files are in the owner's notes, `c5-rehearsal-2026-10-21/67ba588-runner/`, with SHA-256 sums and no secret.

**Newer candidate, 2026-10-21 round: code `51f00a6`** (local branch `rc/2026-10-21`, not on `main`). It is `38ddb4f` plus S14 and T2:
- S14: the admin batch sends and records the executor fee through a shared fee helper, also used by the swaps and the agent batch;
- S14: the allowances OpenAPI describes the real response, and a comment was corrected;
- T2: the unit test pass runs on `pool: 'forks'`.

`git diff --name-only 38ddb4f 51f00a6 -- packages` touches no escrow service, C5 runner, contract or migration. Independent review: approved with P3 caveats only (owner note `2026-10-21-revisao-codigo.md`).

| Evidence on `51f00a6` (2026-10-21, local) | Result |
|---|---|
| backend unit (now `forks`) | 1638 passed / 13 skipped (81 files) |
| real Postgres | 388 / 388 |
| Anvil with real contracts | 63 passed / 3 skipped (the admin batch with native value mines; the fee wallet receives F) |
| Foundry; `contracts:code:check`; typecheck; `spec:lint` / `spec:check` | 356 / 0 / 2; `ddc6936bc680`; clean; OK (the `spec:check` drift was line endings only, and the regenerated file is identical) |
| mcp-server | 163 / 163 |
| ERC-8183 fork suite (Base Sepolia fork) | 7 / 7 |
| **C5 runner end to end** (window 60 s, fork mode only, `WALLET_PROVIDER=local`; run of its own, not carried over from `38ddb4f`) | **2026-10-21, on `51f00a6`.** It ran from worktree `rc-1021` at HEAD `8d08150`, whose `packages` tree equals `51f00a6`'s: tree `8e9baab8…` in both, and `git diff 51f00a6 8d08150 -- packages package-lock.json` is empty. Isolated resources: a dedicated Redis container (removed afterwards), a new database, and ports 8560 / 3170. Preflight: all PASS. Completed 37 / 37, contest 39 / 39, cancel 22 / 22, reconcile 16 / 16. USDC moved −2.0 / +1.994 / +0.006 with exactly 6 transfers. Fee wallet: 0. Gas: **0 wei unexplained** per wallet. `getSummary` (1, 100) `completed` and (1, 0) `rejected` |

On a local fork, both candidates now have the full evidence: `38ddb4f` (runner on 2026-10-18) and `51f00a6` (runner on 2026-10-21). The owner chooses which one C4 deploys from. Evidence files live in the owner's notes, in `c5-rehearsal-2026-10-21/51f00a6-runner/`: logs, evidence JSON, the harness used and SHA-256 sums; no secret is kept.

**Current candidate, code `38ddb4f`** (local branch `rc/2026-10-17`; later commits touch no file under `packages/` — `git diff 38ddb4f HEAD -- packages package-lock.json` is empty, re-checked 2026-10-21). Every row below ran on a **local** machine or a **local Anvil fork**: none is a Base Sepolia transaction, none uses Turnkey, none counts for G2.

| Evidence | Code it ran | Date | Result | Kept at (owner notes, not the repository) |
|---|---|---|---|---|
| backend unit, real Postgres, Anvil with real contracts, mcp-server, typecheck | `38ddb4f` | 2026-10-17 (orchestrator, and again by the independent reviewer in a separate worktree) | unit 1624 passed / 13 skipped; Postgres 388 / 388; Anvil 55 passed / 3 skipped; mcp 163 / 163; clean | round note `2026-10-17-retomada-validacao.md`, review `2026-10-17-revisao-independente.md` |
| Foundry, `contracts:code:check`, `spec:check` / `spec:lint` | `38ddb4f` | 2026-10-17; `contracts:code:check` again on 2026-10-18 | 356 passed / 0 failed / 2 skipped; `ddc6936bc680`; OK | same |
| ERC-8183 fork suite (`npm run test:e2e:escrow-fork`, block 47 822 000) | `6e03bf2`, then **`38ddb4f`** | 2026-10-17; **2026-10-21** | 7 / 7 both times (the escrow service changed between the two: the C3f review P3s) | `c5-rehearsal-2026-10-17/`, `c5-rehearsal-2026-10-21/38ddb4f-fork-suite.log` |
| C5 runner end to end, window 60 s (fork mode only), `WALLET_PROVIDER=local` | `38ddb4f` (worktree at `a18f620` + an untracked harness, archived) | 2026-10-18 (checked 2026-10-19 and 2026-10-21) | preflight all PASS; completed 37 / 37, contest 39 / 39, cancel 22 / 22, reconcile 16 / 16; USDC −2.0 / +1.994 / +0.006, 6 transfers, nonces 12 / 6 / 3, **0 wei unexplained** per wallet — identical to the `75796fb` / `cc0bb90` references | `c5-rehearsal-2026-10-18/` (logs, evidence JSON, `harness/` with instructions and SHA-256 sums) |
| Runner refusals: second `setup`, `fund` after the snapshot; the `worker` field on a fork | `38ddb4f` | 2026-10-17 (rehearsal kit; it then stopped on a bug in the kit itself, not in the code) | both refused with `STOP` as designed; `worker` = `missing` (API and worker in one process on a fork — why the preflight check applies to the real run only) | `C:\Users\AAWZ 360\agentfi-c5-rehearsal\runs\38ddb4f-20261017-111752\` |
| Runner lock (a second runner on a scenario), interruption and adoption by the outbox tag | `75796fb` / `e5ae120` (historical, §8) | 2026-10-15 | as in §8 | runner code unchanged in those paths since: `git diff e6e93bd 38ddb4f -- packages/backend/src/scripts/c5` is only the additive worker check `2a3e9c2` |

The evidence JSON files do not record the code SHA: the link to `38ddb4f` comes from where the run happened and the Git state checked afterwards. Not covered by any row: Turnkey, the real 3600 s window, a worker restart during the contest hold, a real network.

Historical 2026-10-15 evidence (the candidate in this table is superseded by §2):

| Role | Commit | What it means |
|---|---|---|
| fork rehearsal of the runner (§8) | `75796fb` (final run recorded in §8), repeated on `cc0bb90` | the end-to-end run on the Anvil fork; the repeat on `cc0bb90` after the two #189 review fixes gave the same results (round handoff of 2026-10-15; its run files were not kept in the repository) |
| previous candidate for the real run | `e6e93bd` | merge of #189; **same tree as `cc0bb90`** (`git rev-parse cc0bb90^{tree} e6e93bd^{tree}` → both `ce5d0b7d…`), so the second rehearsal ran exactly this code |
| re-checked afterwards | `e6e93bd` | `contracts:code:check` at merge time and again on 2026-10-15 (orchestrated round): `forge build` + `npm run contracts:code:check` → `matches the artifacts (version ddc6936bc680)`; the runtime keccak of all four artifacts equals the table below |

What changed between the rehearsals and the candidate (`git diff --stat 75796fb..e6e93bd -- packages`):
only the runner — `scripts/c5/escrow-validation.ts`, `scripts/c5/plan.ts` and its unit test (+39 / −2):
the preflight rejects an RPC head more than 120 s old on the real network, and a recorded failed
authority check stops `run contest` and blocks `resolve`. No contract (`git diff 162cb06..e6e93bd --
packages/contracts` is empty), no other backend source, no database migration.

**Build** (Foundry 1.7.1, `packages/contracts/foundry.toml`): solc 0.8.24, optimizer 200 runs,
`via_ir = false`, `bytecode_hash = "none"`, `cbor_metadata = false`. Embedded expected code
version `ddc6936bc680adbddc474d63216850b5d936ec0d6ef68896e18aed6220dfbe1d`
(`packages/backend/src/abi/contract-code.generated.ts`). Runtime artifacts as compiled
(immutables still zero; the deployed code differs only in the masked immutable ranges):

| Contract | Runtime bytes | keccak256(runtime artifact) |
|---|---|---|
| `AgentJobEscrow` | 9 727 | `0xe9366fa6afb602a041eef94caf59bcde4814d48deb2b4b71a64799b32ef389be` |
| `ReputationHook` | 6 721 | `0xcbe9fd3373234938558b3b6ef6e65805eb7ed4bf6ab1bc1fe224173e1971f54a` |
| `AgentPolicyModule` | 4 524 | `0x69c8e21ab54bbd99c3d9c57ed26c28863bd31f4e6c1c2aecf62e270ffb6af3f5` |
| `AgentExecutor` | 3 733 | `0xc905f47e00e83eb7a611047ac5b5b72f9ae872431a110aea623318dab11d0acc` |

Check on the candidate: `cd packages/contracts && forge build && cd ../.. && npm run contracts:code:check`
→ `matches the artifacts (version ddc6936bc680)`.

### Historical evidence by class (2026-10-15)

| Class | What | Commit / layer | Result |
|---|---|---|---|
| executed | GitHub CI | `812efa6`, runs 38650330404 (push) and 38726056792 (schedule) | 8/8 jobs green — see the E2E note below |
| executed | backend unit suite | branch, `e5ae120` | 1 596 passed, 13 skipped (the opt-in fork suites), 80 files; typecheck clean |
| executed | runner plan + admin route unit tests | `75796fb` | 20 and 10 passed |
| executed | ERC-8183 fork suite incl. the new authority test | `e5ae120` (test code as committed), Anvil fork of Base Sepolia, block 47 822 000, local wallets | **7 / 7** |
| executed | the runner end to end (§8) | `75796fb`, repeated on `cc0bb90` (= the candidate's tree); same fork, window 60 s (fork mode only) | every scenario PASS, reconcile PASS, both times |
| executed | GitHub CI of the PR head | `cc0bb90` | green, `CLEAN` before the merge |
| executed | re-check of the candidate | `e6e93bd`, local build, 2026-10-15 | `contracts:code:check` OK (`ddc6936bc680`); runtime keccak 4 / 4 = the table above |
| executed | both deploy scripts as the runbook runs them | Anvil fork of Base Sepolia at block 48 149 958 | gas below (§4.4); `verify-deployment.sh` 5 / 5 |
| executed | read-only Base Sepolia reads (no signature, nothing broadcast) | public RPC, block 48 149 375; head-age check on `cc0bb90` | chain id 84532, gas price 0.006 gwei (base fee 0.005), L1 data fee 92–9 931 wei per sampled tx; the runner's preflight against non-build addresses answers 18 FAIL and STOP; RPC head 2 s behind the wall clock (PASS, limit 120 s) |
| skipped | any write on the real network | — | no deploy, funding or transaction |
| skipped | Turnkey | — | no credentials on this machine; the rehearsals use `WALLET_PROVIDER=local` |
| skipped | faucets, Etherscan verification, keystore password prompts | — | owner-only steps |
| skipped | the 3600 s window end to end | — | rehearsed with 60 s; 3600 s is enforced and checked by the runner and only the real run exercises it |
| skipped | a backend restart during the contest hold | — | the rehearsal stack runs API and worker in one process with in-memory wallets; it is an optional step of the real run (§6.4) |
| skipped | Foundry fork suites, DB suite on this branch | — | no contract or database code changed; last run on `162cb06`: 14 / 14 and 365 / 365 |
| documented | costs at today's price, faucet steps, recovery procedures | — | §4, §6 |

**The E2E job is green, but that alone does not prove much.** The CI job `E2E Tests` is
`continue-on-error`. On `812efa6` it really passed, and what it runs is
`transaction.e2e.ts` (3 passed); `fork-smoke.e2e.ts` (2) and `testnet.smoke.e2e.ts` (2) are
skipped without a fork URL / testnet secrets, and the ERC-8183 fork suite is not part of CI
at all (it is the opt-in suite above). The scheduled workflow `E2E Testnet Smoke` is green
because it **skipped**: `E2E_TESTNET_* secrets are not configured`. Neither is testnet
evidence.

## 3. Roles and addresses

### 3.1 Machine inventory (2026-10-15, without printing any secret)

- Node 24.14.1, npm 11.11.0, Git, GitHub CLI, Docker 29.8 + Compose 5.5, OpenSSL 3.5.7,
  Foundry 1.7.1 (`forge`, `cast`, `anvil`); `forge-std` submodule present; dependencies installed.
- **No Foundry keystore** (`~/.foundry/keystores` is empty), **no `.env`** (repository root,
  `packages/backend`, `packages/contracts`), and none of `PRIVATE_KEY`,
  `SAFE_DEPLOYER_PRIVATE_KEY`, `ESCROW_EVALUATOR_PRIVATE_KEY`, `TURNKEY_*`,
  `ETHERSCAN_API_KEY` set in the shell. Both `.env` paths are git-ignored.
- Postgres has no `agentfi_c5` database yet. Redis DB 5 (the runbook's index) holds one stale
  key, `bull:escrow-settlement:meta`: flush it or use an empty index (§6.2).
- The dev stack's API listens on port 3000 (stop it, runbook step 2).

### 3.2 Every address the run uses

No address of this run exists yet. Each is created for this validation, and none is reused
without the owner's explicit decision.

| Role | Created by / how | Signs in the plan | ETH | Reuse |
|---|---|---|---|---|
| **Deployer** | owner: a new key, `cast wallet import c5-deployer --interactive` | the escrow and hook deployments (2 txs; +3 if the policy module / executor are deployed, §9-1) | 0.005 | none on this machine; the May 2026 Base **mainnet** deployer `0x2530…A41b` is not reused for a testnet hot role |
| **Operator** (`OPERATOR_ADDRESS`, escrow `operator()`) | owner: a new key kept in a keystore, not in any `.env` | nothing in the plan (emergency pause, fee-wallet rotation, fee withdrawal only) | 0 | §9-2 |
| **Fee wallet** (`FEE_WALLET`, backend `OPERATOR_FEE_WALLET`) | owner: an address you control | nothing (fees stay in the escrow, §4.1) | 0 | the Base mainnet fee wallet `0xD73d…8646` is not assumed |
| **Evaluator** (`TRUSTED_EVALUATOR`) | owner: `cast wallet new` in your terminal; the key goes only into `packages/backend/.env` | `complete` / `reject`: 3 txs | 0.003 | new |
| **Requester** agent | the runner's `setup` (one Turnkey wallet, EOA) | `createJob`, `setBudget`, `approve`, `fund` per job: 12 txs | 0.002 + 4.5 USDC | new for this run |
| **Provider** agent | the runner's `setup` | ERC-8004 `register` (once), `setProviderAgentId` (≤ 3), `submit` (2): 5–6 txs | 0.002 | new for this run |
| **Backend operator** (holder of `ADMIN_SECRET`, from localhost) | owner | the dispute decision, an API call; the evaluator signs the settlement | — | — |

Never on the real network: the **Anvil test accounts** (public keys; on Base Sepolia they carry
sweeper activity — at the fork block, account 3 had 0 ETH and nonce 771, account 2 held
4.88 USDC) and the **legacy Base Sepolia pair** `0x7714…7203` / `0x1fE2…Fc5d` (not this
build: S9 rejects it, and the runner's preflight answers FAIL on its code).

### 3.3 What only the owner can enter, in a terminal of your own (never in a chat)

1. The deployer key into the keystore (`cast wallet import … --interactive`, password prompt), and the keystore password at each `forge script`.
2. The evaluator key: generated with `cast wallet new`, pasted into `packages/backend/.env` with an editor.
3. The operator and fee-wallet addresses (§9-2).
4. Turnkey (D11): organization id and an API key pair, into `packages/backend/.env`.
5. `API_SECRET` and `ADMIN_SECRET` (`openssl rand -hex 32`, twice) into `packages/backend/.env`.
6. A **valid Alchemy key with Base Sepolia enabled** (`ALCHEMY_API_KEY`): the backend always adds Alchemy as a broadcast / lookup candidate, and a placeholder key makes every "is this transaction known?" answer uncertain (the rehearsal's dummy key produced exactly that error). This is a prerequisite, not optional.
7. The faucet requests (§4.3), and an optional Etherscan API V2 key for `--verify`.
8. The approvals at each gate of §6.

The runner reads the two backend secrets from the `.env` without printing them:
`export C5_OPERATOR_SECRET="$(grep '^API_SECRET=' packages/backend/.env | cut -d= -f2-)"` and the
same for `C5_ADMIN_SECRET` / `ADMIN_SECRET`. The agents' API keys are written by `setup` to
`c5-run/agent-keys.secret.json` (owner-only file in a git-ignored directory) and never printed.

## 4. Financial plan (a proposal for approval — not an authorisation to spend)

### 4.1 USDC (Circle's testnet USDC `0x036C…CF7e`, 6 decimals)

| Scenario | Budget escrowed | To the provider | Platform fee (30 bps) | Back to the requester |
|---|---|---|---|---|
| completed | 2.000000 | 1.994000 | 0.006000 (stays in the escrow, `pendingPlatformFees`) | 0 |
| contest (operator refunds) | 1.500000 | 0 | 0 | 1.500000 |
| cancellation | 1.000000 | 0 | 0 | 1.000000 |
| **run total** | **4.500000** locked at most | **+1.994000** | **+0.006000** | net requester **−2.000000** |

Distinct amounts make every transfer name its scenario. Both feedback scenarios are at least
1 USDC, the hook's `minFeedbackBudget`. The fee is not withdrawn (no transaction from the
operator or the fee wallet); withdrawing it later is a separate act.

### 4.2 Agent policies (registered by `setup`; the preflight re-reads them before every run)

| | Requester | Provider |
|---|---|---|
| `maxValuePerTxUsd` (caps an escrow budget) | `2` | `1` |
| `maxDailyVolumeUsd` (escrow budgets count) | `5` (≥ 4.5; a repeated scenario finds no room and needs a new approval) | `1` |
| `cooldownSeconds` | `0` | `0` |
| `allowedRecipients` | `[provider wallet]`: the requester can only fund jobs for the approved provider | default (empty) |
| `maxOutflowPerTxUsd` | **null**: every ordinary outflow refused | **null** |
| other fields | defaults (`maxValuePerTxEth` 1.0 is moot while the outflow cap is null) | defaults |

### 4.3 ETH (Base Sepolia) and gas

Gas measured on the fork rehearsal (receipts, `c5-run/evidence/*.json` of §8):

| Wallet | Transactions | Gas | At 0.006 gwei | Proposed funding | Runner floor |
|---|---|---|---|---|---|
| requester | createJob 262 577 / 245 477, setBudget 59 130, approve 55 437, fund 97 270 / 80 170 — ×3 | 1 354 842 | ≈ 0.0000081 ETH | **0.002 ETH** | 0.0005, or planned gas × price × 3 |
| provider | ERC-8004 register 200 700, setProviderAgentId 54 450 (×3), submit 122 273 / 86 690 | 573 013 | ≈ 0.0000034 ETH | **0.002 ETH** | 0.0005, idem |
| evaluator | complete 340 302, reject (contest, with feedback) 197 665, reject (cancel) 93 969 | 631 936 | ≈ 0.0000038 ETH | **0.003 ETH** | 0.001, idem (the backend alerts below 0.0005) |
| deployer | escrow 2 209 584 + hook 1 514 835 (+ module 1 032 269, executor 861 826, bind 45 738) | 3 724 419 (5 664 252) | ≈ 0.000022 ETH (0.000034) | **0.005 ETH** | — |

Today's price (0.006 gwei; L1 data fee about 10⁻¹⁴ ETH per tx) leaves a margin of more than
100×; the funding still covers the whole run at about 1 gwei. The runner is stricter on
purpose: it wants 3 × the planned gas at the current price, so with this funding it stops
before a job if Base Sepolia's gas price rises above about 0.4 gwei (the requester's threshold; 0.7 for the provider, 0.8 for the evaluator) —
wait, or top up and re-approve. Faucets: Coinbase Developer
Platform or Alchemy for ETH, `faucet.circle.com` (network Base Sepolia) for USDC. A faucet drip
larger than the proposal stays in the wallet; the policies of §4.2, not the balances, bound
what the agents can move. Total proposed: **0.012 ETH and 4.5 USDC**.

## 5. Stop criteria

The runner stops (exit 2, `STOP: …`) and sends nothing further; the owner decides. A stop is
never followed by a new job: rerunning the same command re-reads the state and adopts the
existing job.

| Condition | Where it is checked |
|---|---|
| **Wrong network**: RPC chain id ≠ 84532; an Anvil fork in `testnet` mode; an RPC head more than 2 minutes behind the wall clock | preflight; contest hold |
| **Configuration not verified**: escrow / hook runtime code ≠ this build; escrow `token`, `platformFeeBP` (30), `evaluatorFeeBP` (0), `operator`, `feeWallet`, `paused`; hook `acp`, `trustedEvaluator`, registries, `minFeedbackBudget`; backend Q7 state not `verified / allowed`; the worker's own Q7 report (`worker` in `GET /admin/escrow/verification`, C3f) not `reported`, `stale`, or without 84532 `verified / allowed` (real run only: the fork rehearsal runs API and worker in one process); backend window ≠ 3600 s; job TTL clamping the window; Turnkey not ready; no admin secret | preflight (before `setup`, `run`, `resolve`) |
| **Unexpected recipient or party**: the job's escrow, evaluator, budget, token or provider ≠ the approved ones; the on-chain job's client / provider / evaluator / hook / budget ≠ the approved; USDC from the escrow to any address other than the two agents; any USDC transfer touching the agents outside the six expected; a transaction from another sender | per job (once funded); settlement checks; reconcile |
| **Insufficient balance**: requester USDC < the scenario budget; any wallet's ETH < max(floor, planned gas × current price × 3) | snapshot; before creating each job; preflight |
| **Event divergence**: missing / extra / wrong settlement events (decision event and reason, payout, fee, refund, `FeedbackWritten` / `FeedbackSkipped` / `NewFeedback`, `FeedbackFailed`); a settlement sooner than 3600 s after `submit`; the contested job settling without the operator; an authority check failing; nonce counts outside the plan; ETH not explained by gas | per scenario (`verify`), contest hold, reconcile |
| **Run integrity**: two jobs tagged for one scenario; an agent's wallet or policy changed; another runner driving the scenario; an escrow `FAILED` / `EXPIRED` | each `run` |

## 6. Execution

### 6.1 C4 — deploy (owner, about 20 minutes)

Checklist §1, from the candidate commit. Recommended scope (§9-1): **`DeployEscrow.s.sol` only**
(escrow + hook, 2 transactions). `Deploy.s.sol` (policy module + executor, 3 transactions) is
not exercised by escrow jobs; deploying it adds unvalidated surface without evidence. If it is
not deployed, leave `POLICY_MODULE_ADDRESS_84532`, `EXECUTOR_ADDRESS_84532` and
`POLICY_OPERATOR_ADDRESS_84532` unset in the backend (the fork rehearsal runs exactly so).

### 6.2 C5 environment (owner, about 15 minutes)

Runbook [testnet-log.md](testnet-log.md) §5.4 steps 1–5, with these choices: an empty Redis
index (`docker compose -f docker-compose.dev.yml exec -T redis redis-cli -n 5 flushdb`, or another
index) and a fresh `agentfi_c5` database; `ESCROW_EVALUATION_DELAY_SECONDS=3600`; the default
`ESCROW_JOB_TTL_SECONDS` (7 days); `SAFE_DEPLOYER_PRIVATE_KEY` empty and unset in every terminal;
a valid Alchemy key (§3.3-6).

### 6.3 The runner (third terminal, `packages/backend`)

```bash
export C5_ESCROW=0x… C5_HOOK=0x…            # C4 copy block
export C5_EVALUATOR=0x… C5_OPERATOR=0x… C5_FEE_WALLET=0x…
export C5_OPERATOR_SECRET="$(grep '^API_SECRET=' .env | cut -d= -f2-)"
export C5_ADMIN_SECRET="$(grep '^ADMIN_SECRET=' .env | cut -d= -f2-)"
npm run c5:escrow -- preflight             # all PASS, or stop
npm run c5:escrow -- setup                 # registers the two agents; prints their addresses and the funding request
#   → fund the two printed addresses from the faucets (§4.3), nothing else
npm run c5:escrow -- snapshot              # baseline: balances, nonces, block
npm run c5:escrow -- run happy             # ≈ 70 min: funding, binding, submit, the hour, complete, acceptance
#   once happy prints binding=BOUND (a few minutes in), in two more terminals:
npm run c5:escrow -- run contest           # ≈ 70 min: … submit, contest, authority checks, held past the hour
npm run c5:escrow -- run cancel            # ≈ 5 min: fund, cancel, reject, acceptance
#   when `run contest` prints HELD:
npm run c5:escrow -- resolve contest       # the operator's decision; settlement; acceptance
npm run c5:escrow -- reconcile             # whole run vs the snapshot; prints the testnet-log rows
```

Every terminal that runs the runner needs the same `export` lines: keep the five address
lines in a file under `c5-run/` (git-ignored) and `source` it, and read the two secrets from
`.env` as shown in each terminal (they are never written anywhere else).

Sequence and duration: C4 about 20 minutes, environment 15, `setup` and faucets 15–30, then the
three scenarios in parallel for about 75–80 minutes (the contest is held 3600 s + 300 s after its
`submit`). About 2 h 30 in total. `npm run c5:escrow -- status` shows every job at any time.

### 6.4 Following the run and recovering from an interruption

- **What to watch**: the runner prints each state change and a line every 5 minutes while
  waiting; the API and worker logs; `GET /health/ready` (`escrowConfig`).
- **Runner interrupted** (Ctrl+C, crash, closed terminal, lost network): rerun the same
  command. It re-reads its scenario file; if the job's answer was lost, it finds the job by the
  run's tag in the requester's outbox and adopts it. Every action is chosen from the job's
  current state, so nothing is repeated (rehearsed: §8). A second runner on the same scenario
  stops at the lock.
- **Backend restarted or unreachable**: the runner only re-reads, with backoff, and acts on
  nothing until the backend answers. The backend resumes from the database and the chain
  (C3c chain truth, re-poll).
- **Optional restart test** (stronger evidence): while `run contest` holds, stop and start the
  worker (terminal B). The job must stay `CONTESTED` / Submitted and nothing may settle.
- **RPC or configuration outage**: new escrow operations answer `503`, queued signatures wait
  (Q7); the runner's preflight stops.
- **A failed identity binding**: the runner stops before `submit` (the feedback would be
  skipped). The job stays funded; deciding it (cancel → refund) is an owner decision.
- **The evaluator key stuck behind an unmined transaction** (C3f item 1, since the 2026-10-17
  round): every later settlement from that key waits behind it, however well it is priced. The
  worker raises one `ESCROW_ALERT evaluator-stuck` after 10 minutes with the same pending nonce,
  naming the earliest `expiresAt` among the live jobs. Nothing is replaced automatically. The
  runner keeps waiting (its hold and timing checks still apply). Unblocking the key (a
  same-nonce replacement signed with the evaluator key) is an owner decision (plan C3g, proposal
  A; A1, a manual operator script with dry-run, is the recommendation and does not exist yet).
  Until it does, stop the run and decide. **Prefer not to replace an evaluator transaction by hand (for example with `cast send --nonce …`) while the worker is running** (plan C3h, D2). Before the C3h fix the worker recorded the job `REJECTED`, or paid, from another transaction's receipt while it stayed Submitted on-chain. Since C3h it records only its own transaction with the event of that job; after a replacement it raises `evaluator-replaced` and reads the job from the chain. But after a manual 0-value cancel the worker will sign the recorded decision again with the next nonce, and a speed-up mined while the worker is stopped records the status but not the fee or feedback (persisting every candidate is A1). After `evaluator-replaced` the job still points at the replaced hash, so contest and resolve answer "pending" until the worker makes a send of its own (C3h review P3-3, closed by A1). Stop the worker first, then reconcile. Mind the deadline: after a job's `expiresAt`,
  `claimRefund` is permissionless and refunds the requester even for delivered work.
- **A settlement send whose answer was lost** (C3f item 3): before signing another settlement,
  the worker asks again about the earlier hash and re-adopts it if it mined or a node knows it,
  so a second `complete` is not sent in the same process (after a worker restart the residual
  remains: plan C3g, proposal C). Only one settlement can ever succeed on-chain.
- **Worst case**: an escrow that nobody settles is refunded to the requester after its 7-day TTL
  by the evaluator's expiry sweep (`claimRefund`).

## 7. Acceptance matrix

`verify <scenario>` checks all of it (read-only, repeatable) and writes
`c5-run/evidence/<scenario>.json`; `reconcile` checks the whole run.

### 7.1 Completed work (budget 2.0 USDC)

| Layer | Expected |
|---|---|
| backend (`GET /v1/jobs/:id`) | `status COMPLETED`; `escrow.onChainStatus COMPLETED`; `platformFeeAmount 6000`; `feedbackStatus written`; `providerAgentIdStatus BOUND`; `resolution null`; `settleTxHash` set |
| contract | `getJob`: status Completed (3), client = requester, provider = provider, evaluator, hook, budget 2 000 000; `providerAgentId(job)` = the bound id |
| settle tx (sent by the evaluator) | `JobCompleted` (reason `keccak256("agentfi.completed")`), `PaymentReleased` 1 994 000 to the provider, `PlatformFeeAccrued` 6 000, USDC `Transfer` escrow → provider 1 994 000 and nothing else, hook `FeedbackWritten(value 100)`, registry `NewFeedback` (client = hook, tag1 `agentfi.job`, tag2 `completed`, value 100) |
| window | settle block time − `submittedAt` ≥ 3600 s |
| ERC-8004 | `ownerOf(id)` = `getAgentWallet(id)` = provider wallet; `tokenURI(id)` = `http://localhost:3000/v1/agents/<provider id>/erc8004.json`; `GET /v1/jobs/:id/feedback.json` 200, its keccak256 = `NewFeedback.feedbackHash`, `outcome completed`, `proofOfPayment.txHash` = the fund tx |
| balances | in reconcile (§7.5) |
| keep | job id, on-chain id, fund / submit / settle tx hashes, the provider's agent id and `register` tx, the feedback file, `evidence/happy.json` |

### 7.2 Cancellation (budget 1.0 USDC)

| Layer | Expected |
|---|---|
| backend | `status CANCELLED`; `escrow.onChainStatus REJECTED`; `feedbackStatus skipped:no-params`; `resolution null` |
| contract | status Rejected (4), budget 1 000 000 |
| settle tx (evaluator) | `JobRejected` (reason `keccak256("agentfi.cancelled")`), `Refunded` 1 000 000 to the requester, USDC escrow → requester 1 000 000 only; no `PaymentReleased`, no `PlatformFeeAccrued`; hook `FeedbackSkipped`; no `NewFeedback` |
| ERC-8004 | no feedback; `feedback.json` answers 404. The provider's `setProviderAgentId` may land before the reject or revert after it (gas only; testnet-log §5.5), and payment is unaffected either way |
| keep | job id, on-chain id, fund and reject tx hashes, `evidence/cancel.json` |

### 7.3 Contest → operator resolution (budget 1.5 USDC)

| Layer | Expected |
|---|---|
| while held | after `POST /contest`: `escrow.onChainStatus CONTESTED`, `status PAYMENT_PENDING`, no settle tx, chain status Submitted — for the whole window and 300 s past it (`submittedAt + 3900 s`), checked on every poll |
| operator | `POST /admin/jobs/:id/resolve {"decision":"refund","verdict":"quality-rejected","note":…}` with `x-admin-secret` from localhost → 202 `{resolution: "quality-rejected", previousOnChainStatus: "CONTESTED", queued: true}` |
| backend after | `status PAYMENT_FAILED`; `onChainStatus REJECTED`; `resolution quality-rejected`; `feedbackStatus written`; `ratedAgentId` = the provider's agent id |
| settle tx (evaluator) | `JobRejected` (reason `keccak256("agentfi.quality-rejected")`), `Refunded` 1 500 000, USDC escrow → requester 1 500 000 only; hook `FeedbackWritten(value 0)`; `NewFeedback` tag2 `rejected`, value 0 |
| ERC-8004 | as 7.1, with `outcome rejected` in the feedback file |
| keep | job id, on-chain id, contest time, the resolve response, settle tx, `evidence/contest.json` (it embeds the authority checks) |

### 7.4 No agent can resolve the dispute

Checked by the runner right after the contest, and by the fork suite (`escrow-erc8183.fork.e2e.ts`). Nothing is sent: the on-chain checks are `eth_call` simulations.

| Attempt | Expected |
|---|---|
| provider / requester API key on `POST /admin/jobs/:id/resolve` | 401 |
| requester `PATCH status CANCELLED` | 400 (no transition from `PAYMENT_PENDING`) |
| provider `PATCH status COMPLETED` again | 400 |
| provider `POST /v1/transactions/batch` calling `escrow.complete` | refused (400). In C5 the refusal is "AgentExecutor not deployed" (`EXECUTOR_ADDRESS_84532` unset), not a guard on the escrow target; with an executor, `complete` / `reject` revert `Unauthorized` at simulation, but `claimRefund` after `expiresAt` would be reachable — plan S15 |
| `complete` / `reject` from the provider or the requester wallet | revert `Unauthorized` (only the evaluator may decide a Submitted job) |
| afterwards | still `CONTESTED`, no resolution, no settle tx; chain status Submitted |

### 7.5 Whole run (`reconcile`, against the snapshot)

| Check | Expected |
|---|---|
| requester USDC Δ | −2 000 000 |
| provider USDC Δ | +1 994 000 |
| escrow USDC Δ = `pendingPlatformFees` Δ | +6 000 |
| fee wallet Δ (USDC, ETH) | 0, 0 |
| USDC transfers touching the agents | exactly 6 (3 funds, 2 refunds, 1 payout), none other |
| transactions | requester 12; provider 5–6; evaluator 3; none from another sender |
| ETH | each wallet's Δ = the gas of the transactions found from the logs (0 unexplained in the rehearsal; at most one reverted, log-less transaction's gas allowed) |
| reputation | `getSummary(id, [hook], "agentfi.job", "completed")` = (1, 100); `…, "rejected")` = (1, 0) |

### 7.6 After a restart or a repeated query

`verify` and `reconcile` are read-only and give the same result every time. A rerun of `run` on a
settled scenario re-verifies and changes nothing. After a backend restart, `GET /v1/jobs/:id`
returns the same terminal state and settle hash, and no second settlement is sent.
A contested job stays held across a worker restart (§6.4).

## 8. Fork rehearsal of the runner

Anvil fork of Base Sepolia at block 47 822 000 (real USDC and ERC-8004 registries), escrow and
hook deployed with `DeployEscrow.s.sol`, the real backend with `WALLET_PROVIDER=local`, window
**60 s (fork mode only)**.

| Step (final run on `75796fb`) | Result |
|---|---|
| `preflight` | every check PASS (chain, this build's code at the escrow and the hook, configuration, Q7 verified, window = the backend's 60 s, TTL) |
| `setup` → `fund` (fork cheat) → `snapshot` | two agents with the approved policies; the second `setup` and a `fund` after the snapshot are refused |
| `run happy` | **37 / 37** checks: on-chain job #1 Completed, provider +1.994000, fee 6 000, feedback 100 on agent #9599, file hash = `NewFeedback.feedbackHash`, settled 64 s after `submit` (window 60) |
| `run contest` + `resolve contest` | **39 / 39**: contested at once, **11 / 11 authority checks**, held until `submittedAt + 360 s` with nothing settled, then the operator's refund: Rejected, `agentfi.quality-rejected`, 1.500000 refunded, feedback 0 `rejected` (settled 370 s after `submit`) |
| `run cancel` (in parallel with contest) | **22 / 22**: Rejected, `agentfi.cancelled`, 1.000000 refunded, `FeedbackSkipped`, `feedback.json` 404 |
| a second `run cancel` while the first ran | `STOP: another runner … is driving cancel` |
| `verify` ×3 again, `reconcile` | identical PASS; reconcile **16 / 16**: USDC Δ −2.0 / +1.994 / +0.006, 6 transfers and no other, nonces 12 / 6 / 3, ETH Δ = gas of the found transactions with **0 wei unexplained** for each wallet, `getSummary` (1, 100) `completed` and (1, 0) `rejected` |

The whole rehearsal was repeated on `cc0bb90` after the two #189 review fixes (stale RPC head in the
preflight, a recorded authority failure stops the run), with the same results; that commit's tree is
the previous candidate `e6e93bd`'s (§2.1). With a copy of the state holding a simulated authority failure, `resolve`
answered STOP.

An earlier run on the same fork (`e5ae120` + working tree) exercised the recovery paths: a runner
killed after creating the cancel job, its record lost, and the rerun adopted the job by its outbox tag
(no new job); a lock held by a live process stopped a second runner, and a lock left by a dead
process was taken over and released. Gas in the tables above is from these receipts; the fork's gas
price (1–3.6 gwei) is not Base Sepolia's.

Found and fixed while rehearsing:

- concurrent runners overwrote each other's state: one file and one lock per scenario now; the lost
  record was recovered by the outbox tag (the adoption path);
- the hold used the chain's head time, which an Anvil fork does not advance without transactions:
  the hold now reads the chain's head on Base Sepolia (and stops on a stale RPC), the later of the
  head and the wall clock on a fork;
- a wrong address made the preflight crash on a reverting view: every read is now a FAIL check;
- the fork's gas price (≈ 1–3.6 gwei, against 0.006 on Base Sepolia) emptied the rehearsal wallets:
  the runner stopped before creating the job (as designed), and the rehearsal now funds 0.1 ETH;
- a 1-minute local Docker network reset (Postgres pool timeouts, Redis `ECONNRESET`) made the backend
  answer 500 for a minute: the runner only re-read and resumed by itself.

## 9. Decisions for the owner (asked once, with a recommendation)

1. **C4 scope** — deploy only `AgentJobEscrow` + `ReputationHook` (recommended: the escrow
   validation does not use the policy module or the executor), or also `AgentPolicyModule` +
   `AgentExecutor`.
2. **Operator and fee wallet** — two new owner-held addresses, the operator in a keystore and
   in no `.env` (recommended), or the evaluator as operator (allowed on testnet by the runbook,
   but it puts the emergency-pause key in the backend's hot `.env`).
3. **The contest decision** — `refund` + `quality-rejected` (recommended: it exercises the
   rating-0 path; the completed scenario already proves payment), or `pay`.
4. **External credentials** — a Turnkey organization with an API key pair and an Alchemy key with
   Base Sepolia enabled (both required, §3.3). Entered by the owner in a local terminal / `.env`, never
   in a chat, a note or an issue.
5. **The package itself** — chain 84532, the six roles, 4.5 USDC and 0.012 ETH from faucets, the
   policies, the 3600 s window, the 22–23 transactions (C4 2 + C5 20–21) and the stop / success criteria above.

Open as of 2026-10-15 (orchestrated round): all five. None is answered by this document.

Still open on 2026-10-17, and two more before C4:

6. **Publishing the round:** the push and PR of `rc/2026-10-17`. Its merge on `main` is the candidate (§2), and that round had no authorisation to push.
7. **The stuck-evaluator procedure** (plan C3g, proposal A; §6.4):
   - **A1 (recommended):** a manual operator recovery procedure, implemented and tested on Anvil before C4. This requires persistent tracking and reconciliation of all candidate hashes/nonces, contest/resolve protection while any candidate may mine, a reviewed persistence design (possibly a migration), and a script with dry-run and explicit confirmation. It is not a runbook-only change.
   - **A0:** keep today's alert only. A stuck key then stops the run, and the owner decides without a procedure.

   Mind the deadline: after `expiresAt`, anyone can `claimRefund` a job, even when the work was delivered.
