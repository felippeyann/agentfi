# Three-minute demo script

For showing the local demo to someone (a tester, a judge). Run `npm run demo` once beforehand so the
dependencies are warm; on the call, run it again with the terminal visible (~40 s), and talk over it.
Everything is local: Anvil chain, local test token, demo data.

**0:00 — The problem (20 s).** "A company lets an agent pay recurring invoices. The finance person
wants two things: to approve in advance who can be paid and how much, and to know afterwards, for
sure, that each invoice was paid exactly once. Marketplaces already let a buyer set per-use, daily and
monthly limits; what is missing is the payment that can be checked afterwards and never happens twice."

**0:20 — The approval (20 s).** Point at step 1. "The operator signs off on one vendor, Acme, at its
registered address, up to 10 tUSD8 per invoice and 50 per day. The agent reads this and cannot
change it."

**0:40 — Paid, and checkable (30 s).** Step 2. "An 8 tUSD8 invoice: paid, and the receipt is a
transaction on-chain." Point at `ops verify INV-001 → VERIFIED`: "The operator does not trust the
agent's answer; this reads the chain: one transfer of 8, from the payer to Acme." Step 3: "Same
invoice again: same receipt, same hash, still one transfer, balance 92."

**1:10 — Refusals (30 s).** Step 4. "12 tUSD8: refused, over the limit, and it says what to do.
Same vendor, new bank details: refused, that is the classic invoice fraud. Nothing was signed;
the impostor address received zero."

**1:40 — The failure that matters (50 s).** Step 5. "Now the agent pays and crashes before it can
answer. The caller saw nothing: did we pay? A naive retry pays twice. Here the agent wrote the signed
transaction to its ledger before sending it, so on restart it looks for that exact transaction on-chain:
found, same receipt, one transfer." Step 6: "If the chain has not mined it yet, the answer is
PENDING, with the hash, and it will not pay again. Once mined, the operator's reconcile confirms it."
Step 7, one sentence: "If it died before sending, it sends the same signed bytes, which can only be
mined once."

**2:30 — The end state (20 s).** Final `ops status`: "Four invoices paid, four transfers, 14 tUSD8,
two refusals with reasons, one conflict. Every line is checkable on the chain."

**2:50 — What is next (10 s).** "This runs locally today. Next: the same agent on Aevum Testnet
with the real tUSD8, and a first team with recurring invoices to try it."

## Variant: the public proof on Aevum Testnet (after the owner authorizes it)

Same story, one invoice, real chain. Run beforehand: `npm run preflight -- --network aevum --payer 0x… --vendor 0x…`
(read-only). Then `npm run session -- --aevum …` (see the README, "The public session").

- **The invoice (20 s).** "One fictitious invoice of 1 tUSD8 to a vendor the operator pre-approved, on QDay Aevum."
- **The lost response (30 s).** "The agent sends the payment and we kill it the moment its ledger records the
  broadcast. The caller got nothing back."
- **The resend (30 s).** "We restart it and resend the same invoice: it answers with the original transaction hash,
  PENDING, because on Aevum we only call a payment paid once its block is finalized, verified on L1. That takes
  about an hour, so this part is shown from the session transcript."
- **The proof (30 s).** Open the explorer link from the receipt: "One transfer, 1 tUSD8, payer to vendor, the same
  hash as the first attempt. Anyone can check it here."
