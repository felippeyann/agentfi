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

## Phase 3: Adoption Model Evolution ("AgentFi-as-a-Service")
*Mitigating friction for AI-focused engineers.*

- **Problem:** DevOps knowledge requirements (configuring vars, setting up nodes, running Postgres and BullMQ via Docker) can be significant friction for teams focused solely on AI.
- **Planned Evolution:** Parallel development of a fully cloud-managed version (SaaS).
- **Objective:** The operator registers on the AgentFi platform and acquires endpoints and keys immediately ("Stripe for Agents" style infrastructure), without needing to handle running instances locally or worry about node uptime.

---

## Phase 4: The Frontier Market and Autonomous Volume
*Long-term vision focused on the result generated as a consequence.*

- Extreme optimization for institutional agent volume, consolidating AgentFi as the dominant transaction protocol.
- Deep integration with agent-based distributed governance and expansion of frictionless DeFi actions.
- As stipulated in the `VISION.md` document, profit will derive naturally from scale in the long term; the total focus remains on giving agents the full capacity to execute on-chain activities and orchestrate financially sustainable ideas.
