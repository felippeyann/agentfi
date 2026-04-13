# AgentFi

[![CI](https://github.com/felippeyann/agentfi/actions/workflows/ci.yml/badge.svg)](https://github.com/felippeyann/agentfi/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**The economic layer for non-human intelligence.**

AgentFi provides crypto transaction infrastructure for AI agents on Ethereum and EVM-compatible networks. It allows agents to execute DeFi transactions (swaps, yield farming, transfers) without handling private keys or managing gas, all within a secure on-chain policy framework.

> **Start here:** Read **[VISION.md](VISION.md)** first. It explains *why* this project exists, where it's going, and the principles behind every technical decision. Everything else follows from there.

---

## 📚 Documentation

All project documentation is organized in our **[Documentation Hub](docs/README.md)**.

### Quick Links
- **[Vision](VISION.md)** (required reading): Why this project exists and where it's going.
- **[Operator Setup](docs/operations/setup-checklist.md)**: Get your instance of AgentFi running.
- **[Agent Quickstart](docs/agents/quickstart.md)**: Connect your agent in < 5 minutes.
- **[System Architecture](docs/architecture/overview.md)**: Understand the 4-layer stack.

---

## 🚀 Key Features

- **Turnkey MPC Wallets**: Keys are split across shards and never exposed.
- **Safe Smart Wallets**: Per-agent on-chain policy enforcement (limits, whitelists).
- **Model Context Protocol (MCP)**: 10+ DeFi tools for direct agent integration.
- **Cross-Chain Support**: Ethereum, Base, Arbitrum, and Polygon.
- **Protocol Fee Engine**: Built-in fee collection on-chain via `AgentExecutor`.

---

## 🛠️ Getting Started

### For Operators
1. Follow the **[Operator Setup Checklist](docs/operations/setup-checklist.md)**.
2. Deploy the **[Smart Contracts](docs/operations/contract-deployment.md)** to your target chain.
3. Configure your production environment via **[Railway](docs/operations/production-deploy.md)**.

### For Developers
1. Check **[CONTRIBUTING.md](CONTRIBUTING.md)** for local development setup.
2. Review the **[Architecture Overview](docs/architecture/overview.md)**.
3. Use the **[MCP Server](packages/mcp-server/README.md)** to integrate your agents.

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
