# Session Notes — 2026-10-21

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

The latest handoff is the owner's note
`agentfi-notas/2026-10-21-fechamento-avanco.md`.
- **2026-10-21:** it closed the evidence of the 2026-10-17 candidate (`38ddb4f`).
- **18/10 harness:** archived in `c5-rehearsal-2026-10-18/harness/`.
- **New candidate in progress:** S14 and T2, on separate branches.

The 2026-10-17 round is described in `2026-10-17-retomada-validacao.md`. Each
of its fronts has its own note:
- front B (C3f): `2026-10-17-frente-b-c3f.md`;
- the independent review: `2026-10-17-revisao-independente.md`;
- the pilot checklist: `2026-10-17-checklist-piloto.md`;
- the C5 fork rehearsal: `c5-rehearsal-2026-10-17/`.

A parallel commercial front (pricing, fund flow, treasury, company and
regulation) is consolidated in the private note
`2026-10-17-politica-comercial-tesouraria.md`. It changed no code and no C4 / C5
parameter.

| Surface | Status |
|---|---|
| `main` | `1b4d1c5` (#190, 2026-10-15 docs). Code unchanged since `e6e93bd` (#189: the C5 runner and the authorisation package) |
| **`rc/2026-10-17`** (local, **not pushed**) | The 2026-10-17 round. Code `38ddb4f`; docs and graph commits after it touch no file under `packages/`. Merged in: the pilot checklist, front B (C3f + review P3s) and front A (X7, A6d, S12). Its PR waits for the owner's authorisation, and its merge on `main` is the new C4 / C5 candidate |
| Tests on `38ddb4f` (local, Windows 11, Node 24) | `contracts:code:check` OK (`ddc6936bc680`); `spec:check` and `spec:lint` OK; typecheck clean; backend unit 1624 (13 skipped); **real Postgres 388 / 388** (21 files); Anvil with real contracts 55 (3 skipped: the Safe-mode fork file); Foundry 356 (2 skipped); mcp-server 163. ERC-8183 fork suite 7 / 7 on `6e03bf2` and on `38ddb4f` (2026-10-21). C5 runner end to end on `38ddb4f`, local fork (2026-10-18): 37 / 39 / 22 / 16, 0 wei unexplained. Matrix by SHA: C5 doc §2.1 |
| Gates | **G1 met on `03a429d`**, within its threshold only. **G2 not met:** needs C4 + C5 on the real network (owner); fork evidence never counts. G3–G5 not started |
| Migrations | unchanged, latest `0025_q6_outflow_usd_cap` |
| C4 / C5 package | candidate moved to the 2026-10-17 round ([c5-escrow-validation.md](docs/project/c5-escrow-validation.md) §2). Open before C4: the five §9 decisions, publishing the round and the stuck-evaluator procedure (plan C3g, proposal A). No deploy, funding or transaction on any real network |
| Pilot | [pilot-checklist.md](docs/project/pilot-checklist.md) (new): the assisted G4 pilot on Base Sepolia after C4 / C5 (D21). Its §8 decisions are open |
| Interviews | checkpoint on 2026-11-05 (D21); kit in the owner's notes; public material in [docs/project/interviews/](docs/project/interviews/) |
| npm `@agent_fi/mcp-server` | 0.5.0 published (31 tools). 0.6.0 is task X3; the source now has `transfer_token.idempotency_key` |

## What this round did

Every fix was reproduced first, with a failing test committed before it, on the
layer that proves it. One independent review covered the financial
consequences: no P1, no P2.

1. **X7.** MCP transfers take an idempotency key: stdio `transfer_token` (`idempotency_key`) and `/mcp/sse` `execute_transfer` (`idempotencyKey`). On real Postgres, the same key twice gives one row, one reservation and one job.
2. **A6d.** An agent batch sends `msg.value` = value + the executor fee, and counts the fee against the USD limits. A batch whose value alone equals a limit is now refused. The `FeeEvent` records the fee charged on-chain. Anvil proves it with the real contracts.
3. **S12.** The Aave allowance reads the Pool. An unreadable provider gives `502 AAVE_POOL_UNAVAILABLE`.
4. **C3f.**
   - A stuck evaluator key raises one `evaluator-stuck` alert, with the refund deadline.
   - A send whose answer was lost is asked about again before another settlement is signed.
   - The worker's own Q7 state shows in `GET /admin/escrow/verification`, and the C5 preflight requires it on the real run.
   - Item 2 was not reproduced (fixed since #176).
   - Proposals A, B and C for the owner (plan C3g).
5. **Plan.**
   - New rows: A6e, A7, S14, X7b, C3g.
   - C3b corrected: the fee sweep is the operator's or the fee wallet's, never the evaluator's.

## Next session (do this first)

1. **Owner: authorise publishing the round.** Push `rc/2026-10-17`, open its PR and merge after CI. Then check `git diff 38ddb4f <merge> -- packages` is empty (C5 doc §2).
2. **Owner: the decision card** in the round note:
   - the C5 §9 decisions plus C3g-A (A1 recommended, to be built before C4);
   - the pilot §8;
   - the commercial decisions.
3. **Owner: approve and run C4 / C5.** This is the only path to G2.
4. **Owner: the interviews** (checkpoint on 2026-11-05).
5. **Code with separate owner decision:** C3g-A1 requires approval and a reviewed candidate-hash persistence/reconciliation design, not just a script.
6. **Code without owner input:**
   - S14;
   - R5, the read-only identity command for the pilot;
   - T2;
   - then X3 / X1 / X2.

_Last touch: 2026-10-18._
