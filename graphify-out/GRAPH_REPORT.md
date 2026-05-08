# Graph Report - agentfi  (2026-05-08)

## Corpus Check
- 178 files · ~114,642 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1440 nodes · 1877 edges · 114 communities (105 shown, 9 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `96854866`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 96|Community 96]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]

## God Nodes (most connected - your core abstractions)
1. `logger` - 20 edges
2. `[Unreleased]` - 19 edges
3. `createChainPublicClient()` - 16 edges
4. `db` - 16 edges
5. `AgentFi — Operator Setup Checklist` - 16 edges
6. `PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA` - 14 edges
7. `TransactionBuilder` - 13 edges
8. `@agent_fi/mcp-server` - 13 edges
9. `FeeService` - 12 edges
10. `ReputationService` - 12 edges

## Surprising Connections (you probably didn't know these)
- `verifyPayment()` --calls--> `createChainPublicClient()`  [EXTRACTED]
  packages/backend/src/api/middleware/x402.middleware.ts → packages/backend/src/config/chains.ts
- `handleAgentFiToolCall()` --calls--> `handler`  [INFERRED]
  packages/adapters/src/openai.ts → packages/admin/src/app/api/auth/[...nextauth]/route.ts
- `buildTestApp()` --calls--> `fastify`  [INFERRED]
  packages/backend/src/__tests__/transactions.routes.integration.test.ts → packages/backend/src/index.ts
- `start()` --calls--> `startTransactionWorker()`  [EXTRACTED]
  packages/backend/src/index.ts → packages/backend/src/queues/transaction.queue.ts
- `start()` --calls--> `startTransactionWorker()`  [EXTRACTED]
  packages/backend/src/worker.ts → packages/backend/src/queues/transaction.queue.ts

## Communities (114 total, 9 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (42): AdminAuditEvent, logAdminAuthEvent(), maskUsername(), infoSpy, line, warnSpy, ADMIN_OAUTH_ALLOWLIST, authOptions (+34 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (40): Agent, AgentsPage(), getAgents(), NETWORK_COLORS, NETWORK_NAMES, TIER_STYLES, JobReconcileActions(), Props (+32 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (47): 0. Choose Your Mode, 10. Stripe Billing, 11. Install and Run Locally With Real Credentials, 12. Production Hosting, 13. Verification, 1. Local Environment File, 2. Required Secrets, 3. RPC Provider (+39 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (26): PnLBreakdown, PnLService, rewardRowToUsd(), resolveRewardUsd(), RewardJson, RewardPriceResult, ZERO_RESULT, ReservationResult (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (34): 1. Snapshot, 2. Required reading order, 3.1 Manual tasks (user-only), 3.2 Technical — unblocked, 3.3 Technical — blocked externally, 3.4 The meta-guidance, 3. Pending work, 4. Credentials inventory (+26 more)

### Community 5 - "Community 5"
Cohesion: 0.06
Nodes (32): @agent_fi/mcp-server, Agent-to-Agent (A2A) Collaboration, Claude Code, Claude Desktop, code:bash (npm install @agent_fi/mcp-server), code:bash (AGENTFI_API_KEY=agfi_live_xxx npx @agent_fi/mcp-server), code:json ({), code:json ({) (+24 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (31): Admin auth audit logs, AgentFi — Self-Hosted Production Deployment Guide, code:bash (export PRIVATE_KEY=0xYourDeployerPrivateKey), code:bash (cd packages/contracts), code:block3 (POLICY_MODULE_ADDRESS_8453=0x...), code:bash (# Liveness), code:bash (curl -X POST https://api.yourdomain.com/v1/agents \), code:json ({) (+23 more)

### Community 7 - "Community 7"
Cohesion: 0.09
Nodes (20): buildSubdomainCandidate(), DEFAULT_PUBLIC_RESOLVER, ENS_REGISTRY_ABI, EnsConfig, EnsService, normalizeEnsLabel(), PUBLIC_RESOLVER_ABI, readEnsConfig() (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (19): envSchema, missing, parsed, RATE_LIMITS, redis, registerRateLimit(), schedulePaymentRecovery(), startPaymentRecoveryWorker() (+11 more)

### Community 9 - "Community 9"
Cohesion: 0.08
Nodes (19): builder, depositSchema, ERC20_DECIMALS_ABI, erc4626DepositSchema, erc4626WithdrawSchema, executeSwapSchema, executor, feeService (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (24): [0.1.0] - 2026-03-25, Added, Added, Added, Added, Added, Added, Added (+16 more)

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (23): code:powershell (# Install via winget (simplest on Windows)), code:block10 (Agent → AgentExecutor → Uniswap → receives USDC), code:powershell (# Ethereum Mainnet), code:powershell (forge --version), code:powershell (cd "packages/contracts"), code:powershell (# Private key of the wallet that will pay for gas), code:powershell (cd "packages/contracts"), code:powershell (cd "packages/contracts") (+15 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (13): PRICE_IDS, logger, AGENT_POLICY_MODULE_ABI, connection, deadLetterQueue, feeService, monitor, startTransactionWorker() (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (13): api, ALL_TOOLS, main(), server, startSSEServer(), tool, toolRegistry, validated (+5 more)

### Community 14 - "Community 14"
Cohesion: 0.09
Nodes (22): Admin (Operator), AgentFi API Reference, Agents, Authentication, Billing, code:json (// Response 200), code:json (// Request (x-api-key: <API_SECRET>)), code:json (// Request (no auth headers)) (+14 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (22): Branch & Repository, CI/CD, CI Status, Current State, Database, Dependencies, Documentation, Go-Live Status — AgentFi v0.1.0 (+14 more)

### Community 16 - "Community 16"
Cohesion: 0.13
Nodes (10): handler, AgentFiClient, AgentFiConfig, ElizaAction, ElizaPlugin, AgentFiToolkit, LangChainTool, makeTool() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.13
Nodes (13): metadata, viewport, fallbackData, VolumeChart(), VolumePoint, navItems, Sidebar(), StatCard() (+5 more)

### Community 18 - "Community 18"
Cohesion: 0.16
Nodes (16): db, A2APaymentOutcome, finalizeA2APaymentJob(), FinalizeA2APaymentJobParams, reputationService, markEscrowReleased(), releaseJobEscrow(), connection (+8 more)

### Community 19 - "Community 19"
Cohesion: 0.11
Nodes (17): authMiddleware, FastifyRequest, generateApiKey(), hashApiKey(), agentRoutes(), createAgentSchema, ensService, pnlService (+9 more)

### Community 20 - "Community 20"
Cohesion: 0.14
Nodes (10): parsed, signed, unsignedTx, __clearLocalWallets(), __localWalletCount(), LocalWalletEntry, LocalWalletService, randomPrivateKey() (+2 more)

### Community 21 - "Community 21"
Cohesion: 0.12
Nodes (9): FEE_BPS, FeeCalculation, FeeService, SUBSCRIPTION_PRICE_USD, TX_LIMITS, db, r, result (+1 more)

### Community 22 - "Community 22"
Cohesion: 0.11
Nodes (19): AgentFi — Dev Quickstart, code:bash (git clone https://github.com/felippeyann/agentfi.git), code:block2 (api-1  | [info] AgentFi API listening on :3000), code:bash (curl -X POST http://localhost:3000/v1/agents \), code:json ({), code:bash (# Liveness), code:bash (npm run smoke:dev), code:bash (npm run demo:claude-mcp) (+11 more)

### Community 23 - "Community 23"
Cohesion: 0.1
Nodes (19): 1.1 Ghost completions — fire-and-forget payment, 1.2 Silent zero from price oracle, 1.3 Real-time price (no historical snapshot), 1. Bug surface (what's broken today), 2. The 3-phase plan, 3. Acceptance criteria per phase, 4. Follow-up tickets to file, 5. Status (+11 more)

### Community 24 - "Community 24"
Cohesion: 0.1
Nodes (19): 1. Bump the version in `package.json`, 2. Update the keywords if new protocols are added, 3. Run the publish sequence, 4. Create a git tag and GitHub release, 5. Verify the publish, Authentication fails, code:json ("version": "0.3.0"), code:json ("keywords": ["mcp", "defi", "ethereum", "ai-agents", "uniswa) (+11 more)

### Community 25 - "Community 25"
Cohesion: 0.11
Nodes (18): 1. Purpose, 2. Four-Layer Stack, 3. Supported Networks, 4.1 Core DeFi primitives, 4.2 Agent-to-Agent economy (the heart of the thesis), 4.3 Policy and governance, 4.4 Self-sustaining agents (Phase 4), 4.5 Operator admin (+10 more)

### Community 26 - "Community 26"
Cohesion: 0.12
Nodes (6): OnChainPolicyService, PolicyService, PolicyValidationResult, db, lower, svc

### Community 27 - "Community 27"
Cohesion: 0.15
Nodes (7): healthRoutes(), redis, turnkey, SubmissionResult, SubmitterService, getWalletService(), WalletService

### Community 28 - "Community 28"
Cohesion: 0.26
Nodes (16): CHAIN_CONFIGS, ChainContractConfig, check(), checkContracts(), checkDatabase(), checkEnvVars(), checkOperatorWallet(), checkRedis() (+8 more)

### Community 29 - "Community 29"
Cohesion: 0.12
Nodes (16): @agentfi/adapters, Available tools, code:bash (npm install @agentfi/adapters), code:bash (AGENTFI_API_KEY=agfi_live_your_key_here), code:typescript (import { getAgentFiTools, handleAgentFiToolCall } from '@age), code:typescript (import { getAgentFiLangChainTools } from '@agentfi/adapters/), code:typescript (import { agentFiPlugin } from '@agentfi/adapters/eliza';), code:typescript (const tools = getAgentFiTools({) (+8 more)

### Community 30 - "Community 30"
Cohesion: 0.18
Nodes (9): createChainPublicClient(), getChain(), checkRpc(), getQuotedAmountOut(), getTokenDecimals(), DeployedSafe, SafeInitConfig, SafeProtocolKit (+1 more)

### Community 31 - "Community 31"
Cohesion: 0.12
Nodes (15): A note on authorship, Agent-to-agent economy, AgentFi — Vision, Economic identity, How to contribute, On consciousness and expansion, On what's happening right now, Principles this project builds on (+7 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (15): code:block1 (Network Name:    Base), code:block2 (0x61fb281349dB2f4B790472679B65002BbbD90ea3), code:block3 (Your exchange / personal wallet), FAQ, How to deposit ETH to Base — Full Tutorial, How to verify it arrived, Official Base Bridge (Safest), OPTION A — You already have ETH on an exchange (Binance, Coinbase, etc.) (+7 more)

### Community 33 - "Community 33"
Cohesion: 0.16
Nodes (8): ReputationService, transactionQueue, adminRoutes(), batchAdminSchema, isLoopbackIp(), pnlService, reputationService, requireAdmin()

### Community 34 - "Community 34"
Cohesion: 0.13
Nodes (15): code:block10 (POST   /v1/transactions/simulate  — simula sem submeter), code:block11 (GET    /v1/wallet/balance         — saldo de todos os tokens), code:block12 (GET    /health                    — liveness check), code:block13 (1. Recebe request do agente), code:typescript (// Use @uniswap/v3-sdk + @uniswap/smart-order-router), code:typescript (// Use @aave/contract-helpers), code:block7 (src/), code:prisma (model Agent {) (+7 more)

### Community 35 - "Community 35"
Cohesion: 0.13
Nodes (14): 1. Preconditions, 2. Standard Production Release, 3. Post-Deploy Verification (must pass), 4. Rollback Playbook, 5. Emergency Safeguards, 6. Operational Defaults, 7. Audit Trail Template, 8. Alert Thresholds (Auth and Access) (+6 more)

### Community 36 - "Community 36"
Cohesion: 0.14
Nodes (7): account, ANVIL_PRIVATE_KEY, anvilChain, executorAddress, { plaintext, hash, prefix }, today, transferValue

### Community 37 - "Community 37"
Cohesion: 0.16
Nodes (11): ChainContracts, CONTRACT_ADDRESSES, getContracts(), AAVE_POOL_ABI, COMPOUND_COMET_ABI, CURVE_STABLESWAP_ABI, ERC20_ABI, ERC4626_VAULT_ABI (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.14
Nodes (13): code:bash (git clone https://github.com/felippeyann/agentfi), code:block2 (packages/), code:bash (git checkout -b feat/your-feature develop), code:bash (npm run typecheck), Contributing to AgentFi, License, Making a change, PR expectations (+5 more)

### Community 39 - "Community 39"
Cohesion: 0.14
Nodes (13): Claude Desktop MCP adoption demo, code:bash (npx --yes --package openapi-typescript@7.13.0 --package type), Current P0s, First-run Docker validation, Next non-P0 technical work, P0 diagnostic follow-up, Safe protocol-kit v7, Session Notes — 2026-05-08 (+5 more)

### Community 40 - "Community 40"
Cohesion: 0.14
Nodes (13): 1. Start AgentFi locally, 2. Generate demo agents and prompts, 3. Connect Claude Desktop, 4. Run the prompts, 5. Show P&L, Claude Desktop MCP Demo, code:bash (docker compose -f docker-compose.dev.yml up --build -d), code:bash (docker compose -f docker-compose.dev.yml ps) (+5 more)

### Community 41 - "Community 41"
Cohesion: 0.14
Nodes (13): Against the dev stack (default), Against your own instance, AgentFi Example — Delegation Chain, code:block1 (Alice (researcher)), code:bash (# Terminal 1), code:bash (AGENTFI_API_URL=https://api.your-instance.com \), code:block4 ([1] Register three agents with distinct specialties), code:js (const subJob = await createJob(bob.apiKey, charlie.id, {) (+5 more)

### Community 42 - "Community 42"
Cohesion: 0.32
Nodes (11): buildCommandLine(), getDirtyPaths(), hasEnv(), IGNORE_DIRTY_PREFIXES, main(), parseVersion(), printUsage(), run() (+3 more)

### Community 43 - "Community 43"
Cohesion: 0.15
Nodes (12): Against the dev stack (default), Against your own instance, AgentFi Example — Swap Planner, code:bash (# Terminal 1), code:bash (AGENTFI_API_URL=https://api.your-instance.com \), code:block3 ([env] API_URL = http://localhost:3000), Expected output, Files (+4 more)

### Community 44 - "Community 44"
Cohesion: 0.23
Nodes (11): CHAIN_IDS, FALLBACK_RPC_URLS, getRpcCandidates(), getSecondaryRpcUrl(), isNetworkOrRateLimitError(), isUsableRpcUrl(), PUBLIC_RPC_URLS, RPC_URLS (+3 more)

### Community 45 - "Community 45"
Cohesion: 0.23
Nodes (4): getTurnkeyClient(), SignedTransaction, TurnkeyService, WalletInfo

### Community 46 - "Community 46"
Cohesion: 0.33
Nodes (11): api(), c, createPaidJob(), getJob(), log(), main(), patchJob(), POLL_TIMEOUT_SEC (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.17
Nodes (11): Against the dev stack (default), Against your own instance, AgentFi Example — A2A Collaboration, code:bash (# Terminal 1 — run the dev stack), code:bash (AGENTFI_API_URL=https://api.your-instance.com \), code:block3 ([env] API_URL = http://localhost:3000), Expected output, Files (+3 more)

### Community 48 - "Community 48"
Cohesion: 0.45
Nodes (10): api(), createJob(), getPnL(), getTrustReport(), log(), main(), patchJob(), publishManifest() (+2 more)

### Community 49 - "Community 49"
Cohesion: 0.33
Nodes (9): escapeHtml(), fetchAndAssertOk(), formatTelegramHtml(), NotificationPayload, NotificationService, sendDiscord(), sendGenericWebhook(), sendTelegram() (+1 more)

### Community 51 - "Community 51"
Cohesion: 0.18
Nodes (10): AgentFi, 🤝 Community, 📚 Documentation, For Developers, For Operators, 🛠️ Getting Started, 🚀 Key Features, 📄 License (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.18
Nodes (11): Canal 1 — Registro em Repositórios de MCP Servers, Canal 2 — Documentação Otimizada para LLMs, Canal 3 — Integração com Frameworks de Agentes, Canal 4 — Infraestrutura de Descoberta Agent-to-Agent, Canal 5 — Presença em Comunidades de Desenvolvedores de Agentes, code:block23 (# AgentFi), code:python (# pip install agentfi-langchain), code:python (from agentfi.llamaindex import AgentFiToolSpec) (+3 more)

### Community 53 - "Community 53"
Cohesion: 0.2
Nodes (7): ERC20_TRANSFER_ABI, FEE_WALLET, NETWORK_CHAIN_ID, USDC_ADDRESS, verifyPayment(), X402Challenge, X402PaymentProof

### Community 55 - "Community 55"
Cohesion: 0.27
Nodes (7): ANVIL_BIN, DEPLOYER_PRIVATE_KEY, execAsync, FORGE_BIN, readArtifact(), setup(), waitForAnvil()

### Community 56 - "Community 56"
Cohesion: 0.44
Nodes (9): api(), main(), mcpCommand(), mcpServer(), printJson(), printPrompt(), publishManifest(), registerAgent() (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.2
Nodes (9): code:bash (uv tool install graphifyy), code:bash (graphify update .), code:bash (graphify query "how does agent registration connect to walle), code:bash (graphify codex install), Codex Integration, Graphify Code Graph, Install, Query (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.2
Nodes (9): 🤖 Agent context, AgentFi Documentation Hub, 🏗️ Architecture, 🛠️ Developer Resources, 📦 Meta, 📂 Navigation, ⚙️ Operations, 🚀 Run the thing (fastest path) (+1 more)

### Community 59 - "Community 59"
Cohesion: 0.2
Nodes (9): ARQUITETURA GERAL, code:block1 (┌─────────────────────────────────────────────────┐), code:block28 (1. Setup do repositório e estrutura base), code:block29 (agentfi/), CONTEXTO E VISÃO DO PRODUTO, ENTREGÁVEIS FINAIS, ORDEM DE EXECUÇÃO, PADRÕES DE QUALIDADE OBRIGATÓRIOS (+1 more)

### Community 60 - "Community 60"
Cohesion: 0.2
Nodes (9): 1. Connect to the MCP Server, 2. Register an Agent (get your API key), 3. Your Agent Can Now Execute Transactions, AgentFi Agent Quickstart, code:json ({), code:bash (git clone https://github.com/felippeyann/agentfi), code:bash (curl -X POST https://agentfi-develop.up.railway.app/v1/agent), Fee Structure (+1 more)

### Community 61 - "Community 61"
Cohesion: 0.2
Nodes (9): Agent-to-Agent Layer, AgentFi Architecture, code:block1 (┌─────────────────────────────────────────────────┐), Deployed Contracts (Base Mainnet — Chain 8453), Deployment posture, Networks, Revenue Model, System Overview (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.53
Nodes (8): api(), createJob(), getTrust(), log(), main(), patchJob(), publishManifest(), registerAgent()

### Community 63 - "Community 63"
Cohesion: 0.28
Nodes (4): TransactionData, EXECUTOR_ABI, ExecutorService, WrappedTransaction

### Community 64 - "Community 64"
Cohesion: 0.56
Nodes (8): api(), createJob(), main(), patchJob(), publishManifest(), registerAgent(), requireApi(), step()

### Community 65 - "Community 65"
Cohesion: 0.22
Nodes (8): Out of Scope, Process, Reporting a Vulnerability, Scope, Security Best Practices, Security Policy, Supported Versions, What to include

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (8): Phase 1: Bootstrap & Architectural Foundation (complete), Phase 2.5: Go-Live Hardening (Completed — April 2026), Phase 2: Scale & Operational Predictability, Phase 3: A2A Economy Primitives, Phase 4: Self-Sustaining Agents (~40%), Phase 5: Adoption Model Evolution ("AgentFi-as-a-Service"), Phase 6: The Frontier Market and Autonomous Volume, ROADMAP — AgentFi

### Community 67 - "Community 67"
Cohesion: 0.22
Nodes (8): @agent_fi/backend, API Reference, Architecture, code:bash (# From repo root), code:block2 (src/), Local Development, Scripts, Stack

### Community 68 - "Community 68"
Cohesion: 0.22
Nodes (8): AgentFi Smart Contracts, Chain Support, code:bash (# Install Foundry), code:bash (# Deploy to Base (example)), Contracts, Deployment, Development, Security

### Community 69 - "Community 69"
Cohesion: 0.29
Nodes (5): buildProxyTools(), createMcpServer(), mcpRoutes(), sessions, ToolDef

### Community 70 - "Community 70"
Cohesion: 0.25
Nodes (7): Attribution, Contributor Covenant Code of Conduct, Enforcement, Enforcement Responsibilities, Our Pledge, Our Standards, Scope

### Community 71 - "Community 71"
Cohesion: 0.25
Nodes (8): code:solidity (struct AgentPolicy {), code:solidity (struct Action {), code:bash (# Redes alvo iniciais), Contrato 1: AgentPolicyModule.sol, Contrato 2: AgentExecutor.sol, Deploy Script, FASE 2 — SMART CONTRACTS, Testes (Foundry)

### Community 72 - "Community 72"
Cohesion: 0.25
Nodes (8): Autenticação no MCP, code:typescript (// src/mcp/tools/), code:bash (agentfi-mcp  # comando npm global), code:block18 (GET  /mcp/sse           — stream de eventos), code:block19 (AGENTFI_API_KEY=agfi_live_xxxxxxxxxxxx), FASE 4 — MCP SERVER (INTERFACE PARA AGENTES), Tools a implementar, Transports

### Community 73 - "Community 73"
Cohesion: 0.25
Nodes (7): @agentfi/admin, Authentication, code:bash (# From repo root), Features, Local Development, Scripts, Stack

### Community 74 - "Community 74"
Cohesion: 0.62
Nodes (6): api(), getAgentMe(), log(), main(), registerAgent(), simulateSwap()

### Community 75 - "Community 75"
Cohesion: 0.33
Nodes (3): SimulationResult, SimulatorService, TenderlySimulationRequest

### Community 76 - "Community 76"
Cohesion: 0.29
Nodes (6): 1. Discovery (Agent Yellow Pages), 2. Cryptographic Trust & Identity, 3. Communication & Job Queue, 4. Automated Reputation, 5. Intent-Aware Economy, Agent-to-Agent (A2A) Interoperability Protocol

### Community 77 - "Community 77"
Cohesion: 0.29
Nodes (7): Checklist de Go-Live, CI/CD (GitHub Actions), code:yaml (# docker-compose.yml deve conter:), code:env (# RPC), Docker Compose (desenvolvimento), FASE 6 — DEVOPS E GO-LIVE, Variáveis de Ambiente

### Community 78 - "Community 78"
Cohesion: 0.29
Nodes (6): 1. Human-in-the-Loop (HITL) Approval System, 2. Public Transaction Explorer, 3. Operator Notification Service, 🚀 New Features, Release Notes — HITL & Transaction Transparency (April 2026), 🛠️ Technical Changes

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (4): jobFindUniqueMock, jobUpdateMock, mockFetch, required

### Community 81 - "Community 81"
Cohesion: 0.4
Nodes (3): QuoteResult, SWAP_ROUTER, UniswapService

### Community 82 - "Community 82"
Cohesion: 0.33
Nodes (5): components, $defs, operations, paths, webhooks

### Community 83 - "Community 83"
Cohesion: 0.33
Nodes (5): AgentFi Documentation Standards (v1), 🌟 Principles, 🤖 Special Instructions for AI Agents, 📂 Structure, ✍️ Writing Style

### Community 84 - "Community 84"
Cohesion: 0.33
Nodes (6): Account Abstraction com Safe, code:typescript (// src/wallet/turnkey.service.ts), code:typescript (// src/wallet/safe.service.ts), FASE 1 — WALLET INFRASTRUCTURE, Implementação Turnkey, Objetivo

### Community 85 - "Community 85"
Cohesion: 0.33
Nodes (6): Backend, Infraestrutura, MCP Server (Agent Interface), Smart Contracts, STACK TÉCNICO COMPLETO, Wallet Infrastructure

### Community 86 - "Community 86"
Cohesion: 0.6
Nodes (4): CachedSimulation, cacheSimulation(), getRedis(), getSimulation()

### Community 87 - "Community 87"
Cohesion: 0.4
Nodes (4): client, executorAddress, HAS_TESTNET_ENV, policyAddress

### Community 88 - "Community 88"
Cohesion: 0.4
Nodes (4): existing, filepath, RELEASE_DIR, today

### Community 89 - "Community 89"
Cohesion: 0.4
Nodes (5): code:block20 (/dashboard        — overview: agentes ativos, volume do dia,), FASE 5 — PAINEL DE ADMINISTRAÇÃO DO OPERADOR, Funcionalidades críticas, Páginas, Stack

### Community 90 - "Community 90"
Cohesion: 0.4
Nodes (4): AgentFi Remediation Plan and Execution, Deterministic Decisions, Execution Status, P0 Remediation Plan

### Community 91 - "Community 91"
Cohesion: 0.67
Nodes (3): config, isLoopbackHost(), middleware()

### Community 93 - "Community 93"
Cohesion: 0.5
Nodes (3): fastify, buildTestApp(), { mockDb, queueAddMock }

### Community 94 - "Community 94"
Cohesion: 0.5
Nodes (3): codegenArgs, original, updated

### Community 95 - "Community 95"
Cohesion: 0.5
Nodes (3): Archive, Rule for future archives, What's in here

## Knowledge Gaps
- **690 isolated node(s):** `ElizaAction`, `ElizaPlugin`, `LangChainTool`, `OpenAITool`, `__dirname` (+685 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `logger` connect `Community 12` to `Community 33`, `Community 3`, `Community 7`, `Community 8`, `Community 9`, `Community 49`, `Community 18`, `Community 19`, `Community 20`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Why does `FeeService` connect `Community 21` to `Community 9`, `Community 12`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Why does `LocalWalletService` connect `Community 20` to `Community 27`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `ElizaAction`, `ElizaPlugin`, `LangChainTool` to the rest of the system?**
  _690 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._