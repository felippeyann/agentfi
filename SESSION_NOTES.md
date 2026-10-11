# Session Notes — 2026-10-11

> Single-point handoff doc. Update on every substantive session, prune stale
> sections aggressively. If this file is older than a few days when you read
> it, trust `git log`, `gh pr list`, `gh issue list` and the status columns in
> [docs/project/execution-plan-2026-10.md](docs/project/execution-plan-2026-10.md)
> over the contents here.

---

## Where we are right now

The project was **archived 2026-05-17** and **reactivated 2026-10-06** in
exploratory mode (90-day validation, go/no-go 2027-01-05). Everything that
matters is tracked in the execution plan; this file only records what the last
sessions did and what the next one should pick up.

| Surface | Status |
|---|---|
| `main` | `79e7b40`. Since 2026-10-07: #156 (plan after the second review), #157 S6, #158 P6, #159 C2b, #160 C3c, #161 H14, #162 C3d, #163 A6, and this docs PR |
| Gates | **G1:** threshold met on `79e7b40` (no known P1: the second review's P1s are fixed and reviewed line by line; C3d and A6 were each re-reviewed independently), **not closed** until the owner answers plan §5 questions 6–9. **G2 not met:** code-complete and rehearsed on a Base Sepolia fork (escrow fork suite 7/7 on the final A6 head 82d9cf4: happy, cancel, example ×2, contest → operator verdict 0, contest → operator pay 100, expiry); the real network needs C4 + C5 (owner). G3–G5 not started |
| Tests on `main` | backend 1186 unit tests (59 files) and 89 Postgres-backed tests (4 files: escrow chain truth 47, daily volume 32, escrow spend policy 5, x402 ledger 5), mcp-server 95, admin 11, Foundry 341 (+2 fork suites skipped without `BASE_SEPOLIA_FORK_URL`), E2E 3 pass / 4 skipped by design, escrow fork suite 7/7 (needs `E2E_ANVIL_FORK_URL`). The local CI reproduction on 79e7b40 is green: run `forge build` before the backend ABI test, and give the E2E the Backend Tests env |
| Dev stack | validated on 79e7b40: 5 services healthy, migrations 0018–0020 applied to the dev database at boot, `smoke:dev` and the three examples green, no ERROR lines |
| In flight | nothing of ours; Dependabot PRs only |
| Contracts | Base mainnet + Base Sepolia deployments are **legacy ABI**; C4 redeploy is **blocked on the owner** (deployer keystore, evaluator key with gas, fee wallet). Checklist: [docs/project/c4-c5-checklist.md](docs/project/c4-c5-checklist.md); runbook: [docs/project/testnet-log.md](docs/project/testnet-log.md) |
| npm `@agent_fi/mcp-server` | 0.5.0 published (31 tools); 35 in source; 0.6.0 is task X3 (owner's npm access) |
| Local toolchain | Node 24.14.1, Docker (Postgres + Redis + the dev stack), Foundry 1.7.1 (`~/.foundry/bin`), graphify |

## What 2026-10-08 → 2026-10-11 did

1. **Second adversarial review (2026-10-08).** It found 5 P1 and about 20 P2, none losing escrowed funds in the contracts. The owner decided D9 (a contest goes to operator review; negative feedback only on an explicit verdict), D10 (C5 writes localhost URIs) and D11 (C5 uses Turnkey). Fix waves, each reviewed line by line and merged with green CI:
   - #159 C2b: contracts before C4.
   - #160 C3c: the chain is the source of truth for escrow.
   - #157 S6: EIP-712 handshake, env guards, MCP hardening.
   - #158 P6: pay-resource money fixes.
   - #161 H14: runbooks rewritten and dry-run on a fork.
2. **#162 C3d (2026-10-11).**
   - A contest puts the job in a `CONTESTED` hold. Settlement, recovery, reconciliation and the boot re-poll all leave it alone. A contest is refused while a settlement could still mine.
   - The operator decides with `POST /admin/jobs/:id/resolve` (or the admin panel): pay = 100; refund = no rating; refund + quality-rejected = 0, the only negative path; payout-blocked.
   - Escrow spending policy: USDC at 1.00, payee allowlist, cooldown, and a daily limit including x402. The reservation is one transaction under the Agent lock.
   - Hook boot check, FATAL in production/staging. Alerts are sanitized.
   - An independent review found no P1. Its three P2s were fixed before merge: an address with no code counted as "unreadable", the alert leaked the RPC key, and the reservation was not atomic.
3. **#163 A6 (2026-10-11).**
   - Reproduced first on Postgres: 15 of 18 cases were wrong on 55148ee. Examples: a confirmed transfer counted twice, A2A counted three times, nothing released on failure, and a batch ignored the limit.
   - Now there is one reservation per Transaction row, created atomically with it, and settled once:
     - CONFIRMED commits;
     - REVERTED after one signed broadcast releases;
     - FAILED releases only if nothing was broadcast;
     - dropped holds.
   - A recovery sweep handles crash gaps. Unpriced native value is refused while a limit applies. The legacy A2A payment is counted by its job only.
   - An independent review found no P1; its P2s were fixed in the PR, and a re-review of the fix round followed.
4. **Evidence policy for this round.** Unit tests with mocks, Postgres-backed tests, Anvil (transaction E2E) and the Base Sepolia fork (escrow suite) are reported separately in the PRs and in `~/agentfi-notas/2026-10-11-revisao-c3d-a6.md`. Nothing ran on a real network.

## Next session (do this first)

1. **Owner: C4 + C5** with [docs/project/c4-c5-checklist.md](docs/project/c4-c5-checklist.md). This is the only path to G2.
2. **Owner: answer plan §5 questions 6–9.** G1 closes after that:
   - default contest window;
   - boot check with the RPC down;
   - USDC policy readings / `maxValuePerTxUsd`;
   - unpriced tokens.
3. **Owner: interviews** with [docs/project/interviews/README.md](docs/project/interviews/README.md). Day-30 checkpoint 2026-11-05.
4. **Code without owner input:**
   - C3e and A6b (review leftovers);
   - C3b (fee sweep), R2b, S3, T1, R4;
   - the bullmq 6 scheduler migration;
   - then X3 (npm 0.6.0, owner's npm access) and X1/X2 for the demo.
5. Before the local E2E with the dev stack up, export `E2E_REDIS_URL=redis://localhost:6379/12`. Deploy the API and the workers from the same release (A6).

_Last touch: 2026-10-11._
