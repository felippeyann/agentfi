# Operator interviews (WS7, gate G4)

Owner-run. Nothing here is sent to anyone by an agent. Each interview is logged
here, anonymised (`O1`, `O2`, `O3`), within a day of the call.

**Gate G4 (plan §1):** at least 3 interviews; at least 2 operators report the
same recurring problem with a concrete example; at least 1 runs the flow with
their own funds (Base Sepolia is enough). Checkpoint: Day 30, 2026-11-05.
Abstract interest in agents does not count.

## Who to talk to

Operators whose agents **already spend money** at least weekly: paid APIs,
data, x402 resources, or other agents. Typical pools: Coinbase Agentic Wallet,
AWS AgentCore Payments or MetaMask Agent Wallet users, x402 buyers listed in
Coinbase Bazaar / Circle Agent Marketplace, Claude Code users with paid MCP
tools. Screen out anyone who has not had an agent pay for something in the
last month.

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
6. **Test (3 min).** "Would you run one job on Base Sepolia with test funds,
   or share an anonymised trace of a real case, in the next two weeks?" Record
   yes or no, and a concrete next step with a date.

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
- Same problem as: <O-ids, or "none">
```

## Decision at the checkpoint

- Same recurring problem with a concrete example in 2 or more interviews, and
  1 or more operators agreeing to test: G4 passes; continue.
- Otherwise, record what was heard and apply plan §1. Either stop, or change
  the hypothesis before any more integration work.
