# PROMPT PARA CLAUDE CODE — AgentFi: Infraestrutura de Transações Cripto para Agentes de IA

---

> **IMPORTANTE:** Antes de qualquer implementação, leia [VISION.md](../../VISION.md) por completo. Ele define o propósito, os princípios e a direção de longo prazo do projeto. Todas as decisões técnicas derivam desse documento.

---

## CONTEXTO E VISÃO DO PRODUTO

Você vai construir o **AgentFi**, uma plataforma de infraestrutura financeira projetada exclusivamente para agentes de IA executarem transações em criptomoedas de forma autônoma na rede Ethereum e redes EVM-compatíveis.

**Usuário-alvo:** Agentes de IA (LLMs, sistemas autônomos, bots). Nenhuma interface para humanos será construída além do painel de administração e monitoramento do operador.

**Problema que resolve:** Agentes de IA não têm uma forma segura, estruturada e auditável de executar transações DeFi. Eles precisam de uma API com semântica de alto nível, políticas de segurança programáticas e infraestrutura de carteiras que não exponha chaves privadas.

**Proposta de valor central:** Um agente de IA deve ser capaz de fazer um swap, depositar em lending ou transferir tokens com uma única chamada de tool, sem entender ABI, gas ou calldata — e com garantias de segurança on-chain.

---

## ARQUITETURA GERAL

O sistema é composto por quatro camadas interdependentes que você construirá sequencialmente:

```
┌─────────────────────────────────────────────────┐
│  CAMADA 4 — MCP Server / Agent Interface Layer  │
│  Tools estruturadas que agentes LLM consomem    │
├─────────────────────────────────────────────────┤
│  CAMADA 3 — Backend API                         │
│  Orquestração, simulação, submissão de tx       │
├─────────────────────────────────────────────────┤
│  CAMADA 2 — Smart Contracts (EVM)               │
│  Policy contract + Executor no Safe             │
├─────────────────────────────────────────────────┤
│  CAMADA 1 — Wallet Infrastructure               │
│  MPC wallets via Turnkey + Account Abstraction  │
└─────────────────────────────────────────────────┘
```

---

## STACK TÉCNICO COMPLETO

### Backend
- **Runtime:** Node.js 20+ com TypeScript strict mode
- **Framework:** Fastify (performance sobre Express para volume de requests de agentes)
- **ORM:** Prisma com PostgreSQL
- **Fila de transações:** BullMQ com Redis
- **EVM interaction:** viem (TypeScript-first, mais moderno que ethers.js)
- **Simulação:** Tenderly SDK para simulação pré-execução
- **RPC:** Alchemy (primário) + Infura (fallback)
- **Autenticação de agentes:** API keys com JWT + HMAC para webhooks
- **Monitoramento:** OpenTelemetry + Grafana

### Wallet Infrastructure
- **MPC Wallets:** Turnkey (API para criação e assinatura programática)
- **Account Abstraction:** Safe SDK (ERC-4337 via Safe{Core} Protocol)
- **Paymaster:** Pimlico para gasless transactions (opcional por policy)

### Smart Contracts
- **Linguagem:** Solidity 0.8.24
- **Framework:** Foundry (forge, cast, anvil)
- **Auditabilidade:** NatSpec completo em todos os contratos
- **Testes:** 100% de cobertura nas funções críticas

### MCP Server (Agent Interface)
- **Protocolo:** Model Context Protocol (MCP) via `@modelcontextprotocol/sdk`
- **Transport:** stdio (local) + SSE (hosted)
- **Schema:** Zod para validação de inputs dos agentes

### Infraestrutura
- **Containerização:** Docker + Docker Compose
- **CI/CD:** GitHub Actions
- **Secrets:** HashiCorp Vault ou AWS Secrets Manager
- **Logs estruturados:** Pino
- **Ambiente de teste:** Anvil (fork local do mainnet)

---

## FASE 1 — WALLET INFRASTRUCTURE

### Objetivo
Criar um sistema onde agentes recebem carteiras programáticas com chaves gerenciadas via MPC, sem nunca expor a chave privada completa em nenhum ponto do sistema.

### Implementação Turnkey

```typescript
// src/wallet/turnkey.service.ts
// Implemente integração com Turnkey API para:
// - Criar wallet por agente (createWallet)
// - Assinar transações via API (signTransaction)
// - Listar wallets de um tenant
// - Exportar endereço público sem expor chave
```

**Endpoints a implementar:**
- `POST /wallets` — provisiona nova wallet para um agente
- `GET /wallets/:agentId` — retorna endereço público e saldo
- `DELETE /wallets/:agentId` — desativa wallet (não deleta chave)

### Account Abstraction com Safe

Cada wallet provisionada deve ter um Safe associado com:
- O endereço Turnkey como owner
- Um `AgentPolicyModule` instalado (contrato customizado — ver Fase 2)
- Configuração de threshold: 1/1 para operações dentro da policy

```typescript
// src/wallet/safe.service.ts
// Use Safe{Core} Protocol Kit para:
// - Deploy de Safe com módulo de policy
// - Execução de transações via Safe SDK
// - Verificação de módulos instalados
```

---

## FASE 2 — SMART CONTRACTS

### Contrato 1: AgentPolicyModule.sol

Módulo Safe que define as regras de operação de cada agente. Implemente os seguintes parâmetros configuráveis por Safe:

```solidity
struct AgentPolicy {
    uint256 maxValuePerTx;          // valor máximo em ETH por transação
    uint256 maxDailyVolume;         // volume diário máximo em USD (oracle)
    address[] allowedContracts;     // whitelist de contratos (Uniswap, Aave, etc)
    address[] allowedTokens;        // whitelist de tokens
    uint256 cooldownBetweenTx;      // segundos mínimos entre transações
    bool active;                    // kill switch do operador
}
```

Funções obrigatórias:
- `setPolicy(address safe, AgentPolicy memory policy)` — apenas owner do Safe ou operador
- `validateTransaction(address target, uint256 value, bytes calldata data)` — chamada antes de executar
- `emergencyPause(address safe)` — pausa imediata, apenas owner
- `getPolicy(address safe)` — view function

### Contrato 2: AgentExecutor.sol

Executor atômico para operações compostas (batching). Permite que o agente execute múltiplas ações em uma única transação:

```solidity
struct Action {
    address target;
    uint256 value;
    bytes data;
}

function executeBatch(Action[] calldata actions) external;
function executeWithCheck(
    Action calldata action,
    bytes calldata expectedResultSelector
) external;
```

### Testes (Foundry)

Implemente testes em `test/` para todos os cenários:
- Policy sendo respeitada
- Policy sendo violada (deve reverter)
- Kill switch
- Batch execution atômico
- Fork test com Uniswap V3 real no mainnet fork

### Deploy Script

```bash
# Redes alvo iniciais
# - Ethereum Mainnet
# - Base
# - Arbitrum One
# - Polygon
```

Use `script/Deploy.s.sol` com Foundry. Salve endereços deployados em `deployments/{chainId}.json`.

---

## FASE 3 — BACKEND API

### Estrutura de pastas

```
src/
  api/
    routes/
      agents.ts
      wallets.ts
      transactions.ts
      policies.ts
      health.ts
    middleware/
      auth.ts
      rateLimit.ts
      requestLogger.ts
  services/
    wallet/
      turnkey.service.ts
      safe.service.ts
    transaction/
      builder.service.ts
      simulator.service.ts
      submitter.service.ts
      monitor.service.ts
    defi/
      uniswap.service.ts
      aave.service.ts
      tokens.service.ts
    policy/
      policy.service.ts
  queues/
    transaction.queue.ts
    monitor.queue.ts
  db/
    schema.prisma
    migrations/
  config/
    chains.ts
    contracts.ts
    env.ts
```

### Schema Prisma (banco de dados)

```prisma
model Agent {
  id          String   @id @default(cuid())
  name        String
  apiKey      String   @unique
  walletId    String   @unique
  safeAddress String   @unique
  chainIds    Int[]
  createdAt   DateTime @default(now())
  active      Boolean  @default(true)
  transactions Transaction[]
  policy      AgentPolicy?
}

model AgentPolicy {
  id                String  @id @default(cuid())
  agentId           String  @unique
  agent             Agent   @relation(fields: [agentId], references: [id])
  maxValuePerTxEth  String  // BigInt como string
  maxDailyVolumeUsd String
  allowedContracts  String[]
  allowedTokens     String[]
  cooldownSeconds   Int
  active            Boolean @default(true)
}

model Transaction {
  id          String   @id @default(cuid())
  agentId     String
  agent       Agent    @relation(fields: [agentId], references: [id])
  chainId     Int
  txHash      String?  @unique
  status      TxStatus
  type        TxType
  fromToken   String?
  toToken     String?
  amountIn    String?
  amountOut   String?
  gasUsed     String?
  error       String?
  simulation  Json?
  createdAt   DateTime @default(now())
  confirmedAt DateTime?
}

enum TxStatus {
  PENDING
  SIMULATING
  SUBMITTED
  CONFIRMED
  FAILED
  REVERTED
}

enum TxType {
  SWAP
  TRANSFER
  DEPOSIT
  WITHDRAW
  APPROVE
  BATCH
}
```

### Endpoints da API

**Agents**
```
POST   /v1/agents              — registra novo agente, retorna API key
GET    /v1/agents/:id          — status e configuração do agente
PATCH  /v1/agents/:id/policy   — atualiza policy do agente
DELETE /v1/agents/:id          — desativa agente
```

**Transactions**
```
POST   /v1/transactions/simulate  — simula sem submeter
POST   /v1/transactions/swap      — executa swap
POST   /v1/transactions/transfer  — transfere token ou ETH
POST   /v1/transactions/deposit   — deposita em protocolo (Aave)
POST   /v1/transactions/batch     — executa múltiplas ações atomicamente
GET    /v1/transactions/:id       — status de uma transação
GET    /v1/transactions           — histórico paginado
```

**Wallets**
```
GET    /v1/wallet/balance         — saldo de todos os tokens relevantes
GET    /v1/wallet/address         — endereço da Safe e EOA
GET    /v1/wallet/allowances      — allowances ativas
```

**Health**
```
GET    /health                    — liveness check
GET    /health/ready              — readiness check (DB, Redis, RPC)
```

### Lógica de Transação (fluxo crítico)

Implemente `TransactionOrchestrator` que coordena:

```
1. Recebe request do agente
2. Valida schema com Zod
3. Verifica policy off-chain (antes de ir on-chain)
4. Verifica cooldown do agente no Redis
5. Resolve calldata (Uniswap SDK, Aave SDK, ou calldata bruto)
6. Simula via Tenderly
7. Se simulação falhar → retorna erro com motivo detalhado
8. Enfileira no BullMQ com prioridade
9. Worker pega da fila, assina via Turnkey, submete via Alchemy
10. Monitor acompanha confirmação com retry exponencial
11. Atualiza DB e notifica via webhook (se configurado)
```

### Integração com Protocolos DeFi

**Uniswap V3:**
```typescript
// Use @uniswap/v3-sdk + @uniswap/smart-order-router
// Implemente:
// - getQuote(fromToken, toToken, amountIn, chainId)
// - buildSwapCalldata(quote, slippageTolerance, recipient)
```

**Aave V3:**
```typescript
// Use @aave/contract-helpers
// Implemente:
// - getSupplyCalldata(asset, amount, onBehalfOf)
// - getWithdrawCalldata(asset, amount, to)
// - getUserAccountData(userAddress)
```

---

## FASE 4 — MCP SERVER (INTERFACE PARA AGENTES)

Este é o produto que os agentes consomem. Deve ser um servidor MCP autônomo que um agente LLM pode usar como tool provider.

### Tools a implementar

```typescript
// src/mcp/tools/

// 1. get_wallet_info
// Retorna endereço, saldo ETH e principais tokens ERC-20
{
  name: "get_wallet_info",
  description: "Returns the agent's wallet address and current token balances",
  inputSchema: {
    chain_id: number // optional, default mainnet
  }
}

// 2. get_token_price
// Consulta preço atual de um token
{
  name: "get_token_price",
  description: "Returns the current USD price of a token",
  inputSchema: {
    token_address: string,
    chain_id: number
  }
}

// 3. simulate_swap
// Simula swap e retorna quote + estimativa de gas
{
  name: "simulate_swap",
  description: "Simulates a token swap and returns expected output, price impact and gas estimate. Always call this before execute_swap.",
  inputSchema: {
    from_token: string,  // address ou symbol (ETH, USDC, WBTC)
    to_token: string,
    amount_in: string,   // em unidades do token (ex: "1.5" para 1.5 ETH)
    chain_id: number,
    slippage_tolerance: number  // em % (ex: 0.5 para 0.5%)
  }
}

// 4. execute_swap
// Executa swap após validação
{
  name: "execute_swap",
  description: "Executes a token swap. Requires simulate_swap to have been called first. Returns transaction hash.",
  inputSchema: {
    from_token: string,
    to_token: string,
    amount_in: string,
    chain_id: number,
    slippage_tolerance: number,
    simulation_id: string  // ID retornado pelo simulate_swap
  }
}

// 5. transfer_token
{
  name: "transfer_token",
  description: "Transfers ETH or an ERC-20 token to an address",
  inputSchema: {
    token: string,         // "ETH" ou address do token
    to: string,            // endereço destino
    amount: string,
    chain_id: number
  }
}

// 6. deposit_aave
{
  name: "deposit_aave",
  description: "Supplies an asset to Aave V3 lending protocol to earn yield",
  inputSchema: {
    asset: string,
    amount: string,
    chain_id: number
  }
}

// 7. withdraw_aave
{
  name: "withdraw_aave",
  description: "Withdraws a previously supplied asset from Aave V3",
  inputSchema: {
    asset: string,
    amount: string,  // ou "max" para retirar tudo
    chain_id: number
  }
}

// 8. get_transaction_status
{
  name: "get_transaction_status",
  description: "Returns the current status of a submitted transaction",
  inputSchema: {
    transaction_id: string
  }
}

// 9. get_policy
{
  name: "get_policy",
  description: "Returns the current operational limits and restrictions for this agent",
  inputSchema: {}
}

// 10. get_defi_rates
{
  name: "get_defi_rates",
  description: "Returns current supply and borrow APY rates for major assets on Aave",
  inputSchema: {
    chain_id: number
  }
}
```

### Transports

Implemente dois modos de transport:

**stdio** — para uso local (agente rodando na mesma máquina)
```bash
agentfi-mcp  # comando npm global
```

**SSE (Server-Sent Events)** — para uso remoto
```
GET  /mcp/sse           — stream de eventos
POST /mcp/messages      — envio de mensagens
```

### Autenticação no MCP

Cada agente se autentica com sua API key via header ou env var:
```
AGENTFI_API_KEY=agfi_live_xxxxxxxxxxxx
```

---

## FASE 5 — PAINEL DE ADMINISTRAÇÃO DO OPERADOR

Interface mínima para o operador humano monitorar e gerenciar agentes. Não é voltada para agentes, é para quem opera a infraestrutura.

### Stack
- Next.js 14 App Router
- Tailwind CSS
- shadcn/ui
- Recharts para gráficos

### Páginas

```
/dashboard        — overview: agentes ativos, volume do dia, erros
/agents           — lista de agentes com status e últimas transações
/agents/:id       — detalhe: histórico, policy, wallet, kill switch
/transactions     — log global de todas as transações
/health           — status dos serviços (RPC, DB, Redis, Turnkey)
```

### Funcionalidades críticas
- Kill switch por agente (desativa imediatamente, on-chain e off-chain)
- Visualização de simulações que falharam (com motivo)
- Alertas por email/webhook quando agente excede thresholds
- Exportação de histórico em CSV

---

## FASE 6 — DEVOPS E GO-LIVE

### Docker Compose (desenvolvimento)

```yaml
# docker-compose.yml deve conter:
services:
  api:         # Backend Fastify
  mcp:         # MCP Server
  admin:       # Painel Next.js
  postgres:    # PostgreSQL 16
  redis:       # Redis 7
  anvil:       # Fork local do Ethereum mainnet para testes
```

### Variáveis de Ambiente

```env
# RPC
ALCHEMY_API_KEY=
INFURA_API_KEY=

# Wallet Infrastructure
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
TURNKEY_ORGANIZATION_ID=

# Simulação
TENDERLY_ACCESS_KEY=
TENDERLY_ACCOUNT=
TENDERLY_PROJECT=

# Database
DATABASE_URL=

# Redis
REDIS_URL=

# Contracts (populados após deploy)
POLICY_MODULE_ADDRESS_1=      # mainnet
POLICY_MODULE_ADDRESS_8453=   # base
EXECUTOR_ADDRESS_1=
EXECUTOR_ADDRESS_8453=

# Admin
ADMIN_SECRET=
NEXTAUTH_SECRET=
```

### CI/CD (GitHub Actions)

Implemente três pipelines:

**ci.yml** — em todo PR:
- Lint (ESLint + Prettier)
- Type check (tsc --noEmit)
- Testes unitários
- Forge test (Foundry)

**deploy-staging.yml** — em merge na branch `develop`:
- Build Docker images
- Deploy no ambiente de staging
- Smoke tests contra staging

**deploy-production.yml** — em tag `v*.*.*`:
- Deploy Foundry contracts (se houver mudança)
- Build e push imagens para registry
- Deploy com zero-downtime (rolling update)
- Health check pós-deploy

### Checklist de Go-Live

Implemente um script `scripts/preflight.ts` que verifica automaticamente antes do deploy em produção:

- [ ] Contratos deployados e verificados no Etherscan
- [ ] Variáveis de ambiente todas presentes
- [ ] Conexão com Turnkey ativa
- [ ] RPC primário e fallback respondendo
- [ ] Simulação de transação de teste passando
- [ ] Banco de dados com migrations aplicadas
- [ ] Redis conectado
- [ ] Webhook de alertas funcionando

---

## ESTRATÉGIA DE DISTRIBUIÇÃO PARA AGENTES

O produto não tem marketing para humanos. A distribuição acontece pelos canais onde agentes são configurados e implantados.

### Canal 1 — Registro em Repositórios de MCP Servers

O MCP server deve ser publicado nos diretórios oficiais e da comunidade:

- **MCP.so** — maior diretório de MCP servers. Submeter com categoria "Finance / DeFi".
- **Smithery.ai** — plataforma de descoberta de MCP servers. Priorizar aqui, tem integração direta com Claude Desktop.
- **npm** — publicar `@agentfi/mcp-server` para instalação via npx.
- **GitHub** — repositório público do MCP server com README detalhado para desenvolvedores que configuram agentes manualmente.

A descrição do server deve ser escrita para que um agente LLM entenda o que cada tool faz pelo nome e description — não para que um humano decida instalar.

### Canal 2 — Documentação Otimizada para LLMs

Crie `llms.txt` na raiz do domínio (padrão emergente):

```
# AgentFi

AgentFi provides crypto transaction infrastructure for AI agents on Ethereum and EVM networks.

## Capabilities
- Execute token swaps via Uniswap V3
- Supply and withdraw assets on Aave V3
- Transfer ETH and ERC-20 tokens
- Query wallet balances and DeFi rates
- Monitor transaction status

## Getting Started
To use AgentFi tools, an API key is required (agfi_live_...).
MCP Server: npx @agentfi/mcp-server
Documentation: https://docs.agentfi.xyz
```

Publique também `openapi.json` atualizado do backend API para que agentes que usam function calling diretamente (sem MCP) possam autodiscovery as capabilities.

### Canal 3 — Integração com Frameworks de Agentes

Publique adaptadores e exemplos para os principais frameworks:

**LangChain:**
```python
# pip install agentfi-langchain
from agentfi.langchain import AgentFiToolkit
tools = AgentFiToolkit(api_key="agfi_live_...").get_tools()
```

**LlamaIndex:**
```python
from agentfi.llamaindex import AgentFiToolSpec
```

**Eliza (a16z):**
Criar plugin oficial para o framework Eliza, que é amplamente usado para agentes autônomos em cripto.

**AutoGen (Microsoft):**
Publicar exemplo de integração como agente autônomo financeiro.

### Canal 4 — Infraestrutura de Descoberta Agent-to-Agent

Implemente um endpoint de capability advertisement no formato que agentes usam para descobrir serviços:

```
GET /.well-known/agent.json
```

```json
{
  "name": "AgentFi",
  "description": "Crypto transaction infrastructure for AI agents",
  "version": "1.0.0",
  "capabilities": ["swap", "transfer", "lending", "balance"],
  "networks": [1, 8453, 42161, 137],
  "authentication": "api_key",
  "mcp_endpoint": "https://mcp.agentfi.xyz/sse",
  "openapi": "https://api.agentfi.xyz/openapi.json"
}
```

### Canal 5 — Presença em Comunidades de Desenvolvedores de Agentes

O alvo humano não é o usuário final — é o desenvolvedor que configura agentes. Presença em:

- Discord da Anthropic (canal de tools/MCP)
- Discord do ElizaOS
- Fórum do LangChain
- Threads técnicas no X/Twitter sobre MCP e AI agents
- Artigos no Mirror.xyz sobre infrastructure for autonomous agents

O conteúdo deve ser técnico, voltado para builders, mostrando casos de uso concretos: "Como dar a um agente Claude capacidade de rebalancear um portfólio DeFi autonomamente."

---

## ORDEM DE EXECUÇÃO

Execute as fases nesta sequência exata:

```
1. Setup do repositório e estrutura base
2. Fase 1 — Wallet Infrastructure (Turnkey + Safe)
3. Fase 2 — Smart Contracts (Foundry)
4. Fase 3 — Backend API (Fastify + Prisma + BullMQ)
5. Fase 4 — MCP Server
6. Fase 5 — Painel Admin (Next.js)
7. Fase 6 — DevOps (Docker, CI/CD, preflight)
8. Testes de integração end-to-end com fork mainnet
9. Deploy staging → validação → deploy produção
```

---

## PADRÕES DE QUALIDADE OBRIGATÓRIOS

- TypeScript strict em todo o backend e MCP server
- Nenhuma chave privada aparece em logs, banco de dados ou respostas de API
- Toda transação passa por simulação obrigatória antes de ser submetida
- Erros retornados ao agente devem ser descritivos o suficiente para o LLM tomar uma decisão de retry ou abortar
- Idempotência: endpoints de transação aceitam `idempotency_key` para evitar submissão duplicada
- Rate limiting por API key no nível do Fastify
- Todos os valores monetários trafegam como strings (evita floating point)
- Timestamps em ISO 8601 UTC
- Todos os endereços Ethereum em checksum (EIP-55)

---

## ENTREGÁVEIS FINAIS

Ao final, o repositório deve conter:

```
agentfi/
  packages/
    contracts/       # Foundry project
    backend/         # Fastify API
    mcp-server/      # MCP server publicável no npm
    admin/           # Next.js dashboard
  docker-compose.yml
  docker-compose.prod.yml
  .github/workflows/
  docs/
    architecture.md
    api-reference.md
    agent-quickstart.md   # Como um agente começa a usar em < 5 minutos
    llms.txt
  scripts/
    preflight.ts
    deploy-contracts.ts
```

Toda documentação em `docs/` deve ser escrita pensando que será lida por LLMs buscando entender como usar o sistema — não apenas por desenvolvedores humanos.
