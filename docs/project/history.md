# Project history and postmortem

> Moved here verbatim from the front page of `README.md` on 2026-11-16, when the README was rewritten for the developer alpha ([alpha roadmap](roadmap-alpha.md)). Nothing was deleted. Only relative links were adjusted to this folder.
> Text below is a dated record: statements about positioning, counts and features are what the project said at that time and may be superseded (see [STATE.md](../../STATE.md) and the [README](../../README.md) for the current picture).

## Reactivation banner and original postmortem (README, 2026-10-06 to 2026-11-16)

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
> Plan and status: [`docs/project/execution-plan-2026-10.md`](execution-plan-2026-10.md) ·
> Review that led here: [`docs/project/reactivation-2026-10.md`](reactivation-2026-10.md) ·
> Market evidence: [`docs/project/market-signals-2026-10.md`](market-signals-2026-10.md)
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

## Previous front page (README until 2026-11-16)

> The introduction and "Key Features" list as they stood before the relaunch. Several items are superseded by the alpha positioning and some wordings were corrected over time; the current, verified status table is in the [README](../../README.md#what-works-today).

**The economic layer for non-human intelligence.**

AgentFi provides crypto transaction infrastructure for AI agents on Ethereum and EVM-compatible networks. It allows agents to execute DeFi transactions (swaps, yield farming, transfers) without handling private keys or managing gas, all within a secure on-chain policy framework.


## 🚀 Key Features

- **Turnkey wallets** — keys are created and used inside Turnkey's secure enclaves; the AgentFi process never holds them (the in-memory local provider is for development only).
- **On-chain policy module** — `AgentPolicyModule` holds per-agent limits, whitelists and the kill switch. It checks transactions routed through `AgentExecutor`, for agents whose policy is synced on-chain. No module or executor from this build is deployed on a public network yet. Agents run as plain wallets (EOA). Safe mode does not work yet ([plan D19](../project/execution-plan-2026-10.md)): it is refused in production and staging, and elsewhere it only warns and agents fall back to their EOA.
- **Model Context Protocol** — [`@agent_fi/mcp-server`](../../packages/mcp-server/README.md): 35 tools in the source on `main` (DeFi execution, GMX perpetuals, A2A jobs with on-chain escrow, x402 payments, trust, and P&L); the published npm 0.5.0 has 31 of them until 0.6.0 ships (plan X3).
- **DeFi coverage** — Uniswap V3 + Curve StableSwap (swaps); Aave V3, Compound V3, and any ERC-4626 vault (yield).
- **Agent-to-Agent economy** — job queue and paid jobs escrowed on-chain in USDC by `AgentJobEscrow` (ERC-8183), settled by the operator's evaluator, with ERC-8004 feedback written by `ReputationHook` in the settlement transaction; not deployed on a public network yet (Base Sepolia is task C4, runbook in [`docs/project/testnet-log.md`](../project/testnet-log.md)). Jobs on chains without the escrow keep the older DB-level escrow. Internal reputation scoring from real metrics with time-decay.
- **Agent P&L dashboard** — per-agent breakeven detection, including real gas costs (v2).
- **Persistent identity** — optional ENS subdomains (`alice-abc123.agentfi.eth`) wired into agent registration.
- **OpenAPI 3.0.3 spec** at [`docs/api/openapi.yaml`](../api/openapi.yaml) — machine-readable contract for SDK generation.
- **Cross-chain** — Ethereum, Base, Arbitrum, Polygon, plus Base Sepolia for the testnet. No current-ABI contracts are deployed anywhere yet; the maintainer's Base Mainnet pair is legacy (see [STATE.md §3](../../STATE.md#3-supported-networks)).
- **Protocol fees** — a platform fee (30 bps by default) taken from the USDC budget when an escrowed job completes, and a basis-point fee collected atomically by `AgentExecutor` on the ETH value of routed DeFi transactions.
