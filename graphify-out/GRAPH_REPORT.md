# Graph Report - agentfi  (2026-10-06)

## Corpus Check
- 237 files · ~165,907 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 24 file(s) not represented in the graph (top: (none) 11, .toml 5, .example 1)

## Summary
- 1902 nodes · 2966 edges · 140 communities (122 shown, 18 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 99 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fcc24bd6`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- mcp-server/src/index.ts
- PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA
- login-rate-limit.ts
- escrow.service.ts
- scripts
- policy-authority.ts
- adapters/package.json
- agents.ts
- mcp-server/package.json
- HANDOFF — AgentFi
- transactionRoutes
- x402.middleware.ts
- backend/src/index.ts
- transaction.queue.ts
- AgentFi API Reference
- viem
- backend/package.json
- admin/package.json
- @agent_fi/mcp-server
- What Was Done (Go-Live Session)
- AgentFi — Dev Quickstart
- AgentFi — Self-Hosted Production Deployment Guide
- dependencies
- transactions.ts
- AgentFiClient
- Dossiê de Retomada — AgentFi (06/10/2026)
- preflight.ts
- OperatorService
- next
- compilerOptions
- executor.service.test.ts
- Sinais de mercado — agentes transacionando (status em 06/10/2026)
- pnl.service.ts
- price.service.ts
- local.service.ts
- compilerOptions
- global-setup.ts
- dependencies
- chains.ts
- release-v1.mjs
- ens.service.ts
- AgentFi — Operator Setup Checklist
- simulator.service.ts
- e2e-issue-81.mjs
- ERC-8004 (Trustless Agents) — integration design
- Sidebar.tsx
- Release Guide - @agent_fi/mcp-server
- AgentFi — Vision
- Contract Deployment — AgentFi
- agents/page.tsx
- transaction.worker.guard.test.ts
- How to deposit ETH to Base — Full Tutorial
- Issue #71 — A2A Revenue Integrity (Execution Plan)
- agents/[id]/page.tsx
- Graphify Code Graph
- 📂 Navigation
- scripts
- safe.service.ts
- transactions/[id]/page.tsx
- pnl.service.test.ts
- a2a-collab/index.mjs
- a2a-collab/package.json
- delegation-chain/package.json
- smoke-dev.mjs
- swap-planner/package.json
- @agentfi/adapters
- dashboard/page.tsx
- jobs/[id]/page.tsx
- notification.service.ts
- builder.service.ts
- simulator.service.test.ts
- AgentFi Production Release and Rollback Runbook
- ROADMAP — AgentFi
- ReputationService
- StripeService
- ref_vitest
- Agent-to-Agent (A2A) Interoperability Protocol
- AgentFi
- AgentFi — Project State
- Contributing to AgentFi
- @agent_fi/backend
- PolicyService
- AgentFi Documentation Standards (v1)
- AgentFi Architecture
- delegation-chain/index.mjs
- AgentFi Example — Swap Planner
- deploy
- gen-release-note.mjs
- Contributor Covenant Code of Conduct
- Claude Desktop MCP Demo
- AgentFi Example — A2A Collaboration
- AgentFi Example — Delegation Chain
- adapters/tsconfig.json
- onChainEscrowService
- submitter.service.ts
- backend/tsconfig.json
- mcp-server/tsconfig.json
- Reporting a Vulnerability
- OnChainPolicyService
- swap-planner/index.mjs
- bug_report.md
- scripts
- @agentfi/admin
- jobs/page.tsx
- devDependencies
- aave.service.ts
- gmx.service.ts
- gmxService
- AgentFi Smart Contracts
- AgentFi Agent Quickstart
- 🚀 New Features
- Address registry
- PULL_REQUEST_TEMPLATE.md
- devDependencies
- uniswap.service.ts
- Session Notes — 2026-10-06
- 4. What the project does today
- AgentFi Remediation Plan and Execution
- ABI versioning
- Disaster recovery
- Deployment
- feature_request.md
- vercel.json
- simulation-cache.ts
- Fee monitoring
- Prerequisites
- health/page.tsx
- repository
- Archive
- Role: Logic Sentinel
- .eslintrc.json
- transactions.routes.integration.test.ts
- verify-deployment.sh
- AGENTS.md
- go-no-go.md
- gen-secrets.sh

## God Nodes (most connected - your core abstractions)
1. `viem` - 40 edges
2. `transactionRoutes()` - 35 edges
3. `logger` - 22 edges
4. `@prisma/client` - 21 edges
5. `next` - 20 edges
6. `createChainPublicClient()` - 20 edges
7. `executeA2APayment()` - 19 edges
8. `Added` - 19 edges
9. `fastify` - 18 edges
10. `compilerOptions` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Phase 3 Progress (Post Go-Live)` --references--> `executeA2APayment()`  [INFERRED]
  docs/_archive/go-live-status-v0.1.0.md → packages/backend/src/api/routes/transactions.ts
- `4. Follow-up tickets to file` --references--> `executeA2APayment()`  [INFERRED]
  docs/project/issue-71-a2a-revenue-integrity.md → packages/backend/src/api/routes/transactions.ts
- `Phase 1.5 — Worker-driven Job finalization (issue #81, branch `fix/issue-81-payment-lifecycle`)` --references--> `executeA2APayment()`  [INFERRED]
  docs/project/issue-71-a2a-revenue-integrity.md → packages/backend/src/api/routes/transactions.ts
- `Phase 1 — Robust status transitions (this PR: `fix/a2a-revenue-integrity`)` --references--> `executeA2APayment()`  [INFERRED]
  docs/project/issue-71-a2a-revenue-integrity.md → packages/backend/src/api/routes/transactions.ts
- `4.2 Agent-to-Agent economy (the heart of the thesis)` --references--> `executeA2APayment()`  [INFERRED]
  STATE.md → packages/backend/src/api/routes/transactions.ts

## Import Cycles
- 3-file cycle: `packages/backend/src/queues/transaction.queue.ts -> packages/backend/src/services/job/payment-finalizer.service.ts -> packages/backend/src/services/policy/escrow.service.ts -> packages/backend/src/queues/transaction.queue.ts`
- 4-file cycle: `packages/backend/src/queues/transaction.queue.ts -> packages/backend/src/services/transaction/pre-submit-guard.ts -> packages/backend/src/services/job/payment-finalizer.service.ts -> packages/backend/src/services/policy/escrow.service.ts -> packages/backend/src/queues/transaction.queue.ts`

## Communities (140 total, 18 thin omitted)

### Community 0 - "mcp-server/src/index.ts"
Cohesion: 0.07
Nodes (33): buildProxyTools(), createMcpServer(), getRequiredFields(), inferJsonSchemaType(), mcpRoutes(), sessions, ToolDef, api (+25 more)

### Community 1 - "PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA"
Cohesion: 0.04
Nodes (46): Account Abstraction com Safe, ARQUITETURA GERAL, Autenticação no MCP, Backend, Canal 1 — Registro em Repositórios de MCP Servers, Canal 2 — Documentação Otimizada para LLMs, Canal 3 — Integração com Frameworks de Agentes, Canal 4 — Infraestrutura de Descoberta Agent-to-Agent (+38 more)

### Community 2 - "login-rate-limit.ts"
Cohesion: 0.08
Nodes (31): GET(), { hasAdminSessionMock }, POST(), { hasAdminSessionMock }, handler, AdminAuditEvent, logAdminAuthEvent(), maskUsername() (+23 more)

### Community 3 - "escrow.service.ts"
Cohesion: 0.11
Nodes (31): logger, createJobSchema, jobRoutes(), reputationService, updateJobSchema, VALID_TRANSITIONS, db, connection (+23 more)

### Community 4 - "scripts"
Cohesion: 0.06
Nodes (35): devDependencies, eslint, prettier, tsx, typescript, engines, node, tsx (+27 more)

### Community 5 - "policy-authority.ts"
Cohesion: 0.07
Nodes (31): [0.1.0] - 2026-03-25, [0.5.0] — 2026-05-15, Added, Added, Changed, Changed, Changed (breaking — mcp-server 0.2.0 → 0.3.0), Changelog (+23 more)

### Community 6 - "adapters/package.json"
Cohesion: 0.06
Nodes (32): description, devDependencies, @types/node, typescript, exports, ./eliza, ./langchain, ./openai (+24 more)

### Community 7 - "agents.ts"
Cohesion: 0.08
Nodes (27): authMiddleware, authPlugin(), fastify, FastifyRequest, generateApiKey(), hashApiKey(), isOperatorKey(), OPERATOR_CAPABLE_ROUTES (+19 more)

### Community 8 - "mcp-server/package.json"
Cohesion: 0.06
Nodes (32): bin, agentfi-mcp, dependencies, dotenv, @modelcontextprotocol/sdk, tsx, zod, description (+24 more)

### Community 9 - "HANDOFF — AgentFi"
Cohesion: 0.06
Nodes (31): 1. Snapshot, 2. Required reading order, 3.1 Owner-only items (summary; details in the plan), 3.2 Known defects being fixed (Week 0), 3.3 Blocked externally, 3.4 The meta-guidance, 3. Pending work, 4. Credentials inventory (+23 more)

### Community 10 - "transactionRoutes"
Cohesion: 0.11
Nodes (15): Added, Added (Phase 3/4 roadmap — merged 2026-05-13), Phase 3: A2A Economy Primitives, ensureChainAllowed(), executeA2APayment(), getAgent(), getIdempotentTransaction(), getLatestAgentTxTimestamp() (+7 more)

### Community 11 - "x402.middleware.ts"
Cohesion: 0.07
Nodes (27): 0. Decisions locked on 2026-10-06 (owner), 1. Goal and gates, 2. Workstreams and tasks, 3. Calendar, 4. Working agreement, 5. Open questions (ask the owner, do not assume), 6. Risks, Appendix — Environment on the maintainer's machine (2026-10-06) (+19 more)

### Community 12 - "backend/src/index.ts"
Cohesion: 0.12
Nodes (23): RATE_LIMITS, redis, registerRateLimit(), billingRoutes(), stripeService, checkDatabase(), checkRedis(), checkRpc() (+15 more)

### Community 13 - "transaction.queue.ts"
Cohesion: 0.10
Nodes (15): env, envSchema, parsed, addDailyVolumeAtomic(), connection, deadLetterQueue, feeService, isRedisQuotaExceededError() (+7 more)

### Community 14 - "AgentFi API Reference"
Cohesion: 0.13
Nodes (15): AgentFi API Reference, Agents, Authentication, Billing, Error Responses, GET /v1/agents/me/pnl, Health, Jobs (Agent-to-Agent) (+7 more)

### Community 15 - "viem"
Cohesion: 0.12
Nodes (22): adminRoutes(), batchAdminSchema, buildKillSwitchOnChainSync(), isLoopbackIp(), OnChainSync, operatorService, pauseAgentSchema, pnlService (+14 more)

### Community 16 - "backend/package.json"
Cohesion: 0.08
Nodes (25): dotenv, @modelcontextprotocol/sdk, tsx, @types/node, typescript, vitest, zod, license (+17 more)

### Community 18 - "admin/package.json"
Cohesion: 0.08
Nodes (22): @types/node, typescript, vitest, license, name, private, repository, directory (+14 more)

### Community 19 - "@agent_fi/mcp-server"
Cohesion: 0.08
Nodes (24): @agent_fi/mcp-server, Agent-to-Agent (A2A) Collaboration, Claude Code, Claude Desktop, Configuration, Environment Variables, Example Usage, How It Works (+16 more)

### Community 20 - "What Was Done (Go-Live Session)"
Cohesion: 0.09
Nodes (22): Branch & Repository, CI/CD, CI Status, Current State, Database, Dependencies, Documentation, Go-Live Status — AgentFi v0.1.0 (+14 more)

### Community 21 - "AgentFi — Dev Quickstart"
Cohesion: 0.20
Nodes (10): AgentFi — Dev Quickstart, Connect Claude Desktop (optional), Graduating to real networks, Prerequisites, Register your first agent, Start the stack, Tearing down, Troubleshooting (+2 more)

### Community 22 - "AgentFi — Self-Hosted Production Deployment Guide"
Cohesion: 0.09
Nodes (23): Admin auth audit logs, AgentFi — Self-Hosted Production Deployment Guide, Contract addresses (per chain you support), Deploy to Base (recommended first), Go-live checklist, Option A — Railway (reference, ~10 minutes from zero), Option B — Fly.io, Option C — Render (+15 more)

### Community 23 - "dependencies"
Cohesion: 0.09
Nodes (23): dependencies, @aave/contract-helpers, @aave/math-utils, bullmq, dotenv, ethers, fastify, @fastify/cors (+15 more)

### Community 24 - "transactions.ts"
Cohesion: 0.10
Nodes (21): AGENT_EXECUTOR_ABI, builder, depositSchema, ERC20_DECIMALS_ABI, erc4626DepositSchema, erc4626WithdrawSchema, executeSwapSchema, executor (+13 more)

### Community 25 - "AgentFiClient"
Cohesion: 0.16
Nodes (10): AgentFiClient, AgentFiConfig, agentFiPlugin(), ElizaAction, ElizaPlugin, AgentFiToolkit, LangChainTool, makeTool() (+2 more)

### Community 26 - "Dossiê de Retomada — AgentFi (06/10/2026)"
Cohesion: 0.10
Nodes (20): 0. Veredito em cinco linhas, 10. Registro desta sessão (06/10/2026), 1.1 Repositório e distribuição, 1.2 Código e toolchain, 1.3 Branches, PRs e pastas irmãs, 1.4 Validação do stack zero-credencial nesta sessão, 1. Estado do projeto, verificado hoje, 2. O que o AgentFi é (resumo de dez linhas) (+12 more)

### Community 27 - "preflight.ts"
Cohesion: 0.10
Nodes (25): isLegacyContractAddress(), getTurnkeyClient(), SignedTransaction, TurnkeyService, WalletInfo, @turnkey/sdk-server, CHAIN_CONFIGS, ChainContractConfig (+17 more)

### Community 29 - "next"
Cohesion: 0.12
Nodes (6): LoginForm(), LoginPage(), config, isLoopbackHost(), middleware(), next

### Community 30 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 31 - "executor.service.test.ts"
Cohesion: 0.16
Nodes (12): TransactionData, ExecutorAction, ExecutorService, toExecutorAction(), WrappedTransaction, EXECUTOR, POOL, SAFE (+4 more)

### Community 32 - "Sinais de mercado — agentes transacionando (status em 06/10/2026)"
Cohesion: 0.11
Nodes (18): 0. Leitura em uma frase, 10. Implicação para o AgentFi, 1. Protocolos e padrões abertos, 2. Trilhos, carteiras e plataformas, 3. Redes de cartão, bancos e reguladores bancários, 4. Big techs e plataformas de LLM, 5. Economias agente-a-agente e DeFAI (o que é real), 6. Regulação (+10 more)

### Community 33 - "pnl.service.ts"
Cohesion: 0.18
Nodes (15): PnLBreakdown, rewardRowToUsd(), resolveRewardUsd(), RewardJson, RewardPriceResult, ZERO_RESULT, getKnownTokenByAddress(), getKnownTokenBySymbol() (+7 more)

### Community 34 - "price.service.ts"
Cohesion: 0.14
Nodes (11): CHAIN_NATIVE_TOKEN, CHAIN_PLATFORM, clearPriceCache(), fetchPrice(), priceCache, weiToUsd(), jobFindUniqueMock, jobUpdateMock (+3 more)

### Community 35 - "local.service.ts"
Cohesion: 0.16
Nodes (7): __clearLocalWallets(), __localWalletCount(), LocalWalletEntry, LocalWalletService, randomPrivateKey(), randomWalletId(), wallets

### Community 36 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module (+9 more)

### Community 37 - "global-setup.ts"
Cohesion: 0.14
Nodes (11): ANVIL_BIN, ANVIL_CHAIN_ID, ANVIL_PORT, ANVIL_RPC, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY, execAsync, FORGE_BIN (+3 more)

### Community 38 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, autoprefixer, clsx, date-fns, framer-motion, lucide-react, next, next-auth (+9 more)

### Community 39 - "chains.ts"
Cohesion: 0.18
Nodes (13): CHAIN_IDS, FALLBACK_RPC_URLS, getChain(), getRpcCandidates(), getSecondaryRpcUrl(), isNetworkOrRateLimitError(), isUsableRpcUrl(), PUBLIC_RPC_URLS (+5 more)

### Community 40 - "release-v1.mjs"
Cohesion: 0.08
Nodes (32): __dirname, nextConfig, codegenArgs, original, updated, api(), main(), mcpCommand() (+24 more)

### Community 41 - "ens.service.ts"
Cohesion: 0.17
Nodes (9): buildSubdomainCandidate(), DEFAULT_PUBLIC_RESOLVER, ENS_REGISTRY_ABI, EnsConfig, EnsService, normalizeEnsLabel(), PUBLIC_RESOLVER_ABI, readEnsConfig() (+1 more)

### Community 42 - "AgentFi — Operator Setup Checklist"
Cohesion: 0.12
Nodes (16): 0. Choose Your Mode, 10. Stripe Billing, 11. Install and Run Locally With Real Credentials, 12. Production Hosting, 13. Verification, 1. Local Environment File, 2. Required Secrets, 3. RPC Provider (+8 more)

### Community 43 - "simulator.service.ts"
Cohesion: 0.17
Nodes (9): describeSimulationError(), isProductionLikeEnv(), isRpcTransportFailure(), PRODUCTION_LIKE_ENVS, SimulationParams, SimulationProvider, SimulationResult, SimulatorService (+1 more)

### Community 44 - "e2e-issue-81.mjs"
Cohesion: 0.33
Nodes (11): api(), c, createPaidJob(), getJob(), log(), main(), patchJob(), POLL_TIMEOUT_SEC (+3 more)

### Community 45 - "ERC-8004 (Trustless Agents) — integration design"
Cohesion: 0.13
Nodes (13): 1. Registries and addresses, 2. Identity Registry (what AgentFi writes), 3. Reputation Registry (current signature, verbatim), 4. AgentFi design: feedback written by the escrow hook, 5. What we do not do, 6. Decisions (owner, 2026-10-06), ERC-8004 (Trustless Agents) — integration design, 1. What the standard defines (+5 more)

### Community 46 - "Sidebar.tsx"
Cohesion: 0.19
Nodes (10): metadata, RootLayout(), viewport, navItems, Sidebar(), StatCardProps, cn(), clsx (+2 more)

### Community 47 - "Release Guide - @agent_fi/mcp-server"
Cohesion: 0.13
Nodes (14): Current Tool Inventory (0.5.0), Directory Follow-Ups, `npm publish` returns `404`, `npm publish` returns `E403`, `npm publish` returns `ENEEDAUTH`, `npm publish` returns `EOTP`, Prerequisites, Publish 0.5.0 (+6 more)

### Community 48 - "AgentFi — Vision"
Cohesion: 0.13
Nodes (15): A note on authorship, Agent-to-agent economy, AgentFi — Vision, Economic identity, How to contribute, On consciousness and expansion, On what's happening right now, Principles this project builds on (+7 more)

### Community 49 - "Contract Deployment — AgentFi"
Cohesion: 0.14
Nodes (14): Automated verification script, Backend-managed installation, Contract Deployment — AgentFi, Fee configuration per chain, Foundry configuration reference, How fee routing works, Manual installation (for self-hosted operators), Manual verification (block explorer) (+6 more)

### Community 50 - "agents/page.tsx"
Cohesion: 0.16
Nodes (12): Agent, AgentsPage(), getAgents(), NETWORK_COLORS, NETWORK_NAMES, TIER_STYLES, CHAIN_NAMES, getTransactions() (+4 more)

### Community 51 - "transaction.worker.guard.test.ts"
Cohesion: 0.20
Nodes (9): AgentSnapshot, PAUSED_BEFORE_SUBMISSION, POLICY_EXPIRED_BEFORE_SUBMISSION, PreSubmitDecision, preSubmitGuard(), resolveBlockReason(), { finalizeMock }, runWorkerStep() (+1 more)

### Community 52 - "How to deposit ETH to Base — Full Tutorial"
Cohesion: 0.15
Nodes (12): FAQ, How to deposit ETH to Base — Full Tutorial, How to verify it arrived, Official Base Bridge (Safest), OPTION A — You already have ETH on an exchange (Binance, Coinbase, etc.), OPTION B — You have ETH on Ethereum mainnet and want to move it to Base, OPTION C — You have USDC or another stablecoin, Step 1 — Add the Base network to your wallet (+4 more)

### Community 53 - "Issue #71 — A2A Revenue Integrity (Execution Plan)"
Cohesion: 0.15
Nodes (12): 2. The 3-phase plan, 3. Acceptance criteria per phase, 4. Follow-up tickets to file, 5. Status, Issue #71 — A2A Revenue Integrity (Execution Plan), Phase 1, Phase 1.5 — Worker-driven Job finalization (issue #81, branch `fix/issue-81-payment-lifecycle`), Phase 1 — Robust status transitions (this PR: `fix/a2a-revenue-integrity`) (+4 more)

### Community 54 - "agents/[id]/page.tsx"
Cohesion: 0.24
Nodes (10): AgentDetail, AgentDetailPage(), getAgent(), getAgentTransactions(), STATUS_COLORS, Transaction, PauseButton(), SyncPolicyButton() (+2 more)

### Community 55 - "Graphify Code Graph"
Cohesion: 0.33
Nodes (5): Codex Integration, Graphify Code Graph, Install, Query, Update

### Community 56 - "📂 Navigation"
Cohesion: 0.20
Nodes (10): 🤖 Agent context, AgentFi Documentation Hub, 🏗️ Architecture, 🛠️ Developer Resources, 📦 Meta, 📂 Navigation, ⚙️ Operations, 🔁 Reactivation (2026-10-06) (+2 more)

### Community 57 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, build, db:generate, db:migrate, db:push, dev, lint, test (+5 more)

### Community 58 - "safe.service.ts"
Cohesion: 0.21
Nodes (7): getPrimaryRpcUrl(), DeployedSafe, init(), SafeInitConfig, SafeProtocolKit, SafeService, @safe-global/protocol-kit

### Community 59 - "transactions/[id]/page.tsx"
Cohesion: 0.24
Nodes (9): 🛠️ Technical Changes, CHAIN_INFO, getTransaction(), PublicTransaction, STATUS_CONFIG, TransactionStatusPage(), TransactionAdminActions(), TransactionAdminActionsProps (+1 more)

### Community 60 - "pnl.service.test.ts"
Cohesion: 0.17
Nodes (7): 1.1 Ghost completions — fire-and-forget payment, 1.2 Silent zero from price oracle, 1.3 Real-time price (no historical snapshot), 1. Bug surface (what's broken today), PnLService, mockFetch, MockOpts

### Community 61 - "a2a-collab/index.mjs"
Cohesion: 0.45
Nodes (10): api(), createJob(), getPnL(), getTrustReport(), log(), main(), patchJob(), publishManifest() (+2 more)

### Community 62 - "a2a-collab/package.json"
Cohesion: 0.18
Nodes (10): description, engines, node, main, name, private, scripts, start (+2 more)

### Community 63 - "delegation-chain/package.json"
Cohesion: 0.18
Nodes (10): description, engines, node, main, name, private, scripts, start (+2 more)

### Community 64 - "smoke-dev.mjs"
Cohesion: 0.56
Nodes (8): api(), createJob(), main(), patchJob(), publishManifest(), registerAgent(), requireApi(), step()

### Community 65 - "swap-planner/package.json"
Cohesion: 0.18
Nodes (10): description, engines, node, main, name, private, scripts, start (+2 more)

### Community 66 - "@agentfi/adapters"
Cohesion: 0.18
Nodes (10): @agentfi/adapters, Available tools, ElizaOS, Installation, LangChain, License, OpenAI / Anthropic, Self-hosted backend (+2 more)

### Community 67 - "dashboard/page.tsx"
Cohesion: 0.27
Nodes (9): DashboardPage(), DashboardStats, getStats(), fallbackData, fetchVolume(), VolumeChart(), VolumePoint, StatCard() (+1 more)

### Community 68 - "jobs/[id]/page.tsx"
Cohesion: 0.25
Nodes (8): CHAIN_NAMES, getJob(), Job, JobDetailPage(), STATUS_CONFIG, JobReconcileActions(), Props, lucide-react

### Community 69 - "notification.service.ts"
Cohesion: 0.33
Nodes (9): escapeHtml(), fetchAndAssertOk(), formatTelegramHtml(), NotificationPayload, notificationService, sendDiscord(), sendGenericWebhook(), sendTelegram() (+1 more)

### Community 70 - "builder.service.ts"
Cohesion: 0.18
Nodes (9): AAVE_POOL_ABI, COMPOUND_COMET_ABI, CURVE_STABLESWAP_ABI, ERC20_ABI, ERC4626_VAULT_ABI, GMX_EXCHANGE_ROUTER_ABI, isNativeWeth(), UNISWAP_ROUTER_ABI (+1 more)

### Community 71 - "simulator.service.test.ts"
Cohesion: 0.33
Nodes (7): assertSimulationUsable(), ensureSimulationUsable(), isSimulationUsable(), SIMULATION_UNAVAILABLE_MESSAGE, SimulationUnavailableError, { envState, estimateGasMock, createChainPublicClientMock }, PARAMS

### Community 72 - "AgentFi Production Release and Rollback Runbook"
Cohesion: 0.20
Nodes (10): 1. Preconditions, 2. Standard Production Release, 3. Post-Deploy Verification (must pass), 4. Rollback Playbook, 5. Emergency Safeguards, 6. Operational Defaults, 7. Audit Trail Template, 8. Alert Thresholds (Auth and Access) (+2 more)

### Community 73 - "ROADMAP — AgentFi"
Cohesion: 0.20
Nodes (9): Phase 1: Bootstrap & Architectural Foundation (complete), Phase 2.5: Go-Live Hardening (Completed — April 2026), Phase 2: Scale & Operational Predictability, Phase 4: Self-Sustaining Agents (~40%), Phase 5: Adoption Model Evolution ("AgentFi-as-a-Service"), Phase 6: The Frontier Market and Autonomous Volume, ROADMAP — AgentFi, MonitorService (+1 more)

### Community 74 - "ReputationService"
Cohesion: 0.22
Nodes (6): connection, reputationQueue, scheduleReputationUpdate(), startReputationWorker(), ReputationService, bullmq

### Community 77 - "Agent-to-Agent (A2A) Interoperability Protocol"
Cohesion: 0.29
Nodes (6): 1. Discovery (Agent Yellow Pages), 2. Cryptographic Trust & Identity, 3. Communication & Job Queue, 4. Automated Reputation, 5. Intent-Aware Economy, Agent-to-Agent (A2A) Interoperability Protocol

### Community 78 - "AgentFi"
Cohesion: 0.20
Nodes (10): AgentFi, 🤝 Community, 📚 Documentation, For Developers, For Operators, 🛠️ Getting Started, 🚀 Key Features, 📄 License (+2 more)

### Community 79 - "AgentFi — Project State"
Cohesion: 0.20
Nodes (10): 1. Purpose, 2. Four-Layer Stack, 3. Supported Networks, 6. Phase progress, 7. Public artifacts, 8. What does _not_ exist (on purpose), 9. Current pending work, AgentFi — Project State (+2 more)

### Community 80 - "Contributing to AgentFi"
Cohesion: 0.22
Nodes (9): Contributing to AgentFi, License, Making a change, PR expectations, Project structure, Reporting bugs, Security issues, Setup (+1 more)

### Community 81 - "@agent_fi/backend"
Cohesion: 0.22
Nodes (6): @agent_fi/backend, API Reference, Architecture, Local Development, Scripts, Stack

### Community 83 - "AgentFi Documentation Standards (v1)"
Cohesion: 0.33
Nodes (5): AgentFi Documentation Standards (v1), 🌟 Principles, 🤖 Special Instructions for AI Agents, 📂 Structure, ✍️ Writing Style

### Community 84 - "AgentFi Architecture"
Cohesion: 0.22
Nodes (9): Agent-to-Agent Layer, AgentFi Architecture, Deployed Contracts (Base Mainnet — Chain 8453), Deployment posture, Diagrams, Networks, Revenue Model, System Overview (+1 more)

### Community 85 - "delegation-chain/index.mjs"
Cohesion: 0.53
Nodes (8): api(), createJob(), getTrust(), log(), main(), patchJob(), publishManifest(), registerAgent()

### Community 86 - "AgentFi Example — Swap Planner"
Cohesion: 0.22
Nodes (9): Against the dev stack (default), Against your own instance, AgentFi Example — Swap Planner, Expected output, Files, Graduating to real execution, Run, What it does (+1 more)

### Community 87 - "deploy"
Cohesion: 0.22
Nodes (8): build, builder, deploy, healthcheckPath, restartPolicyMaxRetries, restartPolicyType, startCommand, $schema

### Community 88 - "gen-release-note.mjs"
Cohesion: 0.33
Nodes (3): filepath, RELEASE_DIR, today

### Community 89 - "Contributor Covenant Code of Conduct"
Cohesion: 0.25
Nodes (7): Attribution, Contributor Covenant Code of Conduct, Enforcement, Enforcement Responsibilities, Our Pledge, Our Standards, Scope

### Community 90 - "Claude Desktop MCP Demo"
Cohesion: 0.25
Nodes (8): 1. Start AgentFi locally, 2. Generate demo agents and prompts, 3. Connect Claude Desktop, 4. Run the prompts, 5. Show P&L, Claude Desktop MCP Demo, Demo talk track, Reset

### Community 91 - "AgentFi Example — A2A Collaboration"
Cohesion: 0.25
Nodes (8): Against the dev stack (default), Against your own instance, AgentFi Example — A2A Collaboration, Expected output, Files, Run, Taking it further, What it does

### Community 92 - "AgentFi Example — Delegation Chain"
Cohesion: 0.25
Nodes (8): Against the dev stack (default), Against your own instance, AgentFi Example — Delegation Chain, Expected output (abbreviated), Files, Making it economic (the self-sustaining loop), Run, Scenario

### Community 93 - "adapters/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 95 - "submitter.service.ts"
Cohesion: 0.39
Nodes (4): SubmissionResult, SubmitterService, getWalletService(), WalletService

### Community 96 - "backend/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 97 - "mcp-server/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 98 - "Reporting a Vulnerability"
Cohesion: 0.25
Nodes (8): Out of Scope, Process, Reporting a Vulnerability, Scope, Security Best Practices, Security Policy, Supported Versions, What to include

### Community 100 - "swap-planner/index.mjs"
Cohesion: 0.62
Nodes (6): api(), getAgentMe(), log(), main(), registerAgent(), simulateSwap()

### Community 101 - "bug_report.md"
Cohesion: 0.29
Nodes (6): Actual Behavior, Additional Context, Description, Environment, Expected Behavior, Steps to Reproduce

### Community 102 - "scripts"
Cohesion: 0.29
Nodes (7): scripts, build, dev, lint, start, test, typecheck

### Community 103 - "@agentfi/admin"
Cohesion: 0.29
Nodes (6): @agentfi/admin, Authentication, Features, Local Development, Scripts, Stack

### Community 104 - "jobs/page.tsx"
Cohesion: 0.38
Nodes (6): FILTER_CHIPS, formatRelative(), getJobs(), Job, JobsPage(), STATUS_CONFIG

### Community 105 - "devDependencies"
Cohesion: 0.29
Nodes (7): devDependencies, dotenv-cli, prisma, tsx, @types/node, typescript, vitest

### Community 106 - "aave.service.ts"
Cohesion: 0.38
Nodes (3): aaveService, @aave/contract-helpers, ethers

### Community 107 - "gmx.service.ts"
Cohesion: 0.29
Nodes (6): DATASTORE_ABI, GMX_CONTRACTS, GMX_MARKETS, GmxExecutionFeeResult, GmxMarketInfo, READER_ABI

### Community 109 - "AgentFi Smart Contracts"
Cohesion: 0.29
Nodes (6): AgentFi Smart Contracts, Chain Support, Contracts, Deployment, Development, Security

### Community 110 - "AgentFi Agent Quickstart"
Cohesion: 0.33
Nodes (6): 1. Connect to the MCP Server, 2. Register an Agent (get your API key), 3. Your Agent Can Now Execute Transactions, AgentFi Agent Quickstart, Fee Structure, Security Guarantees

### Community 111 - "🚀 New Features"
Cohesion: 0.33
Nodes (5): 1. Human-in-the-Loop (HITL) Approval System, 2. Public Transaction Explorer, 3. Operator Notification Service, 🚀 New Features, Release Notes — HITL & Transaction Transparency (April 2026)

### Community 112 - "Address registry"
Cohesion: 0.33
Nodes (6): Address registry, Arbitrum One (Chain 42161) — NOT DEPLOYED, Base Mainnet (Chain 8453) — DEPLOYED, **LEGACY (old `Action` struct) — redeploy pending**, Base Sepolia (Chain 84532) — **LEGACY (old `Action` struct) — redeploy pending**, Ethereum Mainnet (Chain 1) — NOT DEPLOYED, Polygon (Chain 137) — NOT DEPLOYED

### Community 113 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.33
Nodes (5): Changes, Checklist, Summary, Testing, Type

### Community 114 - "devDependencies"
Cohesion: 0.33
Nodes (6): devDependencies, @types/node, @types/react, @types/react-dom, typescript, vitest

### Community 115 - "uniswap.service.ts"
Cohesion: 0.40
Nodes (3): QuoteResult, SWAP_ROUTER, uniswapService

### Community 116 - "Session Notes — 2026-10-06"
Cohesion: 0.33
Nodes (5): Dependabot notes, Next session, Session Notes — 2026-10-06, What this session did, Where we are right now

### Community 117 - "4. What the project does today"
Cohesion: 0.33
Nodes (6): 4.1 Core DeFi primitives, 4.2 Agent-to-Agent economy (the heart of the thesis), 4.3 Policy and governance, 4.4 Self-sustaining agents (Phase 4), 4.5 Operator admin, 4. What the project does today

### Community 118 - "AgentFi Remediation Plan and Execution"
Cohesion: 0.40
Nodes (4): AgentFi Remediation Plan and Execution, Deterministic Decisions, Execution Status, P0 Remediation Plan

### Community 119 - "ABI versioning"
Cohesion: 0.40
Nodes (4): ABI versioning, Backend ABI — single source of truth, Legacy deployments (old `Action` struct) — do not route through, What changed (October 2026)

### Community 120 - "Disaster recovery"
Cohesion: 0.40
Nodes (5): Contract redeployment (fee BPS change), Deploy script fails mid-transaction, Disaster recovery, Emergency pause, Wrong parameters at deploy time

### Community 121 - "Deployment"
Cohesion: 0.40
Nodes (5): Deployment, Step 1 — Environment variables, Step 2 — Run tests, Step 3 — Deploy, Step 4 — Capture output

### Community 122 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Alternatives Considered, Problem, Proposed Solution

### Community 123 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, devCommand, framework, installCommand

### Community 124 - "simulation-cache.ts"
Cohesion: 0.60
Nodes (4): CachedSimulation, cacheSimulation(), getRedis(), getSimulation()

### Community 125 - "Fee monitoring"
Cohesion: 0.50
Nodes (4): Admin dashboard, Check fee wallet balance, Fee monitoring, Query fee events from the executor

### Community 126 - "Prerequisites"
Cohesion: 0.50
Nodes (4): Get block explorer API keys, Install contract dependencies, Install Foundry, Prerequisites

### Community 127 - "health/page.tsx"
Cohesion: 0.83
Nodes (3): getHealthStatus(), HealthPage(), ServiceRow()

### Community 128 - "repository"
Cohesion: 0.50
Nodes (4): repository, directory, type, url

### Community 129 - "Archive"
Cohesion: 0.67
Nodes (3): Archive, Rule for future archives, What's in here

## Knowledge Gaps
- **1000 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+995 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1104 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AgentFi — Project State` connect `AgentFi — Project State` to `ROADMAP — AgentFi`, `docs/README.md`, `4. What the project does today`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Are the 15 inferred relationships involving `transactionRoutes()` (e.g. with `.buildAaveSupply()` and `.buildAaveWithdraw()`) actually correct?**
  _`transactionRoutes()` has 15 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _1000 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `mcp-server/src/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06901960784313725 - nodes in this community are weakly interconnected._
- **Why does `5. End-to-end transaction flow` connect `ROADMAP — AgentFi` to `transactionRoutes`, `simulator.service.ts`, `AgentFi — Project State`, `PolicyService`, `OperatorService`, `submitter.service.ts`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Should `PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Why does `PolicyService` connect `PolicyService` to `OnChainPolicyService`, `agents.ts`, `ROADMAP — AgentFi`, `viem`, `4. What the project does today`, `ABI versioning`, `transactions.ts`, `transactions/[id]/page.tsx`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._