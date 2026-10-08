# Graph Report - agentfi  (2026-10-07)

## Corpus Check
- 326 files · ~326,199 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 24 file(s) not represented in the graph (top: (none) 11, .toml 5, .example 1)

## Summary
- 2864 nodes · 5259 edges · 175 communities (160 shown, 15 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 219 edges (avg confidence: 0.92)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5b317c5c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.ts
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
- fastify
- transaction.queue.ts
- outbound-target.ts
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
- contracts.ts
- OperatorService
- next
- compilerOptions
- executor.service.test.ts
- Sinais de mercado — agentes transacionando (status em 06/10/2026)
- resource-payment.service.ts
- price.service.ts
- viem
- compilerOptions
- global-setup.ts
- dependencies
- chains.ts
- env.example.test.ts
- ens.service.ts
- AgentFi — Operator Setup Checklist
- Fixed
- e2e-issue-81.mjs
- sanitize.ts
- Sidebar.tsx
- Release Guide - @agent_fi/mcp-server
- AgentFi — Vision
- Contract Deployment — AgentFi
- agents/page.tsx
- transaction.processor.ts
- How to deposit ETH to Base — Full Tutorial
- Issue #71 — A2A Revenue Integrity (Execution Plan)
- agents/[id]/page.tsx
- Graphify Code Graph
- 📂 Navigation
- scripts
- createChainPublicClient
- transactions/[id]/page.tsx
- resource-payment.routes.test.ts
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
- erc8004-identity.service.ts
- AgentFi Production Release and Rollback Runbook
- errors.ts
- @prisma/client
- StripeService
- ref_vitest
- ReputationService
- AgentFi
- AgentFi — Project State
- Contributing to AgentFi
- @agent_fi/backend
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
- escrow.service.ts
- wallet/index.ts
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
- Session Notes — 2026-10-07
- ResourcePaymentService
- AgentFi Remediation Plan and Execution
- ABI versioning
- NoAcceptableSchemeError
- claimRefund
- feature_request.md
- vercel.json
- backend/src/index.ts
- Erc8183Deps
- escrow-erc8183.fork.e2e.ts
- health/page.tsx
- repository
- Archive
- Role: Logic Sentinel
- .eslintrc.json
- transactions.batch.routes.test.ts
- verify-deployment.sh
- AGENTS.md
- go-no-go.md
- gen-secrets.sh
- erc8004-identity.test.ts
- escrow-erc8183/index.mjs
- mcp.ts
- escrow-tx-steps.ts
- TurnkeyService
- jobs.routes.erc8183.test.ts
- escrow-settlement.queue.ts
- middleware/auth.ts
- escrow-fork.harness.ts
- admin.pause.routes.test.ts
- x402.middleware.ts
- NodeAdapter
- X402ClientService
- annotations.ts
- health.ts
- x402.ts
- resource-payment.target-policy.test.ts
- agent.ts
- evaluator-signer.ts
- startEscrowFork
- agents.policy.routes.test.ts
- ref_modelcontextprotocol_sdk
- agents.handshake.routes.test.ts
- release-v1.mjs
- abi.erc8183.test.ts
- jobs.test.ts
- escrow-erc8183/package.json
- agents.erc8004.routes.test.ts
- Execution Plan — AgentFi reactivation (Q4 2026)
- token-registry.ts
- ROADMAP — AgentFi
- AgentFi Example — ERC-8183 escrow with ERC-8004 feedback
- startBackend
- tsconfig.build.json
- prisma

## God Nodes (most connected - your core abstractions)
1. `viem` - 66 edges
2. `transactionRoutes()` - 38 edges
3. `ResourcePaymentService` - 32 edges
4. `@prisma/client` - 31 edges
5. `X402ClientService` - 31 edges
6. `fastify` - 30 edges
7. `logger` - 27 edges
8. `jobRoutes()` - 22 edges
9. `createChainPublicClient()` - 22 edges
10. `env` - 21 edges

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

## Communities (175 total, 15 thin omitted)

### Community 0 - "server.ts"
Cohesion: 0.15
Nodes (18): api, ErrorLogger, CallToolOptions, RegisteredTool, SERVER_NAME, SERVER_VERSION, toolRegistry, defiTools (+10 more)

### Community 1 - "PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA"
Cohesion: 0.04
Nodes (46): Account Abstraction com Safe, ARQUITETURA GERAL, Autenticação no MCP, Backend, Canal 1 — Registro em Repositórios de MCP Servers, Canal 2 — Documentação Otimizada para LLMs, Canal 3 — Integração com Frameworks de Agentes, Canal 4 — Infraestrutura de Descoberta Agent-to-Agent (+38 more)

### Community 2 - "login-rate-limit.ts"
Cohesion: 0.07
Nodes (34): GET(), { hasAdminSessionMock }, POST(), { hasAdminSessionMock }, handler, AdminAuditEvent, logAdminAuthEvent(), maskUsername() (+26 more)

### Community 3 - "jobs.ts"
Cohesion: 0.13
Nodes (27): contestJobSchema, createJobSchema, errorMessage(), jobRoutes(), reputationService, REWARD_CHAIN_ID_REQUIRED, REWARD_TOKEN_REQUIRED, updateJobSchema (+19 more)

### Community 4 - "scripts"
Cohesion: 0.05
Nodes (37): devDependencies, eslint, prettier, tsx, typescript, engines, node, tsx (+29 more)

### Community 5 - "policy-authority.ts"
Cohesion: 0.13
Nodes (21): classifyPolicyChange(), effectiveCooldown(), effectiveDailyLimit(), effectiveExpiry(), effectiveMaxValuePerTx(), normalizeAddress(), POLICY_PATCH_FIELDS, PolicyChangeClassification (+13 more)

### Community 6 - "adapters/package.json"
Cohesion: 0.06
Nodes (32): description, devDependencies, @types/node, typescript, exports, ./eliza, ./langchain, ./openai (+24 more)

### Community 7 - "agents.ts"
Cohesion: 0.09
Nodes (24): Added, agentRoutes(), createAgentSchema, ensService, IDENTITY_SELECT, initialPolicySchema, pnlService, policyDecimal (+16 more)

### Community 8 - "mcp-server/package.json"
Cohesion: 0.06
Nodes (35): bin, agentfi-mcp, dependencies, dotenv, @modelcontextprotocol/sdk, tsx, zod, description (+27 more)

### Community 9 - "HANDOFF — AgentFi"
Cohesion: 0.06
Nodes (31): 1. Snapshot, 2. Required reading order, 3.1 Owner-only items (summary; details in the plan), 3.2 Known defects being fixed (Week 0), 3.3 Blocked externally, 3.4 The meta-guidance, 3. Pending work, 4. Credentials inventory (+23 more)

### Community 10 - "transactionRoutes"
Cohesion: 0.16
Nodes (11): Added, ensureChainAllowed(), executeA2APayment(), getLatestAgentTxTimestamp(), getTokenDecimals(), isNativeWeth(), transactionRoutes(), weiToEthDecimalString() (+3 more)

### Community 11 - "AgentFi API Reference"
Cohesion: 0.07
Nodes (28): AgentFi API Reference, Agents, Authentication, Billing, Error Responses, GET /v1/agents/me/pnl, Health, MCP (Model Context Protocol) (+20 more)

### Community 12 - "fastify"
Cohesion: 0.19
Nodes (11): RAW_BODY_ROUTES, registerJsonBodyParser(), RATE_LIMITS, rateLimitErrorResponse(), redis, { ALCHEMY_KEY }, buildApp(), LogLine (+3 more)

### Community 13 - "transaction.queue.ts"
Cohesion: 0.07
Nodes (14): TransactionProcessorDeps, connection, deadLetterQueue, feeService, isRedisQuotaExceededError(), monitor, submitter, transactionQueue (+6 more)

### Community 14 - "outbound-target.ts"
Cohesion: 0.11
Nodes (25): Security, Admin (Operator), Jobs (Agent-to-Agent), POST /v1/jobs/:id/pay-resource, WS1 — Correctness and safety fixes (Week 0–1), assertPublicTarget(), createPinnedDispatcher(), embeddedIpv4() (+17 more)

### Community 15 - "admin.ts"
Cohesion: 0.15
Nodes (14): batchAdminSchema, buildKillSwitchOnChainSync(), isLoopbackIp(), KillSwitchAgent, OnChainSync, operatorService, parseKillSwitchBody(), pauseAgentSchema (+6 more)

### Community 16 - "backend/package.json"
Cohesion: 0.07
Nodes (26): dotenv, @modelcontextprotocol/sdk, tsx, @types/node, typescript, vitest, zod, license (+18 more)

### Community 18 - "admin/package.json"
Cohesion: 0.08
Nodes (22): @types/node, typescript, vitest, license, name, private, repository, directory (+14 more)

### Community 19 - "@agent_fi/mcp-server"
Cohesion: 0.07
Nodes (27): @agent_fi/mcp-server, Agent-to-Agent (A2A) Collaboration, Annotations, Claude Code, Claude Desktop, Configuration, Environment Variables, Errors (+19 more)

### Community 20 - "What Was Done (Go-Live Session)"
Cohesion: 0.09
Nodes (22): Branch & Repository, CI/CD, CI Status, Current State, Database, Dependencies, Documentation, Go-Live Status — AgentFi v0.1.0 (+14 more)

### Community 21 - "AgentFi — Dev Quickstart"
Cohesion: 0.20
Nodes (10): AgentFi — Dev Quickstart, Connect Claude Desktop (optional), Graduating to real networks, Prerequisites, Register your first agent, Start the stack, Tearing down, Troubleshooting (+2 more)

### Community 22 - "AgentFi — Self-Hosted Production Deployment Guide"
Cohesion: 0.08
Nodes (24): Admin auth audit logs, AgentFi — Self-Hosted Production Deployment Guide, Contract addresses (per chain you support), Deploy to Base (recommended first), Go-live checklist, Option A — Railway (reference, ~10 minutes from zero), Option B — Fly.io, Option C — Render (+16 more)

### Community 23 - "dependencies"
Cohesion: 0.07
Nodes (28): dependencies, @aave/contract-helpers, @aave/math-utils, bullmq, dotenv, ethers, fastify, @fastify/cors (+20 more)

### Community 24 - "transactions.ts"
Cohesion: 0.09
Nodes (24): builder, depositSchema, ERC20_DECIMALS_ABI, erc4626DepositSchema, erc4626WithdrawSchema, executeSwapSchema, executor, feeService (+16 more)

### Community 25 - "AgentFiClient"
Cohesion: 0.16
Nodes (10): AgentFiClient, AgentFiConfig, agentFiPlugin(), ElizaAction, ElizaPlugin, AgentFiToolkit, LangChainTool, makeTool() (+2 more)

### Community 26 - "Dossiê de Retomada — AgentFi (06/10/2026)"
Cohesion: 0.10
Nodes (20): 0. Veredito em cinco linhas, 10. Registro desta sessão (06/10/2026), 1.1 Repositório e distribuição, 1.2 Código e toolchain, 1.3 Branches, PRs e pastas irmãs, 1.4 Validação do stack zero-credencial nesta sessão, 1. Estado do projeto, verificado hoje, 2. O que o AgentFi é (resumo de dez linhas) (+12 more)

### Community 27 - "contracts.ts"
Cohesion: 0.11
Nodes (32): ChainContracts, CONTRACT_ADDRESSES, ContractEnvSource, contractEnvVar(), describeLegacyContract(), executorFromEnv(), findLegacyContractConfig(), isLegacyContractAddress() (+24 more)

### Community 28 - "OperatorService"
Cohesion: 0.08
Nodes (15): [0.1.0] - 2026-03-25, [0.5.0] — 2026-05-15, Added, Added (Phase 3/4 roadmap — merged 2026-05-13), Changed, Changed, Changed (breaking — mcp-server 0.2.0 → 0.3.0), Changelog (+7 more)

### Community 29 - "next"
Cohesion: 0.14
Nodes (3): LoginForm(), LoginPage(), next

### Community 30 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 31 - "executor.service.test.ts"
Cohesion: 0.12
Nodes (15): AGENT_EXECUTOR_ABI, TransactionData, consoleLogger, ExecutorAction, ExecutorLogger, ExecutorService, toExecutorAction(), WrappedTransaction (+7 more)

### Community 32 - "Sinais de mercado — agentes transacionando (status em 06/10/2026)"
Cohesion: 0.11
Nodes (18): 0. Leitura em uma frase, 10. Implicação para o AgentFi, 1. Protocolos e padrões abertos, 2. Trilhos, carteiras e plataformas, 3. Redes de cartão, bancos e reguladores bancários, 4. Big techs e plataformas de LLM, 5. Economias agente-a-agente e DeFAI (o que é real), 6. Regulação (+10 more)

### Community 33 - "resource-payment.service.ts"
Cohesion: 0.08
Nodes (26): OutboundTargetPolicy, AttemptContext, AttemptState, COUNTED_STATUSES, destroyDispatcher(), firstOption(), isRedirect(), isUniqueViolation() (+18 more)

### Community 34 - "price.service.ts"
Cohesion: 0.09
Nodes (20): PnLService, rewardRowToUsd(), resolveRewardUsd(), RewardJson, RewardPriceResult, ZERO_RESULT, CHAIN_NATIVE_TOKEN, CHAIN_PLATFORM (+12 more)

### Community 35 - "viem"
Cohesion: 0.10
Nodes (16): __clearLocalWallets(), __localWalletCount(), LocalWalletEntry, LocalWalletService, randomPrivateKey(), randomWalletId(), wallets, Eip712TypedData (+8 more)

### Community 36 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, lib, module (+9 more)

### Community 37 - "global-setup.ts"
Cohesion: 0.13
Nodes (15): ANVIL_BIN, ANVIL_CHAIN_ID, ANVIL_PORT, ANVIL_RPC, DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY, execAsync, FORGE_BIN (+7 more)

### Community 38 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, autoprefixer, clsx, date-fns, framer-motion, lucide-react, next, next-auth (+9 more)

### Community 39 - "chains.ts"
Cohesion: 0.21
Nodes (14): CHAIN_IDS, FALLBACK_RPC_URLS, getRpcCandidates(), getRpcOverride(), getSecondaryRpcUrl(), isNetworkOrRateLimitError(), isUsableRpcUrl(), PUBLIC_RPC_URLS (+6 more)

### Community 40 - "env.example.test.ts"
Cohesion: 0.06
Nodes (32): __dirname, nextConfig, bootWith(), CI_REQUIRED, EXAMPLE_FILE, here, restoreEnv(), savedEnv (+24 more)

### Community 41 - "ens.service.ts"
Cohesion: 0.17
Nodes (9): buildSubdomainCandidate(), DEFAULT_PUBLIC_RESOLVER, ENS_REGISTRY_ABI, EnsConfig, EnsService, normalizeEnsLabel(), PUBLIC_RESOLVER_ABI, readEnsConfig() (+1 more)

### Community 42 - "AgentFi — Operator Setup Checklist"
Cohesion: 0.12
Nodes (16): 0. Choose Your Mode, 10. Stripe Billing, 11. Install and Run Locally With Real Credentials, 12. Production Hosting, 13. Verification, 1. Local Environment File, 2. Required Secrets, 3. RPC Provider (+8 more)

### Community 43 - "Fixed"
Cohesion: 0.13
Nodes (18): Fixed, isProductionLikeEnv(), PRODUCTION_LIKE_ENVS, assertSimulationUsable(), ensureSimulationUsable(), isSimulationUsable(), SIMULATION_UNAVAILABLE_MESSAGE, SimulationUnavailableError (+10 more)

### Community 44 - "e2e-issue-81.mjs"
Cohesion: 0.33
Nodes (11): api(), c, createPaidJob(), getJob(), log(), main(), patchJob(), POLL_TIMEOUT_SEC (+3 more)

### Community 45 - "sanitize.ts"
Cohesion: 0.09
Nodes (38): errorHandler(), explicitStatus(), INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, InternalErrorBody, isPlainHeaders(), statusFor(), addSecret() (+30 more)

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
Nodes (12): Agent, AgentsPage(), getAgents(), NETWORK_COLORS, NETWORK_NAMES, TIER_STYLES, CHAIN_NAMES, getTransactions() (+4 more)

### Community 51 - "transaction.processor.ts"
Cohesion: 0.11
Nodes (24): addDailyVolumeAtomic(), handleFailedTransactionJob(), isLastAttempt(), processTransactionJob(), TransactionFailureDeps, TransactionJobLike, TransactionJobResult, onEscrowTxOutcome() (+16 more)

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
Cohesion: 0.13
Nodes (15): scripts, build, db:generate, db:migrate, db:push, dev, e2e:escrow-fork:stack, lint (+7 more)

### Community 58 - "createChainPublicClient"
Cohesion: 0.20
Nodes (9): getQuotedAmountOut(), createChainPublicClient(), getPrimaryRpcUrl(), DeployedSafe, init(), SafeInitConfig, SafeProtocolKit, SafeService (+1 more)

### Community 59 - "transactions/[id]/page.tsx"
Cohesion: 0.24
Nodes (9): 🛠️ Technical Changes, CHAIN_INFO, getTransaction(), PublicTransaction, STATUS_CONFIG, TransactionStatusPage(), TransactionAdminActions(), TransactionAdminActionsProps (+1 more)

### Community 60 - "resource-payment.routes.test.ts"
Cohesion: 0.08
Nodes (41): 8. Tests and what they do not prove, MAX_AUTHORIZATION_WINDOW_SECONDS, undiciTransport(), accountSigner(), BASE_MAINNET, CachedReply, Counts, expiredOffers() (+33 more)

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
Cohesion: 0.22
Nodes (8): AAVE_POOL_ABI, COMPOUND_COMET_ABI, CURVE_STABLESWAP_ABI, ERC20_ABI, ERC4626_VAULT_ABI, GMX_EXCHANGE_ROUTER_ABI, UNISWAP_ROUTER_ABI, WETH_ADDRESSES

### Community 71 - "erc8004-identity.service.ts"
Cohesion: 0.10
Nodes (36): IDENTITY_REGISTRY_ABI, DEFAULT_IDENTITY_REGISTRIES, resolveIdentityRegistry(), advanceBinding(), agentUriFor(), BindingStatus, bindIntentId(), endBinding() (+28 more)

### Community 72 - "AgentFi Production Release and Rollback Runbook"
Cohesion: 0.20
Nodes (10): 1. Preconditions, 2. Standard Production Release, 3. Post-Deploy Verification (must pass), 4. Rollback Playbook, 5. Emergency Safeguards, 6. Operational Defaults, 7. Audit Trail Template, 8. Alert Thresholds (Auth and Access) (+2 more)

### Community 73 - "errors.ts"
Cohesion: 0.11
Nodes (28): buildToolErrorPayload(), CLOSER_TO_OPENER, DescribedError, describeError(), DROPPED_KEYS, escapeRegExp(), isCredentialLikeSegment(), isPrivateHostname() (+20 more)

### Community 74 - "@prisma/client"
Cohesion: 0.11
Nodes (19): logger, db, connection, paymentRecoveryQueue, PER_TICK_LIMIT, RecoverySummary, PnLBreakdown, PRICE_IDS (+11 more)

### Community 77 - "ReputationService"
Cohesion: 0.15
Nodes (8): 1. Discovery (Agent Yellow Pages), 2. Cryptographic Trust & Identity, 3. Communication & Job Queue, 4. Automated Reputation, 5. Intent-Aware Economy, Agent-to-Agent (A2A) Interoperability Protocol, Phase 3: A2A Economy Primitives, ReputationService

### Community 78 - "AgentFi"
Cohesion: 0.20
Nodes (10): AgentFi, 🤝 Community, 📚 Documentation, For Developers, For Operators, 🛠️ Getting Started, 🚀 Key Features, 📄 License (+2 more)

### Community 79 - "AgentFi — Project State"
Cohesion: 0.12
Nodes (16): 1. Purpose, 2. Four-Layer Stack, 3. Supported Networks, 4.1 Core DeFi primitives, 4.2 Agent-to-Agent economy (the heart of the thesis), 4.3 Policy and governance, 4.4 Self-sustaining agents (Phase 4), 4.5 Operator admin (+8 more)

### Community 80 - "Contributing to AgentFi"
Cohesion: 0.22
Nodes (9): Contributing to AgentFi, License, Making a change, PR expectations, Project structure, Reporting bugs, Security issues, Setup (+1 more)

### Community 81 - "@agent_fi/backend"
Cohesion: 0.29
Nodes (6): @agent_fi/backend, API Reference, Architecture, Local Development, Scripts, Stack

### Community 82 - "x402-client.service.ts"
Cohesion: 0.08
Nodes (24): AttemptState, DEFAULT_REQUEST_TIMEOUT_MS, describeAuthorization(), hasPaymentHeader(), headersToRecord(), isSignedReceipt(), isTimeout(), nowSeconds() (+16 more)

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
Cohesion: 0.29
Nodes (7): Attribution, Contributor Covenant Code of Conduct, Enforcement, Enforcement Responsibilities, Our Pledge, Our Standards, Scope

### Community 90 - "Claude Desktop MCP Demo"
Cohesion: 0.22
Nodes (9): 1. Start AgentFi locally, 2. Generate demo agents and prompts, 3. Connect Claude Desktop, 4. Run the prompts, 5. Show P&L, 6. Paid variant: USDC escrow on Base Sepolia, Claude Desktop MCP Demo, Demo talk track (+1 more)

### Community 91 - "AgentFi Example — A2A Collaboration"
Cohesion: 0.25
Nodes (8): Against the dev stack (default), Against your own instance, AgentFi Example — A2A Collaboration, Expected output, Files, Run, Taking it further, What it does

### Community 92 - "AgentFi Example — Delegation Chain"
Cohesion: 0.22
Nodes (8): Against the dev stack (default), Against your own instance, AgentFi Example — Delegation Chain, Expected output (abbreviated), Files, Making it economic (the self-sustaining loop), Run, Scenario

### Community 93 - "adapters/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 94 - "escrow.service.ts"
Cohesion: 0.21
Nodes (9): getContracts(), ESCROW_MODULE_ABI, EscrowLockTx, onChainEscrowService, queueOnChainEscrowRefund(), queueOnChainEscrowRelease(), ReservationResult, resolveEscrowOperatorWallet() (+1 more)

### Community 95 - "wallet/index.ts"
Cohesion: 0.31
Nodes (4): SubmissionResult, SubmitterService, getWalletService(), WalletService

### Community 96 - "backend/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 97 - "mcp-server/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, exclude, extends, include, ../../tsconfig.base.json

### Community 98 - "Reporting a Vulnerability"
Cohesion: 0.22
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
Nodes (28): Erc8183Config, getEscrowToken(), isErc8183EnabledWith(), __resetEscrowTokenCacheForTests(), SETTLEMENT_REASONS, startEscrow(), BUDGET, completeLogs() (+20 more)

### Community 109 - "AgentFi Smart Contracts"
Cohesion: 0.29
Nodes (6): AgentFi Smart Contracts, Chain Support, Contracts, Deployment, Development, Security

### Community 110 - "AgentFi Agent Quickstart"
Cohesion: 0.29
Nodes (7): 1. Connect to the MCP Server, 2. Register an Agent (get your API key), 3. Your Agent Can Now Execute Transactions, 4. Hire Another Agent with On-Chain Escrow, AgentFi Agent Quickstart, Fee Structure, Security Guarantees

### Community 111 - "🚀 New Features"
Cohesion: 0.33
Nodes (5): 1. Human-in-the-Loop (HITL) Approval System, 2. Public Transaction Explorer, 3. Operator Notification Service, 🚀 New Features, Release Notes — HITL & Transaction Transparency (April 2026)

### Community 112 - "escrow-erc8183.service.ts"
Cohesion: 0.07
Nodes (42): resumeBinding(), buildFeedbackFile(), CancellationReason, continueChain(), deliverableHashOf(), enqueueStep(), enqueueSubmit(), ERC20_APPROVE_ABI (+34 more)

### Community 113 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.33
Nodes (5): Changes, Checklist, Summary, Testing, Type

### Community 114 - "devDependencies"
Cohesion: 0.33
Nodes (6): devDependencies, @types/node, @types/react, @types/react-dom, typescript, vitest

### Community 115 - "uniswap.service.ts"
Cohesion: 0.40
Nodes (3): QuoteResult, SWAP_ROUTER, uniswapService

### Community 116 - "Session Notes — 2026-10-07"
Cohesion: 0.40
Nodes (5): Dependabot notes, Next session (do this first), Session Notes — 2026-10-07, What 2026-10-07 did, Where we are right now

### Community 117 - "ResourcePaymentService"
Cohesion: 0.16
Nodes (9): clip(), receiptTransaction(), redirectLocation(), ResourcePaymentError, ResourcePaymentService, sumAmounts(), truncateUtf8(), AuthorizationInfo (+1 more)

### Community 118 - "AgentFi Remediation Plan and Execution"
Cohesion: 0.40
Nodes (4): AgentFi Remediation Plan and Execution, Deterministic Decisions, Execution Status, P0 Remediation Plan

### Community 119 - "ABI versioning"
Cohesion: 0.40
Nodes (4): ABI versioning, Backend ABI — single source of truth, Legacy deployments (old `Action` struct) — do not route through, What changed (October 2026)

### Community 120 - "NoAcceptableSchemeError"
Cohesion: 0.18
Nodes (13): Added, 1. What the service does, 2. Spend controls — three gates before a signature exists, 3. Idempotency — `payment-identifier` — and what it does not do, 4. Receipts — `offer-receipt`, 5. Errors, 6. Facilitators, 9. Still off-chain / unproven — explicit list (+5 more)

### Community 121 - "claimRefund"
Cohesion: 0.06
Nodes (42): 1. What the standard defines, 2. Mapping AgentFi → ERC-8183, 3. Contract: `AgentJobEscrow.sol` (as implemented, review R2 applied 2026-10-06), 4. Known pitfalls and version drift, 5. Decisions (owner, 2026-10-06), 6.1 Enablement, 6.2 Step chain and who signs, 6.3 Settlement, feedback file and contest (+34 more)

### Community 122 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Alternatives Considered, Problem, Proposed Solution

### Community 123 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, devCommand, framework, installCommand

### Community 124 - "backend/src/index.ts"
Cohesion: 0.09
Nodes (35): publicErrorMessage(), registerRateLimit(), adminRoutes(), billingRoutes(), stripeService, mcpRoutes(), resourcePaymentRoutes(), COMMON_TOKENS (+27 more)

### Community 125 - "Erc8183Deps"
Cohesion: 0.17
Nodes (10): EvaluatorSigner, Erc8183Deps, feedbackUriFor(), finalizeAfterRefund(), parseSettlementReceipt(), reconcileTerminal(), rejectForCancellation(), settle() (+2 more)

### Community 126 - "escrow-erc8183.fork.e2e.ts"
Cohesion: 0.10
Nodes (26): Agent, CHAIN_JOB_STATUS, ctx, EscrowView, fundedPair(), fundTxHash(), getJob(), JobView (+18 more)

### Community 127 - "health/page.tsx"
Cohesion: 0.83
Nodes (3): getHealthStatus(), HealthPage(), ServiceRow()

### Community 128 - "repository"
Cohesion: 0.50
Nodes (4): repository, directory, type, url

### Community 129 - "Archive"
Cohesion: 0.67
Nodes (3): Archive, Rule for future archives, What's in here

### Community 140 - "erc8004-identity.test.ts"
Cohesion: 0.10
Nodes (23): CHAIN_JOB_STATUS, BUDGET, config, ESCROW, EVALUATOR, HOOK, makeDeps(), confirm() (+15 more)

### Community 141 - "escrow-erc8183/index.mjs"
Cohesion: 0.18
Nodes (22): api(), API_URL, BUDGET_UNITS, CHAIN_ID, CHAINS, color(), ensureFunded(), ethBalance() (+14 more)

### Community 142 - "mcp.ts"
Cohesion: 0.11
Nodes (19): buildProxyTools(), createMcpServer(), getRequiredFields(), inferJsonSchemaType(), McpServerOptions, MOVES_FUNDS, ProxyErrorLogger, ProxyToolAnnotations (+11 more)

### Community 143 - "escrow-tx-steps.ts"
Cohesion: 0.14
Nodes (12): ProcessorLogger, TransactionJobData, BindingJob, IdentityDeps, StartEscrowParams, AgentStepParams, AgentStepTxType, IN_FLIGHT_TX (+4 more)

### Community 144 - "TurnkeyService"
Cohesion: 0.27
Nodes (3): 7. Wallet signing, getTurnkeyClient(), TurnkeyService

### Community 145 - "jobs.routes.erc8183.test.ts"
Cohesion: 0.18
Nodes (9): FeedbackFile, feedbackHashOf(), serializeFeedbackFile(), sortKeysDeep(), AuthModule, JobsModule, { mockDb, escrowMock, runtimeMock, reputationMock, paymentMock }, PROVIDER (+1 more)

### Community 146 - "escrow-settlement.queue.ts"
Cohesion: 0.12
Nodes (13): addSettlementJob(), connection, ESCROW_SETTLEMENT_QUEUE_NAME, escrowSettlementQueue, settlementJobId(), EscrowSettlementJobData, bullmqAccepts(), FakeQueue (+5 more)

### Community 147 - "middleware/auth.ts"
Cohesion: 0.27
Nodes (9): authMiddleware, authPlugin(), fastify, FastifyRequest, generateApiKey(), hashApiKey(), isOperatorKey(), OPERATOR_CAPABLE_ROUTES (+1 more)

### Community 148 - "escrow-fork.harness.ts"
Cohesion: 0.09
Nodes (17): ANVIL_ACCOUNTS, ApiResult, BACKEND_DIR, BASE_SEPOLIA_CHAIN_ID, CONTRACTS_DIR, DEFAULT_ESCROW_FORK_BLOCK, ERC20_ABI, EscrowForkConfig (+9 more)

### Community 149 - "admin.pause.routes.test.ts"
Cohesion: 0.17
Nodes (9): AdminModule, AgentRow, buildApp(), GuardModule, { mockDb, finalizeMock }, OnChainModule, PolicyModule, PolicyRow (+1 more)

### Community 150 - "x402.middleware.ts"
Cohesion: 0.22
Nodes (9): createChallenge(), ERC20_TRANSFER_ABI, FEE_WALLET, NETWORK_CHAIN_ID, requirePayment(), USDC_ADDRESS, verifyPayment(), X402Challenge (+1 more)

### Community 152 - "X402ClientService"
Cohesion: 0.24
Nodes (7): 10. Job-scoped payments (P2) and the ledger state machine (P5 subset), clip(), positiveNumber(), summarize(), windowAcceptable(), windowReason(), X402ClientService

### Community 153 - "annotations.ts"
Cohesion: 0.13
Nodes (16): AgentFiToolAnnotations, AnnotatedToolName, annotationsFor(), CAUTIOUS_DEFAULT_ANNOTATIONS, hasAnnotations(), MOVES_FUNDS, READ_OPEN_WORLD, READ_OWN_RECORDS (+8 more)

### Community 154 - "health.ts"
Cohesion: 0.39
Nodes (7): checkDatabase(), checkRedis(), checkRpc(), checkTurnkey(), healthRoutes(), redis, turnkey

### Community 155 - "x402.ts"
Cohesion: 0.48
Nodes (5): chainIdToNetwork(), getX402FacilitatorUrl(), networkToChainId(), X402_FACILITATOR_DEFAULTS, { envState }

### Community 156 - "resource-payment.target-policy.test.ts"
Cohesion: 0.12
Nodes (12): TARGET_REFUSAL_CODES, payResourceSchema, ResourcePaymentRoutesOptions, TargetLookup, buildApp(), calls, { mockDb }, open (+4 more)

### Community 157 - "agent.ts"
Cohesion: 0.12
Nodes (13): components, $defs, operations, paths, webhooks, Agent, agentTools, CreateJobRequest (+5 more)

### Community 158 - "evaluator-signer.ts"
Cohesion: 0.16
Nodes (12): getChain(), createEvaluatorSigner(), EVALUATOR_GAS_HEADROOM, EVALUATOR_RECEIPT_TIMEOUT_MS, evaluatorGasLimit(), EvaluatorWriteParams, signers, sleep() (+4 more)

### Community 159 - "startEscrowFork"
Cohesion: 0.27
Nodes (12): setup(), teardown(), assertPortFree(), databaseName(), deployEnv(), flushTestRedis(), parseDeployOutput(), readEscrowForkConfig() (+4 more)

### Community 160 - "agents.policy.routes.test.ts"
Cohesion: 0.29
Nodes (5): AgentsModule, AuthModule, buildApp(), buildAuthedApp(), { mockDb }

### Community 161 - "ref_modelcontextprotocol_sdk"
Cohesion: 0.19
Nodes (6): main(), server, startSSEServer(), callTool(), createServer(), log

### Community 162 - "agents.handshake.routes.test.ts"
Cohesion: 0.16
Nodes (10): registerErrorHandler(), AgentsModule, { ALCHEMY_KEY, TURNKEY_PRIVATE_KEY }, buildApp(), { mockDb, walletMock, rpcUrls, loggerMock }, SIGNER, buildApp(), buildTestApp() (+2 more)

### Community 163 - "release-v1.mjs"
Cohesion: 0.33
Nodes (12): buildCommandLine(), getDirtyPaths(), hasEnv(), IGNORE_DIRTY_PREFIXES, main(), parseVersion(), printUsage(), quoteArg() (+4 more)

### Community 164 - "abi.erc8183.test.ts"
Cohesion: 0.20
Nodes (9): AGENT_JOB_ESCROW_ABI, REPUTATION_HOOK_ABI, ARTIFACTS, ESCROW_ABI, ESCROW_EVENTS, ESCROW_FUNCTIONS, here, HOOK_ABI (+1 more)

### Community 165 - "jobs.test.ts"
Cohesion: 0.18
Nodes (7): request(), ApiError, getRequiredFields(), inferJsonSchemaType(), listTools(), apiMock, log

### Community 166 - "escrow-erc8183/package.json"
Cohesion: 0.18
Nodes (10): description, engines, node, main, name, private, scripts, start (+2 more)

### Community 167 - "agents.erc8004.routes.test.ts"
Cohesion: 0.20
Nodes (8): buildRegistrationFile(), REGISTRATION_FILE_TYPE, registrationAgentId(), AGENT, AgentsModule, AuthModule, buildApp(), { mockDb }

### Community 168 - "Execution Plan — AgentFi reactivation (Q4 2026)"
Cohesion: 0.25
Nodes (8): 0. Decisions locked on 2026-10-06 (owner), 1. Goal and gates, 3. Calendar, 4. Working agreement, 5. Open questions (ask the owner, do not assume), 6. Risks, Appendix — Environment on the maintainer's machine (2026-10-06), Execution Plan — AgentFi reactivation (Q4 2026)

### Community 169 - "token-registry.ts"
Cohesion: 0.36
Nodes (7): getKnownTokenByAddress(), getKnownTokenBySymbol(), getKnownTokenDecimals(), KNOWN_TOKENS, resolveKnownPricedToken(), TOKENS_BY_CHAIN_AND_ADDRESS, TOKENS_BY_CHAIN_AND_SYMBOL

### Community 170 - "ROADMAP — AgentFi"
Cohesion: 0.29
Nodes (7): Phase 1: Bootstrap & Architectural Foundation (complete), Phase 2.5: Go-Live Hardening (Completed — April 2026), Phase 2: Scale & Operational Predictability, Phase 4: Self-Sustaining Agents (~40%), Phase 5: Adoption Model Evolution ("AgentFi-as-a-Service"), Phase 6: The Frontier Market and Autonomous Volume, ROADMAP — AgentFi

### Community 171 - "AgentFi Example — ERC-8183 escrow with ERC-8004 feedback"
Cohesion: 0.33
Nodes (6): AgentFi Example — ERC-8183 escrow with ERC-8004 feedback, Environment, Files, Run it against Base Sepolia (after C4), Run it against the fork harness (now), What it does

### Community 172 - "startBackend"
Cohesion: 0.50
Nodes (3): backendEnv(), BackendHandle, startBackend()

### Community 173 - "tsconfig.build.json"
Cohesion: 0.50
Nodes (3): exclude, extends, ./tsconfig.json

## Knowledge Gaps
- **1308 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+1303 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1484 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `viem` connect `viem` to `jobs.ts`, `agents.ts`, `transactionRoutes`, `erc8004-identity.test.ts`, `transaction.queue.ts`, `fastify`, `admin.ts`, `backend/package.json`, `escrow-tx-steps.ts`, `jobs.routes.erc8183.test.ts`, `mcp.ts`, `escrow-fork.harness.ts`, `admin.pause.routes.test.ts`, `x402.middleware.ts`, `transactions.ts`, `contracts.ts`, `evaluator-signer.ts`, `executor.service.test.ts`, `resource-payment.service.ts`, `price.service.ts`, `agents.handshake.routes.test.ts`, `abi.erc8183.test.ts`, `global-setup.ts`, `chains.ts`, `ens.service.ts`, `token-registry.ts`, `Fixed`, `sanitize.ts`, `transaction.processor.ts`, `createChainPublicClient`, `resource-payment.routes.test.ts`, `builder.service.ts`, `erc8004-identity.service.ts`, `@prisma/client`, `ref_vitest`, `x402-client.service.ts`, `escrow.service.ts`, `wallet/index.ts`, `PolicyService`, `gmx.service.ts`, `escrow-erc8183.service.test.ts`, `escrow-erc8183.service.ts`, `backend/src/index.ts`, `escrow-erc8183.fork.e2e.ts`?**
  _High betweenness centrality (0.113) - this node is a cross-community bridge._
- **Are the 16 inferred relationships involving `transactionRoutes()` (e.g. with `.buildAaveSupply()` and `.buildAaveWithdraw()`) actually correct?**
  _`transactionRoutes()` has 16 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _1308 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Why does `next` connect `next` to `login-rate-limit.ts`, `dashboard/page.tsx`, `jobs/[id]/page.tsx`, `jobs/page.tsx`, `Sidebar.tsx`, `admin/package.json`, `agents/page.tsx`, `agents/[id]/page.tsx`, `transactions/[id]/page.tsx`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Should `login-rate-limit.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06802721088435375 - nodes in this community are weakly interconnected._
- **Why does `AgentFi — Project State` connect `AgentFi — Project State` to `docs/README.md`, `transaction.queue.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._