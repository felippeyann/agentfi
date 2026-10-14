# Local validation — every check, by layer

**Audience:** contributors and coding agents validating a change before a PR.
**CI is the reference** (`.github/workflows/ci.yml`, Linux, Node 22); this page is how to reproduce it on a workstation, including the Windows machine the maintainer uses, and what each layer does and does not prove.

## 1. One-time setup

```bash
npm ci
npx prisma generate --schema=packages/backend/src/db/schema.prisma
git submodule update --init --recursive          # packages/contracts/lib/forge-std
(cd packages/contracts && forge build)           # backend ABI tests read packages/contracts/out
docker compose -f docker-compose.dev.yml up -d postgres redis
```

Use a **database of your own** (never `agentfi`, the dev stack's — the E2E and `agent.search.test.ts` empty tables), and a second one for the suites that empty their whole database on every run (rows 8 and 9 below — they migrate it themselves):

```bash
docker exec agentfi-postgres-1 psql -U agentfi -d postgres -c "CREATE DATABASE agentfi_<you>"
docker exec agentfi-postgres-1 psql -U agentfi -d postgres -c "CREATE DATABASE agentfi_<you>_e2e"
(cd packages/backend && DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you> npx prisma migrate deploy)
```

Without `E2E_DATABASE_URL` the E2E suites fall back to shared defaults — `agentfi` (the dev stack's) for row 8, `agentfi_e2e_escrow` for row 9 (created on the fly by `prisma migrate deploy`) — which another run on the machine may be emptying at the same time: always pass yours.

The backend test environment (the CI "Backend Tests" job, with your own database and Redis index):

```bash
export DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you>
export REDIS_URL=redis://localhost:6379/<n>       # n ≠ 0 while the dev stack runs
export API_SECRET=test-secret-min-32-chars-long-here
export ADMIN_SECRET=test-admin-secret-min-32-chars-long
export OPERATOR_FEE_WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export ALCHEMY_API_KEY=test TURNKEY_API_PUBLIC_KEY=test TURNKEY_API_PRIVATE_KEY=test TURNKEY_ORGANIZATION_ID=test
```

## 2. The checks, in CI order

| # | Layer | Command (from the repo root unless noted) | Proves | Does not prove |
|---|---|---|---|---|
| 1 | Types | `npm run typecheck` | every workspace compiles | behaviour |
| 2 | OpenAPI | `npm run spec:lint` · `npm run spec:check` | the spec lints; `packages/mcp-server/src/api.generated.ts` matches it | that routes implement the spec |
| 3 | Contracts | `cd packages/contracts && forge test` | Solidity behaviour on the EVM | integration with the backend |
| 4 | Backend unit | `cd packages/backend && npx vitest run` | services and routes with mocked chain / SaaS (and `agent.search.test.ts` on the real DB) | atomicity, real chain |
| 5 | Backend DB | `cd packages/backend && npx vitest run --config vitest.config.db.ts` | routes and services on **real Postgres** (and Redis where named): reservations, races, migrations against pre-existing rows | anything on a chain |
| 6 | MCP | `cd packages/mcp-server && npx vitest run` | tool schemas, dispatch, error sanitising; bodies checked against the OpenAPI spec where a test says so | the backend's behaviour |
| 7 | Admin | `cd packages/admin && npx vitest run` | dashboard units | — |
| 8 | E2E on Anvil | `cd packages/backend && E2E_DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you>_e2e E2E_REDIS_URL=redis://localhost:6379/<m> npx vitest run --config vitest.config.e2e.ts` (Foundry on `PATH`) | the queue → submitter → monitor → accounting pipeline against **real local contracts** | real networks, Turnkey |
| 9 | ERC-8183 fork rehearsal | `cd packages/backend && E2E_DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you>_e2e E2E_ESCROW_REDIS_URL=redis://localhost:6379/<m> E2E_ANVIL_FORK_URL=https://sepolia.base.org npm run test:e2e:escrow-fork` (unset `DATABASE_URL`; ≈ 3–5 min; not at the same time as row 8 — both empty `agentfi_<you>_e2e`) | the escrow flow against the real Base Sepolia USDC / ERC-8004 registries on a fork | a real testnet run (C5) |
| 10 | Dev stack | `docker compose -f docker-compose.dev.yml up --build` then `npm run smoke:dev` ([dev-quickstart.md](../dev-quickstart.md)) | the images boot; two agents register, a no-reward A2A job completes, trust and P&L read back | anything paid or on-chain |

Order matters locally: run `forge build` (or `forge test`) **before** step 4 — a stale `packages/contracts/out` fails `abi.erc8183.test.ts`. Run steps 4 and 5 against your own database, and not at the same time as another run on it (`agent.search.test.ts` empties tables).

Opt-in suites that need public mainnet RPCs (read-only forks; not in CI): the S7 address checks (`contracts.addresses.fork.test.ts`, with #183) — start `anvil --fork-url https://mainnet.base.org --port <p1>` and `anvil --fork-url https://arb1.arbitrum.io/rpc --port <p2>` on free ports (8546 is the escrow rehearsal's default) and set `S7_FORK_RPC_8453=http://127.0.0.1:<p1>` / `S7_FORK_RPC_42161=http://127.0.0.1:<p2>`.

## 3. Known local quirks

- **`spec:check` drift that is only line endings.** On a CRLF checkout the regenerated file can differ by line endings alone: if `git diff --ignore-cr-at-eol` is empty there is no drift.
- **5-second test budgets under load.** A full unit run starts ~68 files in parallel; a test that does a cold `await import()` of a large module inside its own body can exceed vitest's default 5 s per test on a slower machine (fixed for `payment-recovery.erc8183.test.ts` in `51ce9df` and `transaction.queue.multinode.test.ts` in item 7: load the module in `beforeAll` with its own timeout). A test that times out in a full run and passes alone is this, not a regression — but fix it the same way rather than rerunning.
- **Database clock.** Docker Postgres can run a few ms ahead of Node: never write 0-ms age cut-offs in DB tests.
- **Dev stack and E2E.** The dev stack's API runs a transaction worker on Redis DB 0 and takes E2E jobs: give the E2E its own index (`E2E_REDIS_URL`).

## 4. Item 7 — the joint DB suite crashed on Windows (resolved: `pool: 'forks'`)

**Symptom (2026-10-14, Windows 11, Node 24.14.1, vitest 1.6.1, Prisma 5.22.0 library engine):** `npx vitest run --config vitest.config.db.ts` (12 files, 231 tests on `24e1f39`) died part-way with `Segmentation fault` (Git Bash, exit 139); natively the exit code is **`0xC0000005` (STATUS_ACCESS_VIOLATION)**. Every file passed on its own; CI on Linux passed. The crash point varied (inside `broadcast-outcome.db.test.ts` after 7 or 14 of its tests, inside `policy-units.migration.db.test.ts`, inside `escrow-chain-truth.db.test.ts`) — the process died while a *later* file was running.

**Measurements** (each line one factor changed against the default; whole suite; DB and Redis of their own):

| Configuration | Runs | Crashed | Notes |
|---|---|---|---|
| default (`threads`, isolate, `fileParallelism: false`) | 11 | **5** | crashed at random points (2nd, 3rd, 5th, 11th file) |
| `--pool=forks` (now the config) | 20 | 0 | 5 + 6 runs by flag, 9 with the committed config; the only failures were the clock flake below |
| `--pool=forks --poolOptions.forks.singleFork` | 3 | 0 | one child process for all files |
| `--pool=threads --poolOptions.threads.singleThread` | 3 | 0 | one thread, never torn down |
| `--no-isolate` (threads) | 3 | 0 | **invalid**: 58–59 tests fail (module mocks leak across files) |
| `--fileParallelism` (threads, files in parallel) | 2 | 0 | 231/231 both times, but the files share the recovery scans' rows by design (see the config comment): too few runs to adopt |
| Prisma `engineType = "binary"` | — | — | **not run**: needs the binary engine downloaded from Prisma's CDN (not done without the owner's go-ahead) |
| Node 22 | — | — | **not run**: only Node 24.14.1 is installed on the machine |

**Minimal reproduction outside vitest** — `scripts/repro-prisma-worker-thread-crash.mjs` (40 worker lifecycles per run, one after another):

| Mode | Runs | Crashed |
|---|---|---|
| thread: Prisma query, `$disconnect()`, thread ends | 8 | 5 |
| thread: Prisma query, no disconnect, thread ends | 8 | 2 |
| thread: Prisma query, `terminate()` | 8 | 2 |
| thread: Prisma query, `$disconnect()`, `terminate()` | 5 | 0 |
| control — thread without Prisma, `terminate()` | 5 | 0 |
| control — child **process**: Prisma query, `$disconnect()`, exit | 5 | 0 |

Seven more `disconnect` runs (from PowerShell, with Node's report flags, and of the committed script): 3 crashed.

```bash
DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you> \
  node scripts/repro-prisma-worker-thread-crash.mjs 40 disconnect   # exit 139 / 0xC0000005 in about half the runs
```

Exit 0 with "all workers completed" means every lifecycle ended as its mode expects. Exit 1 with entries marked `!` means one did not (a child process that failed or was killed, a thread that exited with an unexpected code or timed out — `T!`): not a clean run, and not the crash either; read the child's error above the line.

**Classification:**

- **Environment (root cause):** Prisma's Node-API query engine (`query_engine-windows.dll.node`) crashes the process when a worker thread that loaded it ends, on Windows with Node 24 — reproduced without vitest, never without Prisma, never with processes. Node's diagnostic report (`--report-on-fatalerror --report-uncaught-exception --report-on-signal`) writes nothing for a native access violation, and Windows recorded no Application Error event, so the faulting frame is not identified; whether Node 22 or the binary engine avoid it was not tested (above).
- **Runner (trigger):** vitest 1.x runs each file in a worker thread and ends it afterwards; with one process per file (`forks`) or one long-lived thread there is no crash.
- **Test isolation (ruled out as the cause):** the suites already `$disconnect()` their clients in `afterAll`, and disconnecting does not prevent the crash (the reproduction crashes with and without it). Closing clients is still good hygiene; it is not a fix.

**Fix:** `packages/backend/vitest.config.db.ts` sets `pool: 'forks'` (each DB file in its own process, still one at a time). Measured with the committed config: 9 whole-suite runs, 0 crashes — 4 before the clock fix below (one with that flake), then **5 of 5 at 231 / 231** with both fixes. Duration is unchanged (≈ 1.5–3 min). `npm test` / `npm run test:db` use it on every platform, CI included. The unit suite keeps `threads`: only `agent.search.test.ts` touches the real engine there and none of the 6 full unit runs of this round crashed.

**A second, unrelated flake found on the way (test timing, fixed):** `escrow-chain-truth.db.test.ts` made the recovery tick and the re-poll treat every row as due with **0-ms cut-offs**. The Docker database's clock ran 1–20 ms ahead of Node, so rows stamped with Postgres `NOW()` looked "in the future" and were skipped: 1–7 re-poll / recovery tests failed in 5 of 29 valid whole-suite runs (threads and forks alike, `main` included), never in a single-file run. Lagging Node's `Date` by 500 ms reproduced it deterministically (25 of 81 failed); the suite now uses a 60-s allowance (as the A6b tests do) and passes under that lag. Measure the skew with `SELECT clock_timestamp()` against `Date.now()` if a time-based DB test flakes.

If a joint run ever crashes again: rerun the file list one file per process to see whether anything fails (`for f in src/__tests__/*.db.test.ts; do npx vitest run --config vitest.config.db.ts "$f" || echo "FAILED $f"; done`), then run the reproduction script to tell an environment crash from a test failure.
