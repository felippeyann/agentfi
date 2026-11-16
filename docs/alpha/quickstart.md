# AgentFi alpha — local quickstart

**What you will see (the demo itself took about 2.5 minutes here; `npm ci` takes several more):** an agent buys paid resources over x402 under rules you set; a purchase that breaks the rules is stopped **before anything is signed**; a purchase whose answer was lost is proven from the chain **without being paid twice**; a payment that never settled is released **only on proof**. Payment (money) and delivery (content) are tracked separately.

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
| OS | Verified on **Windows 11 (Git Bash)**. Linux and macOS are expected to work (the code is portable; CI runs on Linux for its other suites) but **this demo was not run there**. | |
| Node.js | **22** (what CI uses). `package.json` allows `>=20`. Verified here on 24.14.1. | `node -v` |
| npm | Comes with Node. | `npm -v` |
| Git | Any recent version. | `git --version` |
| Postgres 16 and Redis 7 | Easiest with Docker (`docker compose`, below). Or any local Postgres/Redis you can reach. | `docker --version` |
| Foundry `anvil` | **Only 1.7.1 was verified; newer versions are untested.** CI installs the Foundry nightly, and Anvil 1.8+ adds an L1 fee on chain 84532 (see commit `713882b`); this demo checks USDC balances, not gas, but it was not run with 1.8. Install 1.7.1 with `foundryup --install 1.7.1` (the flag is from `foundryup --help`; that exact install was not run here). | `anvil --version` |
| Network egress | HTTPS to a **public read-only RPC** of Base Sepolia (default `https://sepolia.base.org`). The fork reads state from it; nothing is written to it. | `npm run alpha:demo -- --check` |
| Free ports | 8547 (Anvil), 3157 (API), 5432 (Postgres), 6379 (Redis). | the same check |

Install Foundry (provides `anvil`) from <https://book.getfoundry.sh/getting-started/installation>. The demo finds `anvil` on `PATH` or in `~/.foundry/bin`.

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

`<TAG>` must be a commit that **contains `alpha:demo`** (this page and the script arrive with PR #205: any older commit does not have them). It is a placeholder until a tag is cut. Until then use: `<SHA-after-merge>` *(the integrator fills in the merge commit of PR #205 here)*.

- `npm run alpha:demo` first checks the prerequisites and says what is missing (Node, dependencies, `anvil`, Postgres, Redis, free ports, the RPC) and how to fix it; it starts nothing until all pass. `npm run alpha:demo -- --check` only checks.
- It then generates the Prisma client and runs the demo (`npm run demo:x402:fork` in `packages/backend`), which creates the database if needed, applies the migrations, and runs scenarios A-E. **Expect about 2.5 minutes.** It exits `0` only if every invariant held; the first broken invariant stops it with `INVARIANT BROKEN`.
- A transcript is written to `<your temp dir>/agentfi-alpha-demo-transcript.txt` (override with `X402_DEMO_TRANSCRIPT`).
- Stop Postgres and Redis afterwards with `docker compose -f docker-compose.dev.yml down`.

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

**A real-backend run of the HTTP / MCP examples is not reproducible outside the alpha demo today** (the seller and the wallet funding live in the demo harness). Anything marked tested in the compatibility matrix ran against the **stub**, not a real backend.

Reading the results by hand: `npm run x402:ops -- status` (in `packages/backend`, with the same environment as the API, including `DATABASE_URL`) prints the operator report shown in section 3.

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

The commands of section 2 were followed literally, from a fresh `git clone`, on **2026-11-16**: commit `5ed0cc9`, Windows 11 (Git Bash), Node 24.14.1, anvil 1.7.1, Postgres 16 and Redis 7 in Docker, forking `sepolia.base.org`. The demo exited `0` after about 2.5 minutes with 23 invariants checked. After the review fixes (destructive-target guards, stronger budget-block assertion) the demo was run once more end to end from the PR branch with private targets and `npm run alpha:demo -- --yes`: exit `0`, 23 invariants again. Two deviations, both because that machine already ran other work on the default resources: the `docker compose … up -d postgres redis` step was skipped (Postgres and Redis were already up on 5432/6379), and `X402_DEMO_DATABASE_URL`, `X402_DEMO_REDIS_URL`, `X402_DEMO_ANVIL_PORT` and `X402_DEMO_BACKEND_PORT` pointed at a private database, Redis DB and ports (section 6). The default database, Redis DB and ports were not exercised beyond `npm run alpha:demo -- --check`. Not run: Linux, macOS, Node 22.
