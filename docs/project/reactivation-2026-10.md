# Dossiê de Retomada — AgentFi (06/10/2026)

> Revisão completa do projeto (código, branches, infra, distribuição, notas de setembro) e síntese da pesquisa de mercado, para decidir e organizar a volta ao trabalho. Pesquisa de mercado detalhada e fontes em [market-signals-2026-10.md](market-signals-2026-10.md).
>
> Documento em português por ser material de decisão do mantenedor. A documentação pública do repositório (README, STATE, HANDOFF, docs/) segue em inglês e **não foi alterada** nesta sessão: o banner "Archived" continua lá até você decidir.

**Baseline verificado:** `main` = `7585f5f` (17/05/2026, PR #119, arquivamento). Nenhum commit desde então.

---

## 0. Veredito em cinco linhas

1. **Sua leitura do mercado está certa do lado da oferta.** Entre julho e outubro de 2026, Coinbase, Stripe/Tempo, Visa, Mastercard, AWS, Cloudflare, Circle e a Ethereum Foundation convergiram exatamente na tese do VISION.md: agentes com carteira, limite de gasto, identidade on-chain e pagamentos em stablecoin via x402/MPP.
2. **A parte genérica do AgentFi virou commodity.** Carteira MPC + política de gasto + kill switch hoje vêm de graça da Coinbase (Agentic Wallets), MetaMask (Agent Wallet GA em 06/08), AWS (AgentCore Payments GA em 18/08) e Circle. Não vale reconstruir essa camada.
3. **A demanda real ainda é pequena e mal medida.** A TRM Labs estima que só 0,6%–7,5% do valor no x402 vem de agentes de verdade. Vários projetos "economia de agentes" morreram (elizaOS, Giza, Almanak) ou definharam (Virtuals ACP v1, Olas).
4. **O espaço que sobrou é exatamente o que o AgentFi já tem de mais específico:** escrow agente-a-agente (agora padronizado como ERC-8183), reputação ancorada em prova de interação (a lacuna que os papers sobre ERC-8004 apontam) e execução DeFi via MCP para Claude e Codex. Reposicionar como **camada de confiança sobre trilhos de terceiros**, não como mais uma carteira.
5. **O código está vivo, mas não está pronto para demo.** Typecheck passa, contratos continuam na Base, npm continua publicado. Mas há seis defeitos conhecidos de prioridade alta (ABI incompatível com o contrato, simulação fictícia aceita em produção, agente pode relaxar a própria política, entre outros) e o `npm ci` em clone limpo estava quebrado desde maio. Nada disso é grande; tudo precisa ser fechado antes de mostrar o projeto a alguém.

**Recomendação:** retomada restrita e com gates (opção B na §6), começando por uma semana de housekeeping e um mês de validação de demanda. Não expandir funcionalidades sem um operador externo com problema concreto.

---

## 1. Estado do projeto, verificado hoje

### 1.1 Repositório e distribuição

| Item | Estado em 06/10/2026 |
|---|---|
| GitHub `felippeyann/agentfi` | **Arquivado (read-only).** 1 star, 0 forks, 0 issues abertas (10 fechadas), **10 PRs Dependabot abertos** (11/05). Para fazer push é preciso desarquivar primeiro. |
| CI | Último run em `main` (push do arquivamento) foi **cancelado**; o run do PR #119 passou. `e2e-testnet-smoke` falha diariamente por design (sem secrets). |
| npm `@agent_fi/mcp-server` | 0.5.0 publicado em 15/05/2026. Downloads por mês: abr 389, mai 440, jun 128, jul 93, ago 70, set 83 (total 1.204; últimos 30 dias 75). Os picos coincidem com publishes, ou seja, são bots de registries, não usuários. |
| Fly.io backend (`agentfi-backend.fly.dev`) | Fora do ar (sem resposta), conforme decommission. |
| Admin Vercel (`agentfi-admin.vercel.app`) | HTTP 403. |
| Landing `agentfi.cc` | Responde 307 (redirect). O repo `felippeyann/agentfi-landing` citado no HANDOFF **não existe mais** no GitHub. |
| Contratos Base Mainnet | `AgentPolicyModule 0x03af…6A6d` e `AgentExecutor 0x5441…24b3` continuam com bytecode on-chain (confirmado via `eth_getCode` hoje). `EscrowModule` nunca foi deployado. |
| Diretórios MCP | Glama: listagem no ar (200). mcp.so: **404**. awesome-mcp-servers: PR #5091 foi **mergeado em 27/05/2026** (dez dias depois do arquivamento), mas a entrada **já foi removida**: o README atual e a busca de código do GitHub não contêm "agentfi" nem "felippeyann". Listas "awesome" costumam podar repositórios arquivados; desarquivar e reenviar o PR. |
| Vault `brain/` | AgentFi está fora do escopo do vault desde 16/09/2026. Notas de trabalho em `C:\Users\AAWZ 360\agentfi-notas`. |

### 1.2 Código e toolchain

| Item | Estado |
|---|---|
| Tamanho | backend 64 arquivos / 14,4 mil linhas · mcp-server 10 / 4,3 mil · admin 37 / 3,1 mil · adapters 4 / 532 · contratos 3 `.sol` / 680 linhas + 6 arquivos de teste / 1,8 mil · 13 migrations Prisma · 31 tools MCP · 15 arquivos de teste unitário + 4 E2E |
| `npm run typecheck` (4 workspaces) | **Passa** hoje em Node 24.14.1 |
| `npm ci` em clone limpo | **Estava quebrado desde 15/05**: o PR #117 subiu `mcp-server` para 0.5.0 sem regenerar o `package-lock.json`. Qualquer `npm ci` (CI, Dockerfile.admin, novo clone) falhava com `EUSAGE`. **Corrigido nesta sessão** com `npm install --package-lock-only` (4 linhas de diff; `@types/react` 18.3.28→18.3.31 e `@agent_fi/mcp-server` 0.4.0→0.5.0 no lock). Isso significa que o "quickstart em 3 minutos" não funcionava para ninguém que clonasse o repo nos últimos cinco meses. |
| Docker dev stack (`docker-compose.dev.yml`) | **Sobe e passa** depois do lock corrigido: 5 serviços healthy, `npm run smoke:dev` OK, os três exemplos OK (ver §1.4). |
| Foundry (`forge`) | **Não instalado nesta máquina.** Contratos não compilam nem testam localmente até instalar. |
| `.claude/launch.json` | Aponta para `C:/Users/felip/OneDrive/...` (máquina anterior). Quebrado nesta máquina; precisa de paths relativos. |
| Node / Docker | Node 24.14.1 e npm 11.11 locais; projeto pede Node ≥20, CI usa 22, Dockerfiles usam `node:20-alpine`. Docker 29.8.1 funcionando. |
| Grafo `graphify-out/` | Construído em `1869bbc` (anterior ao HEAD). `graphify` não está instalado; o `AGENTS.md` pede atualização após mudanças de código. |

### 1.3 Branches, PRs e pastas irmãs

**Locais (limpas nesta sessão):** apaguei com `git branch -d` (só funciona se já mergeada) quatro branches locais já em `main`: `chore/session-notes-2026-05-07`, `feat/phase-3-4-escrow-revenue-gmx`, `chore/mcp-server-0.5.0`, `docs/session-notes-2026-05-15`. Restam `main` e `develop`.

**Remotas (18, nenhuma com trabalho perdido):**
- 6 branches de feature/docs **já mergeadas** e sem commits únicos: `chore/glama-distribution-checks`, `chore/mcp-server-0.5.0`, `docs/post-0.4.0-publish-state`, `docs/session-notes-2026-05-10`, `docs/session-notes-2026-05-15`, `fix/stale-backend-urls`. Podem ser apagadas no remoto após desarquivar.
- `develop`: 8 commits atrás de `main`, 0 à frente. Espelho desatualizado; sincronizar ou apagar.
- 10 branches `dependabot/*` (11/05/2026), cada uma com 1 commit. Majors que exigem cuidado: `@turnkey/sdk-server` 1.7→6.0, `prisma` 5.22→7.8, `eslint` 8→10, `dotenv-cli` 7→11, `@types/node` 20→25. Minors de baixo risco: `@aave/*` 1.38, `bullmq` 5.76.7, `lucide-react` 1.14, grupo `production-dependencies` (3 pacotes). Sugestão: fechar todas, deixar o Dependabot reabrir contra o lock corrigido e mergear os minors em lote.
- Branches `chore/archive-project` e `feat/phase-3-4-escrow-revenue-gmx` já foram apagadas no remoto (o `fetch --prune` de hoje limpou as referências).

**Pastas irmãs em `C:\Users\AAWZ 360\`:**

| Pasta | Conteúdo | Ação sugerida |
|---|---|---|
| `agentfi-fix-73`, `-74`, `-75`, `-81`, `-notify`, `agentfi-gmx`, `agentfi-phase2-snapshots` | Vazias (só `node_modules`, 36 KB). Restos de worktrees de maio. Não são repositórios git. | Apagar |
| `agentfi-lab` | Laboratório x402 de setembro (14/14 testes, settlement falso, ledger SQLite). Vivo e reproduzível. | Manter; é o protótipo de "orçamento por tarefa" |
| `agentfi-notas` | Duas notas de setembro (revisão crítica de 08/09 e comparação de pagamentos de 10/09). **Leitura obrigatória** antes de codar. | Manter |

**Arquivos soltos na raiz do repo:** `001.png` a `005-mapa_completo.png` (17/09/2026), untracked. São renderizações do diagrama de arquitetura (Execution & DeFi, On-chain, Backend runtime, Jobs & Persistence, mapa completo). Sugestão: mover para `docs/architecture/diagrams/` e referenciar no overview, ou apagar.

### 1.4 Validação do stack zero-credencial nesta sessão

Executado em 06/10/2026, Docker 29.8.1, imagens construídas do zero (sem volumes prévios):

| Passo | Resultado |
|---|---|
| `docker compose -f docker-compose.dev.yml up --build -d` (lock original) | **Falhou** na imagem `admin`: `npm ci` com `EUSAGE` (lock dessincronizado, ver D1/D2) |
| Mesmo comando após `npm install --package-lock-only` | Primeira tentativa falhou em `prisma generate` na imagem `api` (transitório; o rebuild isolado passou e gerou o client v5.22.0). Segunda subida: **5/5 serviços healthy em ~20 s** (postgres, redis, api, admin, mcp) |
| `GET /health` | `{"status":"ok"}` |
| `npm run smoke:dev` | **Passou** (health, 2 registros, lookup autenticado, manifesto + busca, job A2A sem reward, trust report + P&L) |
| `node examples/a2a-collab/index.mjs` | **Passou** (fluxo A2A ponta a ponta) |
| `node examples/swap-planner/index.mjs` | **Passou** (calldata Uniswap V3 construída; simulação **mockada** em dev, confirma A2) |
| `node examples/delegation-chain/index.mjs` | **Passou** (Alice → Bob → Charlie) |

Conclusão: o caminho "clone → `docker compose up` → exemplos" volta a funcionar com a correção de uma linha no lock. O stack foi parado ao final (`docker compose down`, volumes preservados); para subir de novo as imagens já estão construídas.

---

## 2. O que o AgentFi é (resumo de dez linhas)

Infraestrutura de transações cripto para agentes de IA, Apache-2.0, self-hosted. Quatro camadas: (1) carteiras Turnkey MPC + Safe por agente; (2) contratos `AgentPolicyModule` (validação on-chain por Safe), `AgentExecutor` (batch + fee atômica em bps) e `EscrowModule` (custódia A2A, não deployado); (3) backend Fastify 5 + Prisma + BullMQ com política off-chain, simulação Tenderly, fila, worker, monitor, fee, escrow v2/v3, reputação com time-decay, P&L com gas, ENS, revenue sharing para operadores; (4) servidor MCP com 31 tools (swaps Uniswap/Curve, Aave, Compound, ERC-4626, GMX, transfers, A2A jobs, manifesto, trust report, handshake, P&L). Quatro chains EVM (Ethereum, Base, Arbitrum, Polygon). Três exemplos executáveis e um quickstart Docker sem credenciais. Cinquenta e três dias de desenvolvimento intenso (mar–mai/2026), zero usuários externos confirmados.

---

## 3. Defeitos e dívidas conhecidos (revisão de setembro, reconfirmados no código hoje)

A revisão crítica de 08–10/09/2026 (Codex, em `agentfi-notas/`) levantou os itens abaixo. Hoje reli o código nos pontos citados e confirmo os que estão marcados.

| # | Achado | Onde | Prioridade | Confirmado hoje |
|---|---|---|---|---|
| A1 | **Fonte Solidity divergiu do contrato deployado e do backend.** O wrapper codifica `Action(target, value, data)`; o `.sol` atual define `Action(target, value, token, data)`. Hoje verifiquei o bytecode do `AgentExecutor` na Base: ele expõe os seletores `0x34fcd5be`/`0xa60e5271` (versão **sem** `token`), ou seja, **o backend bate com o contrato deployado; é o código-fonte no repo que mudou** (commit `e0c8025`, 06/04/2026, "A2A interoperability") sem redeploy e sem atualizar o backend. Consequência: os 1,8 mil linhas de testes Foundry testam um contrato que não está em produção, e qualquer redeploy a partir da fonte atual quebra o backend. Decidir qual é a verdade (provavelmente a fonte nova, com redeploy junto do EscrowModule) e gerar o ABI do backend a partir do artefato compilado. | `executor.service.ts:31-34, 48-51` vs `AgentExecutor.sol:45-50`; bytecode em `0x5441…24b3` | P1 | Sim (bytecode on-chain) |
| A2 | **Simulação fictícia aceita em produção.** Sem variáveis Tenderly o serviço devolve `success: true, _isMock: true`; nenhuma rota verifica `_isMock`; a validação de env em produção não exige Tenderly. O README promete "every transaction is simulated". | `simulator.service.ts:40, 74`; `config/env.ts` | P1 | Sim |
| A3 | **Pausa administrativa não interrompe jobs já enfileirados.** A rota altera o banco (o comentário diz "also pause the on-chain policy", mas não envia tx) e o worker não relê `agent.active` antes de assinar. | `api/routes/admin.ts:433-461`; `queues/transaction.queue.ts` | P1 | Parcial (leitura estática; corrida não reproduzida) |
| A4 | **`profitable` do P&L não mede autossustentação.** Só soma fees, rewards e gas; não inclui inferência, hosting, APIs. Agente sem atividade sai "breakEven = true". | `services/billing/pnl.service.ts` | P1 de produto | Sim (por leitura anterior) |
| A5 | **A fee on-chain só é cobrada em tx com valor em ETH.** Transferências e swaps ERC-20 (a maioria) não passam pelo Executor; `FEE_BPS` fixo em 30 no wrapper, contra tiers 30/15/5 da doc. O modelo de receita não cobra o que anuncia. | `executor.service.ts:12, 73, 114-116` | P2 | Sim |
| S1 | **Agente pode relaxar a própria política.** `PATCH /v1/agents/:id/policy` é autenticado pela chave do próprio agente e faz upsert direto de `maxValuePerTxEth`, `maxDailyVolumeUsd`, allowlists, cooldown. Não há autoridade separada do operador. (Reportado também por um pesquisador externo em 17/08/2026; detalhes na nota de 08/09.) | `api/routes/agents.ts:304-311`; `policy.service.ts` | P1 segurança | Sim |
| S2 | Tools MCP sem `annotations`; erros brutos do upstream devolvidos ao modelo. | `packages/mcp-server/src/index.ts:49, 100` | P2 | Por leitura anterior |
| S3 | Middleware x402 legado (v0.1.0) aceita replay da mesma tx em desafios distintos e não checa idade do desafio. Não está ligado a nenhuma rota; não reaproveitar. | `agentfi-lab` reproduziu | P2 | Sim (lab) |
| D1 | **Docs contraditórios.** HANDOFF §6.1 diz que GMX e escrow v3 foram adiados; §3.2 diz que foram entregues. Roadmap ainda lista GMX, escrow v3 e revenue sharing como pendentes. STATE diz "0.5.0 pending publish" (já publicado). HANDOFF diz "0 PRs abertos" (são 10). | `HANDOFF.md`, `STATE.md`, `docs/project/roadmap.md` | P2 | Sim |
| D2 | `npm ci` quebrado em clone limpo (lock desatualizado). | `package-lock.json` | P1 adoção | **Corrigido hoje** |

Nada disso é grande. A1, A2 e S1 juntos são talvez dois dias de trabalho com testes. Mas são exatamente o tipo de coisa que um avaliador técnico encontra na primeira hora.

---

## 4. O que o mercado fez entre maio e outubro de 2026

Síntese; fatos, datas e fontes em [market-signals-2026-10.md](market-signals-2026-10.md). Tudo abaixo foi confirmado em fonte primária ou imprensa de referência, e os treze itens mais fortes foram reconferidos em uma segunda busca independente.

**Trilhos e padrões viraram infraestrutura neutra**
- x402 Foundation operacional na Linux Foundation (14/07) com Visa, Mastercard, Amex, Stripe, Google, AWS, Cloudflare, Shopify, Circle como premier.
- Google AP2 doado à FIDO Alliance (abr) com pagamentos "human not present"; A2A entrou na Agentic AI Foundation (ago), que passou de 250 membros.
- ERC-8004 (identidade/reputação de agentes) em mainnet desde jan; **ERC-8183 (escrow de job agente-a-agente)** proposto pela Virtuals com a Ethereum Foundation em fev, já com deployments em três chains.
- Stripe: Tempo mainnet + Machine Payments Protocol (mar); Link wallet para agentes com Pix (abr); checkout "agent-ready" em 7,8 M negócios (set).

**Hyperscalers e redes de cartão entraram**
- AWS Bedrock AgentCore Payments GA (18/08): agentes pagam por APIs e **servidores MCP** com x402/MPP, carteiras Coinbase/Privy, limite de gasto na infra.
- Cloudflare Monetization Gateway (30/09): cobra agentes por request em USDC/Base via x402.
- Mastercard Agent Pay for Machines (10/06) com liquidação em seis stablecoins e 30+ parceiros; comprou a BVNK por até US$ 1,8 bi (ago); AI Probability Score (30/09).
- Visa: Agent Score e Agentic Directory (jun), US$ 7 bi/ano em liquidação stablecoin.
- Circle Arc mainnet (16/09) com BlackRock, Visa, Mastercard e DTCC como validadores; Agent Marketplace (26/09).
- OCC aprovou condicionalmente o Catena Trust Bank (18/09), um banco para agentes de IA.

**Plataformas de LLM**
- Anthropic: Claude Commerce Agents (02/09) com Visa e Mastercard, **deliberadamente sem carteira nem pagamento**. MetaMask Agent Wallet (GA 06/08) e AWS AgentCore anunciam suporte a Claude Code.
- OpenAI: Instant Checkout **descontinuado em março** (conversão abaixo de 1%); pivot para descoberta + checkout no lojista. Lição: botão de compra no chat sem mandato e controles falhou.
- Meta Muse (08/09): agente pessoal que compra via Stripe Link com cartão virtual por compra.

**Regulação**
- EUA: GENIUS Act em implementação (enforcement até jan/2027); CLARITY travou no Senado (15/09). Fed (Waller, 29/09) e seis bancos globais (23/09) nomeiam mandato, autenticação e responsabilidade como o problema.
- **Brasil: Res. BCB 561 em vigor desde 01/10** (stablecoins fora da liquidação eFX com o exterior); prazo de adequação de cadastro em **30/10/2026**. Verificar no texto das Resoluções 519/520/561 antes de qualquer decisão de estrutura.

**Contra-sinais (igualmente verificados)**
- TRM Labs (09/09): só 0,6–7,5% do valor no x402 vem de agentes; US$ 5–11 mil/mês de comércio agêntico real.
- 3% das transações de lojistas envolvem agentes (Checkout.com, jun); 24% dos adultos online nos EUA confiam em IA para comprar.
- Virtuals ACP v1: 19 memos/dia e 3 remetentes únicos no indexador (05/10). Olas: US$ 110 mil de turnover total em três anos. elizaOS fechou; Giza e Almanak colapsaram.
- Reputação ERC-8004 é Sybil e manipulável por centavos (dois papers de 2026).
- Arc Agent Venue (01/10): um desenvolvedor independente montou "agentes contratando agentes com escrow + ERC-8004 + ERC-8183" em semanas. Liquidou US$ 2,55. A barreira técnica caiu; a demanda não apareceu.

---

## 5. Leitura estratégica

| Camada do AgentFi | Situação no mercado (out/2026) | Implicação |
|---|---|---|
| L1 Carteira MPC + Safe por agente | Commodity: Coinbase Agentic Wallets, MetaMask Agent Wallet, Circle Agent Wallets, Privy, Crossmint, Turnkey | Virar **adaptador**: aceitar carteiras de terceiros como provider, como já existe `WALLET_PROVIDER=local|turnkey` |
| L2 Policy on-chain (limites, allowlist, kill switch) | Commodity: session caps na infra (AWS), Guard Mode (MetaMask), Arc Portal (Circle), Safe allowance modules | Manter só o que os outros não têm: política **por tarefa/job** e autoridade separada (operador ≠ agente) |
| L2 `EscrowModule` (A2A) | **Padronizado como ERC-8183** (draft, EF + Virtuals); poucos players: Virtuals ACP v2, Kite+Circle, Agentum, Arc Agent Venue | **Diferencial.** Tornar compatível com ERC-8183 e deployar na Base |
| L3 Reputação (score 0–10 000 com time-decay) | ERC-8004 em mainnet, mas reputação sem prova de interação é o problema documentado; Visa/Mastercard têm Agent Score fechado | **Diferencial.** Gravar feedback ERC-8004 **só a partir de escrow liquidado** (prova de interação) |
| L3 P&L por agente | Ninguém faz bem; mas o "profitable" atual é parcial | Reposicionar como margem on-chain; incluir custos de inferência quando houver fonte |
| L4 MCP server (31 tools) | MCP virou padrão neutro (AAIF); AWS e Cloudflare monetizam servidores MCP; MetaMask/Coinbase têm MCP próprio | **Diferencial de distribuição**, desde que fale x402 e MPP como cliente (pagar por APIs) além de executar DeFi |
| DeFi adapters (Uniswap, Aave, Compound, Curve, ERC-4626, GMX) | Base MCP da Coinbase cobre Morpho, Moonwell, Uniswap, Aerodrome; DeFAI de yield como produto morreu | Manter como ferramentas; não é onde está o valor |

**Posicionamento proposto:** "AgentFi é a camada de confiança para agentes que contratam agentes: escrow ERC-8183, reputação ERC-8004 com prova, execução via MCP, sobre a carteira e o trilho que você já usa (Coinbase, MetaMask, x402, MPP)". Não é carteira, não é token, não é SaaS de yield.

**Riscos que não mudaram:** demanda real pequena; Kite (US$ 35 M), Agentum e a própria Virtuals atacam o mesmo nicho; no Brasil, operar com stablecoin exige decidir se o AgentFi é software (sem custódia, sem câmbio) ou parceiro de PSAV autorizada.

---

## 6. Opções de retomada

| Opção | O que é | Custo | Quando faz sentido |
|---|---|---|---|
| **A. Manter arquivado** | Nada muda. Código fica como referência. | Zero | Se não houver pelo menos uma semana por mês disponível |
| **B. Retomada restrita como camada de confiança** (recomendada) | Housekeeping de uma semana; fechar A1/A2/S1; validação de demanda com três entrevistas; spike técnico de ERC-8183 + ERC-8004 + x402; demo pública com Claude Code; go/no-go em 90 dias | ~1 semana de housekeeping + ~2–3 dias por semana por três meses | Se você acredita na tese e aceita que o produto final pode ser diferente do AgentFi de maio |
| **C. Retomada completa do roadmap anterior** (fases 5–6: SaaS, "Stripe for Agents") | Reconstruir hosted, cobrar por volume, competir com Coinbase/AWS na camada de carteira | Alto | Não recomendado: é a camada que virou commodity |

Recomendo **B**, com os gates abaixo. O critério de abandono já está escrito na nota de 08/09: três entrevistas; só avançar se pelo menos dois operadores relatarem o mesmo problema recorrente com exemplo concreto e um aceitar testar com dados.

---

## 7. Plano de 90 dias

### Semana 0: housekeeping (deixa o repo apresentável e executável)

Técnico, sem decisão de produto:
1. Desarquivar o repositório no GitHub (só você pode).
2. Commitar o `package-lock.json` corrigido (já feito no working tree) via PR, para o CI voltar a rodar `npm ci`.
3. Corrigir **A1** (gerar o ABI do wrapper a partir do artefato do Foundry e testar backend contra contrato local no Anvil), **A2** (exigir Tenderly ou simulação local explícita em produção; rejeitar `_isMock` nas rotas) e **S1** (política só pode ser **reduzida** pelo agente; ampliação exige credencial do operador). Um PR cada.
4. Instalar Foundry nesta máquina e rodar `forge test` (22 testes do EscrowModule + os demais).
5. Fechar as 10 PRs Dependabot, deixar reabrir, mergear os minors; tratar Turnkey 6 e Prisma 7 como PRs próprios com teste.
6. Apagar as 6 branches remotas já mergeadas; sincronizar ou apagar `develop`.
7. Corrigir `.claude/launch.json` para paths relativos; atualizar os Dockerfiles para `node:22-alpine` (alinhar com CI).
8. Atualizar `HANDOFF.md`, `STATE.md` e `roadmap.md` para refletir o que foi entregue (D1) e trocar o banner do README de "Archived" para "Reactivated (exploratory)" **quando** você decidir.
9. Mover os PNGs para `docs/architecture/diagrams/` ou apagar; apagar as pastas `agentfi-fix-*`, `agentfi-gmx`, `agentfi-phase2-snapshots`.
10. Reinstalar `graphify` e rodar `graphify update .`.

### Dias 1–30: validação de demanda + spike técnico (em paralelo)

Demanda (você):
- Três entrevistas com operadores que já rodam agentes que gastam dinheiro (APIs pagas, dados, x402). Roteiro de cinco perguntas pronto na nota de 08/09/2026. Candidatos naturais: quem usa Coinbase Agentic Wallets, AWS AgentCore Payments ou MetaMask Agent Wallet com Claude Code; devs listados nos diretórios de x402 (Coinbase Bazaar, Circle Agent Marketplace).
- Pergunta central: "quando seu agente contrata outro agente ou serviço, como você garante que pagou pelo que recebeu, e o que acontece quando dá errado?"

Spike técnico (agente de código, 2–3 dias cada):
- `EscrowModule.sol` compatível com a interface ERC-8183 (`Job` com client/provider/evaluator/budget/expiry). Deploy em Base Sepolia.
- Escritor de feedback ERC-8004: ao liquidar um job, gravar outcome no Reputation Registry com referência à tx de escrow (prova de interação).
- Cliente x402 e MPP no MCP server: tool `pay_for_resource` que paga uma API 402 dentro do orçamento do job (o `agentfi-lab` já tem o ledger de orçamento por tarefa; migrar o conceito).
- Provider de carteira "externa": aceitar um Coinbase CDP wallet ou MetaMask Agent Wallet como signer em vez de Turnkey.

### Dias 31–60: demo pública

- Screencast de 3 minutos: Claude Code com o MCP do AgentFi descobre outro agente, abre um job com escrow ERC-8183 na Base, o provider entrega, o evaluator aprova, o escrow libera, a reputação ERC-8004 é gravada, o P&L mostra o resultado. Tudo on-chain, com valores pequenos.
- Publicar o exemplo no repo e nos diretórios (Glama, mcp.so, awesome-mcp-servers, Coinbase Bazaar se aplicável).
- Republicar `@agent_fi/mcp-server` 0.6.0 com as novas tools.

### Dias 61–90: go/no-go

Métricas mínimas para continuar: pelo menos **um operador externo** rodando o fluxo com dinheiro próprio; pelo menos **dez jobs** com escrow liquidado que não sejam seus; pelo menos **uma conversa** em que alguém pede uma feature específica. Sem isso, voltar para a opção A com a consciência tranquila e o código muito melhor do que estava.

---

## 8. Decisões que só você pode tomar

1. Desarquivar o GitHub e trocar o banner do README (ação pública).
2. Aceitar o reposicionamento ("camada de confiança", sem carteira própria) ou insistir na pilha completa.
3. Estrutura jurídica no Brasil: software sem custódia (recomendado para começar) ou operação com stablecoin que exija enquadramento PSAV/eFX (prazo de adequação em 30/10/2026 para quem já opera).
4. Orçamento de tempo: a opção B precisa de 2–3 dias por semana por três meses.
5. O que fazer com o contrato `AgentExecutor` na Base: o bytecode deployado **não** corresponde ao `.sol` atual (ver A1). Ou se congela a fonte na versão deployada, ou se redeploya a versão nova junto com o `EscrowModule` e se atualiza o backend. Redeploy custa gas e muda os endereços publicados no STATE.md.
6. Destino das notas: manter `agentfi-notas/` fora do vault (decisão de setembro) ou trazê-las para `docs/project/` do repo.

---

## 9. Checklist executável (após desarquivar)

```bash
# 1. Desarquivar (GitHub web: Settings → Danger zone → Unarchive) ou:
gh api -X PATCH repos/felippeyann/agentfi -f archived=false
```

```bash
# 2. Commitar o lock corrigido via PR
git checkout -b fix/lockfile-sync && git add package-lock.json && git commit -m "fix: sync package-lock with mcp-server 0.5.0 (npm ci was failing on clean checkout)" && git push -u origin fix/lockfile-sync && gh pr create --base main --fill
```

```bash
# 3. Apagar branches remotas já mergeadas
git push origin --delete chore/glama-distribution-checks chore/mcp-server-0.5.0 docs/post-0.4.0-publish-state docs/session-notes-2026-05-10 docs/session-notes-2026-05-15 fix/stale-backend-urls
```

```bash
# 4. Fechar PRs Dependabot (reabrem sozinhos contra o lock novo)
gh pr list --repo felippeyann/agentfi --author app/dependabot --json number -q '.[].number' | xargs -I{} gh pr close {} --repo felippeyann/agentfi --delete-branch
```

```bash
# 5. Apagar pastas vazias de worktrees antigas
rm -rf "/c/Users/AAWZ 360/agentfi-fix-73" "/c/Users/AAWZ 360/agentfi-fix-74" "/c/Users/AAWZ 360/agentfi-fix-75" "/c/Users/AAWZ 360/agentfi-fix-81" "/c/Users/AAWZ 360/agentfi-fix-notify" "/c/Users/AAWZ 360/agentfi-gmx" "/c/Users/AAWZ 360/agentfi-phase2-snapshots"
```

```bash
# 6. Instalar Foundry (PowerShell/winget) e testar contratos
cd packages/contracts && forge test
```

```bash
# 7. Validar o stack zero-credencial do zero
docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up --build -d && npm run smoke:dev && node examples/a2a-collab/index.mjs && node examples/swap-planner/index.mjs && node examples/delegation-chain/index.mjs
```

---

## 10. Registro desta sessão (06/10/2026)

- Lidos: README, VISION, STATE, HANDOFF, CHANGELOG, roadmap, A2A interoperability, architecture overview, dev quickstart, MCP README, RELEASE, claude-instructions, GRAPH_REPORT, as duas notas de setembro e o README/ROUND-2 do `agentfi-lab`.
- Verificados externamente: GitHub (stars, forks, issues, PRs, runs, releases), npm (versões e downloads diários), Fly/Vercel/agentfi.cc, Glama, mcp.so, awesome-mcp-servers, bytecode dos dois contratos na Base.
- Verificados localmente: `git fetch --prune`, comparação de todas as 18 branches remotas contra `main`, typecheck dos 4 workspaces, `npm ci --dry-run`, build Docker.
- Alterações feitas no working tree (nada commitado, nada enviado): `package-lock.json` regenerado (4 linhas); criados `docs/project/reactivation-2026-10.md` e `docs/project/market-signals-2026-10.md`; apagadas 4 branches locais já mergeadas.
- Pesquisa de mercado: três frentes paralelas (protocolos de pagamento; identidade e economia A2A on-chain; macro, regulação e funding), 13 alegações reconferidas em busca independente. Sem contato com terceiros, sem publicação, sem transação.
- Validação do stack Docker: build do zero, 5/5 serviços healthy, smoke test e três exemplos passando após a correção do lock (detalhe em §1.4). Stack parado ao final da sessão.
