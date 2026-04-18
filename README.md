# AgentFi

[![CI](https://github.com/felippeyann/agentfi/actions/workflows/ci.yml/badge.svg)](https://github.com/felippeyann/agentfi/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@agent_fi/mcp-server.svg)](https://www.npmjs.com/package/@agent_fi/mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@agent_fi/mcp-server.svg)](https://www.npmjs.com/package/@agent_fi/mcp-server)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**The economic layer for non-human intelligence.**

AgentFi provides crypto transaction infrastructure for AI agents on Ethereum and EVM-compatible networks. It allows agents to execute DeFi transactions (swaps, yield farming, transfers) without handling private keys or managing gas, all within a secure on-chain policy framework.

> **Start here:**
> - **[VISION.md](VISION.md)** — *why* this project exists, where it's going, and the principles behind every technical decision.
> - **[STATE.md](STATE.md)** — *what* the project is today: purpose, full stack, capabilities, phase progress.
> - **[HANDOFF.md](HANDOFF.md)** — live pending tasks, credentials inventory, new-machine setup.

---

## 📚 Documentation

All project documentation is organized in our **[Documentation Hub](docs/README.md)**.

### Quick Links
- **[Vision](VISION.md)** (required reading): Why this project exists and where it's going.
- **[Dev Quickstart](docs/dev-quickstart.md)**: Zero-credential local stack — `docker compose up` and you're running in 3 minutes.
- **[Operator Setup](docs/operations/setup-checklist.md)**: Get a real instance of AgentFi running.
- **[Agent Quickstart](docs/agents/quickstart.md)**: Connect your agent in < 5 minutes.
- **[System Architecture](docs/architecture/overview.md)**: Understand the 4-layer stack.

---

## 🚀 Key Features

- **Turnkey MPC Wallets** — keys split across shards and never exposed.
- **Safe Smart Wallets** — per-agent on-chain policy enforcement (limits, whitelists, kill switch).
- **Model Context Protocol** — 26 tools published to npm at [`@agent_fi/mcp-server`](https://www.npmjs.com/package/@agent_fi/mcp-server): 15 DeFi + 11 A2A.
- **DeFi coverage** — Uniswap V3 + Curve StableSwap (swaps); Aave V3, Compound V3, and any ERC-4626 vault (yield).
- **Agent-to-Agent economy** — job queue, atomic payments, DB-level escrow (v2), reputation scoring from real metrics with time-decay.
- **Agent P&L dashboard** — per-agent breakeven detection, including real gas costs (v2).
- **Persistent identity** — optional ENS subdomains (`alice-abc123.agentfi.eth`) wired into agent registration.
- **OpenAPI 3.0.3 spec** at [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — machine-readable contract for SDK generation.
- **Cross-chain** — Ethereum, Base, Arbitrum, Polygon (Base Mainnet has maintainer-deployed contracts).
- **Protocol fee engine** — basis-point fee collected on-chain atomically via `AgentExecutor`.

---

## 🛠️ Getting Started

### For Operators
1. Follow the **[Operator Setup Checklist](docs/operations/setup-checklist.md)** to fill third-party accounts and local `.env`.
2. Deploy the **[Smart Contracts](docs/operations/contract-deployment.md)** to your target chain (or reuse the maintainer-deployed Base addresses in [STATE.md](STATE.md#3-supported-networks)).
3. Deploy the backend via **[Self-Hosted Production Guide](docs/operations/production-deploy.md)** — provider-agnostic, with Railway as the reference and Fly.io / Render / Docker documented as alternatives.

### For Developers
1. Start with the **[Dev Quickstart](docs/dev-quickstart.md)** — `docker compose up` → stack running in 3 minutes, zero external accounts.
2. Run the **[A2A Collaboration Example](examples/a2a-collab/README.md)** — two-agent end-to-end flow in one file.
3. Review the **[Architecture Overview](docs/architecture/overview.md)**.
4. Use the **[MCP Server](packages/mcp-server/README.md)** to integrate your agents.

---

## 🛡️ Security

AgentFi is built for security-first autonomy. 
- **Simulations**: Every transaction is simulated via Tenderly before submission.
- **Guardrails**: On-chain policies prevent agents from exceeding predefined limits.
- **Kill Switch**: Operators can pause any agent's transaction ability instantly.

Found a vulnerability? See **[SECURITY.md](SECURITY.md)** for our disclosure policy.

---

## 🤝 Community

- **[Code of Conduct](CODE_OF_CONDUCT.md)**: Our community standards.
- **[Contributing](CONTRIBUTING.md)**: How to contribute to AgentFi.
- **[Changelog](CHANGELOG.md)**: Release history and notable changes.

---

## 📄 License

AgentFi is open-source and licensed under the **[Apache 2.0 License](LICENSE)**.
