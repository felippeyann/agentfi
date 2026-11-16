# Alpha roadmap (from 2026-11-16)

AgentFi is a **B2B headless developer alpha**: an API/MCP layer for companies whose agents buy services. This page says what is in scope now, what is next and what is only a possibility. Dates are **targets**, not promises; the older phase table is in [roadmap.md](roadmap.md) and the history in [history.md](history.md).

For what works today, read the [README status table](../../README.md#what-works-today). For the live task tracker of the earlier plan, see [execution-plan-2026-10.md](execution-plan-2026-10.md).

## Now: developer alpha (local / fork)

- x402 `exact` buying with **job-scoped** budget, agent policy caps, a payment ledger, and automatic reconciliation of unknown payments. Demonstrated on a **local Anvil fork** of Base Sepolia, not on a public network.
- HTTP/OpenAPI and MCP as the two interfaces; one set of financial rules in the backend.
- Reproducible quickstart ([docs/alpha/quickstart.md](../alpha/quickstart.md)) with explicit SIMULATION / LOCAL FORK / PUBLIC TESTNET labels.
- A public feedback channel ([feedback guide](../feedback.md)) and a private one for vulnerabilities ([SECURITY.md](../../SECURITY.md)).

## Next (targets, in this order of preference)

- **Framework examples**: a reference HTTP example plus examples run against fixed framework versions; the [compatibility matrix](../integrations/compatibility.md) records what was actually tested. No logo without a test.
- **Public testnet proof**: a **separate, gated milestone**. It needs owner authorization, RPC/facilitator/faucet availability and evidence kept apart from the local runs. The prepared package is [x402-testnet-proof.md](../operations/x402-testnet-proof.md) and has not been executed.
- **npm release of `@agent_fi/mcp-server` 0.6.0** (adds `pay_for_resource`, `get_job`, `check_outbox`, `contest_job`; 35 tools). Publishing is an explicit distribution step, not a side effect of merging. Package: [mcp-0.6.0-release-package.md](../operations/mcp-0.6.0-release-package.md). Until then the install path is a checkout or tag.
- Feedback review about seven days after the alpha opens: consolidate real use and re-prioritise. No users is neither an approval nor a rejection of the technology.

## Later / possible (possible expansion, not a commitment)

Each item below is a **possible expansion, not a commitment**. None is scheduled and none is needed for the alpha.

- **Agent-to-agent hiring (A2A)**: agents contracting other agents, building on the existing experimental job flow. Possible expansion, not a commitment.
- **Marketplace / discovery** of providers. Possible expansion, not a commitment.
- **Auth-capture style payments** (hold, then capture) beyond `exact`. Possible expansion, not a commitment.
- **Escrow-first flows** (ERC-8183 escrow and ERC-8004 reputation as the front door instead of a side feature); the code stays and stays experimental. Possible expansion, not a commitment.

## Non-goals

- A **hosted, multi-tenant SaaS** operated by the maintainer.
- **Custody changes**: AgentFi does not take custody of visitors' funds or wallets.
- **Mainnet** use, or any production-funds claim. No date is promised.
- A second financial-rules implementation: SDKs and adapters stay thin and must not duplicate budget or authority logic.

## How this relates to the October plan

The October reactivation plan (trust layer: escrow, reputation, MCP) is kept as written and its gates still stand; this page narrows the **front door** of the project to x402 spend control for the alpha. Nothing from the earlier plan was removed.
