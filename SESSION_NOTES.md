# Session Notes — 2026-10-15

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
sessions did and what the next one should pick up. The latest handoff is the
owner's note `agentfi-notas/2026-10-15-orquestracao-paralela.md`, the
orchestrated round of 2026-10-15. Each front of that round has its own note:

- C4/C5 package facts: `2026-10-15-c4c5-atualizacao.md`;
- interview kit: `2026-10-15-kit-entrevistas.md`;
- public-site redesign: `2026-10-15-identidade-visual.md` and
  `2026-10-15-revisao-landing.md`.

Before it: `2026-10-15-autorizacao-c4-c5.md` (the C4/C5 authorisation
package), `2026-10-14-preparacao-c4-c5.md` and `2026-10-14-fechamento-g1.md`.

| Surface | Status |
|---|---|
| `main` | `e6e93bd` (#189, 2026-10-15: the C5 runner and the authorisation package; contracts unchanged). Before it, code `162cb06`. 2026-10-14 (evening), the C4/C5 preparation round: #178 approval day, #179 S8, #180 max withdrawals, #181 X5, #182 S9, #183 S7, #184 DB-suite crash, #185 USD cap on ordinary outflows, #186 / #187 review follow-ups, and this docs PR |
| Gates | **G1 met on `03a429d`**, within its threshold only (not a general security claim). **G2 not met:** needs C4 + C5 on the real network (owner). G3–G5 not started |
| Tests on `162cb06` | GitHub CI 8/8. Local: backend unit 1576 (13 skipped: opt-in fork suites), **real Postgres 365 / 365 in one run** (20 files; `pool: 'forks'` fixed the Windows crash), Anvil with real contracts 39 (3 skipped: Safe-mode fork file), Foundry 356 (2 skipped: Base Sepolia fork suites; CI's nightly forge counts 355), mcp-server 152, admin 14, E2E 3 / 4 skipped by design |
| Forks (read-only) | escrow rehearsal 7/7 and Safe mode 3/3 (Base Sepolia), Foundry fork suites 14/14, S7 addresses 10/10 + routes 6/6 (Base, Arbitrum One), max withdrawal 3/3 (Ethereum mainnet). Commands: [local-validation.md](docs/operations/local-validation.md) |
| Dev stack | validated on `162cb06`: rebuilt with its volumes kept, migration 0025 applied to the dev database at boot, `smoke:dev` and the three examples green (`swap-planner` registers `maxOutflowPerTxUsd: '250'`), no ERROR lines |
| Migrations | latest `0025_q6_outflow_usd_cap`: `AgentPolicy.maxOutflowPerTxUsd`, NULL on every row = ordinary outflows blocked until the operator sets it (escrow, x402 and withdrawals unaffected). Deploy the API and every worker from the same release, after stopping the old processes |
| In flight | nothing of ours; Dependabot PRs only |
| C4 / C5 package (2026-10-15) | prepared, **waiting for the owner's approval**: [c4-c5-checklist.md](docs/project/c4-c5-checklist.md) (package) and [c5-escrow-validation.md](docs/project/c5-escrow-validation.md) (baseline, inventory, amounts, stop criteria, acceptance matrix). Runner `npm run c5:escrow` for the three escrow scenarios, rehearsed end to end on a fork (all PASS): on `75796fb`, then again on `cc0bb90`, whose tree is the candidate `e6e93bd`'s (doc §2.1). `GET /admin/escrow/verification` reports the effective window. No deploy, funding or transaction on Base Sepolia; read-only RPC reads only. Five owner decisions are open (doc §9) |
| Orchestrated round (2026-10-15) | documentation and materials only; no code, contract or network change. Interview script: G4 needs an executed run, not intent; the Day 30 checkpoint is only an on-track signal (plan V3–V5). Docs now say Turnkey keeps keys in secure enclaves (it is not MPC shards) and drop Safe as the working mode (D19). `SECURITY.md` points to GitHub private vulnerability reporting. HANDOFF §7: the landing repository exists and is private. Public site: redesign on an unpushed branch of `felippeyann/agentfi-landing`, plan X8, publish only on the owner's approval. Owner decisions the same day: **D21** (checkpoint on 2026-11-05; assisted pilot on Base Sepolia after C4 / C5; aggregated interview results public, identifiable records private) and **D22** (site identity B, published after these docs are on `main`). Conduct contact (H15): the unmonitored `conduct@agentfi.io` was removed and a monitored channel is still pending. Handoff of the publication round: owner note `2026-10-15-publicacao-b.md` |
| Contracts | legacy deployments fail the S9 identity check by construction; C4 redeploys every contract from the merged commit (`npm run contracts:code:check` must match). Checklist: [docs/project/c4-c5-checklist.md](docs/project/c4-c5-checklist.md) — authorisation section first |
| npm `@agent_fi/mcp-server` | 0.5.0 published (31 tools); 0.6.0 is task X3 (source now has `update_policy.max_outflow_per_tx_usd` and the fixed `pay_agent`) |

## What this round did

Every item was reproduced first (a failing test committed before the fix), on
the layer that proves it: real Postgres for atomicity, real local contracts on
Anvil for authority.

1. **S9, contract identity before authority or value (D16).** The backend compares the runtime bytecode of this repository's build with `eth_getCode` (immutables masked), then the configured bindings and the chain id. Unverified → no Safe module enablement, no executor-routed transaction (`503 CONTRACTS_UNVERIFIED`, re-checked just before the broadcast), no policy sync, no escrow. Reproduced first: a wrong executor kept the funds; a wrong module drained a Safe on a fork; a lookalike escrow took the approved USDC.
2. **AgentPolicyModule (D18):** only the bound executor may validate; the cooldown is checked once per execution. **Safe mode (D19):** FATAL in production / staging.
3. **S8:** the policy sync is signed by the agent's own wallet and sent straight to the module (it always reverted through the executor). `POST /admin/agents/:id/policy/sync`, `GET …/policy/onchain`; the batch routes refuse the module as a target.
4. **S7 / X5:** the four "bad checksum" addresses had no code at all; official deployments now, verified on-chain. The same scan found a second wrong Base QuoterV2 (no slippage floor on Base swaps). `pay_agent` sends the transfer route's real contract.
5. **USD cap on ordinary outflows (D17, migration 0025):** `maxOutflowPerTxUsd`, NULL = blocked, compared in micro-USD; USD limits take at most 6 decimals.
6. **Max withdrawals (D20):** uncounted only when the exact calldata proves the funds return to the signing wallet (Aave pool, Compound comet); ERC-4626 refused.
7. **Approval day (D20):** the approval revalidates the daily budget atomically on the approval day; no override.
8. **Windows DB-suite crash:** Prisma's N-API engine in ended worker threads; the DB config runs with `pool: 'forks'`.
9. **Automated reviews:** every P1 / P2 was reproduced and fixed in the round (Polygon `"ETH"` in the MCP, strict EIP-55 on the transfer route, the max-withdrawal signer, classifier float bypasses, exact approval-day arithmetic); all threads resolved.

## Next session (do this first)

1. **Owner: approve the C4 / C5 package, then run it** (checklist: package first, then §0–§2 with the runner). Open choices in the package: C4 scope (escrow + hook recommended), the operator / fee-wallet addresses, the contest decision. This is the only path to G2.
2. **Owner: plan §5 questions 9–13.**
   - 9: mainnet contest window.
   - 10: `"ETH"` on Polygon at the API.
   - 11: GMX.
   - 12: the Uniswap routers.
   - 13: ERC-4626 max withdrawals.
   - Also: the per-agent `maxOutflowPerTxUsd` values.
3. **Owner: the interviews** (the day-30 checkpoint is on 2026-11-05).
4. **Code without owner input:**
   - S12 (Aave allowance spender);
   - A6d (batch fee);
   - X7 (`transfer_token` idempotency key);
   - T2 (unit suite on Windows);
   - A6c / C3f residuals;
   - then X3 / X1 / X2.

_Last touch: 2026-10-15._
