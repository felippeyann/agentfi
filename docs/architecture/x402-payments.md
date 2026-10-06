# x402 payments — buyer-side client

> Task P1 of the [execution plan](../project/execution-plan-2026-10.md) (WS4). Written 2026-10-06 against `@x402/core`, `@x402/fetch`, `@x402/evm`, `@x402/extensions` **2.28.0**. The legacy `x402` / `x402-fetch` 1.x packages are not used.

Sources: [x402.org](https://www.x402.org) · [coinbase/x402](https://github.com/coinbase/x402) · the installed packages' `.d.ts` files (API names below are the ones that exist in 2.28.0, not the ones in the docs where they differ) · the maintainer's September lab (`~/agentfi-lab`, fake-facilitator harness and the 14-case budget ledger).

## 1. What the service does

`packages/backend/src/services/payments/x402-client.service.ts` exports `X402ClientService.payResource(...)`: fetch a URL; if it answers `402` with x402 v2 requirements, sign a token authorization with the agent's wallet and fetch again with `PAYMENT-SIGNATURE`; return the final response plus what we know about the payment.

```ts
const signer = await toClientSigner(getWalletService(), agent.walletId); // services/wallet/signer.ts
const result = await new X402ClientService().payResource({
  signer,
  url: 'https://api.example.com/quote',
  maxAmountUsd: '$0.50',              // required; no implicit default
  allowedNetworks: ['eip155:84532'],  // CAIP-2; default: any eip155:* network
  paymentId: 'job_…',                 // optional idempotency key
});
// result: { status, body, headers, paid, payment?: { paymentId, network, asset, amount, payer, txHash?, receipt?, receiptVerified? } }
```

Roles, so there is no confusion later: the **buyer** (this service) never talks to a facilitator. It signs an EIP-3009 `transferWithAuthorization` (or a Permit2 authorization) off-chain and hands it to the **resource server**, which calls **its** facilitator to verify and settle, then reports the outcome in the `PAYMENT-RESPONSE` header. Nothing in this service broadcasts a transaction or holds gas.

A `non-402` first response is returned untouched (`paid: false`, nothing signed) — including 4xx/5xx errors. Only payment-specific failures throw.

Scheme support: `exact` on EVM (`eip155:*`) via `ExactEvmScheme` from `@x402/evm/exact/client`. `upto`, Solana, and the `mppx` dialect (P4) are out of scope.

## 2. Spend controls — three gates before a signature exists

| Gate | Where | What it checks |
|---|---|---|
| 1 | `preflight()` in the service, on the raw 402 | Among `accepts[]`: scheme `exact`, network matches `allowedNetworks`, asset is a known USD stablecoin (`ExactEvmScheme.findDefaultAsset`, e.g. USDC on Base / Base Sepolia). None → `NoAcceptableSchemeError`. Some, but every one above `maxAmountUsd` → `BudgetExceededError`. Both carry the offered options in `details`. |
| 2 | `x402Client.fromConfig({ spendControls: { maxAmountPerPayment } })` | The library's own filter (default-asset allowlist + USD cap), built per call from the job's cap and networks. |
| 3 | `onBeforePaymentCreation` hook | Re-prices the option the library actually selected against the cap; returns `{ abort: true }` if it disagrees and the service rethrows `BudgetExceededError`. Also the hook that appends the payment id (§3). |

Gate 1 exists because the library collapses "all options filtered" into a generic `Error` inside `wrapFetchWithPayment`, which would lose the distinction between "nothing we can pay with" and "too expensive"; checking the 402 ourselves first gives typed errors and guarantees the facilitator is never reached. All three gates use the same math (`convertToTokenAmount(cap, asset.decimals)` vs the atomic `amount`), so gate 3 only fires if the library selects something gate 1 did not consider affordable — a defensive redundancy, not an independent policy.

`maxAmountUsd` must be a plain USD amount (`"$1"`, `"0.50"`); ticker suffixes are rejected. Non-default assets (anything `findDefaultAsset` does not know) are never paid.

The cap is per **payment**. Per-job budgets, reservations and double-spend protection across retries are P5 (the ledger from the lab), on top of this service.

## 3. Idempotency — `payment-identifier`

When the 402 declares the `payment-identifier` extension, the hook appends `paymentId` (caller-supplied or `agentfi_<32 hex>` generated via `generatePaymentId`) to `extensions["payment-identifier"].info.id`, which the client echoes in the payment payload. `paymentId` is always returned, including on `PaymentFailedError.details`, so the caller can persist it before retrying.

What the id does **not** do: the extension carries an identifier; deduplication is the resource server's responsibility (an in-memory cache in the test server proves the shape; the lab proved the absence). Retrying with the same id against a server without a cache settles twice — the test `documents that the extension alone does not deduplicate` asserts exactly that. A retry decision after an unknown outcome therefore belongs to P5's reconciliation, never to this service.

## 4. Receipts — `offer-receipt`

If the server declares `offer-receipt`, the 402 carries signed **offers** (one per `accepts[]` entry) and a successful settlement carries a signed **receipt** in `PAYMENT-RESPONSE.extensions["offer-receipt"].info.receipt`. The service returns the raw receipt and sets `receiptVerified: true` only when all of the following hold:

1. offer and receipt are EIP-712 signed (`verifyOfferSignatureEIP712` / `verifyReceiptSignatureEIP712`) and recover to the **same** signer — this binds the receipt to the offer we accepted (matched by scheme/network/asset/payTo/amount);
2. the receipt's `resourceUrl`, `network` and `payer` match the offer and our signer address, and it was issued within the last hour (`verifyReceiptMatchesOffer`);
3. if the receipt names a `transaction`, it equals the settlement's.

A receipt that fails any check — or a JWS-format receipt, which needs DID key resolution we do not do yet — yields `receiptVerified: false` **without** failing the payment; the server did settle, we just cannot vouch for its receipt. There is no trust anchor: "verified" means "internally consistent and signed by whoever signed the offer", not "signed by a key we trust".

2.28.0 quirk found while testing: with `declareOfferReceiptExtension({ includeTxHash: true })`, receipts come back **without** a transaction hash, because `x402HTTPResourceServer` stores each extension's 402 enrichment output (`{ info: { offers }, schema }`) into the same `declaredExtensions` object it later passes to settlement, overwriting `includeTxHash`. `@x402/express` forwards that object unchanged. The test harness passes the route-level declaration to `processSettlement` instead so the tx binding is exercised; real servers on 2.28.0 will mostly produce receipts without a hash, and check 3 then has nothing to compare.

## 5. Errors

All extend `X402PaymentError` (`code`, `details`):

| Error | `code` | Signed? | Meaning |
|---|---|---|---|
| `NoAcceptableSchemeError` | `NO_ACCEPTABLE_SCHEME` | no | No option is `exact` + allowed network + known USD asset. |
| `BudgetExceededError` | `BUDGET_EXCEEDED` | no | Every acceptable option costs more than `maxAmountUsd`. |
| `PaymentFailedError` | `PAYMENT_FAILED` | see `details.authorizationSent` | 402 without usable requirements (`false`); server rejected the signed payment, settlement failed, or the paid request failed in transit (`true`). |

`authorizationSent: true` means a signed authorization left this process. A transport error at that point is an **unknown** outcome (the lab's "response lost after fake settlement" case): the server may have settled. Do not retry automatically; record `paymentId` and reconcile (P5).

A 2xx with no `PAYMENT-RESPONSE` after we sent a payment returns `paid: false` with `payment` present (no `txHash`): the server accepted the request but reported no settlement — same reconciliation path.

## 6. Facilitators

Per-chain defaults live in `config/x402.ts` (`getX402FacilitatorUrl(chainId)`), overridable with `X402_FACILITATOR_URL`:

| Chain | Facilitator | Auth |
|---|---|---|
| Base Sepolia (84532) | `https://x402.org/facilitator` | none; testnet only |
| Base (8453) | `https://api.cdp.coinbase.com/platform/v2/x402` | CDP API key, to be supplied through `HTTPFacilitatorClient.createAuthHeaders` when AgentFi acts as a resource server (not wired in P1) |

Circle's facilitator remains optional (P3). Because the buyer never calls a facilitator, these values do not affect `payResource`; they are here so the choice is explicit for the seller/reconciliation tasks.

## 7. Wallet signing

`services/wallet/signer.ts` — `toClientSigner(walletService, walletId)` resolves the address and returns `{ address, signTypedData }`, the only surface `ExactEvmScheme` needs for the base flow. Both providers gained `signTypedData`:

- `LocalWalletService`: viem account `signTypedData`.
- `TurnkeyService`: `hashTypedData` locally, `signRawPayload` with `HASH_FUNCTION_NO_OP`, r||s||v assembled exactly as `signMessage` already did (shared `signDigest`). Tested against a mocked SDK that signs the digest with an ephemeral key, so the digest and assembly code paths are real.

Not provided: `readContract` / `signTransaction` on the signer, so the EIP-2612 gas-sponsoring enrichment for Permit2 tokens is inert. USDC uses EIP-3009 and does not need it.

## 8. Tests and what they do not prove

`src/__tests__/x402-client.service.test.ts` runs a real x402 v2 resource server (`@x402/core/server` + `@x402/evm/exact/server` on raw `node:http`, driven the same way `@x402/express` drives Express) with a **fake facilitator** that accepts every authorization and returns a synthetic tx hash. Cases: free resource; non-402 error returned; paid within cap (amount `400000` for `$0.40`, payer, fake tx hash); price at the cap; caller-supplied id; above cap → `BudgetExceeded`, facilitator never called; wrong network → `NoAcceptableScheme`; malformed inputs; same id twice with and without a server cache; verify rejected and settle failed → `PaymentFailed`; receipt valid / altered after signing / honest but naming another tx.

The fake facilitator does **not** prove: signature validity, balances, nonces or validity windows; that any USDC moves; that a tx hash exists; facilitator authentication, timeouts or `settlement_pending`; or anything about a real server's deduplication. `src/__tests__/wallet.signer.test.ts` and `src/__tests__/x402.config.test.ts` cover the signer adapter and config.

## 9. Still off-chain / unproven — explicit list

- No payment has been made on Base Sepolia or Base; no wallet has been funded.
- No real facilitator (x402.org, CDP) has been called; CDP auth is not implemented.
- `txHash` and `payer` are whatever the server's `PAYMENT-RESPONSE` says; nothing is checked against an RPC.
- Receipts have no trust anchor (no issuer registry, no DID resolution, no JWS).
- No per-job budget, reservation, or protection against paying twice across process restarts (P5).
- No `ResourcePayment` persistence, route, or MCP tool (P2).
- `@x402/express` is not a dependency: its required `express` peer would add ~60 packages to the lockfile for a test-only server, and `@x402/core/server` already provides the full pipeline.
- The `includeTxHash` quirk (§4) is observed on 2.28.0 and not reported upstream yet.
