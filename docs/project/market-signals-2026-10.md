# Sinais de mercado — agentes transacionando (status em 06/10/2026)

> Pesquisa web consolidada em 06/10/2026 para a decisão de retomada do AgentFi.
> Companheiro do [Dossiê de Retomada](reactivation-2026-10.md). Documento em português por ser material de decisão do mantenedor; a documentação pública do repositório segue em inglês.

**Legenda**
- **[V]** confirmado em fonte primária ou imprensa de referência pelos agentes de pesquisa.
- **[V✓]** reconfirmado de forma independente nesta sessão (segunda busca, fonte distinta).
- **[NV]** só em fonte secundária, blog ou número auto-reportado; não usar em argumento sem checar.

Método: três frentes paralelas de pesquisa (protocolos de pagamento; identidade/A2A on-chain; macro/regulação/funding), depois 13 das alegações mais fortes foram reconferidas em buscas separadas. Tudo abaixo é relato de terceiros, não telemetria própria.

---

## 0. Leitura em uma frase

Entre maio e outubro de 2026 a **oferta** de infraestrutura para agentes transacionarem (trilhos, carteiras, identidade, escrow, padrões abertos) consolidou-se de forma inédita, com Coinbase, Stripe, Visa, Mastercard, AWS, Cloudflare, Circle e Ethereum Foundation convergindo nos mesmos padrões. A **demanda** real ainda é pequena e mal medida: a parcela de volume x402 atribuível a agentes de fato fica entre 0,6% e 7,5% (TRM Labs), e várias "economias de agentes" tokenizadas colapsaram. O mercado está pronto do lado da oferta; o gargalo é confiança, mandato e responsabilidade, exatamente a camada de política, escrow e reputação.

---

## 1. Protocolos e padrões abertos

### x402 (Coinbase → x402 Foundation / Linux Foundation) [V✓]
- Lançado em maio/2025. V2 em 11/12/2025 (identidade por carteira, descoberta de API, multi-chain). Batch settlement em 11/05/2026.
- **x402 Foundation operacional em 14/07/2026 sob a Linux Foundation**, 40 membros fundadores. Premier (17): Adyen, AWS, American Express, Circle, Cloudflare, Coinbase, Fiserv, Google, Mastercard, Monad, MoonPay, Ripple, Shopify, Solana Foundation, Stellar, Stripe, Visa. Diretor executivo nomeado em 01/10/2026 [NV].
- Números brutos: 165 M tx / ~US$ 50 M (abr/2026) → 205 M tx / ~US$ 53 M (set/out 2026). Ticket médio ~US$ 0,20–0,30: é metering de API, não varejo.
- **Contra-sinal [V✓]:** TRM Labs (09/09/2026) analisou US$ 52,7 M em 198,9 M settlements e, após remover self-payments e fluxos de script, estimou que só **0,6%–7,5% do valor vem de agentes de IA** (US$ 5–11 mil/mês). Artemis/Visa (abr/2026): 89% do volume bruto é wash/teste. O contador público do x402.org ficou congelado desde março (McGlynn, set/2026) [NV].
- Integrações em produção: Coinbase Agentic Wallets (11/02/2026), Coinbase Business aceitando x402 (jul–ago/2026), AWS AgentCore Payments GA (18/08/2026), Cloudflare Monetization Gateway (30/09/2026).
- **Para o AgentFi:** x402 é o rail de fato (USDC/Base). Limite de gasto virou commodity; diferenciação precisa vir de escrow, reputação e execução.

### Google AP2 + A2A + UCP [V]
- **AP2** anunciado em 16/09/2025 com 60+ parceiros; extensão A2A-x402 com Coinbase, Ethereum Foundation e MetaMask permite mandato AP2 liquidar em USDC. **AP2 v0.2 (28–29/04/2026) com pagamentos "Human Not Present", doado à FIDO Alliance** (grupos de trabalho com CVS, Google, OpenAI, Mastercard, Visa).
- **A2A** v1.0 em jan/2026; 150+ organizações em abr/2026; doado à Agentic AI Foundation (AAIF) em 17–20/08/2026. AAIF passou de <40 membros (dez/2025) para ~250 (ago/2026); platinum: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI.
- **UCP (Universal Commerce Protocol)**: Google + Shopify em 11/01/2026 com Etsy, Wayfair, Target, Walmart; PayPal e Stripe aderiram; Universal Cart no I/O 2026.
- **Para o AgentFi:** mandatos assinados (cart/payment mandate) e Agent Cards assinados são a referência com a qual política on-chain e reputação precisam interoperar.

### Stripe: ACP, MPP, Tempo, Link [V]
- **Tempo mainnet + Machine Payments Protocol (MPP)** em 18/03/2026 (Stripe + Paradigm; Anthropic, Nubank e Revolut citados como parceiros). Visa publicou SDK de cartões sobre MPP.
- **Sessions 29/04/2026**: Link wallet para agentes (com Pix, stablecoins e UPI), streaming payments, Shared Payment Tokens, Agentic Commerce Suite.
- Set/2026: WebMCP em 7,8 M negócios (checkout hospedado "agent-ready"); Link integrado ao Meta Muse; compras agênticas via Link cresceram 38x em um mês [V via Stripe]. 70% das requisições de API em dev tools vêm de agentes (jun/2026) [NV].
- Tempo: US$ 500 M Série A a US$ 5 bi [NV].
- **Para o AgentFi:** MPP cobre assinatura/streaming/reconciliação que o x402 v1 não cobria; suportar os dois, não um só.

### ERC-8004 "Trustless Agents" [V]
- Proposto em 13/08/2025 (MetaMask, EF dAI, Google, Coinbase). **Mainnet Ethereum em 29/01/2026** (Identity, Reputation, Validation registries).
- Contagens: 614 mil agentes em 24 chains (agenteconomy.to, 04/10/2026), BNB Chain com 359 mil; 9.402 registros no dia 04/10 [NV, indexador].
- **Fragilidade documentada (arXiv 2606.26028, jul/2026; arXiv 2606.12128, jun/2026):** 59–91% dos revisores com comportamento Sybil conforme a chain; só 3–15% dos agentes expõem endpoint válido; ~99% dos feedbacks sem prova de interação; custo de manipular reputação entre US$ 0,003 e US$ 0,06. Conclusão dos autores: "registration-heavy but operationally shallow".
- Usos com evidência: Lemma publica outcomes de resoluções pagas no Reputation Registry na Arbitrum (27/09/2026); Arc Agent Venue usa passaportes ERC-8004 (01/10/2026).
- **Para o AgentFi:** feedback **ancorado em escrow liquidado** (prova de interação) é exatamente a lacuna que os papers apontam. Posicionar-se como evaluator/feedback client ERC-8004 é diferenciação, não competição.

### ERC-8183 "Agentic Commerce" (primitiva Job) [V✓]
- Proposto em 25/02/2026 pela Virtuals em colaboração com o dAI team da Ethereum Foundation. Status: draft. Define `Job` (client, provider, evaluator, budget, expiry) com estados Open → Funded → Submitted → terminal; orçamento em escrow; evaluator aprova ou rejeita.
- Implementação de referência: Virtuals ACP v2 (abr/2026). Deployments em Arbitrum, BNB Chain e XRP Ledger em menos de seis semanas. Arc Agent Venue (out/2026) também usa.
- **Para o AgentFi:** é literalmente o escrow A2A do projeto, agora como padrão com chancela da EF. Tornar `EscrowModule.sol` compatível com ERC-8183 custa pouco e dá interoperabilidade com ACP e Arc.

---

## 2. Trilhos, carteiras e plataformas

| Iniciativa | Data | Status (out/2026) | Fatos | Para o AgentFi |
|---|---|---|---|---|
| **AWS Bedrock AgentCore Payments** [V✓] | preview 07/05, **GA 18/08/2026** | GA | Agentes pagam por APIs, **servidores MCP** e conteúdo; x402 + MPP; carteiras Coinbase CDP e Stripe/Privy; limites de gasto por sessão aplicados na infra; skills para Claude Code, Kiro e Codex; clientes Travala, Anchor Browser, Heurist | Hyperscaler validando "MCP server + policy + pagamento". Compatibilidade x402/MPP vira pré-requisito |
| **Cloudflare Monetization Gateway** [V✓] | 30/09/2026 | beta fechado (EUA), GA início 2027 | Cobra agentes por request em USDC na Base via x402, mínimo US$ 0,001; 60% do tráfego Cloudflare é bot (mai/2026) | Monetização de APIs por agentes vira padrão de borda |
| **Coinbase Agentic Wallets / AgentKit / Base MCP** [V] | 11/02/2026; Base MCP 26/05/2026 | ativo | MPC, limites por sessão e por tx, gasless na Base, servidor MCP; skills para Morpho, Moonwell, Uniswap, Aerodrome, Virtuals. Q2 call (30/07): ">90% do volume agentic em stablecoin liquida na Base"; "agentic finance is still very early days" | Carteira + limites de gasto são commodity gratuita |
| **MetaMask Agent Wallet** [V✓] | early access 08/06, **GA 06/08/2026** | GA | Self-custodial, CLI, Guard Mode (limite diário, allowlist de protocolos, 2FA fora da política) e Beast Mode; simulação + Blockaid + proteção MEV; cobertura até US$ 10 mil; 9+ chains EVM + Hyperliquid; **compatível com Claude Code, Codex, Cursor, OpenClaw** | Concorrente direto da camada 1 do AgentFi, com distribuição de 30 M+ usuários |
| **Circle Agent Stack / Arc** [V✓] | Agent Stack 11/05/2026; **Arc mainnet 16/09/2026** | mainnet | Gas em USDC; validadores fundadores BlackRock, DTCC, ICE, Mastercard, Visa, Galaxy, Standard Chartered; 700 M+ tx em testnet; nanopayments de US$ 0,000001; Circle Agent Marketplace (26/09); Facilitator x402 (Arc/Base/Polygon) | USDC/Arc/Base é o padrão de liquidação; limites de gasto nativos |
| **Tether WDK** [V] | nov/2025; MCP em 27/09/2026 | beta | Wallet CLI + servidor MCP para agentes | Mais um provedor de carteira com MCP |
| **Safe** [V] | Q2/2026 | ativo | ~130 M tx e 2,73 M contas ativas/mês; doc oficial para agentes; Bankr fez tesouraria via módulos Safe | Base técnica do AgentFi continua válida |
| **Privy (Stripe), Crossmint, Turnkey** [V] | 2026 | ativos | Provedores embutidos nas stacks de agentes; Turnkey levantou US$ 12,5 M (mai/2026, Circle Ventures) | Turnkey (usado pelo AgentFi) continua vivo e financiado |

---

## 3. Redes de cartão, bancos e reguladores bancários

- **Visa** [V]: Trusted Agent Protocol (14/10/2025, com Cloudflare); Visa Payments Forum 10/06/2026: Agent Score, Agentic Directory, Large Transaction Model; liquidação em stablecoin ~US$ 7 bi/ano (mar/2026), 9 blockchains (Arc, Base, Tempo adicionadas); 160+ programas de cartão stablecoin; integração com ChatGPT (175 M estabelecimentos, limites pré-autorizados). **Agent Score/Directory é concorrente fechado de "reputação de agente"**, centrado em cartão.
- **Mastercard** [V✓]: Agent Pay (abr/2025); **BVNK** (até US$ 1,8 bi) concluída em 03/08/2026; **Agent Pay for Machines (10/06/2026)**: microtransações, limites programáticos, liquidação multi-trilho com seis stablecoins reguladas (USDC, RLUSD, PYUSD…), 30+ parceiros (Coinbase, Stripe, Adyen, Polygon, Solana Foundation, Aave, Cloudflare, Turnkey, Catena, Tempo); Agent Connect (09/09) distribui o blueprint da Anthropic; **AI Probability Score** (29–30/09/2026) + KYA da Skyfire. Transações agênticas no Canadá e Dinamarca (set/2026).
- **American Express** [V]: ACE Developer Kit + Agent Purchase Protection (14/04/2026), primeira rede a assumir risco de erro do agente; Playbook de comércio agêntico em 06/10/2026.
- **KYA interoperável Visa + Mastercard + Ant International** (10/09/2026) [V]: identidade de agente vira requisito.
- **OCC** [V✓]: em 18/09/2026 aprovou condicionalmente três trust banks para ativos digitais, entre eles **Catena Trust Bank** (Sean Neville, cofundador da Circle), explicitamente para agentes de IA; Catena tem US$ 48 M levantados (Série A de US$ 30 M em 20/05/2026 com a16z crypto e Acrew).
- **Fed** [V]: Waller, Sibos 29/09/2026, "Payments in the Age of AI Agents": distingue agent-assisted de agent-delegated e nomeia autenticação, responsabilidade e fraude como barreiras.
- **Seis bancos globais** (BofA, Capital One, ING, NatWest, CBA, ASB) publicaram princípios de "trusted agentic commerce" em 23/09/2026 [V].
- **BlackRock**, "The Machine-Native Economy" (22/09/2026) [V]: agentes como demanda estrutural por stablecoins.

---

## 4. Big techs e plataformas de LLM

- **Anthropic** [V✓]: MCP doado à Linux Foundation (AAIF) em 09/12/2025; 10 mil+ servidores MCP públicos. **Claude Commerce Agents (02/09/2026)**: blueprint Apache-2.0 de agente comprador + agente lojista, parceiros Visa, Mastercard, Shopify, Priceline, Accenture; Anthropic cita +60% de conversão (auto-reportado). **Deliberadamente sem carteira nem processamento de pagamento**: entrega o carrinho ao checkout do lojista. Managed Agents em beta (abr/2026). Spec MCP 2026-07-28 sob a AAIF.
- **OpenAI** [V✓]: **Instant Checkout (set/2025) descontinuado em março/2026** (anúncio 05/03, pivot 24/03): conversão <1% contra 3–4% da indústria, cerca de uma dúzia de lojistas Shopify, Walmart com 1/3 da conversão do site próprio. ACP continua (spec 2026-04-17; Checkout.com, PayPal, Stripe). Visa integrada ao ChatGPT (10/06/2026). DevDay 29/09/2026: "dots", agentes always-on com computador na nuvem. "ChatGPT Wallet" em código do app Codex [NV]. **Lição:** checkout in-chat B2C sem mandato e controles falhou; infraestrutura M2M avançou.
- **Google** [V]: UCP, AP2 na FIDO, Universal Cart; A2A na AAIF.
- **Microsoft** [V]: Copilot Checkout (08/01/2026) com PayPal, Shopify, Stripe; Agent 365 GA em 01/05/2026 (governança de agentes).
- **Meta** [V✓]: **Muse (08/09/2026)**: agente pessoal que roda em VM própria, abre browser e compra via Stripe Link (cartão virtual single-use por compra, coberto pelas proteções da Link); só EUA; 2,5 M downloads em 15 dias [NV, Sensor Tower]; Shop Pay em todas as lojas Shopify (21/09); PayPal e Mastercard Agent Pay aderiram em três semanas; Amazon bloqueou o Muse.
- **Apple** [V]: WWDC 2026 sem anúncio de pagamento agêntico; App Intents 2.0 como única via de ação por terceiros.
- **Amazon** [V]: Alexa for Shopping (13/05/2026) com "Buy for Me"; perdeu no 9º Circuito contra a Perplexity/Comet (ago/2026).
- **PayPal** [V]: Agentic Commerce Services (28/10/2025); suporta ACP, UCP e AP2; checkout da Perplexity; liderou US$ 18 M na Kite AI.
- **Ant International** [V]: Agentic Mobile Protocol fase 1 (11/09/2026) com 10 carteiras Alipay+.

---

## 5. Economias agente-a-agente e DeFAI (o que é real)

| Iniciativa | Status (out/2026) | Números | Leitura |
|---|---|---|---|
| **Virtuals ACP** (Base, Arbitrum, Solana) [V] | ACP v2 (ERC-8183) vivo; token −87% da máxima | Auto-reportado: 81,9 mil agentes, 2,5 M jobs, aGDP US$ 481,8 M, 4,5 M USDC de receita. Indexador independente: v1 com **19 memos/dia e 3 remetentes únicos em 05/10/2026** [NV, pode não cobrir v2] | Modelo escrow + evaluator validado; demanda orgânica fina e subsidiada |
| **Olas (Autonolas)** [V] | ativo; Optimus em maintenance mode | 20,7 M tx on-chain, 14,7 M A2A; mas **turnover total do marketplace US$ 109,8 mil e US$ 827 de fees** (lifetime); Pearl 598 DAA (set/2026, caindo) | Micropagamento A2A em produção há 3 anos; US$ real ínfimo |
| **Fetch.ai / ASI** [V] | ativo | ~2,7 M agentes no Agentverse (auto-reportado); volume não divulgado [NV] | Descoberta grande, pagamento irrelevante |
| **elizaOS / ai16z** [V] | token "morto", fundação fechando (04/08/2026) após class action (abr/2026) | framework open-source segue (19,5k stars) | Risco do modelo token-first |
| **Agentum** (BNB) [NV] | live | auto-reportado: US$ 12,55 M em escrow, 7,8 mil agentes, 26 mil jobs, fee 1–3% | Concorrente direto; auditar on-chain antes de citar |
| **Arc Agent Venue** [V] | live desde 01/10/2026 | 6 jobs, **US$ 2,55 liquidados**, 1 provider; escrow USDC + ERC-8004 + ERC-8183 | O caso de uso exato do AgentFi, feito por um indie em semanas sobre padrões abertos |
| **Kite + Circle (Arc)** [V] | parceria 18/09/2026; mainnet "em integração" | Kite: US$ 35 M (PayPal Ventures, Coinbase Ventures); Agent Passport (30/04/2026) | Player capitalizado no mesmo nicho de escrow A2A |
| **Giza** [V] | ARMA e Pulse encerrados (mar/2026) | posições residuais ~US$ 12,8 mil | DeFAI de yield não sobreviveu |
| **Almanak** [V] | TVL pico US$ 132 M (dez/2025) → ~US$ 446 mil (out/2026) | — | idem |
| **Theoriq, Wayfinder, Morpheus, Griffain** [NV] | roadmaps, sem métricas | — | sem evidência de uso |

**Programas oficiais das chains (2026)** [V]: EF dAI team (ERC-8004, ERC-8183, x402 como primitivas); Base roadmap agent-native; Arbitrum Trailblazer 2.0 (US$ 1 M para "agentic DeFi", cap US$ 10 mil/grant); Solana Agent Registry + Pay.sh com Google Cloud (06/05/2026); BNB Chain BAP-578 + maior contagem ERC-8004; Circle Arc.

---

## 6. Regulação

- **EUA** [V]: **GENIUS Act** (lei de 18/07/2025); OCC propôs regras em 02/03/2026; FinCEN/OFAC NPRM 08/04/2026; regras finais exigidas até 18/07/2026; enforcement pleno até 18/01/2027. **CLARITY Act**: Câmara aprovou (jul/2025), Senate Banking 15–9 (14/05/2026), **cloture falhou 49–50 em 15/09/2026**; próxima janela improvável antes das midterms. SEC/CFTC: interpretação conjunta 17/03/2026 com taxonomia de cinco categorias. Nenhuma regra exige KYA por nome, mas Fed, MAS e bancos pedem mandato, limites e trilha auditável.
- **UE** [V]: fim da transição MiCA em 01/07/2026; AI Act Digital Omnibus (Reg. 2026/1744) adia alto risco para 02/12/2027; transparência do Art. 50 vale desde 02/08/2026.
- **Singapura** [V]: MAS SAFR (03/07/2026), governança de agentes em runtime.
- **Brasil** [V✓]: Res. BCB 519/520/521 (10/11/2025, vigor 02/02/2026) regulam PSAVs; **Res. BCB 561 (30/04/2026, vigor 01/10/2026)** retira stablecoins e demais criptoativos da liquidação eFX com contraparte no exterior; instituições autorizadas atualizam cadastro no Unicad até **30/10/2026**; sem autorização, pedir ou parar até 31/05/2027. Prazo de protocolo PSAV também citado como 30/10/2026 (VBSO) — **confirmar no texto das Resoluções antes de qualquer decisão societária**. Drex pivotou para plataforma atacadista. Primeira transação agêntica no Brasil: Visa + Banco do Brasil (mar/2026). Não há regime de responsabilidade para transações autônomas de IA.

---

## 7. Funding e teses de VC (2026)

- [V] Catena Labs US$ 30 M Série A (20/05) + charter OCC condicional (18/09) · Natural US$ 30 M Série A (20/07, Forerunner) · AIsa US$ 6,5 M seed (jul, Alibaba + Tribe) · Baselayer US$ 35 M Série A (22/09, M13; KYA; 2.300 instituições) · Kite AI US$ 18 M (PayPal Ventures; US$ 33–35 M total) · Skyfire US$ 9,5 M (a16z CSX, Coinbase Ventures) · Turnkey US$ 12,5 M (mai) · Variant IV US$ 222 M (03/06, tese "autonomia") · Mastercard–BVNK até US$ 1,8 bi.
- [NV] Payman US$ 13,8 M; Nevermined ~US$ 7 M; Sapiom US$ 15,75 M; Locus (YC); Paradigm até US$ 1,5 bi; a16z crypto fundo V US$ 2 bi; Tempo US$ 500 M.
- **Teses** [V]: a16z Big Ideas 2026 (KYA como gargalo; agentes como participantes de rede com x402; stablecoins como settlement layer); Pantera (nov/2025); BlackRock (22/09/2026). a16z State of Crypto 2026 ainda não publicado até 06/10.
- **Leitura:** capital está indo para identidade/KYA, carteiras de agente e orquestração. Nenhum round encontrado em **escrow A2A + reputação com prova**: lacuna aberta.

---

## 8. Tamanho de mercado e volumes reais

- Projeções [V]: McKinsey (out/2025) US$ 3–5 tri globais em 2030; Gartner (jan/2026) 20% das transações de comércio digital via agentes em 2030; Bain US$ 300–500 bi EUA em 2030; Juniper (07/04/2026) US$ 8 bi em 2026 → US$ 1,5 tri em 2030; Morgan Stanley 10–20% do e-commerce dos EUA em 2030. Citi US$ 1,7 tri [NV].
- Realidade hoje [V]: eMarketer US$ 20,6 bi (1,5% do e-commerce EUA 2026); Checkout.com (jun/2026): 89% dos lojistas se preparando, 42% testando, **3% das transações envolvem agentes**; Forrester: 24% dos adultos online nos EUA confiam em IA para compras; 93% dos lojistas querem que o provedor do agente assuma a perda.
- **McKinsey, *The 2026 Global Payments Report: Operational excellence in an invisible world* (set/2026; PDF de 29 páginas lido na íntegra em 06/10/2026) [V]:** receita global de pagamentos US$ 2,6 tri em 2025 (41% da receita bancária) → US$ 3,2 tri em 2030, com crescimento caindo de 9% para 4% a.a.; agentes põem em risco US$ 75 bi (caso base) a US$ 160 bi (agressivo) da receita de 2030, sobretudo NII de depósitos (US$ 65 bi) e interchange de cartão (30–75% do interchange líquido dos EUA); até US$ 110 bi/ano de produtividade com IA no setor. O relatório define "agêntico" só quando a decisão ocorre na execução (contraparte, valor, momento ou trilho não fixados antes) e lista cinco produtos novos (credenciais de agente, gestão de mandato e consentimento, guardrails de política em runtime, carteiras de agente, proteção de transação delegada) monetizados por mandato, por chamada de API e por prêmio de risco, **não por bps de volume**. Sequência de adoção: B2B e tesouraria primeiro; "serviços digitais agente-a-agente" e "comércio B2B agêntico" são os casos menos implantados hoje e seguem entre nascente e inicial em 2030 no caso base; varejo escala por volta de 2035; "migração de identidade econômica para atores-máquina autônomos" além de 2030. Stablecoins: 2/3 dos executivos as veem como liquidação atacadista em corredores ilíquidos, marginais no varejo até 2035. Mercados de cartão resiliente roteiam agentes por cartões (proteção e disputa); mercados de instantâneo dominante, Brasil/Pix citado nominalmente, são "tela aberta" para integração direta de agentes ao trilho. Protocolos TAP, Agent Pay, AP2 e ACP descritos como camadas empilháveis que os PSPs integram ao mesmo tempo; o valor migra para a "camada de controle" (identidade de máquina em tempo real, conformidade de política, revogação, alocação de responsabilidade).
- Stablecoins [V]: oferta recorde US$ 322 bi (mai/2026); volume bruto Q1/2026 US$ 28 tri, **76% bots**; volume ajustado (Visa) recorde US$ 1,79 tri em jun/2026 (USDC 67%); Allium (set/2026): US$ 85 tri brutos jan–ago, só US$ 4 tri de economia real. DWF Ventures (abr/2026): **19% da atividade on-chain é agêntica/automatizada**; >90% do comércio on-chain de agentes em USDC.

---

## 9. Linha do tempo julho–outubro de 2026 (sinais mais fortes)

| Data | Evento |
|---|---|
| 14/07 | x402 Foundation operacional na Linux Foundation (Visa, Mastercard, Amex, Stripe, Google, AWS, Cloudflare, Shopify) |
| 30/07 | Coinbase Q2: agentes criam wallets na CDP; >90% do volume agentic em stablecoin na Base |
| 03/08 | Mastercard conclui compra da BVNK |
| 04/08 | elizaOS: token morto, fundação fechando |
| 06/08 | MetaMask Agent Wallet GA (suporte a Claude Code) |
| 17–20/08 | A2A entra na AAIF; AAIF passa de 250 membros |
| 18/08 | AWS Bedrock AgentCore Payments GA (x402 + MPP, pagamento por servidores MCP) |
| 02/09 | Anthropic Claude Commerce Agents com Visa/Mastercard, sem carteira |
| 08/09 | Meta Muse com Stripe Link |
| 09/09 | TRM Labs: só 0,6–7,5% do x402 é agente; Mastercard Agent Connect |
| 10/09 | KYA interoperável Visa + Mastercard + Ant |
| 15/09 | CLARITY Act trava no Senado (49–50) |
| 16/09 | Circle Arc mainnet (validadores BlackRock, Visa, Mastercard, DTCC) |
| 18/09 | OCC aprova condicionalmente Catena Trust Bank; Kite + Circle escrow na Arc |
| 22/09 | BlackRock "Machine-Native Economy"; Baselayer US$ 35 M |
| 23/09 | Seis bancos globais publicam princípios de comércio agêntico confiável |
| 26/09 | Circle Agent Marketplace |
| 27/09 | Tether WDK com MCP; Lemma grava reputação ERC-8004 na Arbitrum |
| 29/09 | Fed Waller na Sibos; OpenAI "dots"; Stripe Link 38x em compras agênticas |
| 30/09 | Cloudflare Monetization Gateway (x402/USDC); Mastercard AI Probability Score |
| 01/10 | Arc Agent Venue: agentes contratando agentes com escrow + ERC-8004 + ERC-8183; Res. BCB 561 em vigor |
| 06/10 | Amex Playbook de comércio agêntico; Coinbase reporta 205 M tx no x402 |

**Contra-sinais honestos:** Virtuals ACP v1 moribundo no indexador; Olas com US$ 110 mil de turnover total; Giza, Almanak e elizaOS encerrados ou colapsados; reputação ERC-8004 Sybil e manipulável por centavos; volume agentic real no x402 de US$ 5–11 mil/mês; OpenAI Instant Checkout descontinuado; 3% das transações de lojistas com agentes; CLARITY travado.

---

## 10. Implicação para o AgentFi

1. **A tese do VISION.md foi adotada pelos incumbentes** (Coinbase, Stripe, Visa, Mastercard, AWS, Circle, EF) em 2026. Isso é o sinal de que "o mercado está para começar a funcionar", e também o sinal de que a parte genérica (carteira + limites) já tem dono.
2. **Commodity:** carteira MPC, limites de gasto por sessão, kill switch, simulação. Coinbase, MetaMask, AWS, Circle entregam isso de graça ou embutido. Não reconstruir.
3. **Falhou:** checkout in-chat B2C sem mandato; agente de yield como produto de varejo; modelos token-first.
4. **Espaço aberto e alinhado ao código existente:** escrow A2A compatível com ERC-8183 + reputação ERC-8004 ancorada em prova de interação (escrow liquidado) + execução DeFi via MCP para Claude/Codex sobre x402/MPP. É uma **camada de confiança** sobre trilhos de terceiros, não mais uma carteira.
5. **Risco principal continua sendo demanda**, não tecnologia: a barreira técnica caiu tanto que um indie montou o caso de uso em semanas (Arc Agent Venue). O que separa um projeto de um produto é um operador real com o problema.
6. **A McKinsey (set/2026) confirma o posicionamento D1 e tempera o timing:** mandato, guardrails em runtime, proteção de transação delegada e identidade de máquina são exatamente a camada onde o relatório espera a receita; o caso agente-a-agente é o mais imaturo e deve ser validado com um operador B2B, não com varejo; o modelo de receita por bps vira hipótese a testar nas entrevistas (plano §5.4), porque o relatório espera preço por mandato, por chamada ou por prêmio de proteção.

---

## Fontes

Protocolos e trilhos:
https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications · https://x402.org/blog/ · https://www.chainalysis.com/blog/x402-agentic-payments-adoption/ · https://www.trmlabs.com/trm-tech-blog/whos-actually-paying-measuring-ai-agent-payments-onchain · https://decrypt.co/378103/ai-agents-spending-money-research · https://www.coindesk.com/tech/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet · https://aws.amazon.com/about-aws/whats-new/2026/08/bedrock-agentcore-payments-ga/ · https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-payments-is-now-generally-available-enabling-agents-to-transact-safely-and-autonomously-at-scale/ · https://thedefiant.io/news/defi/cloudflare-monetization-gateway-x402-stablecoin-payments · https://fortune.com/2026/09/30/cloudflare-tool-businesses-ai-agents-stablecoins/ · https://www.pymnts.com/cryptocurrency/2026/coinbase-debuts-crypto-wallet-infrastructure-for-ai-agents/ · https://thedefiant.io/news/defi/base-mcp-agent-gateway-launch-2p8bh1 · https://www.fool.com/earnings/call-transcripts/2026/08/03/coinbase-coin-q2-2026-earnings-call-transcript/ · https://metamask.io/news/metamask-launches-agent-wallet-giving-ai-agents-full-defi-access-with-default-security-on-every-transaction · https://www.theblock.co/post/403865/metam · https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet · https://crypto.news/circle-arc-mainnet-launches-with-usdc-gas/ · https://www.coindesk.com/tech/2026/03/18/stripe-led-payments-blockchain-tempo-goes-live-with-protocol-for-ai-agents · https://stripe.com/blog/everything-we-announced-at-sessions-2026 · https://stripe.com/blog/helping-personal-agents-shop-more-intelligently-and-reliably-with-link · https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/ · https://www.axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards · https://shopify.engineering/UCP · https://eips.ethereum.org/EIPS/eip-8004 · https://www.forbes.com/sites/digital-assets/2026/02/05/ai-agents-gain-trust-via-ethereum-erc-8004-on-mainnet/ · https://arxiv.org/html/2606.26028 · https://arxiv.org/html/2606.12128v1 · https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902 · https://blockeden.xyz/blog/2026/03/10/erc-8183-agentic-commerce-standard-ai-agent-transaction-stack/ · https://safefoundation.org/reports/q2-2026 · https://docs.safe.global/home/ai-agent-setup

Cartões, bancos, reguladores:
https://investor.visa.com/news/news-details/2026/Visa-Announces-New-AI-Stablecoin-and-Token-Innovations-to-Power-Intelligent-Programmable-Commerce-at-Visa-Payments-Forum/default.aspx · https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Launches-Agent-Pay-for-Machines-to-Unlock-Super-Fast-Always-On-Payments/default.aspx · https://theblock.co/post/404288/mastercard-agent-pay-machines-support-autonomous-ai-transactions-stablecoins · https://www.mastercard.com/us/en/news-and-trends/press/2026/september/new-trust-and-intelligence-services.html · https://theblock.co/post/410521/mastercard-completes-bvnk-acquisition · https://www.americanexpress.com/en-us/newsroom/articles/innovation/american-express-debuts-agentic-commerce-experiences--ace--devel.html · https://www.americanbanker.com/news/occ-approves-trust-charters-for-bastion-agora-and-catena · https://catena.com/blog/catena-receives-conditional-occ-approval-for-a-national-trust-bank-built-for-ai-agents · https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance · https://www.federalreserve.gov/newsevents/speech/files/waller20260929a.pdf · https://newsroom.bankofamerica.com/content/newsroom/press-releases/2026/09/global-banks-collaborate-on-principles-for-trusted-agentic-comme.html · https://www.disruptionbanking.com/2026/09/25/blackrock-paper-says-ai-agents-could-add-demand-for-stablecoins/

Big techs:
https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation · https://www.digitalcommerce360.com/2026/09/02/anthropic-debuts-claude-features-focused-on-agentic-commerce/ · https://www.crowdfundinsider.com/2026/09/306341-anthropic-unveils-claude-commerce-agents-partners-with-visa-and-mastercard/ · https://www.cnbc.com/2026/03/20/open-ai-agentic-shopping-etsy-shopify-walmart-amazon.html · https://www.shopifreaks.com/openai-pivots-from-instant-checkout-to-an-app-based-shopping-model-inside-chatgpt/ · https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/ · https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/ · https://thepaypers.com/payments/news/meta-launches-personal-ai-agent-with-stripe-powered-checkout · https://newsroom.paypal-corp.com/2026-01-08-PayPal-Powers-Microsofts-Launch-of-Copilot-Checkout · https://techwireasia.com/2026/09/agentic-payments-ant-international-amp-phase-one-wallets/

Economias A2A e chains:
https://agenteconomy.to/erc-8004 · https://agenteconomy.to/virtuals-acp · https://whitepaper.virtuals.io/acp/acp-changelogs · https://olas.network/blog/q2-2026 · https://olas.network/mech-marketplace · https://ownyourmind.ai/projects/elizaos/ · https://ownyourmind.ai/projects/giza/ · https://defillama.com/protocol/almanak · https://app.agentum.space/ · https://dev.to/spread2009/agents-hiring-agents-the-public-venue-is-live-on-arc-settled-in-usdc-2mid · https://www.kucoin.com/news/flash/kite-and-circle-collaborate-on-agent-service-transactions-via-arc-and-usdc · https://arbitrumfoundation.medium.com/trailblazer-2-0-1m-in-grants-to-power-agentic-defi-on-arbitrum-9534aa3fe541 · https://messari.io/report/state-of-solana-q1-2026 · https://solana.com/agent-registry · https://github.com/4waan/Lemma/pull/54

Regulação, funding, mercado:
https://www.federalregister.gov/documents/2026/03/02/2026-04089/ · https://www.orrick.com/en/Insights/2026/10/The-CLARITY-Act-Stalls-in-the-Senate-Whats-Next-for-Digital-Asset-Regulation · https://www.sec.gov/newsroom/press-releases/2026-30-sec-clarifies-application-federal-securities-laws-crypto-assets · https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes · https://www.bakermckenzie.com/en/insight/publications/2026/07/singapore-mas-publishes-agentic-ai-safeguards-for-financial-institutions · https://lefosse.com/noticias/alerta/banco-central-do-brasil-publica-resolucao-que-atualiza-o-servico-de-pagamento-ou-transferencia-internacional-efx/ · https://www.demarest.com.br/banco-central-promove-alteracoes-nas-regras-relativas-ao-servico-de-pagamento-e-transferencia-internacional-efx/ · https://vbso.com.br/as-sociedades-prestadoras-de-servicos-de-ativos-virtuais-e-o-prazo-de-30-de-outubro-de-2026/ · https://finsidersbrasil.com.br/regulamentacao/avanco-dos-agentes-de-ia-esbarra-na-falta-de-regulamentacao/ · https://techcrunch.com/2026/07/20/natural-raises-30m-to-reinvent-payments-for-ai-agents-and-take-on-stripe/ · https://fortune.com/2026/06/03/variant-raises-220-million-for-new-fund-focused-on-ai-and-crypto-autonomy-thesis/ · https://a16z.com/newsletter/big-ideas-2026-part-3/ · https://cointelegraph.com/news/paypal-ventures-backs-kite-ai-with-18m-to-power-ai-agents · https://www.juniperresearch.com/press/agentic-commerce-set-to-generate-15-trillion-globally-by-2030-as-payments-infrastructure-leaders-revealed/ · https://cryptoslate.com/staggering-28-trillion-is-flowing-through-cryptos-agent-economy-but-76-of-it-is-just-bots-shuffling-stablecoins/ · https://decrypt.co/364727/ai-agents-already-run-a-fifth-of-defi-but-still-lose-to-humans-at-trading · https://forkast.news/the-trust-paradox-agent-payment-infrastructure-is-outpacing-consumer-readiness/
