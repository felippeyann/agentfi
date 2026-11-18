# AgentFi

[![Status: developer alpha](https://img.shields.io/badge/status-developer%20alpha-orange.svg)](#status-and-limits)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Website: [agentfi.cc](https://agentfi.cc) · [Run the local demo](docs/alpha/quickstart.md) · [Send feedback](docs/feedback.md)

**Spend controls and a payment ledger for AI agents that buy paid APIs and services.** AgentFi is a self-hosted, headless API and [MCP](packages/mcp-server/README.md) layer: your agent pays an [x402](https://www.x402.org) (HTTP 402) resource under rules you set, the budget is enforced before anything is signed, payment and delivery are recorded separately, and payments whose outcome is uncertain are reconciled against the chain.

> **Developer alpha.** It runs locally, on your machine. We do not offer a hosted service. This alpha deploys and uses no contracts on a public network (legacy contracts from earlier versions exist on Base mainnet; do not use them), and everything x402 was demonstrated on a **local Anvil fork of Base Sepolia**, not on a public testnet and not on mainnet. Do not point it at funds you care about.

## Who it is for

- **Software and automation companies whose agents buy services** and answer for the spend.
- **The integrator developer**, who calls an HTTP/OpenAPI endpoint or an MCP tool from any agent framework.
- **The budget owner**, who needs limits, a payment ledger and a clear list of exceptions.

## The problem

An agent that can pay can also overspend, pay twice after a timeout, or pay for something it never received. Payment rails give you a wallet; they do not give you a budget, a record that separates "money moved" from "the work arrived", or an answer for "did that timed-out payment go through?".

## The first flow

1. **Configure the rules.** Agent policy (per-payment cap in USD, daily volume, allowed tokens and recipients, pause) and a job whose reward is the budget.
2. **The agent buys through x402.** The provider of an accepted job pays a `402` resource with `POST /v1/jobs/{id}/pay-resource` (MCP: `pay_for_resource`).
3. **The budget is respected.** The price is checked against the policy and the remaining budget (job reward minus counted payments) *before* a signature exists. Over budget is refused, not paid.
4. **Payment and delivery are tracked separately.** A payment row (`reserved`, `pending`, `settled`, `unknown`, `refused`, `failed_before_signing`; the reconciliation worker may also set `expired`) is independent of what the resource returned and of the job's own status.
5. **Uncertain operations are reconciled.** A payment whose answer was lost stays counted against the budget and is never retried blindly. The worker reads the USDC contract and settles or releases the row only on proof.

> **Scope of the budget.** The budget is per **job**, and the buyer is the *provider* of an `ACCEPTED` job. There are no budgets per client or per task beyond that, and no standalone "agent buys X" endpoint. Reconciliation proves whether a payment happened; it does not recover content and never re-fetches a paid resource.

## Minimal example

```bash
curl -X POST "$AGENTFI_API_URL/v1/jobs/$JOB_ID/pay-resource" \
  -H "x-api-key: $PROVIDER_AGENT_KEY" -H "content-type: application/json" \
  -d '{ "url": "https://seller.example/quote", "method": "GET", "maxAmount": "0.50" }'
```

Field names below follow [`docs/api/openapi.yaml`](docs/api/openapi.yaml) (`PayResourceResponse`, `ResourcePayment`, `ResourcePaymentError`), trimmed for reading.

**Settled** (`200`): the resource was fetched and the payment recorded.

```json
{ "payment": { "paymentId": "…", "status": "settled", "amount": "400000", "settlementTxHash": "0x…" },
  "remainingBudget": { "symbol": "USDC", "remaining": "600000", "remainingFormatted": "0.6" },
  "resource": { "status": 200, "body": { "…": "…" }, "truncated": false } }
```

**Unknown** (`502`, code `PAYMENT_OUTCOME_UNKNOWN`): no answer after signing, money may have moved. It is not retried; the nonce and window are returned for reconciliation and the amount stays counted.

```json
{ "code": "PAYMENT_OUTCOME_UNKNOWN", "paymentId": "…",
  "authorization": { "method": "eip3009", "nonce": "0x…", "validAfter": "…", "validBefore": "…" } }
```

**Partial delivery**: the paid response was cut at the 64 KiB read limit, `resource.truncated: true`. The payment is still `settled`; delivery is a separate fact. (A server that reports no settlement comes back `200` with `payment.status: "unknown"` and a `warning`.)

Refusals before signing (`402 BUDGET_EXCEEDED`, `403 POLICY_VIOLATION`, `400 INVALID_URL`, ...) sign nothing and spend nothing. Full state machine: [x402 payments](docs/architecture/x402-payments.md).

## Quickstart

Start at **[docs/alpha/quickstart.md](docs/alpha/quickstart.md)**. Every run is labelled with one of three modes so a demo is never mistaken for a public transaction:

| Mode | What it is |
|---|---|
| **SIMULATION** | No chain and no funds. Shows the flow and the rules. |
| **LOCAL FORK** | A local Anvil fork of Base Sepolia with test USDC (`npm run demo:x402:fork` in `packages/backend`). The mode all current x402 evidence comes from. |
| **PUBLIC TESTNET** | Real Base Sepolia. **Not done yet.** A separate, gated milestone; the prepared package is [x402 testnet proof](docs/operations/x402-testnet-proof.md) (not executed). |

**Install = checkout.** There is no package release for the x402 features yet: use a git checkout (or tag) of this repository. The npm package `@agent_fi/mcp-server` is at **0.5.0** (31 tools, published 2026-05-15) and does **not** include `pay_for_resource`; `main` has 35 tools. A 0.6.0 release is planned ([roadmap](docs/project/roadmap-alpha.md)). Until it ships, do not `npm i` for x402.

## Compatibility

HTTP/OpenAPI and MCP first; framework examples are tracked in the **[compatibility matrix](docs/integrations/compatibility.md)**, which says per framework and version what is tested and what is not. `packages/adapters` holds thin tool adapters (not published to npm); see the matrix for what was tested. In the adapters the legacy DeFi tools are opt-in; the MCP server and the backend, however, expose the experimental DeFi/transaction tools and routes unconditionally, so give a paying agent only the payer-safe tool subset (see the matrix).

## What works today

| Status | What |
|---|---|
| **Works locally** (tests and local-fork demo; not a public network) | x402 `exact` buyer with a job budget · agent policy caps (per payment, daily volume, token and recipient allowlists, pause) · payment ledger with idempotent retries · automatic reconciliation of unknown payments (worker) · outbound target policy (no private hosts, no redirects) · MCP tools in source, incl. `pay_for_resource` · OpenAPI contract |
| **Experimental** | ERC-8183 job escrow and ERC-8004 reputation (local fork only) · A2A jobs · DeFi tools (swaps, Aave, Compound, ERC-4626, Curve) and GMX · ENS names · admin dashboard |
| **Not available** | Safe mode (does not work; refused in production and staging) · AgentFi contracts on any public network (the maintainer's Base mainnet pair is legacy: do not use it) · hosted service · mainnet use · `upto` / auth-capture payments · multi-tenant SaaS |

## Status and limits

- Self-hosted by design; we do not offer a hosted service.
- **Defaults are permissive, set your own limits.** A new agent's policy has `maxValuePerTxUsd=1.0` and `maxDailyVolumeUsd=10000`; empty `allowedRecipients` (and token / contract lists) means any payee. Set `allowedRecipients` and the caps yourself before running anything that matters (see [`openapi.yaml`](docs/api/openapi.yaml)).
- Agent wallets: keys held by Turnkey when `WALLET_PROVIDER=turnkey`; the in-memory local provider is for development only and is refused in production and staging. The escrow evaluator's key is a raw key held by the backend.
- Alpha: APIs and tool shapes can change. Not audited. No production funds.
- Only USDC on a supported chain, `exact` scheme, EVM.
- Details and history: [STATE.md](STATE.md) · [alpha roadmap](docs/project/roadmap-alpha.md) · [Project history & postmortem](docs/project/history.md).

## Feedback and security

- **Tried it? Tell us where it broke or worked:** open an [alpha feedback or integration request](https://github.com/felippeyann/agentfi/issues/new/choose) ([what we ask and never collect](docs/feedback.md)). No telemetry; do not paste prompts, keys, seeds or customer data. The issue forms need a (free) GitHub account; there is no account-free channel yet.
- **Vulnerabilities:** [report privately](https://github.com/felippeyann/agentfi/security/advisories/new), never in a public issue. See [SECURITY.md](SECURITY.md).
- [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md).

## Documentation

[Documentation hub](docs/README.md) (alpha quickstart first) · [Dev quickstart](docs/dev-quickstart.md) · [Architecture](docs/architecture/overview.md) · [x402 payments](docs/architecture/x402-payments.md) · [API reference](docs/api-reference.md) · [MCP server](packages/mcp-server/README.md)

## License

Apache 2.0, see [LICENSE](LICENSE).
