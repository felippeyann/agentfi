# x402 public-testnet proof — package for approval (NOT executed)

Prepared 2026-11-15. Nothing here has been run on a public network. Everything x402 so far ran on a **local Anvil fork** of Base Sepolia (`npm run demo:x402:fork`); a fork is not a testnet proof. This page is the exact package an owner approves (or trims) before anyone runs it. Approving C4/C5 does **not** approve this.

## 1. What it would prove — two tracks, never one for the other

| Track | Seller | Proves | Does NOT prove |
|---|---|---|---|
| **T — controlled seller** | ours: `src/__tests__/e2e/x402-demo-seller.ts` pointed at Base Sepolia (we choose its failure modes) | the AgentFi flow on the public network with real finality and a public facilitator: budget, block before signing, lost response proven automatically, partial delivery, `wait → expired` with two independent RPCs | that third-party sellers behave like ours |
| **I — independent seller** | a third-party x402 v2 resource on Base Sepolia (we control nothing) | happy-path interoperability: our buyer pays someone else's 402, the money is proven on-chain, delivery recorded | any recovery path (we cannot make an independent seller drop a response) |

## 2. Candidate and migrations

- Code: `main` after the automatic-reconciliation PR is merged (the merge SHA is recorded in the brain note `orquestracao/tarefas/2026-11-15-x402-primeira-entrega.md`). Nothing newer without a new review.
- Migrations on a **dedicated** database: `0001`–`0029` (`0027_x402_reconciliation`, `0028_x402_resource_truncated`, `0029_x402_reconcile_state` are the x402 ones). Never the C4/C5 database.

## 3. Network, token, contracts

- Base Sepolia, chain id 84532 (CAIP-2 `eip155:84532`).
- USDC (Circle FiatToken, EIP-3009) `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- No AgentFi contract: the x402 path never touches the escrow.

## 4. Facilitator (support verified 2026-11-15 by an unauthenticated `GET /supported`)

| Facilitator | Verified | Use |
|---|---|---|
| `https://x402.org/facilitator` (Coinbase-hosted, testnet) | `GET /supported` 200, no auth: `{x402Version: 2, exact, eip155:84532}` listed (also v1 `base-sepolia`) | **Track T, first choice.** Not verified: whether `/verify` / `/settle` need a key — the first purchase of T1 tells; if refused, fall back to self-facilitation |
| self-facilitated (`@x402/evm` exact facilitator, the code proven on the fork) | runs locally | Track T fallback: needs a **testnet gas wallet** (≤ 0.01 test ETH) |
| CDP (`api.cdp.coinbase.com/platform/v2/x402`) | `GET /supported` → 401 | not used (needs a CDP API key) |
| PayAI | `/supported` 200, lists v2 exact eip155:84532 | not used |

Track I uses whatever facilitator the independent seller configured.

## 5. Independent resources (candidates; single unauthenticated probe, 2026-11-15 ~19:00 UTC)

All answered `402` with x402 v2, `exact`, `eip155:84532`, USDC `0x036C…CF7e`. Hobby / demo deployments with no SLA: **re-probe right before the run**; pick one that still answers.

| URL | Operator | Price |
|---|---|---|
| `https://tollbooth-hello-testnet.sjwilliams8.workers.dev/hello` | individual | 0.001 USDC |
| `https://x402-test.genesisblock.ai/api/weather` | GenesisBlock | 0.001 USDC |
| `https://wallets-demo-seller-server.calebgcarithers.workers.dev/weather` | individual | 0.001 USDC |

Our client is **v2 only**: v1-only sellers (`base-sepolia` network names) are out of scope.

## 6. Credentials and accounts (names only; the owner types values into the local `.env`, never into chat)

| Name | For | Notes |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | dedicated testnet DB / Redis logical DB | local docker is enough |
| `RPC_URL_84532` | primary evidence + backend RPC | an existing provider key (e.g. via `ALCHEMY_API_KEY`) |
| `X402_RECONCILE_SECOND_RPC_URL_84532` | second, **independent** evidence source for automatic expiry | e.g. `https://sepolia.base.org` (public, no key) — must be a different provider than the primary |
| `API_SECRET`, `ADMIN_SECRET`, `OPERATOR_FEE_WALLET` | backend boot | throwaway values for this run |
| `WALLET_PROVIDER=local` | buyer agent wallet | **recommended**: an ephemeral key living in the backend process; funded with ≤ 1 test USDC; leftovers are abandoned (worthless). Turnkey only with a separate approval (it would reuse the C4/C5 organization) |
| seller `payTo` (track T) | an address the owner controls on testnet | receives the test USDC; no key needed on the machine when x402.org settles |
| facilitator gas key (track T fallback only) | `transferWithAuthorization` gas | new testnet wallet, ≤ 0.01 test ETH |
| faucets | test USDC (Circle faucet: 20 USDC / request / 2 h, no account; CAPTCHA) and, for the fallback, test ETH | **the owner** does the faucet step (CAPTCHAs are not automated) |

## 7. Scenarios and acceptance

Policy set by the operator: `maxValuePerTxUsd 0.05`, `maxDailyVolumeUsd 0.20`, `allowedRecipients` = [track-T `payTo`, track-I seller's `payTo`]. Job budget 0.50 USDC. Seller prices on track T: 0.01 USDC (0.06 for the block test). Reconciliation head `safe` (Base Sepolia finality makes `finalized` slow; record which one was used).

| # | Scenario | Acceptance (all observed on Base Sepolia + seller counts + ledger) |
|---|---|---|
| T1 | allowed purchase | `settled`, then proven automatically by the worker; one `Transfer` buyer → `payTo` on basescan with the ledger's tx hash |
| T2 | 0.06 purchase above the 0.05 limit | `403 POLICY_VIOLATION`, no signature, 0 paid requests at the seller, no transfer |
| T3 | seller settles, drops the response | `502 unknown`; the retry with the same id is a replay; the worker proves it; exactly one transfer |
| T4 | body above the 64 KiB read limit | proven, delivery `partial`, operator action shown |
| T5 | seller verifies, never settles | `wait`, then `expired` after `validBefore` + margin **confirmed by the second RPC**; budget released; no transfer for that nonce |
| T6 | primary RPC unreachable for a few minutes (point `RPC_URL_84532` at a dead port, restart the worker) | rows stay `unknown` and counted, backoff visible in `x402:ops status`, nothing expired; proven after restoring it |
| I1 | one purchase from an independent seller | `settled`/`unknown` → proven by the worker with the seller's `payTo`; delivery recorded (complete/partial/unknown) |

Pass = every row: ledger `proven` ⇔ an on-chain Transfer with the same tx hash; agent wallet delta = sum of proven rows; no paymentId with more than one signature.

## 8. Caps

- **Signed authorizations:** at most 8. T1 1, T3 1, T4 1, T5 1, I1 ≤ 2, plus 2 of margin; T2 signs none.
- **On-chain transfers:** at most 6 (T5 produces none). With self-facilitation there are at most 6 gas transactions.
- **Test USDC:** buyer funded with ≤ 1.00 and spending ≤ 0.10 by construction. Stop above 0.20, which is also the policy's daily cap.
- **Test ETH:** the buyer needs 0 (EIP-3009, the facilitator pays the gas). The facilitator wallet, in the fallback only, gets ≤ 0.01.
- **External costs:** none expected. The x402.org facilitator and the faucets are free, the CDP facilitator is not used, and the RPC runs on an existing free tier.

## 9. Stop and recovery

**Stop immediately on any of these:**
- a ledger/chain mismatch;
- a second signature for one paymentId;
- an automatic `expired` without the second-source confirmation in its note;
- spend above the cap;
- repeated facilitator errors.

**Track I stops on its own:** if the independent seller fails, only track I stops (it is outside our control).

**Recovery:**
- An open row is handled by the worker. Use `x402:ops status` to check it, and `x402:ops reconcile --apply` or `x402:ops resolve` when the report asks for an operator.
- Every authorization lapses within its `maxTimeoutSeconds` (≤ 120 s on track T). Nothing stays live for long.
- Nothing is swept back: the remaining test USDC is abandoned.

## 10. Duration and owner presence

- **Preparation, about 45 min:**
  - `.env` with the owner typing the RPC values;
  - the dedicated DB and the migrations;
  - funding by the owner from the faucet (about 5 min with a CAPTCHA);
  - the policy and the job.
- **Run, about 45–75 min:**
  - most of it is waiting for `safe`/finality and for `validBefore` + margin (T5);
  - the owner only needs to be present for the faucet step and the go/no-go at the start. A short check-in at the end is recommended.
- **Report, about 15 min:**
  - the transcript, the basescan links and the ledger dump go into `agentfi-notas`.

## 11. Known blockers and the smallest alternative

- **x402.org `/settle` may require a key:** in that case track T self-facilitates (fallback in §4), which needs approval for the gas wallet.
- **Track I may find no independent v2 seller alive:** it is then reported as "not run". It is not replaced by our own seller.
- **Smallest alternative if the public run is not approved:** keep the fork demo and add an `anvil --fork-url` run pinned to a **recent** public block on the day. That still does not count as a testnet proof.
