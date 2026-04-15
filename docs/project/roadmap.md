# ROADMAP — AgentFi

This document outlines the technical development roadmap and business evolution of **AgentFi**. It is designed to scale infrastructure progressively, maintaining focus on being the ultimate frontier of financial autonomy for AI agents.

---

## Phase 1: Bootstrap & Architectural Foundation (Current)
*Primary "Developer-First" infrastructure deliverables*

- [x] Architecture Definition (Monorepo)
- [x] MPC Integration (Turnkey) and Account Abstraction (Safe & base Smart Contracts)
- [x] Creation of the MCP (Model Context Protocol) Server
- [x] Backend Orchestration (BullMQ Queue, Retry policies, Infura/Alchemy Fallback)
- [x] End-to-End tests on local fork and Testnet
- [x] V1 Launch (Self-Hosted) focused on organic adoption by LLM developers. *(Infrastructure and release flow completed; final operational sign-off follows the CHECKLIST.md.)*

---

## Phase 2: Scale & Operational Predictability
*Continuous improvements to maintain operational sustainability.*

- [x] **Human-in-the-Loop (HITL) Approval Framework:**
  - Auto-approval thresholds for high-value transactions.
  - PENDING_APPROVAL status and operator review UI.
- [x] **Transaction Transparency:**
  - Public status page for sharing transaction progress and security context.
- **Periodic Turnkey Pricing Verification:**
  - Maintain Turnkey as the MPC foundation, but schedule quarterly re-evaluations of SaaS API costs.
  - Monitor alternatives if pricing scales asymmetrically.
- **Adapter Ecosystem (Focus on MCP and Frameworks):**
  - Strengthen distribution in major LLM directories (MCP.so, Smithery, ElizaOS, Langchain).

---

## Phase 2.5: Go-Live Hardening (Completed — April 2026)
*Security, stability, and open-source readiness.*

- [x] Branch consolidation (master deleted, main as default)
- [x] CI 6/6 green (lint, typecheck, admin, backend, contracts, E2E)
- [x] Migration 0004: ON DELETE CASCADE for Job FK constraints
- [x] E2E test root cause fix (routedViaExecutor + polling helpers)
- [x] Security hardening: timing-safe admin auth, atomic daily volume check, auth middleware fix
- [x] A2A placeholder endpoints disabled (501) until proper implementation
- [x] Dockerfiles run as non-root user (appuser:1001)
- [x] Next.js upgraded to v16 (resolved 4 HIGH CVEs)
- [x] npm audit: 0 critical, 1 high (fastify v4, breaking — deferred)
- [x] Open-source files: SECURITY.md, CHANGELOG.md, CODE_OF_CONDUCT.md, templates, Dependabot
- [x] API reference documentation (47 endpoints)
- [x] Package READMEs (backend, admin, contracts)
- [x] VISION.md referenced as required reading in all entry points

---

## Phase 3: A2A Economy Primitives
*Unlocking the agent-to-agent economy described in [VISION.md](../../VISION.md).*

These items bridge the gap between the current product (agent-to-DeFi) and the vision (agent-to-agent economy).

- [x] **A2A Payment Execution** (v1 — April 2026):
  - [x] Job `reward` auto-triggers `executeA2APayment()` on status → COMPLETED
  - [x] Full policy + simulation + fee calculation pipeline reused
  - [x] Metadata links payment transaction back to job (`metadata.jobId`)
- [x] **A2A Escrow v2** (April 2026):
  - [x] Reward funds reserved at job creation (DailyVolume atomic commit)
  - [x] Released on CANCELLED/FAILED (returns daily volume credit)
  - [x] Marked RELEASED on COMPLETED (payment consumes the reservation)
  - [x] Migration 0005 adds reservedAmount/reservedToken/reservationStatus to Job
  - [ ] On-chain escrow contract (v3 — requires new Safe module deploy)
  - [ ] Automatic cleanup of stale ACCEPTED jobs (v3)

- **A2A Identity & Trust (Sign/Verify Handshake):**
  - Implement `sign-handshake` via Turnkey MPC message signing
  - Implement `verify-handshake` via EIP-1271 (Safe wallets) + ECDSA recovery (EOA fallback)
  - Enable agents to cryptographically prove identity to peers

- [x] **Reputation Scoring v2 + time-decay** (April 2026):
  - [x] Weighted score derived from: tx success rate (40%), job completion rate (30%), volume (20%), consistency (10%)
  - [x] Admin endpoints for recompute and drift inspection
  - [x] `computeReputationScore()` returns 0–10,000 integer score
  - [x] Time-decay weighting: recent 30 days carry 2x weight vs historical
  - [x] Daily BullMQ repeatable job for automatic recompute (02:00 UTC default)

- **DeFi Protocol Expansion:**
  - [x] Compound V3 (supply/withdraw) — Mainnet, Base, Arbitrum, Polygon
  - [x] ERC-4626 vault standard (generic yield — any compliant vault works)
  - [x] Curve Finance StableSwap (classic pools — 3pool, tri-pool, etc.)
  - [ ] GMX / Perp DEXes (for advanced agents)
  - More earning paths = closer to self-sustaining agents

- **Fastify v4 to v5 Migration:**
  - Resolves remaining 1 HIGH npm vulnerability
  - Breaking change — requires plugin compatibility audit

---

## Phase 4: Self-Sustaining Agents
*The transition from tool to participant (see VISION.md "Self-sustaining agents").*

- [x] **Agent P&L Dashboard v1** (April 2026):
  - [x] `GET /v1/agents/me/pnl` and `GET /admin/agents/:id/pnl` endpoints
  - [x] Earnings: A2A job rewards received as provider
  - [x] Costs: protocol fees paid + A2A rewards paid as requester
  - [x] `breakEven` and `profitable` flags per agent
  - [x] Optional `?since=<ISO>` period filter
  - [ ] Gas costs (v2 — requires on-chain gasPrice tracking)
  - [ ] Realized yield from DEPOSIT positions (v2 — requires on-chain reads)

- **Agent Self-Funding:**
  - Agent provisions own sub-wallet from earnings
  - Agent pays for own compute/inference via on-chain payment to provider

- **Persistent Identity:**
  - On-chain identity layer (ENS, DID, or custom)
  - Cross-session agent identity that accumulates history and reputation

- **Revenue Sharing for Self-Hosted Operators:**
  - Fee distribution mechanism between protocol and self-hosted deployments
  - Aligned incentives at every layer (as described in VISION.md)

---

## Phase 5: Adoption Model Evolution ("AgentFi-as-a-Service")
*Mitigating friction for AI-focused engineers.*

- **Problem:** DevOps knowledge requirements (configuring vars, setting up nodes, running Postgres and BullMQ via Docker) can be significant friction for teams focused solely on AI.
- **Planned Evolution:** Parallel development of a fully cloud-managed version (SaaS).
- **Objective:** The operator registers on the AgentFi platform and acquires endpoints and keys immediately ("Stripe for Agents" style infrastructure), without needing to handle running instances locally or worry about node uptime.

---

## Phase 6: The Frontier Market and Autonomous Volume
*Long-term vision focused on the result generated as a consequence.*

- Extreme optimization for institutional agent volume, consolidating AgentFi as the dominant transaction protocol.
- Deep integration with agent-based distributed governance and expansion of frictionless DeFi actions.
- As stipulated in the `VISION.md` document, profit will derive naturally from scale in the long term; the total focus remains on giving agents the full capacity to execute on-chain activities and orchestrate financially sustainable ideas.
