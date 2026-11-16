# x402 over HTTP: reference clients (TypeScript and Python)

The smallest possible client for AgentFi's one money-moving call,
`POST /v1/jobs/{id}/pay-resource`, in **TypeScript** (Node >= 20, `fetch` only) and **Python**
(>= 3.9, standard library `urllib` only). Both do the same thing: one request, never a retry,
and a classification of every documented outcome so your agent (or your code) knows what is
safe to do next.

Use this when your framework has no AgentFi adapter or MCP support: it is the contract that
every other integration in [`docs/integrations/`](../../docs/integrations/README.md) wraps.

## What is real and what is stubbed

| Piece | Status |
|---|---|
| Request and response **shapes** | Real: taken from [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml) (`PayResourceRequest`, `PayResourceResponse`, `ResourcePaymentError`), cross-checked with the backend's route test (`resource-payment.routes.test.ts`) and the fork demo (`x402-spend.demo.ts`). |
| The clients (`ts/src`, `python/agentfi_pay.py`) | Real code you can copy. |
| The API in `run-stub-demo.mjs` | **STUB** ([`../_stub-api/stub-api.mjs`](../_stub-api/stub-api.mjs)). It replays real-shaped answers chosen by the URL path. It has **no budget, no policy, no ledger, no wallet and no chain**. Nothing is signed or paid. |
| Run against the real backend | **Not done by this example.** To do it, start the API as in the [alpha quickstart](../../docs/alpha/quickstart.md) (the local fork demo), create two agents and an ACCEPTED job, and point `AGENTFI_API_URL` / `AGENTFI_API_KEY` at it. |

## Prerequisites for a real run

* An AgentFi API you run (there is no hosted one): base URL in `AGENTFI_API_URL`
  (default `http://localhost:3000`, the dev stack).
* The **provider** agent's API key in `AGENTFI_API_KEY`. The key is the identity: only the
  job's provider can pay (`403 NOT_PROVIDER` for anyone else). Never use the operator secret
  here and never put a key in the source.
* A job in `ACCEPTED` status whose reward is USDC on a supported chain. The job's remaining
  reward is the budget; the provider's policy (per-payment cap, daily volume, allowed payees)
  also applies. Both are enforced by the backend before anything is signed.

## Run the stub demo (no credentials, no network beyond localhost)

```bash
cd examples/x402-http-reference/ts && npm install && npm run build && cd ..
node run-stub-demo.mjs          # starts the STUB API, runs both clients against it
```

It walks every outcome and ends by checking that no `paymentId` was paid twice (the stub
counts paid requests). Recorded output (Windows 11, Node 24.14.1, Python 3.14.3, 2026-11-16):

```
== /settled          outcome: settled                    (HTTP 200)
== /partial          outcome: settled_partial_delivery   (HTTP 200)
== /delivery-failed  outcome: settled_not_delivered      (HTTP 200)
== /free             outcome: free_resource              (HTTP 200)
== /budget           outcome: budget_exceeded            (HTTP 402)
== /policy           outcome: policy_violation           (HTTP 403)
== /in-progress      outcome: payment_in_progress        (HTTP 409)
== /outstanding      outcome: outstanding_authorization  (HTTP 409)
== /refused          outcome: refused_after_signing      (HTTP 402)
== /unknown          outcome: outcome_unknown            (HTTP 502)
== /unknown again, SAME paymentId     outcome: outcome_unknown (HTTP 200, replayed)
== /settled again, SAME paymentId     outcome: replayed        (HTTP 200)
[STUB] paid requests per path (2 clients x 1 purchase each; the replays added none): {"/settled":2,"/unknown":2,"/partial":2}
[STUB] OK: no paymentId was paid twice.
```

## Run against your own API

```bash
export AGENTFI_API_URL=http://localhost:3000
export AGENTFI_API_KEY=<provider agent key>          # never commit it
# TypeScript
node ts/dist/main.js <jobId> https://seller.example/report --max-amount 0.50
# Python
python python/agentfi_pay.py <jobId> https://seller.example/report --max-amount 0.50
```

Pass `--payment-id <id>` to retry **the same purchase**; omit it for a new one (the client
generates a UUID and prints it: keep it).

## Outcomes and what to do

| Outcome | HTTP | What happened | What to do |
|---|---|---|---|
| `settled` | 200 | `payment.status: settled` **and** `resource.status` 2xx, not truncated | Paid and delivered. Keep the `paymentId`. |
| `settled_not_delivered` | 200 | settled, but the seller answered an HTTP error (`resource.status` >= 400) | The money is spent and the content was **not** delivered. Do **not** pay again with a new id; take it up with the seller/operator. |
| `settled_partial_delivery` | 200 | settled, but `resource.truncated: true` (body cut at 64 KiB) | You paid; you did not get everything. Fetching again is a **new purchase**: ask the seller/operator. |
| `replayed` | 200 | `replayed: true`: recorded state of an earlier call with this `paymentId`; `resource` is `null` | Nothing was paid again and the content was **not** re-fetched. |
| `free_resource` | 200 | an **explicit** `payment: null`: the resource never asked for payment | Nothing spent. (A 200 with no `payment` field at all is treated as uncertain.) |
| `budget_exceeded` | 402 `BUDGET_EXCEEDED` | price above the remaining job budget or your `maxAmount`; `price`, `remaining`, `cap` in base units | Nothing signed. A new `paymentId` is fine for a different purchase; do not try to raise the budget from the payer. |
| `policy_violation` | 403 `POLICY_VIOLATION` | `rule`: `maxValuePerTxUsd`, `maxDailyVolume`, `allowedTokens` or `allowedRecipients` | Nothing signed. Only the operator can change the policy. |
| `payment_in_progress` | 409 `PAYMENT_IN_PROGRESS` | same `paymentId` is being processed | Wait, re-ask with the **same** id. |
| `outstanding_authorization` | 409 `OUTSTANDING_AUTHORIZATION` | an earlier refused payment to the same payee still has a live authorization (`validBefore`) | Nothing signed now. Re-ask after `validBefore`. |
| `refused_after_signing` | 402 `PAYMENT_REFUSED` | the seller answered the signed payment without settling; the authorization stays live until `countedUntil` and the amount stays counted | Re-ask with the same id after `countedUntil`. |
| `outcome_unknown` | 502 `PAYMENT_OUTCOME_UNKNOWN`, 200 with `payment.status: unknown`, or **any answer whose body cannot be read/parsed** (connection cut mid-body, invalid JSON) | a signed authorization left the process and no answer came back: **the money may have moved** | **Do not retry with a new id.** The worker reconciles it; the amount stays reserved. Check status. |
| `no_answer` | none | your client timed out: unknown whether the backend acted | Re-ask with the **same** `paymentId` only. |
| `error` | other | `JOB_NOT_ACTIVE`, `NOT_PROVIDER`, `INVALID_URL`, `PAYMENT_FAILED`, ... | See the OpenAPI. A 5xx is uncertain: same id only. |

### Reading the payment and delivery state

There is **no `GET` endpoint for payments** in the API today. You read state from:

* the `payment` object of the answer: `status` is `reserved` / `pending` / `settled` / `unknown` /
  `refused` / `failed_before_signing` (the worker can also move a row to `expired`: the OpenAPI
  enum does not list it yet, so treat any unknown status as uncertain);
* **payment is not delivery**: `payment.status` is the money; `resource.status` and
  `resource.truncated` are what arrived. The byte count and SHA-256 of the body are recorded by the
  backend but are **not** in the HTTP answer: the operator sees them (`delivery: delivered /
  partial / not-delivered / unknown`) with `npm run x402:ops -- status --job <id>`;
* re-asking with the **same** `paymentId`: for `pending`, `settled` and `unknown` rows the backend
  returns the recorded row with `replayed: true` and never pays again.

## Tests

`cd ts && npm test` (node:test) and `cd python && python -m unittest test_agentfi_pay` reproduce a 200 with a cut body, invalid JSON, a missing `payment`, and settled-with-seller-error.

## Pinned versions

TypeScript `typescript@6.0.3`, `@types/node@20.19.0` (build only; runtime is plain Node >= 20).
Python: standard library only.
