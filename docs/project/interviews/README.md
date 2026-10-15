# Operator interviews (WS7, gate G4)

Owner-run. Nothing here is sent to anyone by an agent. Each interview is logged
here, anonymised (`O1`, `O2`, `O3`), within a day of the call.

**Gate G4 (plan §1):** at least 3 interviews; at least 2 operators report the
same recurring problem with a concrete example; at least 1 runs the flow with
their own funds (Base Sepolia is enough). Checked at the go/no-go on
2027-01-05; Day 30 is only an on-track checkpoint (see the end
of this file). Abstract interest in agents, or agreeing to test, does not
count as running the flow.

## Who to talk to

Operators whose agents **already spend money** at least weekly: paid APIs,
data, x402 resources, or other agents. Where to look, as hypotheses only:
Coinbase Agentic Wallet, AWS AgentCore Payments or MetaMask Agent Wallet users;
Circle Agent Marketplace participants; Claude Code users with paid MCP tools.
The x402 Bazaar lists payment-gated *services*, which are sellers
([CDP docs](https://docs.cdp.coinbase.com/x402/buyer/discover-services), checked 2026-10-15).
A listing there is not evidence of a buyer. Screen out anyone who has not had
an agent pay for something in the last month.

## Script (about 25 minutes)

Do not describe AgentFi before question 5. Ask for the last real case, not
opinions; ask "when was the last time…" rather than "would you…".

0. **Context (1 min).** "I'm researching how teams control money that agents
   spend. I'm not selling anything today. May I take anonymised notes?"
1. **Last spend (5 min).** "Tell me about the last time one of your agents
   paid for something or hired another agent or service. What was the task,
   roughly how much, and on which rail?" Get a date and an amount.
2. **Last failure (5 min).** "When did it last go wrong: paid and got nothing
   or something unusable, paid twice, a timeout with no answer, spend above
   what you expected?" Ask who noticed it, what happened next, how long it
   took to resolve and what it cost (money or hours).
3. **Frequency (3 min).** "How often does that happen? How many paid calls or
   jobs do your agents make per week?"
4. **Current solution (5 min).** "What do you use today to set limits, check
   that you received what you paid for, and resolve a dispute? Where did it
   fail in the case you just told me?" (spreadsheets, manual review, vendor
   dashboards, wallet spend limits, facilitator logs)
5. **Fit and price (3 min).** Describe in one sentence: payment held in
   escrow, released only after the result is checked, with an operator
   resolving disputes and the outcome recorded as reputation. "Would that have
   prevented your case? Would you rather pay per guaranteed job or a
   percentage of volume?" (plan §5.4, decision D6)
6. **Test (3 min).** "Once it is available, would you run one job on Base
   Sepolia with test funds? Separately, could you share an anonymised trace of
   a real case?" Record yes or no for each, and a concrete next step.

   Rules for this question:
   - Offer a dated Base Sepolia run only after C4 deploys this build there
     (still pending, see [c4-c5-checklist.md](../c4-c5-checklist.md)). Until
     then a run can only be local or on a fork, and does not count for G4.
   - A real-case trace is evidence for the problem (questions 1–4), not a run
     of the flow.

## Log template (one file per interview: `O1.md`, `O2.md`, `O3.md`)

```markdown
# O<n> — <YYYY-MM-DD>

- Profile: <role; what the agents do; paid calls per week (band)>
- Rail(s): <x402 / card / wallet / API credits / other>
- Concrete case: <what happened, date, amount, who noticed>
- Frequency: <per week / month>
- Current solution and where it failed: <…>
- Cost of the problem: <money / hours / customer impact>
- Fit (Q5): <would it have prevented the case? why or why not>
- Pricing preference: <per guaranteed job / % of volume / other>
- Willing to test: <yes / no> — next step and date: <…>
- Ran the flow: <not yet / yes — date, Base Sepolia tx hashes of `fund` and settlement, verified by>
- Same problem as: <O-ids, or "none">
```

## Decisions: Day 30 checkpoint and the G4 gate

These are two different decisions. Agreeing to test is a next step, never a
pass.

- **Day 30 checkpoint (plan V3): is G4 on track?** The date is 2026-11-05
  counted from the reactivation on 2026-10-06. The plan calendar's
  "Days 1–30" window ends on 2026-11-11, so the owner confirms which date
  applies. On track means two things:
  - 2 or more interviews describe the same recurring problem with a concrete
    example;
  - at least 1 operator has committed to run the flow once it is available.
    While C4 / C5 are pending, no date can be offered, so a conditional
    commitment is the most that can exist. Its absence alone does not mean
    there is no demand.

  If two of three operators say "not a problem", stop WS3–WS6 and reassess.
  The pilot modality, and what happens if the flow is never available
  before the go/no-go, are open owner decisions (owner note
  `2026-10-15-kit-entrevistas.md` §11).
- **G4 gate (plan §1, checked at the go/no-go on 2027-01-05).** G4 passes only
  when all three thresholds hold:
  - at least 3 interviews;
  - 2 or more operators with the same recurring problem and a concrete
    example;
  - at least 1 operator who **has run the flow** with their own funds (Base
    Sepolia is enough). The evidence is the Base Sepolia transaction hashes of
    the job's `fund` and its settlement, logged in their `O<n>.md`.
    Pseudonymous addresses are enough to stay anonymous, and a trace can only
    complement the hashes.
- Otherwise, record what was heard and apply plan §1. Either stop, or change
  the hypothesis before any more integration work.
