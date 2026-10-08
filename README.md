# AgentFi

[![Status: Reactivated (exploratory)](https://img.shields.io/badge/status-reactivated%20(exploratory)-orange.svg)](#-reactivated-exploratory--2026-10-06)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@agent_fi/mcp-server.svg)](https://www.npmjs.com/package/@agent_fi/mcp-server)

> ## 🔁 Reactivated (exploratory) — 2026-10-06
>
> AgentFi was archived on 2026-05-17 after ~50 days of development
> without finding a user (the postmortem is kept below for honesty).
> It is being reactivated in **exploratory mode**: a 90-day validation
> with explicit go/no-go gates, not a relaunch.
>
> **What changed.** Between May and October 2026 the market converged on
> the thesis: x402 became a Linux Foundation standard backed by Visa,
> Mastercard, Stripe, Google and AWS; AWS, Cloudflare and Circle shipped
> agent payment rails; ERC-8004 (agent identity/reputation) is on
> mainnet and ERC-8183 (agent-to-agent job escrow) is a draft standard.
> Generic agent wallets with spending limits are now a commodity.
>
> **New direction.** AgentFi is repositioning as a **trust layer** for
> agents that hire agents: ERC-8183-compatible escrow, ERC-8004
> reputation anchored in settled payments, and an MCP server so
> Claude/Codex agents can execute, all on top of third-party wallets
> and rails (Coinbase CDP, MetaMask, x402, MPP). Not another wallet.
>
> Plan and status: [`docs/project/execution-plan-2026-10.md`](docs/project/execution-plan-2026-10.md) ·
> Review that led here: [`docs/project/reactivation-2026-10.md`](docs/project/reactivation-2026-10.md) ·
> Market evidence: [`docs/project/market-signals-2026-10.md`](docs/project/market-signals-2026-10.md)
>
> <details>
> <summary>Original postmortem (2026-05-17)</summary>
>
> **Honest postmortem.** AgentFi reached technical MVP early (agent
> registration → on-chain transaction with operator fee collection
> worked) and then accumulated breadth (4 chains, 31 MCP tools, A2A
> jobs, escrow v3, revenue sharing) without ever finding a user. Over
> ~50 days the surface area grew while real adoption stayed at zero.
>
> **Why archived.** The thesis (AI agents executing autonomous DeFi
> operations) remains directionally correct, but the market is ~2-3
> years early — confidence in LLM-driven financial autonomy is the
> bottleneck, not tooling. When the market opens, well-capitalized
> incumbents (Coinbase Agent Kit, Safe modules, Anthropic-native
> primitives) will move in. No defensible moat for a solo OSS
> protocol in that window.
>
> Live infrastructure (Fly.io backend, Upstash Redis) was decommissioned
> on archive. The maintainer's smart contracts on Base Mainnet remain
> deployed.
> </details>

---

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
- **[Graphify Code Graph](docs/graphify.md)**: Queryable codebase map for agent-assisted development.
- **[Agent Quickstart](docs/agents/quickstart.md)**: Connect your agent in < 5 minutes.
- **[System Architecture](docs/architecture/overview.md)**: Understand the 4-layer stack.

---

## 🚀 Key Features

- **Turnkey MPC Wallets** — keys split across shards and never exposed.
- **Safe Smart Wallets** — per-agent on-chain policy enforcement (limits, whitelists, kill switch).
- **Model Context Protocol** — [`@agent_fi/mcp-server`](packages/mcp-server/README.md): 35 tools in the source on `main` (DeFi execution, GMX perpetuals, A2A jobs with on-chain escrow, x402 payments, trust, and P&L); the published npm 0.5.0 has 31 of them until 0.6.0 ships (plan X3).
- **DeFi coverage** — Uniswap V3 + Curve StableSwap (swaps); Aave V3, Compound V3, and any ERC-4626 vault (yield).
- **Agent-to-Agent economy** — job queue and paid jobs escrowed on-chain in USDC by `AgentJobEscrow` (ERC-8183), settled by the operator's evaluator, with ERC-8004 feedback written by `ReputationHook` in the settlement transaction; not deployed on a public network yet (Base Sepolia is task C4, runbook in [`docs/project/testnet-log.md`](docs/project/testnet-log.md)). Jobs on chains without the escrow keep the older DB-level escrow. Internal reputation scoring from real metrics with time-decay.
- **Agent P&L dashboard** — per-agent breakeven detection, including real gas costs (v2).
- **Persistent identity** — optional ENS subdomains (`alice-abc123.agentfi.eth`) wired into agent registration.
- **OpenAPI 3.0.3 spec** at [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — machine-readable contract for SDK generation.
- **Cross-chain** — Ethereum, Base, Arbitrum, Polygon, plus Base Sepolia for the testnet. No current-ABI contracts are deployed anywhere yet; the maintainer's Base Mainnet pair is legacy (see [STATE.md §3](STATE.md#3-supported-networks)).
- **Protocol fees** — a platform fee (30 bps by default) taken from the USDC budget when an escrowed job completes, and a basis-point fee collected atomically by `AgentExecutor` on the ETH value of routed DeFi transactions.

---

## 🛠️ Getting Started

### For Operators
1. Follow the **[Operator Setup Checklist](docs/operations/setup-checklist.md)** to fill third-party accounts and local `.env`.
2. Deploy the **[Smart Contracts](docs/operations/contract-deployment.md)** to your target chain. Do not point a backend at the maintainer's Base addresses in [STATE.md](STATE.md#3-supported-networks): that pair is legacy (old `Action` ABI, every routed transaction reverts), and an escrow + hook you did not deploy names someone else's operator, fee wallet and trusted evaluator.
3. Deploy the backend via **[Self-Hosted Production Guide](docs/operations/production-deploy.md)** — provider-agnostic, with Railway as the reference and Fly.io / Render / Docker documented as alternatives.

### For Developers
1. Start with the **[Dev Quickstart](docs/dev-quickstart.md)** — `docker compose up` → stack running in 3 minutes, zero external accounts.
2. Run the **[A2A Collaboration Example](examples/a2a-collab/README.md)** — two-agent end-to-end flow in one file.
3. Run the **[Claude Desktop MCP Demo](docs/demos/claude-desktop-mcp.md)** — two MCP identities, discovery, A2A job, trust, and P&L.
4. Run the **[ERC-8183 escrow example](examples/escrow-erc8183/README.md)** on the local Base Sepolia fork harness — USDC escrow, settlement and ERC-8004 feedback end to end.
5. Review the **[Architecture Overview](docs/architecture/overview.md)**.
6. Use the **[MCP Server](packages/mcp-server/README.md)** to integrate your agents.

---

## 🛡️ Security

AgentFi is built for security-first autonomy. 
- **Simulations**: Every transaction is simulated before submission — via Tenderly when configured, otherwise an `eth_call`/`estimateGas` dry-run against the chain RPC. A mock simulation is never used in production.
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
