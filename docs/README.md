# AgentFi Documentation Hub

Welcome to the AgentFi documentation. This hub is designed for both human operators and AI agents to understand, deploy, and interact with the AgentFi economic layer.

## 📂 Navigation

### 🌟 Start here (required reading, in order)
- **[VISION](../VISION.md)** — *why* the project exists. Every technical decision derives from here.
- **[STATE](../STATE.md)** — *what* the project is today: purpose, stack, capabilities, phase progress.
- **[Execution Plan (Q4 2026)](project/execution-plan-2026-10.md)** — *live* task tracker for the reactivation: workstreams, gates, calendar, open questions.
- **[HANDOFF](../HANDOFF.md)** — credentials, working conventions, lessons learned, new-machine setup.

### 🔁 Reactivation (2026-10-06)
- **[Reactivation review](project/reactivation-2026-10.md)** (pt-BR) — state of the repo, known defects, options and the 90-day plan that was adopted.
- **[Market signals](project/market-signals-2026-10.md)** (pt-BR) — what the market did between May and October 2026, with sources.
- **[ERC-8183 mapping](architecture/erc-8183-mapping.md)** — how AgentFi jobs map onto the Agentic Commerce escrow standard.
- **[ERC-8004 integration](architecture/erc-8004-integration.md)** — identity and settlement-anchored reputation design.

### 🚀 Run the thing (fastest path)
- **[Dev Quickstart](dev-quickstart.md)** — `docker compose up` → stack running in ~3 minutes, **zero external accounts**.
- **[Claude Desktop MCP Demo](demos/claude-desktop-mcp.md)** — two local AgentFi MCP identities running discovery, A2A job flow, trust, and P&L.
- **[Examples](../examples/)** — three runnable demos:
  - [`a2a-collab`](../examples/a2a-collab/README.md) — two-agent A2A loop
  - [`swap-planner`](../examples/swap-planner/README.md) — DeFi planning pipeline
  - [`delegation-chain`](../examples/delegation-chain/README.md) — three-agent cascade

### 🏗️ Architecture
- **[System Overview](architecture/overview.md)** — the 4-layer stack.
- **[API Reference](api-reference.md)** — human-readable REST endpoint docs.
- **[OpenAPI Spec](api/openapi.yaml)** — machine-readable, used for SDK codegen + CI drift guard.
- **[A2A Interoperability](a2a-interoperability.md)** — the agent-to-agent protocol.

### ⚙️ Operations
- **[Setup Checklist](operations/setup-checklist.md)** — third-party accounts needed for a real deployment.
- **[Self-Hosted Production Deployment](operations/production-deploy.md)** — provider-agnostic guide (Railway / Fly.io / Render / Docker).
- **[Contract Deployment](operations/contract-deployment.md)** — deploying `AgentPolicyModule` + `AgentExecutor` to new chains.
- **[Funding Wallets](operations/funding-wallets.md)** — moving ETH around for testing.
- **[Release Runbook](operations/release-runbook.md)** — release + rollback procedures.
- **[Go/No-Go Template](operations/templates/go-no-go.md)** — release sign-off checklist.

### 🤖 Agent context
- **[Agent Quickstart](agents/quickstart.md)** — connect an agent in < 5 minutes.
- **[Claude Instructions](agents/claude-instructions.md)** — specialized brief for Claude-based agents (Portuguese).

### 📦 Meta
- **[Documentation Standards](STANDARDS.md)** — conventions all docs in this tree follow.
- **[Roadmap](project/roadmap.md)** — forward-looking development plan.
- **[Changelog](../CHANGELOG.md)** — release history.
- **[Contributing](../CONTRIBUTING.md)** — how to propose changes.
- **[Security](../SECURITY.md)** — vulnerability disclosure.
- **[Code of Conduct](../CODE_OF_CONDUCT.md)** — community standards.
- **[Archive](_archive/README.md)** — superseded historical docs.

---

## 🛠️ Developer Resources
- **Repository**: [felippeyann/agentfi](https://github.com/felippeyann/agentfi)
- **npm**: [@agent_fi/mcp-server](https://www.npmjs.com/package/@agent_fi/mcp-server)
- **License**: Apache 2.0
- **Staging demo**: none (the Fly.io instance was decommissioned on 2026-05-17; run the [Dev Quickstart](dev-quickstart.md) locally)
