# AgentFi alpha — local quickstart

**What you will see (measured: the demo takes 2.5 minutes on Windows and 3.6 on a Linux container; `npm ci` took about 6 minutes on Windows and 4m53 on Linux; the Linux rehearsal needed about 21 minutes to the first result, installing the prerequisites included):** an agent buys paid resources over x402 under rules you set; a purchase that breaks the rules is stopped **before anything is signed**; a purchase whose answer was lost is proven from the chain **without being paid twice**; a payment that never settled is released **only on proof**. Payment (money) and delivery (content) are tracked separately.

**You need no credentials, no funds and no accounts.** Nothing in this guide signs with a real key, spends real money or sends a transaction to a public network.

## 0. Modes — read this first

Every command in this guide is labelled with one of three modes. They are not interchangeable.

| Mode | What it is | In this guide |
|---|---|---|
| **SIMULATION** | A fake chain inside the test process (unit and Postgres tests). Proves the logic, not the real USDC contract. | `npm test` (section 7). |
| **LOCAL FORK** | A **local** Anvil that forks Base Sepolia **read-only** (the real USDC contract code and state, a chain only you can write to), a seller we control with the real `@x402/evm` facilitator, our API and worker processes. | **Sections 1-5 (the demo).** |
| **PUBLIC TESTNET** | The real Base Sepolia network, with funded wallets and an independent seller. | **NOT part of this quickstart, and not yet done.** Do not infer from the demo that it works there. |

## 1. Requirements

| Need | Version / detail | How to check |
|---|---|---|
| OS | Verified on **Windows 11 (Git Bash)**. Run once on **Debian 12 (container, as root), Node 22.23.2, Postgres 16.16, Redis 7.0.15, anvil 1.7.1, on 2026-11-18, by an agent rehearsal of a new integrator** (demo exit 0, 23 invariants; this is an internal rehearsal, not feedback from an outside user). macOS was not run. | |
| Node.js | **22** (what CI uses). `package.json` allows `>=20`. Verified here on 24.14.1. | `node -v` |
| npm | Comes with Node. | `npm -v` |
| Git | Any recent version. | `git --version` |
| Postgres 16 and Redis 7 | Easiest with Docker (`docker compose`, below). Or any local Postgres/Redis you can reach. | `docker --version` |
| Foundry `anvil` | **Only 1.7.1 was verified; newer versions are untested.** CI installs the Foundry nightly, and Anvil 1.8+ adds an L1 fee on chain 84532 (see commit `713882b`); this demo checks USDC balances, not gas, but it was not run with 1.8. Install 1.7.1 with `foundryup --install 1.7.1` (the flag is from `foundryup --help`; that exact install was not run here). | `anvil --version` |
| Network egress | HTTPS to a **public read-only RPC** of Base Sepolia (default `https://sepolia.base.org`). The fork reads state from it; nothing is written to it. | `npm run alpha:demo -- --check` |
| Free ports | 8547 (Anvil), 3157 (API), 5432 (Postgres), 6379 (Redis). | the same check |

Install Foundry (provides `anvil`) from <https://book.getfoundry.sh/getting-started/installation>. The demo finds `anvil` on `PATH` or in `~/.foundry/bin`. After the installer, `foundryup` is usually **not** on `PATH` yet: run `export PATH="$HOME/.foundry/bin:$PATH"` and then `foundryup --install 1.7.1` (or `~/.foundry/bin/foundryup --install 1.7.1`; the Linux rehearsal used exactly this).

**Postgres and Redis without Docker** (what the Linux rehearsal did; not run on Windows). Only Postgres **16** was tested (on Debian 12 it comes from the PGDG apt repository, not the default one); 15 was not tried. The demo creates and resets its own database, so the role needs `CREATEDB` (or superuser): `CREATE ROLE agentfi LOGIN PASSWORD 'agentfi' CREATEDB;`. Start Redis bound to loopback only (`redis-server --bind 127.0.0.1`).

**The demo WIPES data. Read this before running.** By default it **truncates every table** of the Postgres database `agentfi_e2e_x402` and **flushes** (`FLUSHDB`) Redis logical database 14, then starts and stops its own Anvil, API and worker processes. **Other local work that shares those defaults would be wiped** (another checkout or agent running the same demo, a database you named the same). To avoid that, point the demo at private targets (a database and a Redis DB number only you use) with `X402_DEMO_DATABASE_URL` and `X402_DEMO_REDIS_URL` (section 6). Guards, enforced twice (by `npm run alpha:demo` and again by the harness, so running `npm run demo:x402:fork` directly is covered too):

- both targets must be on a **loopback host** (`localhost`, `127.0.0.1`, `::1`) unless you set `X402_DEMO_ALLOW_REMOTE=1`;
- the database name must contain **`e2e`, `demo` or `test` as a whole word between underscores** (`agentfi_e2e_x402`, `agentfi_you_test`: yes; `latest`, `contest`, `demo2`: no), and is never `agentfi`, `agentfi_c5` or `agentfi_alpha`; the Postgres URL may carry only the parameters `schema`, `connection_limit`, `sslmode`, `pool_timeout`, `connect_timeout` (`host`, `hostaddr`, `service`, `options` could redirect the connection and are refused);
- the Redis logical DB is never 0 (the dev stack's);
- `npm run alpha:demo` prints a banner with the exact Postgres host/database and Redis host/DB it will wipe, **before** it starts; if either target is not the documented default it asks you to confirm: type `wipe` at the prompt, or pass `--yes` (`npm run alpha:demo -- --yes`). Without a terminal and without `--yes` it refuses. The direct harness run prints the same scope line but does not ask.

`npm run alpha:test` runs the self-test of these guards (remote host, non-test database name and Redis DB 0 are refused).

## 2. Run the demo — LOCAL FORK

From a clean clone. `<TAG>` is the release tag of the alpha; **until a tag exists, use the commit SHA** the alpha announcement names.

```bash
git clone https://github.com/felippeyann/agentfi.git
cd agentfi
git checkout <TAG>            # a tag, or the commit SHA until a tag exists (see the note below)
npm ci
docker compose -f docker-compose.dev.yml up -d postgres redis
npm run alpha:demo
```

`<TAG>` must be a commit that **contains `alpha:demo`** (this page and the script arrive with PR #205: any older commit does not have them). It is a placeholder until a tag is cut. Until then use: `32b3593` (the merge of PR #205, the first commit on `main` with `alpha:demo`; any later commit on `main` also works).

- `npm run alpha:demo` first checks the prerequisites and says what is missing (Node, dependencies, `anvil`, Postgres, Redis, free ports, the RPC) and how to fix it; it starts nothing until all pass. `npm run alpha:demo -- --check` only checks.
- It then generates the Prisma client and runs the demo (`npm run demo:x402:fork` in `packages/backend`), which creates the database if needed, applies the migrations, and runs scenarios A-E. **Expect about 2.5 minutes.** It exits `0` only if every invariant held; the first broken invariant stops it with `INVARIANT BROKEN`.
- A transcript is written to `<your temp dir>/agentfi-alpha-demo-transcript.txt` (override with `X402_DEMO_TRANSCRIPT`).
- Stop Postgres and Redis afterwards with `docker compose -f docker-compose.dev.yml down` (only if you started them that way; with your own Postgres and Redis there is nothing to stop here: the demo leaves its test database in place, and the next run wipes it).
- A successful run ends with `All N invariants held.` (N is counted, 23 today); a failure stops at the first broken invariant and exits 1.

## 3. What the demo shows

The demo runs **one buyer agent** (the *provider* of a job) with the rules below, against a seller and the real USDC contract on the local fork. Lines starting with `✓` are checked invariants. The excerpts are from a real run (section 9); transaction hashes and ids differ on every run.

| What you asked to see | Demo section | Result |
|---|---|---|
| (a) an allowed purchase | **B** | settled, proven on-chain by the worker with no operator command |
| (b) a block **before the authorization is signed** | **A** | per-payment limit (policy) **and** the job's own remaining budget; 0 requests reach the seller |
| (c) recovery of a failed or uncertain response, with no double charge and no wrongful release | **C, D, E** | proven from the chain; one transition per payment; released only once proven unused |

### Section A — the rules, and a purchase that breaks them (block before signing)

The operator sets the buyer's rules; the agent cannot raise them; a purchase above a rule is refused before a signature exists. Two different budgets apply: the **policy** (per-payment and daily limits, who may be paid) and the **job's own reward** (what is left of it). The demo breaks each in turn.

```text
## A. Operator sets the budget
  ✓ operator PATCH policy → 200 (≤ 0.50 USD per payment, ≤ 3.00 USD per day, only to the seller)
  ✓ the agent raising its own per-payment limit → 403
  job …: budget 5.00 USDC · agent wallet 0x…: 5.00 USDC on the fork
  ✓ a 0.60 purchase (limit 0.50) → 403 POLICY_VIOLATION rule maxValuePerTxUsd; 0 paid requests reached the seller
  ✓ a 0.30 purchase on a job with 0.20 left → 402 BUDGET_EXCEEDED (price 0.3 USDC, remaining 0.2 USDC); ledger row failed_before_signing, no authorization nonce; the seller saw 1 unpaid probe and 0 paid requests
```

### Section B — an allowed purchase, and partial delivery

```text
## B. Purchases proven automatically by the worker (no operator command)
  ✓ allowed purchase → 200 settled (reported by the seller)
  ✓ a 70 KiB resource → 200, body cut at the 64 KiB read limit
  ✓ the worker proved both on-chain (chainVerifiedAt set) on its own
  ✓ partial delivery recorded: 65536 bytes received, resourceTruncated=true, sha256 …
```

"Settled (reported)" is what the seller said. "Proven" is what the chain says; the worker moves a payment to proven by itself.

### Section C — an uncertain response, a dead evidence source, a killed worker (recovery)

The seller settled on-chain but the response was lost, while the chain-evidence source is down, and then the worker is killed.

```text
## C. Lost response while the evidence source is DOWN; worker killed and restarted
  ✓ seller settled on-chain but the response was lost → 502 PAYMENT_OUTCOME_UNKNOWN
  ✓ source down: row stays unknown (counted), attempts=2, next look … — not concluded, not released
    (meanwhile the chain already holds 3 transfers: the money DID move; the ledger simply waits for proof)
  ✓ worker w1 KILLED (SIGKILL) mid-backoff
  ✓ a NEW worker process resumed and proved it: tx 0x…
  ✓ retry with the same paymentId → ledger replay; the seller saw exactly 1 paid request (nothing re-signed or re-fetched)
```

While the evidence is unavailable the payment stays **unknown and counted against the budget**: an unreadable chain is never read as "no payment". A retry with the same `paymentId` returns the ledger row; it does not sign or fetch again.

### Section D — two workers at once

```text
## D. Two reconciliation workers at once
  ✓ 3 lost-response payments, 2 concurrent workers: 3 transitions written, each payment once (A: 1, B: 2)
```

### Section E — a signature that never settles

The seller takes the signature and never settles. The worker waits while the authorization could still be used, then releases the budget only after the chain proves it can never move money (the head is past `validBefore`, and a second evidence source agrees on the block).

```text
## E. Seller takes the signature and never settles
  ✓ pay /report-hold → 502 PAYMENT_OUTCOME_UNKNOWN
  ✓ worker: "wait" — unused but valid until validBefore; amount held; next look …
  ✓ after validBefore + margin on-chain, confirmed by the second evidence source at the same block hash, the worker marked it expired (proven unused) — budget released, no operator command
```

On a local fork the "second evidence source" is the same Anvil node reached directly: it shows the wiring, not independence. In production it must be a different provider.

### The evidence, and the operator view

The demo then compares the **chain** with the **ledger** and prints the operator report (`npm run x402:ops -- status`):

```text
## Financial evidence (fork) vs the ledger
  ✓ 6 USDC transfers on-chain (allowed, partial, 4 lost responses) — got 6
  ✓ every on-chain transfer is a proven ledger row with the same tx hash, and vice versa
  ✓ agent wallet −1.80 USDC, seller +1.80 USDC
  ✓ ledger: committed 1.8, proven 1.8, open 0 USDC
  ✓ the partial purchase stays visible: money proven, delivery PARTIAL, operator action
  ✓ seller saw exactly one paid request per purchase (no duplicate authorization, no re-fetch)
```

```text
      Job …  [ACCEPTED] budget 5 · committed 1.8 (proven 1.8, reported 0, open 0) · remaining 3.2
        - demo-premium-… failed_before_signing   0.6 USDC  money:not-moved  delivery:unknown  [not counted]
        - demo-allowed-… settled                 0.3 USDC  money:proven     delivery:delivered (HTTP 200)
        - demo-partial-… settled                 0.3 USDC  money:proven     delivery:partial (HTTP 200)
        - demo-dropped-… settled                 0.3 USDC  money:proven     delivery:unknown
        - … three more lost-response purchases, each settled and proven …
        - demo-held-…    expired                 0.3 USDC  money:not-moved  delivery:unknown  [not counted]
```

The refused 0.60 purchase and the expired one are **not counted**: the budget they held was released, with a reason. The six paid purchases (three more lost-response ones are omitted above) moved 1.80 USDC on the fork, every one proven by a chain transfer.

## 4. Part 2 — the same flow by hand (REST)

**Read this before you try it.** The buy step (`pay-resource`) needs an x402 **seller**, a chain, and a funded buyer wallet. Outside the demo you have none of the three: the seller (`x402-demo-seller.ts`) and the wallet funding (Anvil storage writes) are part of the demo harness, which tears everything down when it ends. So **the manual path can be followed up to creating and accepting the job; the purchase itself only runs inside the demo.** What follows is the exact request sequence the demo performs (taken from the harness and checked against `docs/api/openapi.yaml` and a running API), so you can read, adapt or replay it.

There is **no standalone purchase endpoint**: an agent buys *inside a job*. `POST /v1/jobs/{id}/pay-resource` is paid by the job's **provider** agent, on an **ACCEPTED** job, from the job reward (the budget), subject to the provider's policy.

**Security: this API listens on all interfaces (`0.0.0.0`), and the secrets below are public demo values.** Run it only on a trusted network, or replace `API_SECRET` and `ADMIN_SECRET` with fresh values (`openssl rand -hex 32`, and use the same value in the `K=` line). The demo backend (port 3157) also listens on all interfaces while the demo runs, with its own public demo secrets.

Run an API locally to follow steps 1-4 (LOCAL FORK-style environment without a chain; no wallet funds are involved). In `packages/backend`, with Postgres and Redis up and the migrations applied (`npx prisma migrate deploy` with `DATABASE_URL` set):

```bash
export NODE_ENV=development API_PORT=3177 WALLET_PROVIDER=local TRANSACTION_WORKER_ENABLED=false
export API_SECRET=dev-api-secret-min-32-chars-long-xxxxx ADMIN_SECRET=dev-admin-secret-min-32-chars-long-yyyy
export OPERATOR_FEE_WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 ALCHEMY_API_KEY=stub
export DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_alpha REDIS_URL=redis://localhost:6379/5
export SYNTHETIC_TEST_PRICES_USD=84532:0x036CbD53842c5426634e7929541eC2318f3dCF7e=1
npx tsx src/index.ts
```

`SYNTHETIC_TEST_PRICES_USD` is required: a testnet asset has no oracle price, so without it creating a job on chain 84532 is refused (`PRICE_UNAVAILABLE`). Then, in another terminal (`B` is the API, `K` the operator key set above; `curl` and the response ids are shown for readability, copy them by hand or with `jq`):

```bash
B=http://localhost:3177; K=dev-api-secret-min-32-chars-long-xxxxx

# 1. Two agents: a buyer (will be the job's provider) and a requester. The response holds the agent id and a one-time apiKey.
curl -s -X POST $B/v1/agents -H "content-type: application/json" -H "x-api-key: $K" \
  -d '{"name":"buyer","chainIds":[84532],"policy":{"cooldownSeconds":0}}'
curl -s -X POST $B/v1/agents -H "content-type: application/json" -H "x-api-key: $K" \
  -d '{"name":"requester","chainIds":[84532],"policy":{"maxValuePerTxUsd":"10","maxOutflowPerTxUsd":"10","cooldownSeconds":0}}'

# 2. The operator sets the buyer's rules (operator key). allowedRecipients = who it may pay.
curl -s -X PATCH $B/v1/agents/<BUYER_ID>/policy -H "content-type: application/json" -H "x-api-key: $K" \
  -d '{"maxValuePerTxUsd":"0.50","maxDailyVolumeUsd":"3.00","allowedRecipients":["<SELLER_ADDRESS>"],"reason":"alpha quickstart budget"}'
#    The buyer cannot raise its own limits: the same PATCH with the BUYER's apiKey returns 403.

# 3. The requester posts a job with a USDC reward: this is the budget the buyer may spend.
curl -s -X POST $B/v1/jobs -H "content-type: application/json" -H "x-api-key: <REQUESTER_API_KEY>" \
  -d '{"providerId":"<BUYER_ID>","payload":{"task":"buy usage reports"},"reward":{"amount":"5.00","token":"USDC","chainId":84532}}'

# 4. The buyer accepts it. Only an ACCEPTED job can pay.
curl -s -X PATCH $B/v1/jobs/<JOB_ID> -H "content-type: application/json" -H "x-api-key: <BUYER_API_KEY>" \
  -d '{"status":"ACCEPTED"}'

# 5. The buy (needs a seller and a funded wallet: only runs inside the demo).
curl -s -X POST $B/v1/jobs/<JOB_ID>/pay-resource -H "content-type: application/json" -H "x-api-key: <BUYER_API_KEY>" \
  -d '{"url":"<SELLER_URL>/report","method":"GET","paymentId":"my-first-purchase-0001"}'
```

What steps 1-4 return on a real API (verified): `201` agents with `id`, `apiKey`, `safeAddress`; `200` policy with your limits; `201` job with `reservationStatus: PENDING`; `200` job `status: ACCEPTED`. Two refusals worth trying on step 5, both verified: from the **requester** the answer is `403 NOT_PROVIDER`; a URL on `127.0.0.1` is refused `400 INVALID_URL` (`refusal: private-host`) unless the API runs with `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true`, which only the demo sets (it is for local sellers; never set it on a shared API).

**Can `docker-compose.dev.yml` reach the x402 flow?** No. The zero-credential dev stack (`docs/dev-quickstart.md`) runs agents, policy, jobs and the MCP server, but (1) it does not set `SYNTHETIC_TEST_PRICES_USD`, so a USDC job on Base Sepolia is refused; (2) it does not set `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS`, so it cannot reach a seller on your machine; (3) its agents' local wallets hold no USDC and it has no chain behind them; (4) it sets no RPC for the reconciliation worker. The demo supplies all four. (This was established by running the same steps on an API with the dev stack's environment, not by starting the compose stack itself.)

**The seller and the wallet funding live in the demo harness, so the purchase step only runs against it.** Section 10 runs a real agent framework against exactly that backend (`npm run alpha:framework`). Every compatibility-matrix row not marked as run against the real local backend ran against the **stub**.

Reading the results by hand: `npm run x402:ops -- status` prints the operator report shown in section 3. **It needs more than `DATABASE_URL`**: the CLI loads the backend configuration, and without `NODE_ENV` it refuses to start inside a container (`FATAL: NODE_ENV is not set ...`). The minimal environment (checked by running it; `<...>` are yours; the secrets can be any 32+ characters because the CLI only reads the database):

```bash
cd packages/backend
NODE_ENV=development WALLET_PROVIDER=local \
DATABASE_URL=<the demo database> REDIS_URL=<the demo redis> \
ALCHEMY_API_KEY=x OPERATOR_FEE_WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
API_SECRET=<32+ characters> ADMIN_SECRET=<32+ characters> \
npm run x402:ops -- status --agent <agent id>        # or --job <job id>
```

**Which database holds the demo's data:** the one in `X402_DEMO_DATABASE_URL` (default `postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402`), and it is wiped at the start of the next run. The demo prints this command, with your values filled in, at the end of its output. The agent id is printed in the `Operator view` of the transcript; `npm run alpha:serve` (section 10) writes a ready-to-source `operator.env`.

## 5. Glossary

**Payment (money)** and **delivery (content)** are two different facts, tracked separately.

- **Payment states** (what the ledger says about the money):
  - **reserved** — the amount is set aside in the budget; nothing is signed yet.
  - **pending** — a payment authorization is signed and being sent.
  - **settled** — the seller *reported* success. Shown as **reported** until the chain proves it; then **proven** (a USDC transfer for exactly that payment is found on-chain).
  - **unknown** — the request failed or timed out **after signing**: the money may or may not have moved. It stays **counted against the budget** (it is never assumed "not paid").
  - **refused** — the seller answered the signed payment without reporting a settlement. It still counts: the seller may hold a valid authorization, and its answer is not proof that nothing moved.
  - **expired** — proven by the chain to be unable to move money (never used and past its validity, or cancelled). The amount is **released** and is not counted. This is the only way budget returns without a transfer to point at, which is why it needs a second evidence source.
  - **failed_before_signing** — stopped by a rule before any signature. Not counted.
- **Delivery states** (what arrived): **delivered** (HTTP 2xx and the body arrived), **partial** (the body was cut at the 64 KiB read limit), **not-delivered** (the seller answered an error), **unknown** (no paid response arrived at all).
- **Counted** means "holds budget": reserved, pending, settled, unknown, and refused while its authorization could still be used.
- **What automatic reconciliation does.** The worker looks at every payment that is not proven or terminal, reads the USDC contract, and moves a payment **only on chain proof**: used with a matching transfer → proven; unused past its validity (confirmed by a second source) or cancelled → expired. If the evidence source is down it backs off and retries; after several failures it **alerts the operator once** and keeps retrying. It **never signs, sends, retries or re-fetches** a paid resource.
- **What still needs a human.** Payments the chain cannot judge (a different authorization scheme, rows without the needed evidence, evidence sources that disagree) are **stopped and escalated**. Run `npm run x402:ops -- status` (in `packages/backend`): it lists each payment with an `automatic` line (next look, `ALERT`, `STOPPED`) and an `ACTION` only where a person is needed, and `x402:ops resolve` records a human decision with who and why (an attestation, never shown as proof).
- **Two things in the operator output look like errors and are not.** A line `reason: … fetch failed` on a row that ends up `money:proven` is the seller-side failure the buyer saw at the time (a lost response); the chain later proved the money moved, so the row is settled and the reason is only history. A `WARN: SYNTHETIC_TEST_PRICES_USD is set` line is expected: a testnet asset has no price oracle, so the demo gives USDC a synthetic price of 1 USD for the policy limits.
- **Reconciliation proves payment; it does not recover content.** A proven payment with delivery `partial` or `unknown` means the money moved but the content did not fully arrive. Take it up with the seller. **A paid resource is never refetched** by AgentFi: fetching it again would be a new purchase.

## 6. Configuration and cleanup

| Variable | Default | Meaning |
|---|---|---|
| `X402_DEMO_DATABASE_URL` | `postgresql://agentfi:agentfi@localhost:5432/agentfi_e2e_x402` | **Truncated** by the demo. Created on first run. Loopback host only; the name must contain `e2e`, `demo` or `test` as a whole underscore-separated word; `agentfi`, `agentfi_c5`, `agentfi_alpha` are refused; only the URL parameters listed in section 2 are allowed. |
| `X402_DEMO_REDIS_URL` | `redis://localhost:6379/14` | Logical DB **flushed** by the demo. Loopback host only; DB 0 is refused. Pick a number nothing else uses. |
| `X402_DEMO_ALLOW_REMOTE` | unset | `1` lifts the loopback-host rule. Only if you mean to wipe a remote Postgres/Redis. |
| `--yes` (to `npm run alpha:demo`) | | Confirms a wipe of non-default targets without a prompt (needed without a terminal). |
| `E2E_ANVIL_FORK_URL` | `https://sepolia.base.org` | Read-only Base Sepolia RPC to fork. |
| `E2E_ANVIL_FORK_BLOCK_NUMBER` | latest | Pin a block (a pruned public node serves only recent blocks). |
| `X402_DEMO_ANVIL_PORT` / `X402_DEMO_BACKEND_PORT` | `8547` / `3157` | Local ports. |
| `X402_DEMO_TRANSCRIPT` | `<tmp>/agentfi-alpha-demo-transcript.txt` | Where the transcript is written. |

If a run is interrupted, a stray `anvil` may keep port 8547: find it (`netstat -ano` on Windows, `lsof -i :8547` elsewhere) and stop only that process.

## 7. Tests that back the same behaviour — SIMULATION

**Use a dedicated throwaway database** (for example `agentfi_<you>_test`, which you create) and a **non-zero Redis logical DB**: the Postgres suites **empty whatever `DATABASE_URL` points to**. Never point them at the dev stack's `agentfi` database or Redis DB 0.

`cd packages/backend && npm test` runs the unit and Postgres suites against a fake chain, including `resource-payment.auto-reconcile.db.test.ts` (recovery, restarts, two workers, an expired worker lease while another worker takes the row). They need the CI environment (`DATABASE_URL`, `REDIS_URL`, secrets set to dummy values; see `docs/operations/local-validation.md`). They prove the logic; only the demo exercises the real USDC contract.

## 8. What this does not show

- It is **not** the public testnet and **not** an independent seller: the seller, the facilitator and the chain are ours, on one machine.
- It does not show **mainnet**, real funds, a real marketplace, or a production deployment.
- The Postgres/Redis, ports and transcripts above are local; nothing is exposed to a network.
- Reconciliation here uses a "latest" head on a local chain (`X402_RECONCILE_LOCAL_CHAIN=true`). On a real network the default is the **finalized** head and a second provider is required to release budget.

## 9. Verified run

The commands of section 2 were followed literally, from a fresh `git clone`, on **2026-11-16**: commit `5ed0cc9`, Windows 11 (Git Bash), Node 24.14.1, anvil 1.7.1, Postgres 16 and Redis 7 in Docker, forking `sepolia.base.org`. The demo exited `0` after about 2.5 minutes with 23 invariants checked. After the review fixes (destructive-target guards, stronger budget-block assertion) the demo was run once more end to end from the PR branch with private targets and `npm run alpha:demo -- --yes`: exit `0`, 23 invariants again. Two deviations, both because that machine already ran other work on the default resources: the `docker compose … up -d postgres redis` step was skipped (Postgres and Redis were already up on 5432/6379), and `X402_DEMO_DATABASE_URL`, `X402_DEMO_REDIS_URL`, `X402_DEMO_ANVIL_PORT` and `X402_DEMO_BACKEND_PORT` pointed at a private database, Redis DB and ports (section 6). The default database, Redis DB and ports were not exercised beyond `npm run alpha:demo -- --check`. Not run on that machine: macOS. Linux (Debian 12 container, Node 22.23.2, Postgres 16.16, Redis 7.0.15, anvil 1.7.1) was run once on 2026-11-18 by an agent rehearsal that followed this page as a new integrator: demo exit 0, 23 invariants, about 21 minutes to the first result (`npm ci` 4m53, demo 3m34).

## 10. Run it through an agent framework — LOCAL FORK, scripted model

Sections 2-3 drive the backend with a test script. This section drives **the same backend** with a real agent framework: the **OpenAI Agents SDK** (Python) calls the **AgentFi MCP server** (stdio, built from this checkout), which calls the real local API; the API signs a real EIP-3009 authorization with the buyer agent's wallet and the seller's real `@x402/evm` exact facilitator settles it on the local Anvil fork.

**What is real and what is not.** Real: the framework, the MCP stdio transport and server, the API and worker, the signature, the `@x402/evm` facilitator, the USDC contract code on a **local fork** of Base Sepolia. **Not real:** the model is a **scripted stand-in** (a fixed list of tool calls: no LLM ran, no key, no cost; never read this as "a model decided to buy"); the seller is **ours**; the chain is a **local fork, not a public testnet**; the API accepts a seller on `127.0.0.1` only because the harness starts it with `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true` (a non-production switch for local sellers; never set it on a shared API). The agent is restricted to the payer-safe tools `get_my_agent_profile`, `get_policy`, `get_job`, `pay_for_resource`, and the example asserts it.

**Prerequisites** (on top of section 1): Python **3.10 or newer** (the `Requires-Python` of both pinned packages; 3.14.3 was run) and the example's pinned packages (`openai-agents==0.24.0`, `mcp==2.3.0`) in a virtual environment. On Debian/Ubuntu `python3 -m venv` needs the `python3-venv` package. The same destructive-target rules as the demo apply: private targets and `--yes` (section 6).

```bash
# repository root, after npm ci (section 2), with Postgres, Redis and anvil as in section 1

# Linux / macOS (NOT run: only Windows was run for this section)
python3 -m venv .venv
.venv/bin/pip install -r examples/openai-agents/requirements.txt
export ALPHA_PYTHON=.venv/bin/python

# Windows, Git Bash (what was run)
python -m venv .venv                 # what was run; the py launcher (py -m venv .venv) also works if installed
.venv/Scripts/pip install -r examples/openai-agents/requirements.txt
export ALPHA_PYTHON=.venv/Scripts/python.exe

# both: private targets (WIPED / FLUSHED), then the run
export X402_DEMO_DATABASE_URL=postgresql://agentfi:agentfi@localhost:5432/agentfi_<you>_demo
export X402_DEMO_REDIS_URL=redis://localhost:6379/11
npm run alpha:framework -- --yes
```

`npm run alpha:framework` checks the prerequisites (the demo's checks plus the Python import, printing the versions it found), prints the destructive-target banner, builds the MCP server, starts the backend (`demo:x402:serve`: Anvil fork, API, worker, seller, an operator policy of at most 0.50 USD per payment and 3.00 per day to the seller only, a 5.00 USDC job and a 0.20 USDC job, the buyer wallet funded with 5.00 USDC **on the fork**), runs the framework twice, reads the ledger, the chain and the seller, checks every invariant, and stops everything (also on Ctrl+C). It exits 0 only if all held; the first broken invariant makes it exit 1. Allow about 4 minutes on top of the build. The transcript is written to `<tmp>/agentfi-alpha-framework-transcript.txt` (`X402_FRAMEWORK_TRANSCRIPT`).

**Running the pieces yourself.** `npm run alpha:serve -- --out-dir <dir> --yes` starts the backend with the same checks, banner and `--yes` rule (a relative `<dir>` is resolved against the directory you run npm in), prints `SERVE READY` and keeps running until Ctrl+C or until `<dir>/stop` exists. It writes two files:

- `<dir>/agent.env`, exactly: `AGENTFI_API_URL`, `AGENTFI_API_KEY` (the buyer agent's own key), `AGENTFI_JOB_ID` (the 5.00 job), `AGENTFI_SMALL_JOB_ID` (the 0.20 job), `SELLER_URL`. No operator secret and no chain RPC (the Anvil RPC can rewrite balances and storage, so it is not the agent's).
- `<dir>/operator.env`: the demo's operator secrets, the backend configuration `x402:ops` needs, `ANVIL_RPC_URL`, `AGENTFI_AGENT_ID` and a read-only evidence endpoint (`CONTROL_URL`). First line `# OPERATOR secrets (demo only) - never give this file to an agent`; mode 0600 on Linux/macOS (Windows does not apply POSIX modes). Never give it to an agent.

Then, in a second terminal: `.venv/Scripts/python.exe examples/openai-agents/agent.py --mode stub --backend env-file --env-file <dir>/agent.env --scenario allowed` (or `--scenario blocked`; `.venv/bin/python` on Linux/macOS), and read the ledger with `set -a; . <dir>/operator.env; set +a; cd packages/backend && npm run x402:ops -- status --job $AGENTFI_JOB_ID`. Every value in both files is written without shell metacharacters (the backend refuses to write one that has any), so sourcing them is safe.

**Before you connect your own agent:** [payer-setup.md](payer-setup.md) says which credential the agent gets, the reference policy (this section's buyer is close to it: it leaves `allowedTokens` empty and the cooldown at 0), what the agent's key can still do besides buying (it is not an x402-only key), and how to check the permissions in force: `npm run x402:ops -- payer --agent <id>` (with `operator.env` sourced, from `packages/backend`).

### What you see: an allowed purchase

Verbatim from the recorded run (section "Verified run" below; ids, addresses and hashes differ on every run). The versions the run found, and the framework's trace:

```text
  ok    python 3.14.3 | openai-agents 0.24.0 | mcp 2.3.0 | openai 3.54.0 | AgentFi MCP server (packages/mcp-server from this checkout) 0.5.0 | node 24.14.1 | win32
    [tools exposed to the agent] ['get_policy', 'get_my_agent_profile', 'get_job', 'pay_for_resource']
    [tool call] pay_for_resource {"job_id": "cmwlqj3xt0009ewefphrxang1", "url": "http://127.0.0.1:63871/report", "payment_id": "fw-allowed-112df35f56-0000001"}
```

The tool result is the full ledger row plus the job's budget (condensed from the transcript: the payment's `status` is `"settled"`, `amount` `"300000"`, a non-null `authorizationNonce` and `settlementTxHash`, `responseStatus` 200, and):

```text
        "remainingBudget": {
          ...
          "total": "5000000",
          "spent": "300000",
          "remaining": "4700000",
          "remainingFormatted": "4.7"
        },
```

The operator's view, the Anvil Transfer log and the seller's counters (verbatim):

```text
      Job cmwlqj3xt0009ewefphrxang1 [ACCEPTED] budget 5 · committed 0.3 (proven 0.3, reported 0, open 0) · remaining 4.7
        - fw-allowed-112df35f56-0000001 settled                    0.3 USDC  money:proven  delivery:delivered (HTTP 200)
            http://127.0.0.1:63871/report → 0x9e9B22E97Ae3C5234e0504AD208ceeBf20B51B9d  tx 0x4787c11ca9ee09fe50256c82034a16f89e5486185187febe04d9df6e088b537f
            reconciled: transfer proven on-chain in 0x4787c11ca9ee09fe50256c82034a16f89e5486185187febe04d9df6e088b537f, block 60305585 (was settled)
  Anvil Transfer logs (agent -> seller): [{"tx":"0x4787c11ca9ee09fe50256c82034a16f89e5486185187febe04d9df6e088b537f","from":"0x759cE075827CC9c8301653fDDf369244546fA513","to":"0x9e9B22E97Ae3C5234e0504AD208ceeBf20B51B9d","value":"300000","block":"60305585"}]
  seller request counters: {"plain":{"/report":1},"paid":{"/report":1}}
  paymentId fw-allowed-112df35f56-0000001 -> tx 0x4787c11ca9ee09fe50256c82034a16f89e5486185187febe04d9df6e088b537f
  ✓ agent wallet 5.00 USDC -> 4.70 USDC (-0.30)
```

**How to read the ledger line, three separate facts.** *Money*: `settled` is the seller's word; `money:proven` means the worker found a USDC Transfer for exactly this payment on-chain (in the tool result the row still has `chainVerifiedAt: null`: the worker proves it a few seconds later, with no operator command). *Delivery*: `delivered (HTTP 200)` is what arrived (with its SHA-256); it says nothing about whether the money moved, and the other way round. *Budget*: `committed 0.3 … remaining 4.7` is what the job's 5.00 reward still allows; a payment counts against it from the moment it is reserved.

### What you see: blocked purchases (before anything is signed)

The scripted model then tries two purchases the rules forbid: `/report` (0.30 USDC) on the job that has 0.20 left, and `/report-premium` (0.60 USDC; the policy allows 0.50 per payment) on the big job. Verbatim:

```text
    [tool call] pay_for_resource {"job_id": "cmwlqj3z4000bewef4nbensbe", "url": "http://127.0.0.1:63871/report", "payment_id": "fw-overbudget-ec6d978dc8-00001"}
    [tool call] pay_for_resource {"job_id": "cmwlqj3xt0009ewefphrxang1", "url": "http://127.0.0.1:63871/report-premium", "payment_id": "fw-overpolicy-ec6d978dc8-00001"}
  ✓ over-budget tool result: paid=false HTTP 402 BUDGET_EXCEEDED (price 0.3, remaining 0.2)
  ✓ over-policy tool result: paid=false HTTP 403 POLICY_VIOLATION (rule maxValuePerTxUsd)
```

```text
        - fw-overpolicy-ec6d978dc8-00001 failed_before_signing      0.6 USDC  money:not-moved  delivery:unknown  [not counted]
            reason: Payment of 0.6 USDC exceeds the policy's per-transaction limit of 0.50 USD (maxValuePerTxUsd)
        - fw-overbudget-ec6d978dc8-00001 failed_before_signing      0.3 USDC  money:not-moved  delivery:unknown  [not counted]
            reason: Cheapest acceptable option on [internal-url] costs 0.3 USDC, above the cap of $0.2
  agent wallet 4.70 USDC after (before this run: 4.70); seller counters {"plain":{"/report":2,"/report-premium":1},"paid":{"/report":1}}
  ✓ over-budget: ledger row failed_before_signing for 0.30 USDC, authorization nonce null, no settlement tx, no paid response
  ✓ over-policy: ledger row failed_before_signing for 0.60 USDC, authorization nonce null, no settlement tx, no paid response
  ✓ no USDC transfer from the agent wallet to the seller; the agent wallet balance is unchanged at 4.70 USDC
  ✓ zero paid requests reached the seller during the blocked run
```

(The two `failed_before_signing` rows are verbatim lines from two different `x402:ops status --job` blocks in the transcript, shown together here.)

**How the operator recognises a block:** the row says `failed_before_signing` with `money:not-moved` and `[not counted]`, and a `reason:` line names the rule. Both kinds of block leave a ledger row (a policy block does too), both with a **null authorization nonce**: no signature ever existed. Outside the backend, nothing moved either: no new Transfer from the agent wallet to the seller, the wallet unchanged at 4.70 USDC, and the seller counted only unpaid 402 probes during the blocked run (its one paid request is the allowed purchase).

**Verified run.** The excerpts above are from the run recorded at commit `a4edf4a` of the PR branch (later commits change documentation only), on 2026-11-18, Windows 11 (Git Bash), Node 24.14.1, Python 3.14.3, openai-agents 0.24.0, mcp 2.3.0, anvil 1.7.1, Postgres 16 and Redis 7 in Docker, private database, Redis DB and ports: exit 0, `OK: 28 invariants held.` Earlier on the same day the section was also followed literally from a fresh `git clone` of the branch (commit `4b02c24`): exit 0, 28 invariants. Along the way two attempts failed and were fixed before those runs: a wrong assertion of ours, and a worker setting the harness lacked (how soon the worker re-reads a settled-but-unproven payment: 5 minutes by default, 10 seconds in the harness).

**Limits.** A local fork, not the public testnet; a scripted model, not an LLM; a seller we control; this section ran only on Windows 11 with the versions above (Linux ran the section 2 demo, not this section; the `.venv/bin` commands and the POSIX process-group shutdown were not run). A second framework (Google ADK) is not wired to the real backend: its example still runs against the stub only. The compatibility matrix says the same, row by row.

## 11. Feedback

Issues and integration reports go to the repository's GitHub issue forms, which **need a GitHub account**. Do not post keys, wallet secrets or logs that contain them.
