# x402 payments — buyer-side client

> Task P1 of the [execution plan](../project/execution-plan-2026-10.md) (WS4). Written 2026-10-06 against `@x402/core`, `@x402/fetch`, `@x402/evm`, `@x402/extensions` **2.28.0**; hardened the same day after review R3 (findings F1–F9, PR `fix/review-r3-x402`). The legacy `x402` / `x402-fetch` 1.x packages are not used.

Sources: [x402.org](https://www.x402.org) · [coinbase/x402](https://github.com/coinbase/x402) · the installed packages' `.d.ts` files (API names below are the ones that exist in 2.28.0, not the ones in the docs where they differ) · the maintainer's September lab (`~/agentfi-lab`, fake-facilitator harness and the 14-case budget ledger).

## 1. What the service does

`packages/backend/src/services/payments/x402-client.service.ts` exports `X402ClientService.payResource(...)`: fetch a URL; if it answers `402` with x402 v2 requirements, sign a token authorization with the agent's wallet and fetch again with `PAYMENT-SIGNATURE`; return the final response plus what we know about the payment.

```ts
const signer = await toClientSigner(getWalletService(), agent.walletId); // services/wallet/signer.ts
const result = await new X402ClientService(/* { requestTimeoutMs, maxAuthorizationWindowSeconds } */).payResource({
  signer,
  url: 'https://api.example.com/quote',
  maxAmountUsd: '$0.50',                  // required; no implicit default
  allowedNetworks: ['eip155:84532'],      // required; exact CAIP-2 ids, no "any network" default
  // allowWildcardNetworks: true,         // only then may allowedNetworks contain "eip155:*"
  paymentId: 'job_…',                     // optional idempotency key (see §3 for what it does NOT do)
  // requestTimeoutMs: 30_000,            // per-phase transport deadline (default 30 s)
  // maxAuthorizationWindowSeconds: 600,  // longest validBefore/deadline we will sign (default 600 s)
});
// result: { status, body, headers, paid,
//           payment?: { paymentId, paymentIdSent, network, asset, amount, payer,
//                       authorization?: { scheme, method, nonce, validAfter, validBefore },
//                       txHash?, receipt?, receiptVerified? } }
```

Roles, so there is no confusion later: the **buyer** (this service) never talks to a facilitator. It signs an EIP-3009 `transferWithAuthorization` (or a Permit2 authorization) off-chain and hands it to the **resource server**, which calls **its** facilitator to verify and settle, then reports the outcome in the `PAYMENT-RESPONSE` header. Nothing in this service broadcasts a transaction or holds gas.

A `non-402` first response is returned untouched (`paid: false`, nothing signed) — including 4xx/5xx errors. Only payment-specific failures throw.

Scheme support: `exact` on EVM via `ExactEvmScheme` from `@x402/evm/exact/client`, registered only for the networks in `allowedNetworks`. `upto`, Solana, and the `mppx` dialect (P4) are out of scope; an `upto`-only offer is `NoAcceptableSchemeError`.

**Networks are explicit.** `allowedNetworks` is required and non-empty, and each entry must be an exact CAIP-2 id. A wildcard such as `eip155:*` would make mainnet payable by default, so it is rejected unless the caller passes `allowWildcardNetworks: true` on purpose. When a 402 offers several networks (e.g. Base and Base Sepolia), only an allowed one can be selected, regardless of the order the server lists them in.

## 2. Spend controls — three gates before a signature exists

| Gate | Where | What it checks |
|---|---|---|
| 1 | `preflight()` in the service, on the raw 402 | Among `accepts[]`: scheme `exact`, network matches `allowedNetworks`, `maxTimeoutSeconds` within `maxAuthorizationWindowSeconds`, asset is a known USD stablecoin (`ExactEvmScheme.findDefaultAsset`, e.g. USDC on Base / Base Sepolia, MegaUSD with 18 decimals). None → `NoAcceptableSchemeError` (the window case lists each rejected option with its `reason` in `details.rejected`). Some, but every one above `maxAmountUsd` → `BudgetExceededError`. Both carry the offered options in `details`. |
| 2 | `x402Client.fromConfig({ spendControls: { maxAmountPerPayment }, policies: [window filter] })` | The library's own filter (default-asset allowlist + USD cap), built per call from the job's cap and networks, plus a policy that hides options whose `maxTimeoutSeconds` exceeds the window so the library's "first option" selector cannot pick one. |
| 3 | `onBeforePaymentCreation` hook | Re-checks the option the library actually selected against the window and the cap; returns `{ abort: true }` if it disagrees and the service rethrows the typed error. |

Gate 1 exists because the library collapses "all options filtered" into a generic `Error` inside `wrapFetchWithPayment`, which would lose the distinction between "nothing we can pay with" and "too expensive"; checking the 402 ourselves first gives typed errors and guarantees the facilitator is never reached. All three gates use the same math (`convertToTokenAmount(cap, asset.decimals)` vs the atomic `amount`, with the asset's real decimals — 6 for USDC, 18 for MegaUSD/mUSD), so gate 3 only fires if the library selects something gate 1 did not consider affordable — a defensive redundancy, not an independent policy. Gates 2 and 3 are proven live by tests that disable gate 1 through `X402ClientServiceOptions.__testOnlyGates` (refused when `NODE_ENV=production`; never set it from application code).

`maxAmountUsd` must be a plain USD amount (`"$1"`, `"0.50"`); ticker suffixes are rejected. Non-default assets (anything `findDefaultAsset` does not know) are never paid.

**Authorization window.** `@x402/evm` signs `validBefore = now + requirement.maxTimeoutSeconds` (Permit2: `deadline` likewise) and the value is entirely server-chosen. Unbounded, a server could obtain a ≤cap authorization that stays settleable for years, answer `insufficient_funds`, and settle it later. `MAX_AUTHORIZATION_WINDOW_SECONDS` (600) caps what we accept; a 402 whose acceptable options all exceed it is `NoAcceptableSchemeError` before anything is signed. Override per service or per call with `maxAuthorizationWindowSeconds` when a specific seller needs more.

The cap is per **payment**. Per-job budgets, reservations and double-spend protection across retries are P5 (the ledger from the lab), on top of this service; the agent policy (per-payment cap, daily volume, allowlists) is applied by the job-scoped service (§10, P6).

## 3. Idempotency — `payment-identifier` — and what it does not do

When the 402 declares the `payment-identifier` extension, the hook appends `paymentId` (caller-supplied or `agentfi_<32 hex>` generated via `generatePaymentId`) to `extensions["payment-identifier"].info.id`, which the client echoes in the payment payload. `paymentIdSent` on the result (and on `PaymentFailedError.details`) is true only when that actually happened; when the server did not declare the extension it never saw the id. `paymentId` is always returned, including on `PaymentFailedError.details`, so the caller can persist it before retrying.

**The client re-signs on every call.** `payResource` creates a fresh EIP-3009/Permit2 authorization with a new nonce each time it is invoked — the id does not short-circuit anything on our side, and the server cannot see it until the signed payment arrives (it travels inside the payload, not on the plain request). So even against a server with an idempotency cache, calling twice with the same `paymentId` produces **two live authorizations** and one settlement; the test `signs a fresh authorization on every call; a server cache keyed by paymentId prevents the second settlement` asserts exactly that (`signatures: 2`, distinct nonces, `settle: 1`). Against a server without a cache it settles twice.

Rule for P5 (reconciliation): **do not call `payResource` again for a `paymentId` whose last attempt had `authorizationSent: true` until that attempt is reconciled.** The outcome of the first authorization is unknown; the nonce and `validBefore` in `details.authorization` are what reconciliation needs — either the settlement shows up on-chain, the window passes, or the authorization is cancelled (`cancelAuthorization` on EIP-3009 tokens). Only then is a new signature safe. The job-scoped ledger (§10) enforces this for `unknown` rows (never re-signed) and, since P6, for refused ones: a server's "refused" after signing is not proof that nothing settled, so the row stays counted and its payee gets no new signature until `validBefore`.

## 4. Receipts — `offer-receipt`

If the server declares `offer-receipt`, the 402 carries signed **offers** (one per `accepts[]` entry) and a successful settlement carries a signed **receipt** in `PAYMENT-RESPONSE.extensions["offer-receipt"].info.receipt`. The service returns the raw receipt and sets `receiptVerified: true` only when all of the following hold:

1. the offer matched to our accepted option (by scheme/network/asset/payTo/amount) names the resource the 402 itself declared (`paymentRequired.resource.url`) and, when it carries `validUntil`, had not expired when we signed;
2. offer and receipt are EIP-712 signed (`verifyOfferSignatureEIP712` / `verifyReceiptSignatureEIP712`) and recover to the **same** signer — this binds the receipt to the offer we accepted;
3. the receipt's `resourceUrl`, `network` and `payer` match the offer and our signer address, and it was issued within the last hour (`verifyReceiptMatchesOffer`);
4. **when the receipt names a transaction**, it equals the settlement's. 2.28.0 servers usually omit it (quirk below), in which case this check has nothing to compare and the receipt is bound to the offer and payer only, not to a settlement tx.

A receipt that fails any check — or a JWS-format receipt, which needs DID key resolution we do not do yet — yields `receiptVerified: false` **without** failing the payment; the server did settle, we just cannot vouch for its receipt. There is no trust anchor: "verified" means "internally consistent and signed by whoever signed the offer", not "signed by a key we trust".

2.28.0 quirk found while testing: with `declareOfferReceiptExtension({ includeTxHash: true })`, receipts come back **without** a transaction hash, because `x402HTTPResourceServer` stores each extension's 402 enrichment output (`{ info: { offers }, schema }`) into the same `declaredExtensions` object it later passes to settlement, overwriting `includeTxHash`. `@x402/express` forwards that object unchanged. The test harness passes the route-level declaration to `processSettlement` instead so the tx binding is exercised; real servers on 2.28.0 will mostly produce receipts without a hash.

## 5. Errors

All extend `X402PaymentError` (`code`, `details`). Messages never contain the URL's query string, fragment or userinfo (API keys travel there) and clip server-supplied reasons and upstream error text at 200 characters — **after** running them through the backend sanitizer (`api/errors/sanitize.ts`, P6): clipping first could cut a secret (an RPC key in a signer error, a token) at the boundary and leave a prefix no rule recognises afterwards. The full URL and the decoded server objects live in `details`.

**Bounded reads (P6).** No response body is read whole. The final body is read up to `maxBodyBytes` (default `DEFAULT_MAX_BODY_BYTES` = 64 KiB, per service or per call) and the body stream is cancelled beyond it, which aborts the transfer — the result carries `bodyTruncated: true` and at most that many bytes (an incomplete trailing UTF-8 character is dropped). The body of a plain 402 is read up to `MAX_PAYMENT_REQUIRED_BYTES` (16 KiB; v2 carries the requirements in the `PAYMENT-REQUIRED` header, the body is only a v1 fallback) — a larger one, or a `Content-Length` announcing one, is `PaymentFailedError` (`stage: 'request'`, `authorizationSent: false`) before anything is signed, and `@x402/fetch`, which would read whatever body it is handed, gets a replay of the bounded bytes instead of the live stream. Before P6 a provider could stream an unbounded body into `response.text()` (measured: 256 MiB in 2.9 s, RSS +774 MB).

| Error | `code` | Signed? | Meaning |
|---|---|---|---|
| `NoAcceptableSchemeError` | `NO_ACCEPTABLE_SCHEME` | no | No option is `exact` + allowed network + window ≤ limit + known USD asset. |
| `BudgetExceededError` | `BUDGET_EXCEEDED` | no | Every acceptable option costs more than `maxAmountUsd`. |
| `PaymentFailedError` | `PAYMENT_FAILED` | see `details.authorizationSent` | 402 without usable requirements, or the library refused to create a payment (`false`, `stage: 'request' \| 'payment-creation'`); server rejected the signed payment, settlement failed, or the paid request failed or timed out in transit (`true`, `stage: 'paid-request'`). |

`PaymentFailedError.details` always carries `paymentId`, `paymentIdSent`, `authorizationSent`, `stage`, `timedOut`; whenever `authorizationSent` is true it also carries `authorization: { scheme, method: 'eip3009' | 'permit2', nonce, validAfter, validBefore }` — the data needed to cancel or reconcile what the server now holds.

`authorizationSent: true` means a signed authorization left this process. A transport error or timeout at that point is an **unknown** outcome (the lab's "response lost after fake settlement" case): the server may have settled. Do not retry automatically; record `paymentId` + `authorization` and reconcile (P5, §3).

**Timeouts.** Every phase — the plain request, the paid request, and reading the body — runs under `AbortSignal.timeout(requestTimeoutMs)` (default `DEFAULT_REQUEST_TIMEOUT_MS` = 30 s, overridable per service and per call), combined with any signal the caller passed in `init`. A timeout surfaces as `PaymentFailedError` with `timedOut: true` and the correct `authorizationSent` for the phase that stalled.

A 2xx with no `PAYMENT-RESPONSE` after we sent a payment returns `paid: false` with `payment` present (no `txHash`, `authorization` present): the server accepted the request but reported no settlement — same reconciliation path.

## 6. Facilitators

Per-chain defaults live in `config/x402.ts` (`getX402FacilitatorUrl(chainId)`), overridable with `X402_FACILITATOR_URL`:

| Chain | Facilitator | Auth |
|---|---|---|
| Base Sepolia (84532) | `https://x402.org/facilitator` | none; testnet only |
| Base (8453) | `https://api.cdp.coinbase.com/platform/v2/x402` | CDP API key, to be supplied through `HTTPFacilitatorClient.createAuthHeaders` when AgentFi acts as a resource server (not wired in P1) |

`X402_FACILITATOR_URL` is parsed with `z.preprocess(v => v === '' ? undefined : v, z.string().url().optional())`: a blank `X402_FACILITATOR_URL=` from dotenv or docker `env_file` means "unset" instead of aborting boot. `.env.example` ships the line commented out, and `src/__tests__/env.example.test.ts` boots the real schema from the shipped example (with the CI dummy secrets) so no future blank `KEY=` with a format constraint can regress this.

Circle's facilitator remains optional (P3). Because the buyer never calls a facilitator, these values do not affect `payResource`; they are here so the choice is explicit for the seller/reconciliation tasks.

## 7. Wallet signing

`services/wallet/signer.ts` — `toClientSigner(walletService, walletId)` resolves the address and returns `{ address, signTypedData }`, the only surface `ExactEvmScheme` needs for the base flow. Both providers gained `signTypedData`:

- `LocalWalletService`: viem account `signTypedData`.
- `TurnkeyService`: `hashTypedData` locally, `signRawPayload` with `HASH_FUNCTION_NO_OP`, r||s||v assembled exactly as `signMessage` already did (shared `signDigest`). Tested against a mocked SDK that signs the digest with an ephemeral key, so the digest and assembly code paths are real.

Two properties of that assembly matter on-chain:

- **`v` must be 27/28.** viem's `recoverTypedDataAddress` also accepts `v ∈ {0, 1}`, but USDC's `transferWithAuthorization` runs `ecrecover`, which does not. `signDigest` normalises Turnkey's recovery id whether it arrives as `"00"/"01"` (documented) or `"1b"/"1c"` (already offset) — `rec >= 27 ? rec : rec + 27` — and rejects anything else. The signer tests assert the last byte is `1b`/`1c` on every path.
- **Turnkey policies cannot see the typed data.** With `HASH_FUNCTION_NO_OP` Turnkey signs an opaque 32-byte digest; a Turnkey policy cannot inspect the asset, amount, recipient or window inside the EIP-712 message. Asset/amount/network/window restrictions therefore have to live in AgentFi's own spend caps (§2) — relevant to task W2 when wallet-level policies are designed.

Not provided: `readContract` / `signTransaction` on the signer, so the EIP-2612 gas-sponsoring enrichment for Permit2 tokens is inert. USDC uses EIP-3009 and does not need it.

## 8. Tests and what they do not prove

`src/__tests__/x402-client.service.test.ts` runs a real x402 v2 resource server (`@x402/core/server` + `@x402/evm/exact/server` on raw `node:http`, driven the same way `@x402/express` drives Express) with a **fake facilitator** that accepts every authorization and returns a synthetic tx hash, plus a hand-built 402 (`fake402`) for offers the server fixture cannot express. Cases:

- free resource; non-402 error returned; paid within cap (amount `400000` for `$0.40`, payer, fake tx hash, `authorization` with a 32-byte nonce and `validBefore` within the route's 300 s); price at the cap; caller-supplied id; `paymentIdSent: false` when the extension is not declared;
- gate 1: above cap → `BudgetExceeded`, wrong network → `NoAcceptableScheme`, multi-network offer (Base listed first) pays only the allowed network, `allowedNetworks` required / wildcard refused without `allowWildcardNetworks` / honoured with it, `maxTimeoutSeconds: 1e9` → `NoAcceptableScheme` with the reason in `details.rejected` and nothing signed, window widened per call and per service, malformed inputs, an `upto` offer, an 18-decimal asset (MegaUSD) priced and capped with 18 decimals (0.6 × 10¹⁸ is $0.60, not $600 000 000 000);
- gates 2 and 3 with gate 1 disabled through the test-only hook (and the hook refused under `NODE_ENV=production`);
- same id twice with and without a server cache: two signatures, distinct nonces, one vs two settlements;
- verify rejected / settle failed → `PaymentFailed` carrying the nonce; transport failure after signing → `authorizationSent: true`; 2xx without `PAYMENT-RESPONSE` → `paid: false` with `authorization`; stalled plain request and stalled paid request → `timedOut: true` with the right `authorizationSent`;
- error hygiene: `?api_key=…` never appears in a message (only in `details.url`); a 5000-char server reason is clipped to 200;
- bounded reads (`x402-client.body-limit.test.ts`, P6): a free resource streaming 256 MiB is cut at 64 KiB with the transfer aborted (bytes the server managed to write and RSS bounded), exact-limit vs limit+1, no half UTF-8 character at the cut, the paid response bounded too, a 402 streaming an endless body or announcing a large `Content-Length` refused before signing, a small 402 body still pays;
- receipt valid / altered after signing / honest but naming another tx / signed by a key other than the offer's / offer + receipt for a different resource than the 402 named / offer expired before signing.

The fake facilitator does **not** prove: signature validity, balances, nonces or validity windows; that any USDC moves; that a tx hash exists; facilitator authentication or `settlement_pending`; or anything about a real server's deduplication. `src/__tests__/wallet.signer.test.ts` (incl. `v` = 27/28 on every path and both Turnkey `v` encodings), `src/__tests__/x402.config.test.ts` and `src/__tests__/env.example.test.ts` cover the signer adapter and config.

## 9. Still off-chain / unproven — explicit list

- No payment has been made on Base Sepolia or Base; no wallet has been funded.
- No real facilitator (x402.org, CDP) has been called; CDP auth is not implemented.
- `txHash` and `payer` are whatever the server's `PAYMENT-RESPONSE` says; nothing is checked against an RPC.
- Receipts have no trust anchor (no issuer registry, no DID resolution, no JWS).
- Per-job budget, reservation and replay protection exist (§10, P2/P6) but there is no reconciliation of `unknown` or `refused` rows and no `cancelAuthorization` helper yet; the nonce and `validBefore` are stored so the reconciliation task can add both. Until then a server that refuses a signed payment and settles it anyway is only bounded, not detected (§10, *Post-signature refusals*).
- `@x402/express` is not a dependency: its required `express` peer would add ~60 packages to the lockfile for a test-only server, and `@x402/core/server` already provides the full pipeline.
- The `includeTxHash` quirk (§4) is observed on 2.28.0 and not reported upstream yet.

## 10. Job-scoped payments (P2) and the ledger state machine (P5 subset)

> Task P2 of the execution plan, with the part of P5 that fits in it: the durable ledger semantics of `~/agentfi-lab/ledger.mjs` (reserve → pending → settled/unknown; no automatic retry on unknown) restated on a `ResourcePayment` row. Reconciliation of `unknown` rows is **not** part of this; see the TODO list at the end. Money and robustness fixes from the second adversarial review (2026-10-08) are task **P6**: the retry race, post-signature refusals, the agent policy, bounded reads and the outbound P3s below.

`POST /v1/jobs/:id/pay-resource` (`api/routes/resource-payments.ts` → `services/payments/resource-payment.service.ts`) and the MCP tool `pay_for_resource` let the agent **working** on a job pay a 402 resource from that job's budget. The whole thing sits on top of `payResource` (§1); nothing in the client changed except two hooks (below).

**Who pays.** The job's provider, from its own wallet (`toClientSigner(getWalletService(), provider.walletId)`). The requester is refused (`403 NOT_PROVIDER`); the job must be `ACCEPTED` (`409 JOB_NOT_ACTIVE`); the provider must be active with a non-paused, non-expired policy (`403`).

**Budget.** The job reward must be USDC on the job's chain (`reward.token` = `USDC` or the chain's USDC address; anything else is `400 UNSUPPORTED_BUDGET_TOKEN` — converting an ETH reward would need the price oracle, and a payment gate must not depend on one). Then

```
remaining = parseUnits(reward.amount, 6) − Σ amount of this job's COUNTED rows
            counted = reserved, pending, settled, unknown,
                      and refused while now < authorizationValidBefore      (P6)
cap       = min(remaining, maxAmount)            // maxAmount: the caller's optional own cap
```

The counting rule lives in one place, `services/payments/resource-payment-ledger.ts` (`countedWhere`, `liveRefusalWhere`, `retryableWhere`), and is used by the budget, the reservation and the daily volume alike.

`cap` is what `payResource` receives as `maxAmountUsd`, and `allowedNetworks` is `[eip155:<job.chainId>]`, so gates 1–3 (§2) refuse an above-cap price or a foreign network **before anything is signed**. `BudgetExceededError` becomes `402 BUDGET_EXCEEDED` with `price`, `remaining` and `cap` (base units); `NoAcceptableSchemeError` becomes `400 UNSUPPORTED_ASSET`. A second, explicit check in the pre-signing hook refuses any asset that is not the chain's USDC even if the default-asset registry grows.

**Two client hooks.** `PayResourceParams` gained `onBeforeSign(selected)` — called after gate 3 with the priced option (`network`, `asset`, `amount`, `payTo`, `symbol`, `decimals`, `usd`), before any signature; a throw aborts and is rethrown unchanged — and `onAuthorizationSigned(authorization, selected)` — called after signing and **before the paid request leaves**; a throw propagates out of the library's `createPaymentPayload` (and the transport shim refuses to send a paid request once `state.abort` is set), so the signature exists but never reaches the server. The service uses them as the two ledger writes:

```
           onBeforeSign                                 onAuthorizationSigned                   response
402 ──► reserve (row locks: Job, then Agent) ──► sign ──► pending (+nonce, +validBefore) ──► send ──► settled | unknown | refused
             │
             └─ row busy / payee holds a live refused authorization / price > remaining /
                policy refuses / asset ≠ USDC  →  409 / 402 / 403 / 400, nothing signed
```

The reservation runs in a transaction that first takes `SELECT … FOR UPDATE` on the Job row (re-checking that the job is still `ACCEPTED`) and then on the paying Agent row, and inside it, in order:

1. **the row** — for a same-`paymentId` retry, the row must still be retryable (`failed_before_signing`, or `refused` with an expired authorization); anything else is `409 PAYMENT_IN_PROGRESS` (or `OUTSTANDING_AUTHORIZATION` for a live refusal). The row is then taken with a **conditional** `updateMany … WHERE id = … AND <retryable>` that must match exactly one row — so of N concurrent retries of one id at most one signs (P6: before, the unlocked read and an unconditional update let 5 parallel retries at $0.40 sign 5 times on a $1 budget, settle 5 times, and leave one `settled` row: $2.00 spent, $0.60 reported remaining). A first attempt creates the row; the `(jobId, paymentId)` unique index turns a concurrent duplicate into `409 PAYMENT_IN_PROGRESS`;
2. **the payee** — no live refused authorization to the same `payTo` on this job (`409 OUTSTANDING_AUTHORIZATION`, see below);
3. **the budget** — the counted rows are re-summed, so two concurrent payments on the same job cannot both pass on the same remaining amount;
4. **the agent policy** — see *Agent policy* below; the Agent lock serializes the payer's reservations across all its jobs, so the daily volume cannot be overrun by parallel payments either.

Anything refused here happened before any signature. The `failed_before_signing` rows written for budget / asset / policy refusals are created, or updated only while the row is still retryable — a refusal can never overwrite a row another attempt is using or one that still counts.

**State machine** (`ResourcePayment.status`, terminal states never change):

| Status | Set when | Counts against budget | Same `paymentId` again |
|---|---|---|---|
| `reserved` | row created (or taken back), budget and policy re-checked under the locks | yes | `409 PAYMENT_IN_PROGRESS` |
| `pending` | authorization signed; nonce and `validBefore` stored; payload about to leave | yes | returned as-is, no new payment |
| `settled` | 2xx with `PAYMENT-RESPONSE{success:true}`; `settlementTxHash` from the response (or the receipt), `receipt` + `receiptVerified` when an `offer-receipt` came back | yes | returned as-is |
| `unknown` | timeout or transport error **after** signing, or a 2xx **without** a settlement report (§5) | **yes** — the server may still settle | returned as-is with a `warning`; **no automatic retry** |
| `refused` | the server answered the signed payment without reporting a settlement: verification rejected, `settle.success:false`, any 4xx/5xx, or a 3xx | **yes, until `authorizationValidBefore`** (P6) | `409 OUTSTANDING_AUTHORIZATION` until then; afterwards a fresh attempt on the same row |
| `failed_before_signing` | 402 unparseable or oversized, budget / asset / policy refusal, library refused to create the payment, plain request failed or timed out | no | fresh attempt on the same row |

`unknown` is the case §3 warns about: the rule "do not call `payResource` again for a `paymentId` whose last attempt had `authorizationSent: true`" is enforced by the ledger — the row is returned, nothing is re-signed, the amount stays reserved, and the operator gets an `error`-level log line with the nonce and `validBefore`. The caller gets `502 PAYMENT_OUTCOME_UNKNOWN` (or, for the 2xx-without-report case, `200` with `payment.status: "unknown"` and a `warning`) carrying `authorization { method, nonce, validAfter, validBefore }` — never the signature.

**Post-signature refusals (P6).** Before P6 a `refused` row did not count and could be retried at once, on the reasoning that the server's answer proved nothing settled. It does not: in every post-signature refusal the server already holds a valid EIP-3009 authorization for up to 600 s (`MAX_AUTHORIZATION_WINDOW_SECONDS`) and can answer `500` — or `settle.success:false`, or a redirect — and settle anyway, and the agent's retry then signs again: a malicious server could drain the provider's wallet one "refused" payment at a time while the ledger showed nothing spent. Now:

- every write of `refused` stores `authorizationValidBefore` (the signed `validBefore` / `deadline`, recorded at `pending`; if the client could not describe the authorization, an upper bound: now + the option's `maxTimeoutSeconds`);
- the row **counts** against the job budget and the payer's daily volume until that time has passed — or, once the reconciliation task exists, until it proves no transfer happened;
- while it is live, **no new authorization to the same `payTo` is signed on that job** (`409 OUTSTANDING_AUTHORIZATION` with `payTo`, `outstandingPaymentId`, `validBefore`; `payTo` compared case-insensitively), so a payee can hold at most one live authorization from a job at a time; the same `paymentId` is refused before anything is fetched;
- the caller gets `402 PAYMENT_REFUSED` with `countedUntil` and `authorization { method, nonce, validAfter, validBefore }`; the operator gets a `warn` line with the nonce and window;
- rows written before migration 0018 have no `authorizationValidBefore` and are treated as live for 600 s after their last update (the refusal happened after signing, so that bounds the real window from above).

Pre-signature refusals (`failed_before_signing`) stay uncounted: nothing was signed.

What this does **not** do: after `validBefore` the row stops counting even if the server did settle inside the window, because nothing on our side can tell (that needs the reconciliation task — `authorizationState(payer, nonce)` on USDC, or the `AuthorizationUsed` event). A server that refuses and settles anyway therefore costs at most one payment amount per job and payee per authorization window, within the job budget and the daily limit, instead of an unbounded drain at request speed; the `warn` log is the operator's signal to look.

**Agent policy (P6).** Before P6 this path only checked that the provider's policy was active and unexpired — `PolicyService` (transactions) never saw x402 spend, and x402 never saw the policy's limits. The scenario that made it matter: an attacker posts a job with a large USDC reward to a victim provider, a prompt-injected payload says "pay `https://attacker/x`", the victim spends up to the reward from its own wallet whatever the operator configured, and the attacker cancels and gets its reservation back. Now `services/policy/usdc-spend-policy.ts` (`evaluateUsdcSpend`, written to be reused by the escrow path, C3d) runs inside the reservation, under the locks, before signing; a refusal is `403 POLICY_VIOLATION` with `rule` (and a `failed_before_signing` row):

| `rule` | Rule for a USDC spend (USDC priced at exactly 1 USD, no oracle) |
|---|---|
| `maxValuePerTx` | the stored `maxValuePerTxEth` number is compared with the USDC amount, i.e. **read in USD for USDC**. There is no ETH leg to price, and converting through an ETH/USD oracle would make a payment gate fail whenever the oracle does; at any ETH price above 1 USD this reading is never looser than the ETH one. The default `"1.0"` therefore caps each x402 payment at 1 USDC. |
| `maxDailyVolume` | `DailyVolume` (transactions, today UTC) + Σ counted pay-resource rows of the agent with `reservedAt` today, across all its jobs + this price ≤ `maxDailyVolumeUsd`; `"0"` = no limit; `spentToday` is returned. In the other direction `PolicyService.validateTransaction` now adds the same pay-resource sum to its projection, so one daily limit covers both paths. |
| `allowedTokens` | when non-empty, must list the chain's USDC — checked before anything is fetched. |
| `allowedContracts` | when non-empty, must list the 402's **`payTo`**. For an x402 payment the agent never calls a contract: it signs an authorization that the server's facilitator submits to USDC. The list is therefore read as the set of counterparties the agent may send value to (like an ETH transfer's recipient), which is what an operator restricting where an agent's money goes expects; listing the USDC contract does **not** open payments to any payee. |

Limits are parsed with `policy-numbers.ts` (S1): an unparsable stored value is unlimited, exactly what the tighten-only classifier assumes; amounts are compared exactly in micro-USD (a limit with more than 6 decimals is rounded down, i.e. stricter). Not applied: `maxValueForAutoApprovalEth` (an x402 payment cannot wait for a human approval) and `cooldownSeconds` (an agent pays several resources in a row). A `reservedAt` column (migration 0018) dates each row for the daily window, because a retry reuses the row. The Job lock also re-checks that the job is still `ACCEPTED`, so a job cancelled while its 402 was being read cannot be paid from.

**Receipts** reuse §4 unchanged: `receiptVerified: true` only when the receipt binds to the accepted offer and our payer; a mismatch still **settles** (the server did report a settlement) but the row is stored with `receiptVerified: false` and a `warn` log — the plan's "marked unverified". `settlementTxHash` is the server's `transaction`, falling back to the receipt's when present (2.28.0 servers usually omit both, §4).

**What is stored and what is not.** The row keeps `url` as origin + path only (query strings and userinfo — where API keys travel — are sent to the resource but never stored, logged or echoed), `method`, `network`, `asset`, `amount`, `payTo`, `paymentId`, `authorizationNonce`, `authorizationValidBefore`, `reservedAt`, `receipt`, `receiptVerified`, `settlementTxHash`, `responseStatus`, `error`. `error` is sanitized before it is clipped to 500 characters (P6), so the row never holds a secret or a prefix of one; the raw text goes to the operator log only. The signed authorization payload is never persisted or returned. The resource response is returned with a whitelist of headers and a body read up to 64 KiB, the transfer aborted beyond it (§5, *Bounded reads*).

**Idempotency on the server side.** `paymentId` (caller-supplied, or a server UUID) is also sent through the `payment-identifier` extension, so a cache-enabled resource server deduplicates on its side — but as §3 says, that protects nothing on our side; the ledger does.

**Outbound target policy (S4).** The URL is chosen by an authenticated agent and the backend returns up to 64 KiB of what it fetches, so the fetch is an SSRF surface (cloud metadata, the Postgres / Redis ports, the admin API on loopback). `services/payments/outbound-target.ts` applies three controls, in every environment:

1. *Resolve before connecting.* `assertPublicTarget(url)` first applies the **port policy** (P6): the URL's port — or the scheme default — must be allowed; production and staging allow 80 and 443 only unless `RESOURCE_PAYMENT_ALLOWED_PORTS` (comma-separated, e.g. `80,443,8443`) says otherwise, development and test allow any port unless it is set, and when set it applies in every environment (`resolveAllowedPorts`). It then refuses a host that is `localhost` / `*.localhost` or an address literal in a refused range, resolves the hostname with `dns.promises.lookup(host, { all: true, verbatim: true })` and refuses if **any** address is in one. Refused: IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4` and above; IPv6 `::/96` (`::`, `::1`, IPv4-compatible), `::ffff:0:0:0/96` (SIIT), `64:ff9b:1::/48` (local-use NAT64), `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`; `::ffff:0:0/96`, `64:ff9b::/96` and `2002::/16` (6to4, bits 16-47) are judged by the embedded IPv4. URL parsing normalises `2130706433` / `0x7f.1` / `[::ffff:127.0.0.1]` before the check, and anything that is not a parseable address is refused. Refusal: `400 INVALID_URL` with `refusal` and `hostname`: `private-host` (the literal or `localhost` the agent typed), `port-not-allowed` (with `port`), or `no-public-address` — the **same** answer, message included, whether the name does not resolve or resolves to a refused address (P6: two different answers let an agent probe which internal names exist). The precise reason and the resolved `address` are only logged (S5); a transient resolver error is `502 PAYMENT_FAILED`, `stage: "resolve"`. Nothing is fetched, signed or recorded, and the check runs after the provider / job / budget checks, so a caller that may not pay cannot make the backend resolve names.
2. *Pin what was validated.* The request goes through a per-request undici `Agent` whose `connect.lookup` answers only the validated addresses (and refuses any other hostname); it is passed as `init.dispatcher`, forwarded by `X402ClientService` on both the plain and the paid request, and destroyed afterwards. The URL is not rewritten, so `Host` and TLS SNI still carry the hostname and certificate validation is unchanged. The client's default transport is the `undici` package's own `fetch` (`undiciTransport`), not Node's built-in one, so the Agent and the fetch always come from the same undici copy whatever Node bundles (6.x on Node 22, 7.x on Node 24).
3. *No redirects.* `redirect: 'manual'` (the client's default too): following a `Location` would send the request — and after signing, `PAYMENT-SIGNATURE` — to an origin that never went through 1–2. Any `3xx` is `400 REDIRECT_REFUSED` with `location` (query string stripped). Before signing nothing is recorded; after signing the row becomes `refused` (no settlement reported) or `settled` (a settlement was reported on the redirect: the amount is spent and counted).

What pinning does **not** cover: it protects this one exchange; it does not stop a public resource server from fetching internal URLs itself, and it does not constrain egress at the network layer — run the backend with an egress firewall that blocks metadata and internal ranges as defence in depth. `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true` lifts only the range refusal (resolution, pinning and the redirect rule stay) so a resource server on `127.0.0.1` can be paid during development; it defaults to `false` and boot is `FATAL` with `true` in `production` / `staging`.

**Tests.** `src/__tests__/resource-payment.routes.test.ts` runs the real route, service and client against the P1 harness (now shared in `src/__tests__/helpers/x402-fixture.ts`) with an ephemeral provider key and an in-memory `ResourcePayment` table enforcing the unique index: budget exceeded → `failed_before_signing`, signer never called; same `paymentId` → one payment, same row; retry of a failed row (and of a refused row once its authorization expired) on the same row; `maxAmount` below the remaining budget; settled and unknown rows counted, refused rows counted until `validBefore`; receipt tampered → `settled` + `receiptVerified: false` + warn; stalled paid request → `unknown`, 502 with `paymentId` and nonce, replay without re-signing; 2xx without `PAYMENT-RESPONSE` → `unknown` + warning; verification rejected → `refused`, counted, the same id and the same payee refused until `validBefore` (P6); non-USDC asset and mainnet-only offers → `400 UNSUPPORTED_ASSET`, nothing signed; requester → 403; job not `ACCEPTED` → 409; paused / expired policy → 403; URL stored without its query string; the authorization never echoed. Two tests in the P1 suite pin the hooks (a throw in `onBeforeSign` signs nothing; a throw in `onAuthorizationSigned` signs but never sends). That suite runs with `RESOURCE_PAYMENT_ALLOW_PRIVATE_HOSTS=true` (the harness is on loopback) and adds the S4 cases: a `3xx` before signing, after signing, and after a reported settlement → `REDIRECT_REFUSED`, `Location` never requested; a `.test` name pinned to the harness pays end to end through the real default transport, resolved once, `Host` preserved. `resource-payment.target-policy.test.ts` runs with the override **unset** and proves the refusals (literals, mapped / NAT64 / 6to4 / SIIT / local-use NAT64, 198.18/15 and 192.0.0/24, names resolving to private A / AAAA records, the collapsed `no-public-address` for NXDOMAIN / empty / private answers, the port policy) happen before anything is fetched, signed or written; `outbound-target.test.ts` covers the range boundaries, the port policy and `publicRefusal`, and opens real sockets through `createPinnedDispatcher`.

P6 regressions: in the route suite (in-memory ledger) a verification rejection, a failed settlement, a 5xx after a real settlement and a redirect after signing are all `refused` **and counted**, a second signature to the same payee is `409 OUTSTANDING_AUTHORIZATION` (same id: nothing fetched), the expired refusal is retried on the same row; the policy rules (per-payment cap, daily volume across jobs with `DailyVolume`, token allowlist before fetching, `payTo` allowlist), a job cancelled under the lock, an 8 MiB resource cut at 64 KiB with the transfer aborted, and a secret straddling the clip boundary (no 8-character piece of it in the response or the row). `resource-payment.ledger.db.test.ts` runs the service on the **real test database**: the reviewer's race (5 concurrent retries of one id after a `BUDGET_EXCEEDED`, looped 5 times: exactly one signature, one settlement, one `settled` row, counted = settled), concurrent first attempts with one id, 5 distinct ids on a $1 budget (exactly two pay), the refused-row rules with Postgres' case-insensitive `payTo` match, a pre-0018 refused row, and the policy rules. It cleans up its own rows; `agent.search.test.ts` now deletes only its own agents so the two DB-backed suites can run in parallel. `usdc-spend-policy.test.ts` covers the evaluator and the counting predicates; `policy.service.test.ts` that transactions see today's x402 spend.

**Still to do (not in P2/P6):**

- Reconciliation of `unknown` and `refused` rows (`unknown → settled` with the tx hash, a `refused` row released early once the nonce is proven unused, or cancel the authorization once `validBefore` has passed): a worker that matches `authorizationNonce` against on-chain USDC `AuthorizationUsed` / `Transfer` events to `payTo` (or reads `authorizationState`). Until then an operator resolves them by hand; the `error` (`unknown`) and `warn` (`refused`) log lines carry everything needed.
- The `mppx` dialect (P4) behind the same route/tool.
- Facilitator configuration (P3) does not affect this flow — the buyer never calls one.
