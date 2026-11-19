# AgentFi invoice agent (QDay Aevum Builder Challenge)

**One invoice, one payment, one receipt.** An operator approves an agent in advance to pay a known vendor up to a limit per invoice. Invoices arrive; the agent checks the vendor, the payee address and the limits, pays in tUSD8 with a plain ERC-20 transfer, and returns a receipt the operator can check on-chain. The same invoice id is paid at most once, including when the agent dies after the payment went out and before it could answer (the exact guarantee and its conditions: [What is guaranteed](#what-is-guaranteed-and-under-which-conditions)).

> **Status: local prototype (2026-11-19).** It runs on a **local Anvil chain** (chain id 31337) with a **local test ERC-20** (`tUSD8-LOCAL`: 6 decimals like QDay's tUSD8, open mint, deployed by the demo; *not* QDay's tUSD8) and demo data. Nothing here has run on Aevum Testnet yet; see [What is missing for Aevum Testnet](#what-is-missing-for-aevum-testnet).

## Run it

Needs Node 22.13+ and Foundry's `anvil` ([install Foundry](https://book.getfoundry.sh/getting-started/installation): `curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`; on `PATH` or in `~/.foundry/bin`). No wallet, key, faucet or public network is needed: everything runs on your machine.

```bash
git clone https://github.com/felippeyann/agentfi.git
cd agentfi
npm ci                 # the whole monorepo, a few minutes: the mandate imports AgentFi's policy evaluator from packages/backend
cd packages/invoice-agent
npm run demo           # 20-40 s: starts anvil and the agent, runs the scenario, checks invariants, stops everything
npm test               # 32 tests on a local chain: lost response, races, RPC failures, the lock, guards, confirmation rule and reorgs, 15-30 s
```

**What to expect.** The demo prints each step (below) with the agent's answer, the operator's `ops verify` / `ops status` output and a `✓` per invariant, and ends with `OK: every invariant held.` and exit code 0 (a broken invariant prints `✗ INVARIANT BROKEN` and exits 1). `npm test` may print `ExperimentalWarning: SQLite is an experimental feature`: the ledger uses Node's built-in `node:sqlite`; the warning is expected.

**Where the receipt is.** The agent answers `POST /invoices` with JSON; when paid, `receipt` holds `invoiceId`, `invoiceHash`, `chainId`, `token`, `from`, `to`, `amount` (and `amountUnits`, 6 decimals), `txHash`, `blockNumber`, `logIndex`. The demo prints INV-001's receipt in full and checks it with `npm run ops -- verify INV-001`, which reads the transaction and its `Transfer` log from the chain. The same receipt is kept in the ledger (a SQLite file, one row per invoice, plus an event log). The transcript, ledger and mandate go to a temporary folder printed at the start and at the end (`DEMO_TRANSCRIPT=<file>` chooses the transcript path). Anvil is stopped at the end, so the chain itself does not outlive the run. Ports: Anvil 8566, agent 8787 (`DEMO_ANVIL_PORT`, `DEMO_AGENT_PORT`).

**The keys are Anvil's public development keys** (from Foundry's published `test … junk` mnemonic): fine on a local chain, swept within seconds on any real one. The agent refuses them, and the simulated crashes (`INVOICE_FAIL_AT`), when the mandate names any chain other than Anvil's 31337; and the agent and `ops` refuse to run, and the agent to sign, when the node behind `INVOICE_RPC_URL` serves another chain than the mandate's (`eth_chainId`), so a 31337 mandate pointed at a public RPC stops before anything is signed.

**Running the agent and `ops` yourself** (outside the demo, against your own Anvil): `INVOICE_RPC_URL` (the node), `INVOICE_MANDATE` (the mandate JSON, written with `npm run ops -- mandate …`), `INVOICE_LEDGER` (the SQLite ledger; a `.lock` file appears next to it while the agent runs), and for the agent only `INVOICE_PAYER_KEY` and `INVOICE_PORT` (default 8787). Optional: `INVOICE_CONFIRMATION` (`finalized`, `depth:N`, or `inclusion` on Anvil only), `INVOICE_EXPLORER_URL` (default for 44005: the official explorer), `INVOICE_LOGS_FROM_BLOCK` (first block of the `Transfer` counts). Then `npm run server` and `npm run ops -- status | verify <id> | reconcile`. Inside the demo, `ops verify INV-001` runs while Anvil is still up.

A 3-minute walkthrough of the same run: [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

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
| mined, success, Transfer payer → payTo of the exact amount, the block meets the [confirmation rule](#when-the-operator-can-trust-the-receipt) and is canonical | `recovered` (or `replayed` if already confirmed): the receipt | moved once |
| mined and matching, the rule not met yet (or the block at that height changed) | `pending`, stage `included`, + tx hash, block, explorer link: "do not treat it as paid yet"; ask again any time | moved once (not final) |
| it was in a block, and that block left the canonical chain | back to "sent": found in the mempool → `pending`; unknown and the nonce unused → the **same signed bytes** are sent again | moves once |
| known to the node, not mined | `pending` + tx hash + "run `ops reconcile`" | not sent again |
| unknown to the node, the payer's nonce still unused | rebroadcast the **same signed bytes** (same hash: can be mined at most once) | moves once |
| unknown to the node, but the payer's nonce is used | `unresolved` (row `stuck`, kept open and checked again every time): "Do NOT pay this invoice again", look up the payer's transaction at that nonce. Another transaction may have used the nonce, or the node has not indexed ours: the agent cannot tell, so it never says "no money moved". Once the operator has checked, `ops resolve <id> --not-paid --by NAME --note …` closes it as not paid (it refuses if the transaction has appeared on-chain meanwhile) | unknown |
| mined but reverted | `failed`: no tokens moved, operator decides | none |
| the RPC fails (timeout, 5xx, …) on a resubmission | `pending` with the hash and the last known state: "Could not read the chain … Do NOT pay this invoice again"; the row is left as it was, nothing is decided from a failed read (`ops verify` exits with the error) | — |
| the RPC fails while a NEW payment is broadcast or its receipt awaited | `pending` + tx hash: "may already be on-chain … Do NOT pay this invoice again, under this id or another"; resubmitting the same id reconciles it | maybe moved, once |

Before signing a new invoice, open rows are reconciled first (one that cannot be settled right now does not block new invoices), and a new nonce never reuses the nonce of a signed-but-unsent payment (tested). If the id was taken between the check and the write, the freshly signed bytes are discarded, never sent. A refused invoice signed nothing, so a resubmission is judged again (it is paid if the operator has since raised the limit).

## What is guaranteed, and under which conditions

- **At most one payment per invoice id**, with **one agent process per ledger file**: the agent holds an exclusive lock (a SQLite file next to the ledger, locked for the life of the process) and a second process refuses to start. The operating system releases the lock when the process dies, however it dies, so a restart after a crash starts at once and there is no stale lock to take over (tested: ten processes starting together after a crash, exactly one runs). Two agents on different machines with separate ledgers are not protected against each other.
- **Deduplication is only as good as the invoice id and the ledger.** The id is the key, exactly as written (case-sensitive): `INV-001` and `inv-001` are two invoices, and the same invoice resent under a new id is a new invoice, paid again if the mandate allows it (the per-invoice and daily limits still apply). The vendor's own invoice number is the natural key; whoever submits invoices must keep it stable. The memory is the ledger file: an agent started on a new or different ledger does not know earlier payments (their `Transfer` logs stay on-chain and `ops status` lists them, but the agent does not match them to invoices on its own). A ledger is bound to the chain, token and payer it was first used with; the agent and `ops` refuse it under another one (the mandate's limits, expiry and vendor may change).
- **The mandate is checked when written and every time it is read**: limits must be plain decimals above 0 (`10`, `2.5`; not `1e1`), the expiry a valid date or `null`, the addresses valid. A malformed mandate stops the agent instead of loosening the limits.
- **A payment is `confirmed` only under the chain's confirmation rule** ([below](#when-the-operator-can-trust-the-receipt)): one block on the local Anvil demo, the node's `finalized` block on Aevum. Until then it is `pending` with its hash.
- **A transaction that stays in the mempool** is reported `pending` with its hash: there is no fee bump or replacement. The operator stops there and checks the payer in the explorer; the session command stops by itself after 10 minutes without a block.
- **`ops verify` reads the chain**, and it also uses the agent's ledger to know which transaction belongs to which invoice: it fails when the receipt's block or log differ from the ledger, or when a transfer to that payee is not matched to an invoice.

Tested on a local chain (`npm test`, 32 tests): crash after broadcast, after signing, while nothing is mined; a transaction dropped from the mempool is resent with the same bytes; two writers racing on one invoice; RPC failures during the resubmission and right after a new payment is sent; a node serving another chain; the nonce taken by another transaction; refusal, conflict, re-judged refusal; and the confirmation rule: pending until finalized, a block that leaves the canonical chain before the rule is met (dropped, or replaced by a reorg), a depth confirmation withdrawn after a deeper reorg, a receipt inconsistent with the block at its height, the finalized block unreadable.

## When the operator can trust the receipt

A receipt is returned only when the payment's block satisfies the confirmation rule **and** is canonical. Before that the agent answers `pending` (stage `included`) with the transaction hash, the block, the explorer link and what is missing; resubmitting the same invoice, `ops reconcile` and `ops verify` all apply the same rule, and any of them can be asked again at any time.

| Rule (`INVOICE_CONFIRMATION`) | Confirmed when | Where |
|---|---|---|
| `inclusion` | one block includes it | local Anvil (31337) only: the demo's behaviour; refused on any other chain |
| `finalized` | its block number ≤ the node's `finalized` block (`eth_getBlockByNumber("finalized")`) | **default on every other chain, used for Aevum** |
| `depth:N` | confirmations ≥ N, where confirmations = head − inclusion block + 1 (the including block counts as 1; head = `eth_blockNumber` at the time of the check). **An operational choice, not a protocol guarantee** | only when chosen explicitly |

**Canonical check, before confirming, on every rule:** the receipt is read again by transaction hash and the block at that height must carry the receipt's block hash. A block that leaves the canonical chain before confirmation is never confirmed; the agent then finds the transaction again (mempool, or mined in a new block) or sends the same signed bytes again, never a new payment. **After confirmation:** under `depth:N` a confirmed payment is checked again on every resend and reconcile, and the confirmation is withdrawn (back to `pending`, same hash, same signed bytes) if a reorg deeper than N removed its block; under `finalized` it is final by the node's own definition and not re-checked; `inclusion` is local only. The receipt states the rule it was confirmed under.

**Limits of the rule:** the agent trusts one RPC: a node that lies about its `finalized` block or its head is believed (use the official RPC; the explorer link lets anyone check independently). Changing `INVOICE_CONFIRMATION` between runs changes the verdict for payments not yet confirmed.

**What `finalized` means on Aevum** (read from the public RPC on 2026-11-19; the official pages say nothing about finality): the node is `cdk-erigon … validium` (Polygon CDK), with ~1 s blocks. Its `finalized` and `safe` blocks equal the last block whose batch is verified on L1 (`zkevm_isBlockConsolidated` is true for it and false for the next). It advances **in jumps**: at 20:06 UTC it was block 3600041 (stamped 19:04, 62 min behind the head); it stayed there until 20:35–20:37 UTC, then jumped to 3601691 (stamped 19:32), still about 65 min behind. Samples every minute: `zkevm_verifiedBatchNumber` 544892 → 545057 in one step. So a payment on Aevum stays `pending` for roughly one to one and a half hours before it is `confirmed`. Preflight fails if `finalized` is already further behind than the session will wait, but it cannot tell whether it will advance; the session stops waiting after `--max-wait-min`, leaving the payment `pending` and sending nothing else. One read in about fifty failed (`fetch failed`) during the sampling: the agent treats it as an error, never as an answer.

## Aevum Testnet: preflight and the public session

**Preflight** (read-only, no key, sends nothing):

```bash
npm run preflight -- --network aevum [--payer 0x…public] [--vendor 0x…public] [--amount 1] [--max-finalized-lag-min 150]
```

It checks the chain the node reports (44005), the official tUSD8 (`0x456569838f1d43009A91ebA4263147Afd7233483`: contract code, `decimals()` = 6, symbol), that the explorer knows the same token and follows the same chain, the `finalized` lag; with the payer's public address, its tQDAY and tUSD8 balances and an empty mempool; with the vendor too, the gas of `transfer(vendor, amount)` and its cost in tQDAY. Exit 0 only if every check passed.

**Rehearsal** of the public sequence, on a local Anvil with one block per second and the `finalized` rule (Anvil reports finalized = head − 64; the rehearsal mines blocks to move it):

```bash
npm run session -- --rehearse
```

**The public session** (needs the owner's authorization: it signs and sends one transfer on Aevum):

```bash
INVOICE_PAYER_KEY=<set by the owner, never written to disk> npm run session -- --aevum --vendor 0x… --by NAME --amount 1 --i-authorize-a-public-transaction
```

Both run the same steps: preflight; a mandate for that vendor, ≤ 1 tUSD8 per invoice and per day; one invoice of 1 tUSD8; the moment the ledger records the broadcast, the caller drops the connection and the agent is **killed** (a real crash, no simulated fail point); the agent restarts, the operator resends the same invoice, the agent answers with the **original** hash (pending until the rule is met); the same invoice is resent every 30 s; once confirmed, `ops verify` and an independent count of `Transfer` logs payer → vendor since the session's first block must show exactly one transfer, the receipt's. The ledger, mandate and transcript stay in `.sessions/<mode>-<time>/` (ignored by git), so `ops verify` can be run again later.

**Stop criteria** (exit 3, nothing more is sent): preflight fails, including when `finalized` is already further behind than the session will wait; the agent records no payment, or the broadcast is not recorded within 60 s; a resend answers anything but pending/paid with the original hash (unresolved, failed, conflict, refused, another hash); an agent error (HTTP 500, RPC down) decides nothing and is asked again, five times at the start, then every 30 s until the wait ends; the transaction stays out of a block for 10 minutes (`--max-unmined-min`): do not resend, check the payer in the explorer; `ops verify` fails; not exactly one transfer. Exit 2: still pending after `--max-wait-min` (default 150): nothing more is sent; run `ops verify` later with the environment it prints. An Anvil key, `INVOICE_FAIL_AT` or the `inclusion` rule are refused on Aevum.

**The operator's view** (`npm run ops -- …`, never needs the agent's key): `status` (mandate, every invoice, balances, every Transfer from the payer), `verify <id>` (the receipt against the chain, plus the count of transfers to that payee), `reconcile [<id>]` (brings open rows up to the chain, never signs), `resolve <id> --not-paid --by NAME --note …` (closes a stuck invoice after the operator checked the chain), `mandate …` (writes the mandate).

## AgentFi before the challenge vs. built for the challenge

| | Before the challenge (AgentFi open source, Apache-2.0) | Built during the challenge (this package) |
|---|---|---|
| Spend rules | `evaluateUsdcSpend` (`packages/backend/src/services/policy/usdc-spend-policy.ts`): per-payment cap, daily limit, allowed recipients, allowed tokens, expiry. **Reused as is**, imported by `src/mandate.ts`. | The mandate (one vendor, its registered address, per-invoice and daily limits), its mapping to an AgentFi policy, the vendor identity check, plain-language refusals with "what to do" |
| Payments | x402 purchases of HTTP resources (EIP-3009 authorizations settled by the seller's facilitator), with a Postgres ledger and on-chain reconciliation of `transferWithAuthorization` | Direct ERC-20 invoice payment from the payer's own key; the write-ahead ledger; the reconciliation by transaction hash and nonce; receipts and `ops verify`; the lost-response handling and its tests |
| Not used here | the AgentFi API, worker, MCP server, Postgres/Redis, Turnkey/Safe wallets | — |

The x402 ledger taught the vocabulary used here (money proven on-chain vs. reported, a block refused before anything is signed, "do not retry with a new id"), but its code is EIP-3009-specific and was not reused.

## What is missing for Aevum Testnet

Ready and rehearsed locally: the network profile (44005, official RPC, explorer, tUSD8, 6 decimals; nothing to deploy), the `finalized` confirmation rule, a starting block for `Transfer` counts (`INVOICE_LOGS_FROM_BLOCK`, read in 50,000-block windows), the read-only preflight, and the session command with a real crash. Read on the public RPC and explorer: chain id, token, decimals, the `finalized` block, a gas estimate. **Not done, and each needs the owner's authorization:**

- A payer key funded from the faucet (tQDAY for gas, tUSD8 to pay), kept out of the repository, and the vendor's public address.
- Any signature or transaction on Aevum: nothing has been sent there.
- Not verified on Aevum until the first session: the RPC's answer to `eth_sendRawTransaction` of an already-known transaction, its "not found" vs. its errors under load, and how often `finalized` advances.
- Fee bumping for a transaction stuck in the mempool: not implemented (the session stops instead).

## Third-party code

Runtime: [viem](https://github.com/wevm/viem) (MIT). Development: [tsx](https://github.com/privatenumber/tsx) (MIT), [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), `@types/node` (MIT). SQLite through Node's built-in `node:sqlite`. The test token is compiled with Foundry (`npm run build:token`; solc 0.8.24).

## Files

- `src/invoice.ts` invoice shape, amounts, content hash · `src/mandate.ts` the operator's mandate and the verdict (uses AgentFi's evaluator)
- `src/ledger.ts` the write-ahead ledger · `src/chain.ts` sign / broadcast / receipts / Transfer logs · `src/payer.ts` the decision and the reconciliation
- `src/server.ts` the headless agent (HTTP) · `src/ops.ts` the operator CLI · `src/demo.ts` the scenario
- `src/finality.ts` the confirmation rule · `src/preflight.ts` the read-only checks · `src/session.ts` the rehearsal and the public session · `src/config.ts` environment and the Aevum profile
- `test/finality.test.ts` the confirmation rule, reorgs before confirmation, inconsistent receipts, an unreadable finalized block · `test/config-guard.test.ts` keys, mandate, ledger binding, confirmation settings
- `test/lost-response.test.ts` the crash cases · `test/review-fixes.test.ts` races, the lock, RPC failures, nonce taken, re-judged refusal, operator resolve (from the independent review) · `contracts/src/LocalTestUSD8.sol` the local test token
