# AgentFi invoice agent (QDay Aevum Builder Challenge)

**One invoice, one payment, one receipt.** An operator approves an agent in advance to pay a known vendor up to a limit per invoice. Invoices arrive; the agent checks the vendor, the payee address and the limits, pays in tUSD8 with a plain ERC-20 transfer, and returns a receipt the operator can check on-chain. The same invoice id is paid at most once, including when the agent dies after the payment went out and before it could answer (the exact guarantee and its conditions: [What is guaranteed](#what-is-guaranteed-and-under-which-conditions)).

> **Status: local prototype (2026-11-19).** It runs on a **local Anvil chain** with a **local test token** (`tUSD8-LOCAL`, *not* QDay's tUSD8) and demo data. Nothing here has run on Aevum Testnet yet; see [What is missing for Aevum Testnet](#what-is-missing-for-aevum-testnet).

## Run it

Needs Node 22.13+ and Foundry's `anvil` (on `PATH` or in `~/.foundry/bin`). From the repository root (`npm ci` installs the whole monorepo, a few minutes: the mandate imports AgentFi's policy evaluator from `packages/backend`):

```bash
npm ci
cd packages/invoice-agent
npm run demo        # ~40 s: starts anvil and the agent, runs the scenario, checks invariants, stops everything
npm test            # 11 tests on a local chain: lost response, races, RPC failures, ~7 s
```

Node prints `ExperimentalWarning: SQLite is an experimental feature`: the ledger uses Node's built-in `node:sqlite`; the warning is expected.

`npm run demo` exits 0 only if every invariant held and writes a transcript (path printed at the end; `DEMO_TRANSCRIPT=<file>` to choose it). Ports: Anvil 8566, agent 8787 (`DEMO_ANVIL_PORT`, `DEMO_AGENT_PORT`).

## What the demo shows

1. **The operator authorizes in advance** (`mandate.json`): pay vendor `acme` at its registered address, ≤ 10 tUSD8 per invoice, ≤ 50 per day. The agent reads it and cannot change it.
2. **INV-001, 8 tUSD8 → paid.** The agent answers with a receipt (tx hash, block, log index, from, to, amount). `npm run ops -- verify INV-001` checks it against the chain: `VERIFIED`, one Transfer of 8 tUSD8.
3. **INV-001 again → replayed**: the same receipt, the same tx hash; on-chain still one transfer, payer 100 → 92. INV-001 with a different amount → `conflict`, not paid. A second agent process started on the same ledger refuses to start.
4. **INV-002 (12 tUSD8) → refused**: "above the 10 tUSD8 per invoice the operator approved". **INV-003 (payee changed) → refused**: "not Acme Data Ltd's registered address … a changed bank detail is the classic invoice fraud", with what to do. No transfer, the changed payee received nothing.
5. **The failure that matters.** INV-004: the agent broadcasts the payment and is killed before answering (the caller sees `ECONNRESET`). Resubmitted after a restart → **recovered**: the payment is found on-chain, nothing new is signed or sent, exactly one transfer, the one in the receipt.
6. **Same crash while nothing is being mined** (INV-005): every resubmission answers **PENDING** with the tx hash ("NOT sent again"), `ops verify` says "NOT on-chain yet. Do not pay again; run reconcile"; once a block is mined, `ops reconcile` confirms it and the next resubmission returns that receipt (as `replayed`, since the operator's reconcile confirmed it first).
7. **Crash after recording, before broadcasting** (INV-006): resubmitted → the **same signed transaction** (same hash, same nonce) is sent; still one transfer.

End state, checked by the script: 4 transfers from the payer (8 + 3 + 2 + 1 = 14 tUSD8), payer 86, vendor 14, changed payee 0.

## How it works

**The payment** is `token.transfer(payTo, amount)` sent by the payer's own address (an externally owned account). The token contract moves the balance and emits `Transfer(payer, payTo, amount)`. No escrow contract, no allowance, no relayer; the agent pays gas in the native coin (tQDAY on Aevum).

**One payment per invoice id.** The invoice id is the idempotency key. The ledger (SQLite, `node:sqlite`) has one row per id; a second submission is answered from that row and the chain, never by signing again. Same id with different content (payee or amount) is a `conflict`.

**Write-ahead before broadcast.** The agent signs the transfer locally, so the transaction hash is known before anything is sent, and commits the signed bytes, hash and nonce to the ledger **before** broadcasting. After a crash, a resubmission reconciles that row against the chain:

| The chain says | Answer | Money |
|---|---|---|
| mined, success, Transfer payer → payTo of the exact amount | `recovered` (or `replayed` if already confirmed): the receipt | moved once |
| known to the node, not mined | `pending` + tx hash + "run `ops reconcile`" | not sent again |
| unknown to the node, the payer's nonce still unused | rebroadcast the **same signed bytes** (same hash: can be mined at most once) | moves once |
| unknown to the node, but the payer's nonce is used | `unresolved` (row `stuck`, kept open and checked again every time): "Do NOT pay this invoice again", look up the payer's transaction at that nonce. Another transaction may have used the nonce, or the node has not indexed ours: the agent cannot tell, so it never says "no money moved" | unknown |
| mined but reverted | `failed`: no tokens moved, operator decides | none |
| the RPC fails (timeout, 5xx, …) | an error; the row is left as it was, nothing is decided from a failed read | — |

Before signing a new invoice, open rows are reconciled first (one that cannot be settled right now does not block new invoices), and a new nonce never reuses the nonce of a signed-but-unsent payment (tested). If the id was taken between the check and the write, the freshly signed bytes are discarded, never sent. A refused invoice signed nothing, so a resubmission is judged again (it is paid if the operator has since raised the limit).

## What is guaranteed, and under which conditions

- **At most one payment per invoice id**, with **one agent process per ledger file**: the agent takes an exclusive lock on the ledger at start-up and a second process refuses to start (a lock left by a crashed process is taken over). Two agents on different machines with separate ledgers are not protected against each other.
- **The id is the key, exactly as written** (case-sensitive): `INV-001` and `inv-001` are two invoices; the same content under a new id is a new invoice. The vendor's invoice number is the natural key.
- **A payment is `confirmed` as soon as one block includes it** (0 confirmations): right for a local chain, not enough for a public one (see below).
- **A transaction that stays in the mempool** is reported `pending` forever: there is no fee bump or replacement yet.
- **`ops verify` reads the chain**, and it also uses the agent's ledger to know which transaction belongs to which invoice: it fails when the receipt's block or log differ from the ledger, or when a transfer to that payee is not matched to an invoice.

Tested on a local chain (`npm test`, 11 tests): crash after broadcast, after signing, while nothing is mined; a transaction dropped from the mempool is resent with the same bytes; two writers racing on one invoice; RPC failures during the resubmission; the nonce taken by another transaction; refusal, conflict, re-judged refusal.

**The operator's view** (`npm run ops -- …`, never needs the agent's key): `status` (mandate, every invoice, balances, every Transfer from the payer), `verify <id>` (the receipt against the chain, plus the count of transfers to that payee), `reconcile [<id>]` (brings open rows up to the chain, never signs), `mandate …` (writes the mandate).

## AgentFi before the challenge vs. built for the challenge

| | Before the challenge (AgentFi open source, Apache-2.0) | Built during the challenge (this package) |
|---|---|---|
| Spend rules | `evaluateUsdcSpend` (`packages/backend/src/services/policy/usdc-spend-policy.ts`): per-payment cap, daily limit, allowed recipients, allowed tokens, expiry. **Reused as is**, imported by `src/mandate.ts`. | The mandate (one vendor, its registered address, per-invoice and daily limits), its mapping to an AgentFi policy, the vendor identity check, plain-language refusals with "what to do" |
| Payments | x402 purchases of HTTP resources (EIP-3009 authorizations settled by the seller's facilitator), with a Postgres ledger and on-chain reconciliation of `transferWithAuthorization` | Direct ERC-20 invoice payment from the payer's own key; the write-ahead ledger; the reconciliation by transaction hash and nonce; receipts and `ops verify`; the lost-response handling and its tests |
| Not used here | the AgentFi API, worker, MCP server, Postgres/Redis, Turnkey/Safe wallets | — |

The x402 ledger taught the vocabulary used here (money proven on-chain vs. reported, a block refused before anything is signed, "do not retry with a new id"), but its code is EIP-3009-specific and was not reused.

## What is missing for Aevum Testnet

Nothing below has been done; each needs the QDay round's own scope (keys, faucet, public transactions).

- Point the mandate at Aevum: `chainId` 44005, `token` = tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals), RPC `https://rpc-test.qday.info`, explorer `https://explorer-test.qday.info`. Nothing needs deploying.
- A payer key funded from the faucet (tQDAY for gas, tUSD8 to pay), kept out of the repository, and a vendor address.
- `ops status` and `verify` read Transfer logs from block 0; on a public chain they need a starting block (a small change).
- Confirmation depth before `confirmed` (and re-checking a confirmed payment after a reorg), fee bumping for a transaction stuck in the mempool, and the RPC's behaviour under load (its "not found" vs. its errors).
- The demo's crash scenarios use Anvil-only calls (`evm_setAutomine`, `evm_mine`); on Aevum the lost-response case is shown with a real crash and a resubmission, and the pending case depends on block timing.
- Not verified: the RPC's behaviour for `eth_sendRawTransaction` of already-known transactions and for `txpool` calls (only `eth_*` methods are used outside the demo).

## Third-party code

Runtime: [viem](https://github.com/wevm/viem) (MIT). Development: [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), `@types/node` (MIT). SQLite through Node's built-in `node:sqlite`. The test token is compiled with Foundry (`npm run build:token`; solc 0.8.24).

## Files

- `src/invoice.ts` invoice shape, amounts, content hash · `src/mandate.ts` the operator's mandate and the verdict (uses AgentFi's evaluator)
- `src/ledger.ts` the write-ahead ledger · `src/chain.ts` sign / broadcast / receipts / Transfer logs · `src/payer.ts` the decision and the reconciliation
- `src/server.ts` the headless agent (HTTP) · `src/ops.ts` the operator CLI · `src/demo.ts` the scenario
- `test/lost-response.test.ts` the crash cases · `test/review-fixes.test.ts` races, RPC failures, nonce taken, re-judged refusal (from the independent review) · `contracts/src/LocalTestUSD8.sol` the local test token
