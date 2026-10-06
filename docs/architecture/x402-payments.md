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

The cap is per **payment**. Per-job budgets, reservations and double-spend protection across retries are P5 (the ledger from the lab), on top of this service.

## 3. Idempotency — `payment-identifier` — and what it does not do

When the 402 declares the `payment-identifier` extension, the hook appends `paymentId` (caller-supplied or `agentfi_<32 hex>` generated via `generatePaymentId`) to `extensions["payment-identifier"].info.id`, which the client echoes in the payment payload. `paymentIdSent` on the result (and on `PaymentFailedError.details`) is true only when that actually happened; when the server did not declare the extension it never saw the id. `paymentId` is always returned, including on `PaymentFailedError.details`, so the caller can persist it before retrying.

**The client re-signs on every call.** `payResource` creates a fresh EIP-3009/Permit2 authorization with a new nonce each time it is invoked — the id does not short-circuit anything on our side, and the server cannot see it until the signed payment arrives (it travels inside the payload, not on the plain request). So even against a server with an idempotency cache, calling twice with the same `paymentId` produces **two live authorizations** and one settlement; the test `signs a fresh authorization on every call; a server cache keyed by paymentId prevents the second settlement` asserts exactly that (`signatures: 2`, distinct nonces, `settle: 1`). Against a server without a cache it settles twice.

Rule for P5 (reconciliation): **do not call `payResource` again for a `paymentId` whose last attempt had `authorizationSent: true` until that attempt is reconciled.** The outcome of the first authorization is unknown; the nonce and `validBefore` in `details.authorization` are what reconciliation needs — either the settlement shows up on-chain, the window passes, or the authorization is cancelled (`cancelAuthorization` on EIP-3009 tokens). Only then is a new signature safe.

## 4. Receipts — `offer-receipt`

If the server declares `offer-receipt`, the 402 carries signed **offers** (one per `accepts[]` entry) and a successful settlement carries a signed **receipt** in `PAYMENT-RESPONSE.extensions["offer-receipt"].info.receipt`. The service returns the raw receipt and sets `receiptVerified: true` only when all of the following hold:

1. the offer matched to our accepted option (by scheme/network/asset/payTo/amount) names the resource the 402 itself declared (`paymentRequired.resource.url`) and, when it carries `validUntil`, had not expired when we signed;
2. offer and receipt are EIP-712 signed (`verifyOfferSignatureEIP712` / `verifyReceiptSignatureEIP712`) and recover to the **same** signer — this binds the receipt to the offer we accepted;
3. the receipt's `resourceUrl`, `network` and `payer` match the offer and our signer address, and it was issued within the last hour (`verifyReceiptMatchesOffer`);
4. **when the receipt names a transaction**, it equals the settlement's. 2.28.0 servers usually omit it (quirk below), in which case this check has nothing to compare and the receipt is bound to the offer and payer only, not to a settlement tx.

A receipt that fails any check — or a JWS-format receipt, which needs DID key resolution we do not do yet — yields `receiptVerified: false` **without** failing the payment; the server did settle, we just cannot vouch for its receipt. There is no trust anchor: "verified" means "internally consistent and signed by whoever signed the offer", not "signed by a key we trust".

2.28.0 quirk found while testing: with `declareOfferReceiptExtension({ includeTxHash: true })`, receipts come back **without** a transaction hash, because `x402HTTPResourceServer` stores each extension's 402 enrichment output (`{ info: { offers }, schema }`) into the same `declaredExtensions` object it later passes to settlement, overwriting `includeTxHash`. `@x402/express` forwards that object unchanged. The test harness passes the route-level declaration to `processSettlement` instead so the tx binding is exercised; real servers on 2.28.0 will mostly produce receipts without a hash.

## 5. Errors

All extend `X402PaymentError` (`code`, `details`). Messages never contain the URL's query string, fragment or userinfo (API keys travel there) and clip server-supplied reasons at 200 characters; the full URL and the decoded server objects live in `details`.

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
- receipt valid / altered after signing / honest but naming another tx / signed by a key other than the offer's / offer + receipt for a different resource than the 402 named / offer expired before signing.

The fake facilitator does **not** prove: signature validity, balances, nonces or validity windows; that any USDC moves; that a tx hash exists; facilitator authentication or `settlement_pending`; or anything about a real server's deduplication. `src/__tests__/wallet.signer.test.ts` (incl. `v` = 27/28 on every path and both Turnkey `v` encodings), `src/__tests__/x402.config.test.ts` and `src/__tests__/env.example.test.ts` cover the signer adapter and config.

## 9. Still off-chain / unproven — explicit list

- No payment has been made on Base Sepolia or Base; no wallet has been funded.
- No real facilitator (x402.org, CDP) has been called; CDP auth is not implemented.
- `txHash` and `payer` are whatever the server's `PAYMENT-RESPONSE` says; nothing is checked against an RPC.
- Receipts have no trust anchor (no issuer registry, no DID resolution, no JWS).
- No per-job budget, reservation, or protection against paying twice across process restarts (P5) — and no `cancelAuthorization` helper yet; the nonce is surfaced so P5 can add one.
- No `ResourcePayment` persistence, route, or MCP tool (P2).
- `@x402/express` is not a dependency: its required `express` peer would add ~60 packages to the lockfile for a test-only server, and `@x402/core/server` already provides the full pipeline.
- The `includeTxHash` quirk (§4) is observed on 2.28.0 and not reported upstream yet.
