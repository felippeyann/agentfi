# Graph Report - agentfi  (2026-10-06)

## Corpus Check
- 284 files · ~253,066 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 24 file(s) not represented in the graph (top: (none) 11, .toml 5, .example 1)

## Summary
- 2375 nodes · 4134 edges · 162 communities (149 shown, 13 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 177 edges (avg confidence: 0.92)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b051077d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- mcp-server/src/index.ts
- PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA
- login-rate-limit.ts
- jobs.ts
- scripts
- policy-authority.ts
- adapters/package.json
- agents.ts
- mcp-server/package.json
- HANDOFF — AgentFi
- transactionRoutes
- AgentFi API Reference
- backend/src/index.ts
- transaction.queue.ts
- session.ts
- admin.ts
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
- executor.service.ts
- Sinais de mercado — agentes transacionando (status em 06/10/2026)
- resource-payment.service.ts
- pnl.service.ts
- viem
- compilerOptions
- global-setup.ts
- dependencies
- chains.ts
- abi.erc8183.test.ts
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
- pre-submit-guard.ts
- How to deposit ETH to Base — Full Tutorial
- Issue #71 — A2A Revenue Integrity (Execution Plan)
- agents/[id]/page.tsx
- Graphify Code Graph
- 📂 Navigation
- scripts
- createChainPublicClient
- transactions/[id]/page.tsx
- x402-fixture.ts
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
- Fixed
- AgentFi Production Release and Rollback Runbook
- FeeService
- logger.ts
- StripeService
- ref_vitest
- Agent-to-Agent (A2A) Interoperability Protocol
- AgentFi
- AgentFi — Project State
- Contributing to AgentFi
- api-reference.md
- x402-client.service.ts
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
- env
- backend/tsconfig.json
- mcp-server/tsconfig.json
- Reporting a Vulnerability
- PolicyService
- swap-planner/index.mjs
- bug_report.md
- scripts
- @agentfi/admin
- jobs/page.tsx
- devDependencies
- aave.service.ts
- gmx.service.ts
- escrow-erc8183.service.test.ts
- AgentFi Smart Contracts
- AgentFi Agent Quickstart
- 🚀 New Features
- escrow-erc8183.service.ts
- PULL_REQUEST_TEMPLATE.md
- devDependencies
- uniswap.service.ts
- Session Notes — 2026-10-06
- ResourcePaymentService
- AgentFi Remediation Plan and Execution
- ABI versioning
- NoAcceptableSchemeError
- claimRefund
- feature_request.md
- vercel.json
- env.ts
- settle
- [0.5.0] — 2026-05-15
- health/page.tsx
- repository
- Archive
- Role: Logic Sentinel
- .eslintrc.json
- fastify
- verify-deployment.sh
- AGENTS.md
- go-no-go.md
- gen-secrets.sh
- contracts.ts
- processSettlementJob
- lib/auth.ts
- transaction.processor.ts
- TurnkeyService
- jobs.routes.erc8183.test.ts
- executor.service.test.ts
- middleware/auth.ts
- policy-authority.test.ts
- admin.pause.routes.test.ts
- x402.middleware.ts
- NodeAdapter
- @prisma/client
- transaction.worker.test.ts
- health.ts
- x402.ts
- escrow-erc8183.runtime.ts
- Testnet log — Base Sepolia (chain 84532)
- db/client.ts
- ReputationService
- agents.policy.routes.test.ts
- .chain

## God Nodes (most connected - your core abstractions)
1. `viem` - 55 edges
2. `transactionRoutes()` - 36 edges
3. `X402ClientService` - 28 edges
4. `@prisma/client` - 27 edges
5. `logger` - 26 edges
6. `ResourcePaymentService` - 25 edges
7. `fastify` - 24 edges
8. `createChainPublicClient()` - 22 edges
9. `start()` - 21 edges
10. `next` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Added` --references--> `waitForFeeEvent()`  [INFERRED]
  CHANGELOG.md → packages/backend/src/__tests__/e2e/transaction.e2e.ts
- `Added` --references--> `waitForDailyVolume()`  [INFERRED]
  CHANGELOG.md → packages/backend/src/__tests__/e2e/transaction.e2e.ts
- `Phase 3 Progress (Post Go-Live)` --references--> `executeA2APayment()`  [INFERRED]
  docs/_archive/go-live-status-v0.1.0.md → packages/backend/src/api/routes/transactions.ts
- `4. Follow-up tickets to file` --references--> `executeA2APayment()`  [INFERRED]
  docs/project/issue-71-a2a-revenue-integrity.md → packages/backend/src/api/routes/transactions.ts
- `Phase 1.5 — Worker-driven Job finalization (issue #81, branch `fix/issue-81-payment-lifecycle`)` --references--> `executeA2APayment()`  [INFERRED]
  docs/project/issue-71-a2a-revenue-integrity.md → packages/backend/src/api/routes/transactions.ts

## Import Cycles
- None detected.

## Communities (162 total, 13 thin omitted)

### Community 0 - "mcp-server/src/index.ts"
Cohesion: 0.06
Nodes (37): buildProxyTools(), createMcpServer(), getRequiredFields(), inferJsonSchemaType(), mcpRoutes(), sessions, ToolDef, api (+29 more)

### Community 1 - "PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA"
Cohesion: 0.04
Nodes (46): Account Abstraction com Safe, ARQUITETURA GERAL, Autenticação no MCP, Backend, Canal 1 — Registro em Repositórios de MCP Servers, Canal 2 — Documentação Otimizada para LLMs, Canal 3 — Integração com Frameworks de Agentes, Canal 4 — Infraestrutura de Descoberta Agent-to-Agent (+38 more)

### Community 2 - "login-rate-limit.ts"
Cohesion: 0.16
Nodes (18): attemptsByKey, AttemptState, buildAttemptKey(), clearLoginFailures(), getClientIp(), getLoginAttemptContext(), getMaxLoginAttempts(), HeaderMap (+10 more)

### Community 3 - "jobs.ts"
Cohesion: 0.15
Nodes (24): contestJobSchema, createJobSchema, errorMessage(), jobRoutes(), reputationService, updateJobSchema, VALID_TRANSITIONS, erc8183Config (+16 more)

### Community 4 - "scripts"
Cohesion: 0.05
Nodes (37): devDependencies, eslint, prettier, tsx, typescript, engines, node, tsx (+29 more)

### Community 5 - "policy-authority.ts"
Cohesion: 0.23
Nodes (12): classifyPolicyChange(), effectiveCooldown(), effectiveDailyLimit(), effectiveExpiry(), effectiveMaxValuePerTx(), normalizeAddress(), POLICY_PATCH_FIELDS, PolicyChangeClassification (+4 more)

### Community 6 - "adapters/package.json"
Cohesion: 0.06
Nodes (32): description, devDependencies, @types/node, typescript, exports, ./eliza, ./langchain, ./openai (+24 more)

### Community 7 - "agents.ts"
Cohesion: 0.11
Nodes (20): agentRoutes(), createAgentSchema, ensService, initialPolicySchema, pnlService, policyDecimal, policyService, publicRegistrationSchema (+12 more)

### Community 8 - "mcp-server/package.json"
Cohesion: 0.06
Nodes (32): bin, agentfi-mcp, dependencies, dotenv, @modelcontextprotocol/sdk, tsx, zod, description (+24 more)

### Community 9 - "HANDOFF — AgentFi"
Cohesion: 0.06
Nodes (31): 1. Snapshot, 2. Required reading order, 3.1 Owner-only items (summary; details in the plan), 3.2 Known defects being fixed (Week 0), 3.3 Blocked externally, 3.4 The meta-guidance, 3. Pending work, 4. Credentials inventory (+23 more)

### Community 10 - "transactionRoutes"
Cohesion: 0.16
Nodes (10): Added, ensureChainAllowed(), executeA2APayment(), getAgent(), getIdempotentTransaction(), getLatestAgentTxTimestamp(), isNativeWeth(), transactionRoutes() (+2 more)

### Community 11 - "AgentFi API Reference"
Cohesion: 0.06
Nodes (33): Admin (Operator), AgentFi API Reference, Agents, Authentication, Billing, Error Responses, GET /v1/agents/me/pnl, Health (+25 more)

### Community 12 - "backend/src/index.ts"
Cohesion: 0.22
Nodes (13): RATE_LIMITS, redis, registerRateLimit(), billingRoutes(), resourcePaymentRoutes(), walletRoutes(), fastify, start() (+5 more)

### Community 13 - "transaction.queue.ts"
Cohesion: 0.12
Nodes (11): connection, deadLetterQueue, feeService, isRedisQuotaExceededError(), monitor, startTransactionWorker(), submitter, transactionQueue (+3 more)

### Community 14 - "session.ts"
Cohesion: 0.26
Nodes (7): Jobs (Agent-to-Agent), POST /v1/jobs/:id/pay-resource, GET(), { hasAdminSessionMock }, POST(), { hasAdminSessionMock }, hasAdminSession()

### Community 15 - "admin.ts"
Cohesion: 0.15
Nodes (16): adminRoutes(), batchAdminSchema, buildKillSwitchOnChainSync(), isLoopbackIp(), KillSwitchAgent, OnChainSync, operatorService, parseKillSwitchBody() (+8 more)

### Community 16 - "backend/package.json"
Cohesion: 0.08
Nodes (24): dotenv, @modelcontextprotocol/sdk, tsx, @types/node, typescript, vitest, zod, license (+16 more)

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
Cohesion: 0.07
Nodes (27): dependencies, @aave/contract-helpers, @aave/math-utils, bullmq, dotenv, ethers, fastify, @fastify/cors (+19 more)

### Community 24 - "transactions.ts"
Cohesion: 0.09
Nodes (24): builder, depositSchema, ERC20_DECIMALS_ABI, erc4626DepositSchema, erc4626WithdrawSchema, executeSwapSchema, executor, feeService (+16 more)

### Community 25 - "AgentFiClient"
Cohesion: 0.16
Nodes (10): AgentFiClient, AgentFiConfig, agentFiPlugin(), ElizaAction, ElizaPlugin, AgentFiToolkit, LangChainTool, makeTool() (+2 more)

### Community 26 - "Dossiê de Retomada — AgentFi (06/10/2026)"
Cohesion: 0.10
Nodes (20): 0. Veredito em cinco linhas, 10. Registro desta sessão (06/10/2026), 1.1 Repositório e distribuição, 1.2 Código e toolchain, 1.3 Branches, PRs e pastas irmãs, 1.4 Validação do stack zero-credencial nesta sessão, 1. Estado do projeto, verificado hoje, 2. O que o AgentFi é (resumo de dez linhas) (+12 more)

### Community 27 - "preflight.ts"
Cohesion: 0.16
Nodes (21): ioredis, @turnkey/sdk-server, CHAIN_CONFIGS, ChainContractConfig, check(), checkContracts(), checkDatabase(), checkEnvVars() (+13 more)

### Community 29 - "next"
Cohesion: 0.12
Nodes (6): LoginForm(), LoginPage(), config, isLoopbackHost(), middleware(), next

### Community 30 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 31 - "executor.service.ts"
Cohesion: 0.23
Nodes (7): TransactionData, consoleLogger, ExecutorAction, ExecutorLogger, ExecutorService, toExecutorAction(), WrappedTransaction

### Community 32 - "Sinais de mercado — agentes transacionando (status em 06/10/2026)"
Cohesion: 0.11
Nodes (18): 0. Leitura em uma frase, 10. Implicação para o AgentFi, 1. Protocolos e padrões abertos, 2. Trilhos, carteiras e plataformas, 3. Redes de cartão, bancos e reguladores bancários, 4. Big techs e plataformas de LLM, 5. Economias agente-a-agente e DeFAI (o que é real), 6. Regulação (+10 more)

### Community 33 - "resource-payment.service.ts"
Cohesion: 0.08
Nodes (25): AttemptContext, AttemptState, COUNTED_STATUSES, firstOption(), isPrivateHost(), isPrivateIpv4(), isUniqueViolation(), JobBudget (+17 more)

### Community 34 - "pnl.service.ts"
Cohesion: 0.08
Nodes (28): PnLBreakdown, PnLService, rewardRowToUsd(), resolveRewardUsd(), RewardJson, RewardPriceResult, ZERO_RESULT, CHAIN_NATIVE_TOKEN (+20 more)

### Community 35 - "viem"
Cohesion: 0.11
Nodes (13): __clearLocalWallets(), __localWalletCount(), LocalWalletEntry, LocalWalletService, randomPrivateKey(), randomWalletId(), wallets, Eip712TypedData (+5 more)

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
Cohesion: 0.12
Nodes (18): CHAIN_IDS, FALLBACK_RPC_URLS, getChain(), getRpcCandidates(), getSecondaryRpcUrl(), isNetworkOrRateLimitError(), isUsableRpcUrl(), PUBLIC_RPC_URLS (+10 more)

### Community 40 - "abi.erc8183.test.ts"
Cohesion: 0.06
Nodes (45): __dirname, nextConfig, ARTIFACTS, ESCROW_ABI, ESCROW_EVENTS, ESCROW_FUNCTIONS, here, HOOK_ABI (+37 more)

### Community 41 - "ens.service.ts"
Cohesion: 0.11
Nodes (17): Phase 1: Bootstrap & Architectural Foundation (complete), Phase 2.5: Go-Live Hardening (Completed — April 2026), Phase 2: Scale & Operational Predictability, Phase 3: A2A Economy Primitives, Phase 4: Self-Sustaining Agents (~40%), Phase 5: Adoption Model Evolution ("AgentFi-as-a-Service"), Phase 6: The Frontier Market and Autonomous Volume, ROADMAP — AgentFi (+9 more)

### Community 42 - "AgentFi — Operator Setup Checklist"
Cohesion: 0.12
Nodes (16): 0. Choose Your Mode, 10. Stripe Billing, 11. Install and Run Locally With Real Credentials, 12. Production Hosting, 13. Verification, 1. Local Environment File, 2. Required Secrets, 3. RPC Provider (+8 more)

### Community 43 - "simulator.service.ts"
Cohesion: 0.19
Nodes (8): describeSimulationError(), findExecutionRevert(), isRpcTransportFailure(), SimulationParams, SimulationProvider, SimulationResult, SimulatorService, TenderlySimulationRequest

### Community 44 - "e2e-issue-81.mjs"
Cohesion: 0.33
Nodes (11): api(), c, createPaidJob(), getJob(), log(), main(), patchJob(), POLL_TIMEOUT_SEC (+3 more)

### Community 45 - "ERC-8004 (Trustless Agents) — integration design"
Cohesion: 0.29
Nodes (7): 1. Registries and addresses, 2. Identity Registry (what AgentFi writes), 3. Reputation Registry (current signature, verbatim), 4. AgentFi design: feedback written by the escrow hook, 5. What we do not do, 6. Decisions (owner, 2026-10-06), ERC-8004 (Trustless Agents) — integration design

### Community 46 - "Sidebar.tsx"
Cohesion: 0.19
Nodes (10): metadata, RootLayout(), viewport, navItems, Sidebar(), StatCardProps, cn(), clsx (+2 more)

### Community 47 - "Release Guide - @agent_fi/mcp-server"
Cohesion: 0.13
Nodes (14): Current Tool Inventory (0.5.0), Directory Follow-Ups, `npm publish` returns `404`, `npm publish` returns `E403`, `npm publish` returns `ENEEDAUTH`, `npm publish` returns `EOTP`, Prerequisites, Publish 0.5.0 (+6 more)

### Community 48 - "AgentFi — Vision"
Cohesion: 0.12
Nodes (16): A note on authorship, Agent-to-agent economy, AgentFi — Vision, Economic identity, How to contribute, On consciousness and expansion, On what's happening right now, Principles this project builds on (+8 more)

### Community 49 - "Contract Deployment — AgentFi"
Cohesion: 0.05
Nodes (38): Address registry, Admin dashboard, Arbitrum One (Chain 42161) — NOT DEPLOYED, Automated verification script, Backend-managed installation, Base Mainnet (Chain 8453) — DEPLOYED, **LEGACY (old `Action` struct) — redeploy pending**, Base Sepolia (Chain 84532) — **LEGACY (old `Action` struct) — redeploy pending**, Check fee wallet balance (+30 more)

### Community 50 - "agents/page.tsx"
Cohesion: 0.16
Nodes (13): Agent, AgentsPage(), getAgents(), NETWORK_COLORS, NETWORK_NAMES, TIER_STYLES, CHAIN_NAMES, getTransactions() (+5 more)

### Community 51 - "pre-submit-guard.ts"
Cohesion: 0.18
Nodes (10): AgentSnapshot, PAUSED_BEFORE_SUBMISSION, POLICY_EXPIRED_BEFORE_SUBMISSION, PreSubmitDecision, preSubmitGuard(), resolveBlockReason(), workerDecision(), { finalizeMock, escrowOutcomeMock } (+2 more)

### Community 52 - "How to deposit ETH to Base — Full Tutorial"
Cohesion: 0.15
Nodes (12): FAQ, How to deposit ETH to Base — Full Tutorial, How to verify it arrived, Official Base Bridge (Safest), OPTION A — You already have ETH on an exchange (Binance, Coinbase, etc.), OPTION B — You have ETH on Ethereum mainnet and want to move it to Base, OPTION C — You have USDC or another stablecoin, Step 1 — Add the Base network to your wallet (+4 more)

### Community 53 - "Issue #71 — A2A Revenue Integrity (Execution Plan)"
Cohesion: 0.12
Nodes (16): 1.1 Ghost completions — fire-and-forget payment, 1.2 Silent zero from price oracle, 1.3 Real-time price (no historical snapshot), 1. Bug surface (what's broken today), 2. The 3-phase plan, 3. Acceptance criteria per phase, 4. Follow-up tickets to file, 5. Status (+8 more)

### Community 54 - "agents/[id]/page.tsx"
Cohesion: 0.22
Nodes (11): AgentDetail, AgentDetailPage(), getAgent(), getAgentTransactions(), STATUS_COLORS, Transaction, PauseButton(), ToggleResponse (+3 more)

### Community 55 - "Graphify Code Graph"
Cohesion: 0.33
Nodes (5): Codex Integration, Graphify Code Graph, Install, Query, Update

### Community 56 - "📂 Navigation"
Cohesion: 0.20
Nodes (10): 🤖 Agent context, AgentFi Documentation Hub, 🏗️ Architecture, 🛠️ Developer Resources, 📦 Meta, 📂 Navigation, ⚙️ Operations, 🔁 Reactivation (2026-10-06) (+2 more)

### Community 57 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, build, db:generate, db:migrate, db:push, dev, lint, test (+5 more)

### Community 58 - "createChainPublicClient"
Cohesion: 0.17
Nodes (10): getQuotedAmountOut(), createChainPublicClient(), getPrimaryRpcUrl(), AGENT_POLICY_MODULE_ABI, DeployedSafe, init(), SafeInitConfig, SafeProtocolKit (+2 more)

### Community 59 - "transactions/[id]/page.tsx"
Cohesion: 0.27
Nodes (9): 🛠️ Technical Changes, CHAIN_INFO, getTransaction(), PublicTransaction, STATUS_CONFIG, TransactionStatusPage(), TransactionAdminActions(), TransactionAdminActionsProps (+1 more)

### Community 60 - "x402-fixture.ts"
Cohesion: 0.08
Nodes (38): 8. Tests and what they do not prove, MAX_AUTHORIZATION_WINDOW_SECONDS, accountSigner(), BASE_MAINNET, CachedReply, Counts, expiredOffers(), failAfterSigning() (+30 more)

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
Cohesion: 0.27
Nodes (7): CHAIN_NAMES, getJob(), Job, JobDetailPage(), STATUS_CONFIG, JobReconcileActions(), Props

### Community 69 - "notification.service.ts"
Cohesion: 0.33
Nodes (9): escapeHtml(), fetchAndAssertOk(), formatTelegramHtml(), NotificationPayload, notificationService, sendDiscord(), sendGenericWebhook(), sendTelegram() (+1 more)

### Community 70 - "builder.service.ts"
Cohesion: 0.20
Nodes (9): AAVE_POOL_ABI, COMPOUND_COMET_ABI, CURVE_STABLESWAP_ABI, ERC20_ABI, ERC4626_VAULT_ABI, GMX_EXCHANGE_ROUTER_ABI, isNativeWeth(), UNISWAP_ROUTER_ABI (+1 more)

### Community 71 - "Fixed"
Cohesion: 0.26
Nodes (10): Fixed, isProductionLikeEnv(), PRODUCTION_LIKE_ENVS, assertSimulationUsable(), ensureSimulationUsable(), isSimulationUsable(), SIMULATION_UNAVAILABLE_MESSAGE, SimulationUnavailableError (+2 more)

### Community 72 - "AgentFi Production Release and Rollback Runbook"
Cohesion: 0.20
Nodes (10): 1. Preconditions, 2. Standard Production Release, 3. Post-Deploy Verification (must pass), 4. Rollback Playbook, 5. Emergency Safeguards, 6. Operational Defaults, 7. Audit Trail Template, 8. Alert Thresholds (Auth and Access) (+2 more)

### Community 73 - "FeeService"
Cohesion: 0.18
Nodes (4): TransactionProcessorDeps, FeeService, MonitorService, 5. End-to-end transaction flow

### Community 74 - "logger.ts"
Cohesion: 0.17
Nodes (11): logger, connection, paymentRecoveryQueue, PER_TICK_LIMIT, RecoverySummary, connection, reputationQueue, { mockDb, finalizeMock, recoverMock, captured } (+3 more)

### Community 75 - "StripeService"
Cohesion: 0.26
Nodes (4): getStripe(), PRICE_IDS, StripeService, stripe

### Community 77 - "Agent-to-Agent (A2A) Interoperability Protocol"
Cohesion: 0.29
Nodes (6): 1. Discovery (Agent Yellow Pages), 2. Cryptographic Trust & Identity, 3. Communication & Job Queue, 4. Automated Reputation, 5. Intent-Aware Economy, Agent-to-Agent (A2A) Interoperability Protocol

### Community 78 - "AgentFi"
Cohesion: 0.20
Nodes (10): AgentFi, 🤝 Community, 📚 Documentation, For Developers, For Operators, 🛠️ Getting Started, 🚀 Key Features, 📄 License (+2 more)

### Community 79 - "AgentFi — Project State"
Cohesion: 0.12
Nodes (16): 1. Purpose, 2. Four-Layer Stack, 3. Supported Networks, 4.1 Core DeFi primitives, 4.2 Agent-to-Agent economy (the heart of the thesis), 4.3 Policy and governance, 4.4 Self-sustaining agents (Phase 4), 4.5 Operator admin (+8 more)

### Community 80 - "Contributing to AgentFi"
Cohesion: 0.22
Nodes (9): Contributing to AgentFi, License, Making a change, PR expectations, Project structure, Reporting bugs, Security issues, Setup (+1 more)

### Community 81 - "api-reference.md"
Cohesion: 0.20
Nodes (6): @agent_fi/backend, API Reference, Architecture, Local Development, Scripts, Stack

### Community 82 - "x402-client.service.ts"
Cohesion: 0.09
Nodes (28): AttemptState, clip(), DEFAULT_REQUEST_TIMEOUT_MS, describeAuthorization(), hasPaymentHeader(), headersToRecord(), isSignedReceipt(), isTimeout() (+20 more)

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
Cohesion: 0.20
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

### Community 94 - "onChainEscrowService"
Cohesion: 0.38
Nodes (3): ESCROW_MODULE_ABI, EscrowLockTx, onChainEscrowService

### Community 95 - "env"
Cohesion: 0.21
Nodes (7): env, SubmissionResult, SubmitterService, getWalletService(), WalletService, SignedTransaction, WalletInfo

### Community 96 - "backend/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 97 - "mcp-server/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 98 - "Reporting a Vulnerability"
Cohesion: 0.25
Nodes (8): Out of Scope, Process, Reporting a Vulnerability, Scope, Security Best Practices, Security Policy, Supported Versions, What to include

### Community 99 - "PolicyService"
Cohesion: 0.14
Nodes (5): Changed, OnChainPolicyService, OperatorResumeOutcome, PolicyService, PolicyValidationResult

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
Cohesion: 0.19
Nodes (7): DATASTORE_ABI, GMX_CONTRACTS, GMX_MARKETS, GmxExecutionFeeResult, GmxMarketInfo, gmxService, READER_ABI

### Community 108 - "escrow-erc8183.service.test.ts"
Cohesion: 0.08
Nodes (27): AGENT_JOB_ESCROW_ABI, REPUTATION_HOOK_ABI, CHAIN_JOB_STATUS, __resetEscrowTokenCacheForTests(), SETTLEMENT_REASONS, BUDGET, completeLogs(), config (+19 more)

### Community 109 - "AgentFi Smart Contracts"
Cohesion: 0.29
Nodes (6): AgentFi Smart Contracts, Chain Support, Contracts, Deployment, Development, Security

### Community 110 - "AgentFi Agent Quickstart"
Cohesion: 0.33
Nodes (6): 1. Connect to the MCP Server, 2. Register an Agent (get your API key), 3. Your Agent Can Now Execute Transactions, AgentFi Agent Quickstart, Fee Structure, Security Guarantees

### Community 111 - "🚀 New Features"
Cohesion: 0.33
Nodes (5): 1. Human-in-the-Loop (HITL) Approval System, 2. Public Transaction Explorer, 3. Operator Notification Service, 🚀 New Features, Release Notes — HITL & Transaction Transparency (April 2026)

### Community 112 - "escrow-erc8183.service.ts"
Cohesion: 0.07
Nodes (29): buildFeedbackFile(), CancellationReason, ERC20_APPROVE_ABI, Erc8183ChainConfig, Erc8183RecoveryOutcome, ESCROW_COLUMNS, ESCROW_TOKEN_DECIMALS, escrowIntentId() (+21 more)

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
Cohesion: 0.40
Nodes (5): Dependabot notes, Next session (do this first), Session Notes — 2026-10-06, What this session did (2026-10-06, four passes), Where we are right now

### Community 117 - "ResourcePaymentService"
Cohesion: 0.16
Nodes (9): payResourceSchema, ResourcePaymentRoutesOptions, clip(), ResourcePaymentError, ResourcePaymentService, sumAmounts(), truncateUtf8(), AuthorizationInfo (+1 more)

### Community 118 - "AgentFi Remediation Plan and Execution"
Cohesion: 0.40
Nodes (4): AgentFi Remediation Plan and Execution, Deterministic Decisions, Execution Status, P0 Remediation Plan

### Community 119 - "ABI versioning"
Cohesion: 0.40
Nodes (4): ABI versioning, Backend ABI — single source of truth, Legacy deployments (old `Action` struct) — do not route through, What changed (October 2026)

### Community 120 - "NoAcceptableSchemeError"
Cohesion: 0.15
Nodes (16): Added, 10. Job-scoped payments (P2) and the ledger state machine (P5 subset), 1. What the service does, 2. Spend controls — three gates before a signature exists, 3. Idempotency — `payment-identifier` — and what it does not do, 4. Receipts — `offer-receipt`, 5. Errors, 6. Facilitators (+8 more)

### Community 121 - "claimRefund"
Cohesion: 0.12
Nodes (21): 1. What the standard defines, 2. Mapping AgentFi → ERC-8183, 3. Contract: `AgentJobEscrow.sol` (as implemented, review R2 applied 2026-10-06), 4. Known pitfalls and version drift, 5. Decisions (owner, 2026-10-06), 6.1 Enablement, 6.2 Step chain and who signs, 6.3 Settlement, feedback file and contest (+13 more)

### Community 122 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Alternatives Considered, Problem, Proposed Solution

### Community 123 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, devCommand, framework, installCommand

### Community 124 - "env.ts"
Cohesion: 0.14
Nodes (18): blankToUndefined(), configuredEscrowChainIds, configuredEscrowChains, envSchema, ESCROW_CHAIN_IDS, escrowAddressFields, escrowEvaluatorAddress, optionalAddress() (+10 more)

### Community 125 - "settle"
Cohesion: 0.16
Nodes (11): TransactionJobData, EvaluatorSigner, Erc8183Deps, feedbackUriFor(), finalizeAfterRefund(), parseSettlementReceipt(), reconcileTerminal(), rejectForCancellation() (+3 more)

### Community 126 - "[0.5.0] — 2026-05-15"
Cohesion: 0.12
Nodes (16): [0.1.0] - 2026-03-25, [0.5.0] — 2026-05-15, Added, Added, Changed, Changed, Changed (breaking — mcp-server 0.2.0 → 0.3.0), Changelog (+8 more)

### Community 127 - "health/page.tsx"
Cohesion: 0.83
Nodes (3): getHealthStatus(), HealthPage(), ServiceRow()

### Community 128 - "repository"
Cohesion: 0.50
Nodes (4): repository, directory, type, url

### Community 129 - "Archive"
Cohesion: 0.67
Nodes (3): Archive, Rule for future archives, What's in here

### Community 133 - "fastify"
Cohesion: 0.25
Nodes (5): buildApp(), { mockDb, queueAddMock, validateMock, getPolicyMock, simulateMock }, buildTestApp(), { mockDb, queueAddMock }, fastify

### Community 140 - "contracts.ts"
Cohesion: 0.22
Nodes (13): ChainContracts, CONTRACT_ADDRESSES, ContractEnvSource, contractEnvVar(), describeLegacyContract(), executorFromEnv(), findLegacyContractConfig(), isLegacyContractAddress() (+5 more)

### Community 141 - "processSettlementJob"
Cohesion: 0.19
Nodes (13): continueChain(), deliverableHashOf(), enqueueStep(), enqueueSubmit(), handleStepFailure(), loadEscrowJob(), onEscrowTxOutcome(), processSettlementJob() (+5 more)

### Community 142 - "lib/auth.ts"
Cohesion: 0.20
Nodes (8): handler, AdminAuditEvent, logAdminAuthEvent(), maskUsername(), ADMIN_OAUTH_ALLOWLIST, authOptions, KNOWN_CREDENTIAL_PLACEHOLDERS, next-auth

### Community 143 - "transaction.processor.ts"
Cohesion: 0.26
Nodes (9): addDailyVolumeAtomic(), handleFailedTransactionJob(), isLastAttempt(), ProcessorLogger, processTransactionJob(), TransactionFailureDeps, TransactionJobLike, TransactionJobResult (+1 more)

### Community 144 - "TurnkeyService"
Cohesion: 0.27
Nodes (3): 7. Wallet signing, getTurnkeyClient(), TurnkeyService

### Community 145 - "jobs.routes.erc8183.test.ts"
Cohesion: 0.18
Nodes (10): FeedbackFile, feedbackHashOf(), serializeFeedbackFile(), sortKeysDeep(), AuthModule, buildApp(), JobsModule, { mockDb, escrowMock, runtimeMock, reputationMock, paymentMock } (+2 more)

### Community 146 - "executor.service.test.ts"
Cohesion: 0.20
Nodes (8): AGENT_EXECUTOR_ABI, EXECUTOR, POOL, SAFE, TARGET, USDC, VAULT, WETH

### Community 147 - "middleware/auth.ts"
Cohesion: 0.24
Nodes (9): authMiddleware, authPlugin(), fastify, FastifyRequest, generateApiKey(), hashApiKey(), isOperatorKey(), OPERATOR_CAPABLE_ROUTES (+1 more)

### Community 148 - "policy-authority.test.ts"
Cohesion: 0.24
Nodes (8): isPolicyDecimal(), parsePolicyDecimal(), POLICY_DECIMAL_MESSAGE, POLICY_DECIMAL_PATTERN, EARLIER, EXPIRY, LATER, UNPARSABLE_LIMITS

### Community 149 - "admin.pause.routes.test.ts"
Cohesion: 0.18
Nodes (8): AdminModule, AgentRow, buildApp(), GuardModule, { mockDb, finalizeMock }, OnChainModule, PolicyModule, PolicyRow

### Community 150 - "x402.middleware.ts"
Cohesion: 0.24
Nodes (9): createChallenge(), ERC20_TRANSFER_ABI, FEE_WALLET, NETWORK_CHAIN_ID, requirePayment(), USDC_ADDRESS, verifyPayment(), X402Challenge (+1 more)

### Community 151 - "NodeAdapter"
Cohesion: 0.31
Nodes (3): NodeAdapter, send(), handle()

### Community 152 - "@prisma/client"
Cohesion: 0.33
Nodes (5): FEE_BPS, FeeCalculation, SUBSCRIPTION_PRICE_USD, TX_LIMITS, @prisma/client

### Community 153 - "transaction.worker.test.ts"
Cohesion: 0.25
Nodes (6): { finalizeMock, weiToUsdMock, escrowOutcomeMock }, JOB_DATA, makeDb(), makeDeps(), TX_HASH, TxRow

### Community 154 - "health.ts"
Cohesion: 0.39
Nodes (7): checkDatabase(), checkRedis(), checkRpc(), checkTurnkey(), healthRoutes(), redis, turnkey

### Community 155 - "x402.ts"
Cohesion: 0.39
Nodes (6): chainIdToNetwork(), getX402FacilitatorUrl(), networkToChainId(), X402_FACILITATOR_DEFAULTS, { envState }, @x402/core

### Community 156 - "escrow-erc8183.runtime.ts"
Cohesion: 0.43
Nodes (7): enqueueSubmit(), erc8183Deps(), getEscrowToken(), publicClients, recoverErc8183Job(), requestCancellationReject(), startEscrow()

### Community 157 - "Testnet log — Base Sepolia (chain 84532)"
Cohesion: 0.29
Nodes (5): 1. Deployments (task C4), 2. C4 runbook (owner runs it; the agent prepared it), 3. Jobs settled on testnet (tasks C5, G2, G5), 4. ERC-8004 identities registered (task R2), Testnet log — Base Sepolia (chain 84532)

### Community 158 - "db/client.ts"
Cohesion: 0.38
Nodes (4): stripeService, COMMON_TOKENS, ERC20_READ_ABI, db

### Community 160 - "agents.policy.routes.test.ts"
Cohesion: 0.29
Nodes (5): AgentsModule, AuthModule, buildApp(), buildAuthedApp(), { mockDb }

### Community 161 - ".chain"
Cohesion: 0.50
Nodes (4): Erc8183Config, getEscrowToken(), isErc8183EnabledWith(), startEscrow()

## Knowledge Gaps
- **1138 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+1133 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1274 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `viem` connect `viem` to `jobs.ts`, `agents.ts`, `transactionRoutes`, `contracts.ts`, `transaction.queue.ts`, `admin.ts`, `backend/package.json`, `transaction.processor.ts`, `executor.service.test.ts`, `jobs.routes.erc8183.test.ts`, `admin.pause.routes.test.ts`, `x402.middleware.ts`, `transactions.ts`, `@prisma/client`, `transaction.worker.test.ts`, `escrow-erc8183.runtime.ts`, `db/client.ts`, `executor.service.ts`, `resource-payment.service.ts`, `pnl.service.ts`, `global-setup.ts`, `chains.ts`, `abi.erc8183.test.ts`, `ens.service.ts`, `simulator.service.ts`, `createChainPublicClient`, `x402-fixture.ts`, `builder.service.ts`, `Fixed`, `ref_vitest`, `x402-client.service.ts`, `onChainEscrowService`, `env`, `PolicyService`, `gmx.service.ts`, `escrow-erc8183.service.test.ts`, `escrow-erc8183.service.ts`, `env.ts`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `transactionRoutes()` (e.g. with `.buildAaveSupply()` and `.buildAaveWithdraw()`) actually correct?**
  _`transactionRoutes()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _1138 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `mcp-server/src/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0632996632996633 - nodes in this community are weakly interconnected._
- **Why does `next` connect `next` to `dashboard/page.tsx`, `jobs/[id]/page.tsx`, `jobs/page.tsx`, `session.ts`, `Sidebar.tsx`, `admin/package.json`, `agents/page.tsx`, `agents/[id]/page.tsx`, `transactions/[id]/page.tsx`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `X402ClientService` (e.g. with `Added` and `WS4 — Payments client: pay for 402 resources inside a job budget (Days 15–45)`) actually correct?**
  _`X402ClientService` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._