# Session Notes — 2026-10-14

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
sessions did and what the next one should pick up. The detailed handoff of
this round is in the owner's note `agentfi-notas/2026-10-14-fechamento-g1.md`.

| Surface | Status |
|---|---|
| `main` | code `03a429d`. 2026-10-14: #170 Q8, #171 A6b-R, #172 Q6/Q7, #173 Q9 + A6b, #174 admin batch signer, #175 C3e + 6d, #176 fixes from the independent review, and this docs PR |
| Gates | **G1 met on `03a429d`** (criteria and evidence in the plan header and row G1c). **G2 not met:** code-complete and rehearsed on a Base Sepolia fork; needs C4 + C5 on the real network (owner). G3–G5 not started |
| Tests on `main` | backend 1398 unit (66 files) and 231 real-Postgres (12 files — run them one at a time on Windows, the all-files run segfaults), mcp-server 103, admin 11, Foundry 341 (+2 fork suites skipped without `BASE_SEPOLIA_FORK_URL`), E2E 3 pass / 4 skipped by design, escrow fork suite 7/7 (`E2E_ANVIL_FORK_URL`) |
| Dev stack | validated on `03a429d`: migrations 0021–0024 applied to the dev database at boot, `smoke:dev` and the three examples green, no ERROR lines |
| Migrations | latest `0024_a6b_broadcast_tx_hash`; this round added 0021 (Q8), 0022 (Q9), 0023 (C3e), 0024 (A6b). Deploy the API and every worker from the same release, after stopping the old processes |
| In flight | nothing of ours; Dependabot PRs only |
| Contracts | legacy-ABI deployments only; C4 redeploy blocked on the owner. Checklist: [docs/project/c4-c5-checklist.md](docs/project/c4-c5-checklist.md) |
| npm `@agent_fi/mcp-server` | 0.5.0 published (31 tools); 0.6.0 is task X3 |

## What 2026-10-14 did

1. **Owner decisions Q6–Q9 implemented (D12–D15)**, plus three scope choices the owner made the same day (Q7 gate on escrow operations only, Q8 USD cap on USDC payments only, Q9 batch calldata "only authorised contracts").
   - **Q6:** contest window 3600 s in the C5 configuration; production refuses to boot without an explicit value.
   - **Q7:** per-process verification of the escrow configuration, valid 600 s, re-checked every 120 s, revoked by any failure. While a chain is unverified, new escrow signatures are deferred and API requests that would start one get `503`.
   - **Q8:** `maxValuePerTxUsd` and `allowedRecipients`, migrated by exact copy.
   - **Q9:** no spend counted as zero; synthetic test prices on Base Sepolia only, FATAL in production.
2. **C3e / A6b reviewed by financial effect, reproduced before fixing.** Confirmed and fixed:
   - a second signed transaction after a lost `SUBMITTED` write;
   - pending `fund` / `submit` unwound;
   - A2A refunds while the payment could still mine;
   - stranded `QUEUED` rows;
   - contest accepted while a settlement could mine;
   - the approval-day reservation;
   - the admin batch signed by an arbitrary agent.
   Classified residuals are in rows A6c and C3f.
3. **Independent adversarial review** of the round's combined diff found no P1. Its P2 (a delivery refunded at expiry while a Q7 deferral held its submit) and four P3s were reproduced and fixed in #176. During that review the multi-node "is it known" lookup was made strict: it answers "unknown" only when every RPC answers so.
4. **Evidence by layer** on `03a429d`, with nothing run on a real network:
   - GitHub CI 7/7;
   - local reproduction of every CI job;
   - real Postgres;
   - Anvil E2E;
   - escrow fork suite;
   - dev stack.

## Next session (do this first)

1. **Owner: C4 + C5** with the updated checklist. It now adds `SYNTHETIC_TEST_PRICES_USD`, the 3600 s window, migrations 0001–0024, the Q7 log line and `escrowConfig`, and a valid `ALCHEMY_API_KEY`. This is the only path to G2.
2. **Owner: plan §5 questions 6–9.**
   - Q6: USD cap on ordinary transactions.
   - Q7: `max` withdrawals.
   - Q8: approval-day override.
   - Q9: mainnet contest window.
3. **Owner: the interviews** (the day-30 checkpoint is on 2026-11-05).
4. **Code without owner input:**
   - S7 (contract-address checksums);
   - S8 (on-chain policy sync path);
   - S9 (boot verification of module / executor);
   - X5 (MCP `pay_agent`);
   - A6c / C3f residuals;
   - then X3 / X1 / X2.

_Last touch: 2026-10-14._
