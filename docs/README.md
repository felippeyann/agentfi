# AgentFi Documentation Hub

Welcome to the AgentFi documentation. This hub is designed for both human operators and AI agents to understand, deploy, and interact with the AgentFi economic layer.

## 📂 Navigation

### 🌟 Start here (required reading, in order)
- **[VISION](../VISION.md)** — *why* the project exists. Every technical decision derives from here.
- **[STATE](../STATE.md)** — *what* the project is today: purpose, stack, capabilities, phase progress.
- **[HANDOFF](../HANDOFF.md)** — *live* pending tasks + credentials + new-machine setup.

### 🚀 Run the thing (fastest path)
- **[Dev Quickstart](dev-quickstart.md)** — `docker compose up` → stack running in ~3 minutes, **zero external accounts**.
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
- **Staging demo**: `https://agentfi-develop.up.railway.app` (no SLA — demo only)
