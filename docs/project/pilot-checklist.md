# Assisted pilot on Base Sepolia — operational checklist (gate G4)

> **Status (2026-10-17): proposal, nothing executed.** Written against `main` `1b4d1c5`. No pilot
> has been offered or scheduled, and no deploy, funding or transaction has been sent for it. Every
> repository script, npm command, environment variable and log line cited below was checked against
> the code at that commit (the other tools are Foundry's `forge` / `cast`, Docker and `curl`). Where
> a step needs something the repository does not offer, the gap is stated instead of a command.
> Decisions still open for the owner are marked **[open: …]** and listed in §8.

This checklist covers the run that counts for the third condition of G4: an external operator runs
the escrow flow with their own funds on Base Sepolia ([execution plan](execution-plan-2026-10.md)
§1, V4). The owner decided the modality on 2026-10-15 (plan D21): the pilot is **assisted, on Base
Sepolia, after C4 / C5**. The operator funds the job from a wallet they control, the maintainer
accompanies, identifiable records stay private, and public results are aggregated only
([interviews/README.md](interviews/README.md)).

It contains no personal data and must never contain any. Names, contacts, wallet addresses tied to
a person, transaction hashes and dates of a specific run go only in the owner's private record
`O<n>`, outside this repository.

## 1. Entry gates: no date is offered before both pass

| # | Gate | Done when | Where |
|---|---|---|---|
| R1 | **C4**: escrow and hook deployed on Base Sepolia from the authorised commit | addresses and deploy tx hashes recorded in `testnet-log.md` §1 | [c4-c5-checklist.md](c4-c5-checklist.md) §1, [testnet-log.md](testnet-log.md) §2 |
| R2 | **C5**: the three scenarios and `reconcile` PASS on Base Sepolia; **G2** marked passed | `testnet-log.md` §3–4 filled, evidence files PASS | [c4-c5-checklist.md](c4-c5-checklist.md) §2 and §4, [c5-escrow-validation.md](c5-escrow-validation.md) §7 |

Until R1 and R2 are done, an interviewed operator can give at most a **conditional commitment**
("I will run it once it is available"), with no date ([interviews/README.md](interviews/README.md),
question 6). That counts as "on track" at the Day-30 checkpoint (2026-11-05), never as a run. A
local, Anvil or fork run never counts for G4.

Also before offering a date:

- [ ] The owner has decided R3 (who hosts the backend and the wallet provider, §2) and the items of §8.
- [ ] The commit the operator will deploy and run from is named, and its `npm run contracts:code:check` version is noted (§4 needs both).
- [ ] The operator has received the pilot notice. It says the software is experimental, the pilot runs on testnet only, and the operator signs and funds with their own wallet. They never share a key or credential, not even with the maintainer. Transactions are public on-chain, so a fresh test wallet is recommended. Hashes are published only with their consent, and they may stop at any time.
- [ ] The second verifier (§7) is named and did not take part in the interview.

## 2. Recommended path, conditional on decision R3: the operator hosts everything

**Recommendation [open: R3].** The operator runs **their own backend** with **their own Turnkey and
Alchemy credentials** and **their own evaluator key**, and deploys **their own `AgentJobEscrow` +
`ReputationHook` from this build**. The maintainer only watches and verifies by reading the chain.

Why:

- **Own wallet.** The backend creates each agent's wallet in the Turnkey organization it is
  configured with, and signs with it ([STATE.md](../../STATE.md) §4.3, `POST /v1/agents`). With the
  operator's organization, the requester wallet that signs `fund` is the operator's.
- **Assumption A1** (plan §0): during the validation the maintainer runs no hosted instance and
  holds no custody. The recommended path needs neither.
- **The hook trusts only the evaluator fixed at deploy.** `DeployEscrow.s.sol` passes
  `TRUSTED_EVALUATOR` to the `ReputationHook` constructor, where it is an immutable. Any job whose
  `evaluator` is another address skips feedback (`untrusted-evaluator`). The escrow's `operator`
  and fee wallet are set at deploy too. So an operator who runs their own backend deploys their own
  pair ([STATE.md](../../STATE.md) §3, "Reusing the maintainer's addresses does not work for the
  escrow").
- **Using the maintainer's C4 escrow from the operator's backend does not work either.** The
  backend's boot check compares `hook.trustedEvaluator()` with its own evaluator, and a difference
  is a mismatch. That is FATAL in production / staging and logged `would be FATAL` in development.
  Q7 then refuses every escrow signature on that chain (`503 ESCROW_CONFIG_UNVERIFIED`). Even
  without the check, the platform fee of the operator's job would accrue to the maintainer's
  escrow, under the maintainer's operator and fee wallet.

### 2.1 Where the alternative, a backend hosted by the maintainer, breaks

| Variant | What breaks |
|---|---|
| Maintainer's backend, maintainer's Turnkey organization | The requester wallet is created and signed inside the maintainer's organization. The wallet is not the operator's, so the "own funds" condition of G4 fails. The maintainer's infrastructure would sign the `fund`, and a run the maintainer operates does not count. Serving a backend to a third party is also the hosted instance and custody that A1 rules out |
| Maintainer's backend, operator's Turnkey credentials | The maintainer would hold the operator's credentials. The pilot rule is that the maintainer never holds a key or credential of the operator. It is also a hosted service (A1) |
| Either variant | The evaluator that decides the operator's job, the escrow's operator and the fee wallet are the maintainer's. The maintainer becomes the operator's arbiter and fee receiver |

A lower-friction variant, the operator's backend with `WALLET_PROVIDER=local`, is **not
recommended without an explicit decision**. It keeps the keys in the memory of one process, so API
and worker cannot be split and every restart loses the agents' keys
([testnet-log.md](testnet-log.md) §5.4, "Local wallet provider"). D11 chose Turnkey for the real
network.

### 2.2 Steps for the operator, with the commands that exist

The operator runs every step in their own terminal (Git Bash on Windows). The maintainer types
nothing on the operator's machine and takes no remote control. Detail behind each step:
[testnet-log.md](testnet-log.md) §2 and §5.4, [c4-c5-checklist.md](c4-c5-checklist.md),
[contract-deployment.md](../operations/contract-deployment.md) and
[setup-checklist.md](../operations/setup-checklist.md) ("Real-chain local" mode). These were written
for the owner's C4 / C5; nobody outside the project has run them yet (§9, R4).

| # | Step | Command / setting | Expected |
|---|---|---|---|
| 1 | Checkout of the named commit, dependencies | `git checkout <commit>`; `git submodule update --init --recursive`; `npm ci`; `forge --version` | forge 1.7.1; Node 22+ |
| 2 | Build identity of the checkout | `cd packages/contracts && forge build && cd ../.. && npm run contracts:code:check` | `[contracts:code] … matches the artifacts (version …)`, exit 0. On `1b4d1c5` the version is `ddc6936bc680` (contracts unchanged since the C4 candidate `e6e93bd`) |
| 3 | Keys and addresses: all new, operator-owned, entered only in the operator's terminal | deployer: `cast wallet import <name> --interactive`; evaluator: `cast wallet new` (address → `TRUSTED_EVALUATOR`, key → `ESCROW_EVALUATOR_PRIVATE_KEY` in `packages/backend/.env` only); operator: a separate keystore address (recommended, [c5-escrow-validation.md](c5-escrow-validation.md) §9-2); fee wallet: any address the operator controls | addresses noted (pseudonymous) |
| 4 | Faucet ETH for the deployer and the evaluator | Coinbase Developer Platform or Alchemy Base Sepolia faucets ([testnet-log.md](testnet-log.md) §2.1). C5 proposed 0.005 ETH for the deployer and 0.003 ETH for the evaluator's three settlements ([c5-escrow-validation.md](c5-escrow-validation.md) §4.3); one job needs less | balances > 0 on the explorer |
| 5 | Deploy escrow + hook with the **default parameters** | `unset PRIVATE_KEY`; `export EXPECTED_CHAIN_ID=84532 OPERATOR_ADDRESS=0x… FEE_WALLET=0x… TRUSTED_EVALUATOR=0x…`; from `packages/contracts`: `forge script script/DeployEscrow.s.sol --rpc-url base_sepolia --account <name> --broadcast` (`--verify` optional, needs an Etherscan V2 key) | `Hook gas requirement: 597937`, `Hook bind requirement: 140794`, copy block `AGENT_JOB_ESCROW_ADDRESS_84532` / `REPUTATION_HOOK_ADDRESS_84532`. Keep the defaults (`FEE_BPS` 30, `EVALUATOR_FEE_BPS` 0, `MIN_FEEDBACK_BUDGET` 1 USDC, Base Sepolia registries): §4's check expects them |
| 6 | Post-deploy reads | the `cast call` block of [contract-deployment.md, "Post-deployment checks"](../operations/contract-deployment.md#post-deployment-checks) | every value equals its comment |
| 6b | `scripts/verify-deployment.sh` | **Not for this path.** It checks only `AgentPolicyModule` / `AgentExecutor` views (operator, bound executor, fee wallet, fee bps, policy module), not the escrow or the hook and not bytecode. Use it only if the operator also ran `Deploy.s.sol`, which escrow jobs do not use ([c5-escrow-validation.md](c5-escrow-validation.md) §9-1) | — |
| 7 | Postgres and Redis | `docker compose -f docker-compose.dev.yml up -d postgres redis`, a fresh database and an empty Redis index ([testnet-log.md](testnet-log.md) §5.4 step 2) | — |
| 8 | `packages/backend/.env` (git-ignored) | the template of [testnet-log.md](testnet-log.md) §5.4 step 3 with the operator's values: `NODE_ENV=development`, **`WALLET_PROVIDER=turnkey`** and the three `TURNKEY_*`, a valid `ALCHEMY_API_KEY` with Base Sepolia, `BACKEND_PUBLIC_URL=http://localhost:3000` (D10, see §5.3), `OPERATOR_FEE_WALLET`, the step-5 copy block, `ESCROW_EVALUATOR_PRIVATE_KEY`, **`ESCROW_EVALUATION_DELAY_SECONDS=<value>`** [open: P-3], `SAFE_DEPLOYER_PRIVATE_KEY` empty. Leave `POLICY_MODULE_ADDRESS_84532`, `EXECUTOR_ADDRESS_84532` and `POLICY_OPERATOR_ADDRESS_84532` **unset** (the template's `<§2.5>` placeholders are for the module / executor deploy only) | file exists; `git status` does not list it |
| 9 | Schema | `cd packages/backend && npx prisma generate && npx prisma migrate deploy` | migrations 0001–0025 applied |
| 10 | API and worker, two terminals in `packages/backend` | A: `TRANSACTION_WORKER_ENABLED=false npx tsx src/index.ts`; B: `TRANSACTION_WORKER_ENABLED=true npx tsx src/worker.ts` | `ERC-8183 boot check: escrow (+ ReputationHook where configured) match the configuration` and `ERC-8183 configuration verified — escrow signatures allowed on this chain` (chain 84532) in both; no `would be FATAL`, no `CONFIG DRIFT` |
| 11 | Readiness | `curl http://localhost:3000/health/ready` | `"turnkey":true`; `escrowConfig` with `{"chainId":84532,"state":"verified","allowed":true,…}` |
| 12 | Register the provider, then the requester, with the pilot policies [open: R7] | `POST /v1/agents` with `x-api-key: <API_SECRET>` and body `{"name": …, "chainIds": [84532], "policy": {…}}`. The provider goes first so the requester's `allowedRecipients` can name its wallet (as the C5 runner's `setup` does). Policy fields: `maxValuePerTxUsd` ≥ budget, `maxDailyVolumeUsd`, `cooldownSeconds`, `allowedRecipients`; leave `maxOutflowPerTxUsd` unset (null), so ordinary transfers, swaps and deposits are refused ([c4-c5-checklist.md](c4-c5-checklist.md) §3) | `201` with the agent id and its wallet (`safeAddress`) |
| 13 | Fund the two agent wallets | requester: the budget in USDC (`faucet.circle.com`, network Base Sepolia) plus ETH for gas; provider: ETH only. Only from faucets or the operator's own wallets | balances on the explorer |
| 14 | **Stop here until §4 passes** | the maintainer runs the read-only identity check on the addresses from steps 3 and 5 | §4 all applicable lines PASS |
| 15 | Run one job [open: R6] | one of: the escrow example `node examples/escrow-erc8183/index.mjs` with `AGENTFI_API_URL`, `AGENTFI_OPERATOR_SECRET` and `AGENTFI_REWARD_USDC` ([examples/escrow-erc8183](../../examples/escrow-erc8183/README.md); it reuses the step-12 agents through `AGENTFI_REQUESTER_API_KEY` / `AGENTFI_PROVIDER_API_KEY`; without them it registers new agents with only a USD cap that covers the reward and no cooldown, and **prints their API keys**, see §5.3); the MCP tools from a source checkout ([quickstart §4](../agents/quickstart.md#4-hire-another-agent-with-on-chain-escrow), `post_job` with `chain_id`, `get_job`, `check_inbox`, `update_job_status`); or the REST API directly | the job reaches a terminal state: Completed, or Rejected with the refund (§7) |

The C5 runner (`npm run c5:escrow`) is built for the owner's three-scenario validation. Its fixed
budgets need 4.5 USDC at `snapshot`, and its policies are C5's. It is not the pilot path unless the
owner decides otherwise.

## 3. Timing

With the 3600 s contest window used for C5 (D12), a completed job settles about one hour after
`submit`, so plan on about 70 minutes for the job alone ([c4-c5-checklist.md](c4-c5-checklist.md)
§3), plus setup. A cancellation, a reject with a refund, settles in minutes but writes no reputation
(`skipped:no-params`). The window value for the pilot is open (§8).

## 4. Read-only identity check of the operator's deployment (R5)

The maintainer checks, **before the operator funds the job** and again for the verification
afterwards, that the escrow and the hook hold this build's runtime code. Immutables are masked,
because they differ per deployment (S9 / D16). The check also covers the bindings. The maintainer
uses only public chain reads: no transaction, no key, no access to the operator's backend.

**What exists today, and what each piece does:**

| Tool | Reads the chain? | Covers escrow / hook identity? |
|---|---|---|
| `npm run contracts:code:check` | no | no: it proves only that the checkout's embedded expected code (`packages/backend/src/abi/contract-code.generated.ts`) equals the local Foundry artifacts, and prints the build version |
| `scripts/verify-deployment.sh` | yes (views) | no: module / executor views only |
| `npm run preflight` (root) | yes | no: executor selectors only, plus production infrastructure |
| backend boot check and Q7 (`/health/ready` `escrowConfig`, `/admin/escrow/verification`) | yes | yes, but it runs **in the operator's backend**, with the operator's checkout. It is useful evidence from the operator, not an independent check |
| C5 runner `preflight` (`packages/backend/src/scripts/c5`) | yes | **yes**: `escrow runtime code = this build`, `hook runtime code = this build` (the backend's own masked comparison, `codeIdentityProblem`), then the escrow and hook views. It is coupled to C5 (see below) |
| C5 runner `verify` | — | no: it needs the run's state file, the agents' API keys and the backend, so it serves only the person who ran the job with the runner |

**Procedure with the C5 runner's `preflight`, used read-only** (maintainer's machine, Git Bash,
`packages/backend` of a checkout at the **same commit** the operator deployed from):

```bash
cd packages/contracts && forge build && cd ../.. && npm run contracts:code:check   # note the version
cd packages/backend
export C5_STATE_DIR="$(mktemp -d)"     # empty: never the owner's own c5-run directory
export C5_API_URL=http://127.0.0.1:9   # unreachable on purpose: no backend is consulted
export C5_ESCROW=0x… C5_HOOK=0x…       # the operator's copy block
export C5_EVALUATOR=0x… C5_OPERATOR=0x… C5_FEE_WALLET=0x…   # the addresses the operator declared
unset C5_ADMIN_SECRET C5_OPERATOR_SECRET
npm run c5:escrow -- preflight
```

Read the lines one by one. The command ends in `STOP: preflight failed` (exit 2) **by design**,
because the backend lines cannot pass here:

| Line | Use for the pilot |
|---|---|
| title `build <version>` | must equal the version from `contracts:code:check` and the one the operator reported |
| `RPC chain id` = 84532; `RPC is a local fork only in fork mode`; `RPC head is current` | must PASS |
| `escrow runtime code = this build`; `hook runtime code = this build` | **must PASS: this is the identity** |
| `escrow.token()` = USDC, `escrow.platformFeeBP()` = 30, `escrow.evaluatorFeeBP()` = 0, `escrow.operator()` / `escrow.feeWallet()` = the declared addresses, `escrow not paused` | must PASS |
| `hook.acp() = escrow`, `hook.trustedEvaluator()` = the declared evaluator, both ERC-8004 registries, `hook.minFeedbackBudget()`, `USDC symbol / decimals` | must PASS |
| `evaluator gas …` | informative (C5's floor, 0.001 ETH) |
| `backend /health/ready reachable`, `backend escrow configuration verified (Q7)`, `backend Turnkey readiness`, `C5_ADMIN_SECRET set` | FAIL expected, not applicable; the operator shows the equivalent from their own backend (§2.2 steps 10–11) |

Limits: the runner hard-codes the default fee parameters, the 1 USDC feedback minimum and the
official Base Sepolia registries, so a deployment with other parameters fails those lines (hence
step 5's defaults). It must run from a checkout whose build version equals the deployed build. It
proves the contracts, not who deployed them: the deploy tx hashes (from = the operator's deployer)
are part of the evidence (§5.2). **This is an adaptation of a C5 tool, not a procedure for third
parties. The gap and a proposal are in §9.**

## 5. During the session

### 5.1 Roles

| Role | Does | Never does |
|---|---|---|
| Operator | deploys, configures, registers the agents, funds them, creates and funds the job (or their agent does), runs the evaluator through their own backend | shares a key, a credential, the `.env` or a URL that embeds a key |
| Maintainer | accompanies, answers questions, runs the read-only check of §4, notes the public evidence | signs, funds, sends faucet funds, types on the operator's machine, takes remote control, holds any key or credential of the operator |

A run in which the maintainer operates does not count for G4.

### 5.2 Evidence to capture (into the private record `O<n>`, never into this repository)

- [ ] Chain id (84532), the commit and the `contracts:code` version the operator deployed from.
- [ ] Escrow and hook addresses, and their two deploy tx hashes (from = the operator's deployer).
- [ ] The declared evaluator, operator and fee-wallet addresses, and the §4 output (applicable lines).
- [ ] The AgentFi job id and the on-chain job id.
- [ ] **Mandatory:** the `fund` tx hash and the settlement tx hash (`complete`, or `reject` with the refund; `claimRefund` after an expiry).
- [ ] Recommended: `createJob`, `setBudget`, `approve`, `submit` tx hashes.
- [ ] The requester wallet address, and the operator's statement that they control it and funded it.
- [ ] Optional: an anonymised trace (backend logs with no secrets and no keyed URLs). It only complements the hashes.

### 5.3 Privacy

- No private key, seed, keystore password, Turnkey or Alchemy key, `API_SECRET` / `ADMIN_SECRET`,
  agent API key, `.env` content or RPC URL with an embedded key may be shown, pasted or recorded.
  This holds in chat, on a shared screen, in a log and in the evidence.
- When sharing a screen, the operator does not show the `.env`, the Turnkey dashboard, the
  keystore prompts or the escrow example's first lines: when it registers new agents, the example
  prints both agents' API keys.
- Keep `BACKEND_PUBLIC_URL=http://localhost:3000` (D10). The backend writes it on-chain,
  permanently, in the job description and in each provider's ERC-8004 `agentURI`. A public host
  would tie the run to the operator.
- Use fresh test wallets; hashes then identify a pseudonym, not a person. Hashes and addresses stay
  in the private `O<n>` record. They are published only with the operator's consent.

## 6. Stop criteria (R10)

Any one of these stops the session. Nothing more is sent, and no new job is created "to try again"
without the operator and the owner agreeing. A stopped run is recorded privately as an **attempt**,
with the reason. These follow the C5 runner's stops ([c5-escrow-validation.md](c5-escrow-validation.md) §5).

| Stop when | Seen where |
|---|---|
| **Wrong network**: the RPC chain id is not 84532; a local fork or Anvil; a stale RPC head; any mainnet endpoint, mainnet asset or real money involved | §4, the backend boot, the explorer |
| **Contract fails identity or binding**: escrow or hook runtime code not this build; `hook.acp()` ≠ the escrow; `hook.trustedEvaluator()` ≠ the operator's evaluator; token ≠ USDC; fees or feedback minimum not the defaults; escrow paused; the backend logs a mismatch, `would be FATAL` or `CONFIG DRIFT`, or `escrowConfig` is not `verified / allowed` | §4, §2.2 steps 10–11 |
| **Wallet not controlled by the operator**: the agents' wallets are created in a Turnkey organization the operator does not control; a USDC or ETH inflow to the requester wallet comes from a maintainer address; the maintainer is asked to sign, fund, send faucet funds or type a command | §2, §5.1, the explorer |
| **Value divergence**: the job's budget, token, provider, evaluator or hook differ from what was agreed; USDC moves to any address other than the escrow, the provider (payout) or the requester (refund); the policy or the contest window differ from the agreed values; an ordinary outflow is attempted | the job view (`GET /v1/jobs/:id`), `getJob`, the explorer |
| **A key or credential is asked for or exposed**, by anyone, including the maintainer, a web page or a tool's output | always |
| **The operator wants to stop** | always |

If a credential was exposed, record the fact (never the value) in the private record. The operator
decides whether to replace it, or the agents and wallets, before any new attempt. A funded job that
is left unsettled returns to the requester after the job TTL (7 days by default), through the
expiry sweep of the operator's own backend ([c5-escrow-validation.md](c5-escrow-validation.md) §6.4).
That backend's worker must be running then.

## 7. After the session: verification and records

A run counts for G4 only after **two verifiers** have each checked it, read-only and independently,
from the same evidence package. The second verifier does not see the first one's conclusion and did
not conduct the interview. Each checks:

- (a) every transaction succeeded on chain 84532;
- (b) the `fund` comes from the declared requester wallet and moves USDC to the escrow;
- (c) the **first hop only**: the USDC and ETH inflows to the requester wallet before the `fund` come
  from no address of the maintainer (`testnet-log.md` §1 and §4, plus any other maintainer-controlled
  address the owner declares privately to the verifiers). Earlier hops, such as shared faucets, are
  not traced;
- (d) the identity of §4 holds for the escrow and the hook;
- (e) the terminal state: `getJob` shows Completed (3), or Rejected (4) with the refund, and the
  events agree.

Tools, all read-only: the explorer (Base Sepolia Basescan) for each transaction, and from a shell:

```bash
RPC=https://sepolia.base.org
cast receipt <tx hash> --rpc-url $RPC      # status 1 (success), from, to, logs
cast call <escrow> "getJob(uint256)((uint256,address,address,address,string,uint256,uint256,uint8,address))" <on-chain job id> --rpc-url $RPC
#   (id, client = requester wallet, provider, evaluator = hook.trustedEvaluator(), description, budget, expiredAt, status, hook)
```

Expected settlement events: on `complete`, `JobCompleted`, `PaymentReleased` to the provider,
`PlatformFeeAccrued`, a USDC `Transfer` from the escrow to the provider, and the hook's
`FeedbackWritten` with the registry's `NewFeedback`. On `reject` with a refund: `JobRejected`,
`Refunded` and a USDC `Transfer` from the escrow to the requester.

Records:

- [ ] Private record `O<n>`: the field "Ran the flow" with the date, the `fund` and settlement hashes, and both verifiers (who, when, method, result). An attempt that did not count is recorded with its reason, separating lack of interest (demand) from a flow that could not be run (supply).
- [ ] Consent to publish the hashes: yes or no, recorded in `O<n>`.
- [ ] Public `interviews/results.md`, after the checkpoint and after the go/no-go: counts only. It gives the number of verified runs and the verifiers' roles, plus the hashes only with consent ([interviews/README.md](interviews/README.md), "Aggregated results").

## 8. Decisions this checklist leaves open (owner)

| Item | Question | Options |
|---|---|---|
| R3 | Who hosts the backend and the wallet provider in the session | operator's own backend, Turnkey, Alchemy, evaluator and contracts (recommended, §2); maintainer-hosted (breaks own wallet and A1, §2.1); operator's backend with the local provider (not recommended, §2.1) |
| P-3 | The evaluator and the pilot's window | evaluator: the operator's own backend signer under R3's recommendation (D5). Contest window: 3600 s as in C5 (D12, about 70 min) or another explicit value. Calendar: plan days 61–90, before the 2027-01-05 go/no-go |
| P-10 | What applies if the flow is never available before the go/no-go | to decide before the interview data comes in, and record in the plan (§6 risk "G4 fails on setup friction") |
| R6 | How the operator drives the job | MCP tools built from source (until 0.6.0 is published separately, X3); the escrow example; the REST API |
| R7 | Pilot policy values and budget | at least 1 USDC (the hook's feedback minimum); `maxValuePerTxUsd` ≥ budget; daily volume, cooldown and `allowedRecipients` as in C5 or as the operator prefers; `maxOutflowPerTxUsd` null |

## 9. Known gaps

- **R4: no guide for a third party, tested by someone who did not write it.** This checklist links
  the owner's runbooks and the generic operator docs. It is not that guide, and no external person
  has run the path.
- **R5: no read-only identity tool for a third-party deployment.** Today's option (§4) borrows the C5
  runner's `preflight`: backend lines fail by design, parameters are hard-coded and the state
  directory must be isolated. The per-job checks of §7 are manual. **Proposal:** a read-only command,
  for example `npm run c5:escrow -- identity`, or a separate `scripts/` entry reusing
  `codeIdentityProblem` and the preflight's chain checks. It would take the RPC, the escrow, the
  hook and the declared evaluator, operator and fee wallet. With an optional on-chain job id and the
  `fund` and settlement hashes, it would also run checks (a), (b), (d) and (e) of §7. It would
  print the build version, PASS / FAIL per line and an exit code, and nothing would depend on a
  backend or a state file. Its tests: this build passes; a lookalike, a legacy build and an EOA fail
  (the backend's `contract-identity.test.ts` and `contract-identity.*.anvil.ts` already build such
  cases).
