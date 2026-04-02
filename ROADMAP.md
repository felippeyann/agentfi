# ROADMAP — AgentFi

Este documento delineia o roadmap de desenvolvimento técnico e evolução de negócios do **AgentFi**. Ele foi desenhado para escalar progressivamente a infraestrutura, mantendo o foco em ser a fronteira definitiva de autonomia financeira para agentes de IA.

---

## Fase 1: Bootstrap & Fundação Arquitetural (Atual)
*Entregáveis primários de infraestrutura "Developer-First"*

- [x] Definição de Arquitetura (Monorepo)
- [x] Integração MPC (Turnkey) e Abstração de Contas (Safe & Smart Contracts base)
- [x] Criação do MCP (Model Context Protocol) Server
- [x] Orquestração de Backend (Fila BullMQ, Retry policies, Fallback Infura/Alchemy)
- [x] Testes End-to-End no fork local e Testnet
- [ ] Lançamento V1 (Auto-Hospedado) focado na adoção orgânica pelos desenvolvedores de LLMs.

---

## Fase 2: Escala & Previsibilidade Operacional
*Melhorias contínuas para manter a sustentabilidade da operação.*

- **Verificação Periódica de Pricing do Turnkey:**
  - Manter o Turnkey como fundação de MPC, mas programar reavaliações trimestrais de custos das APIs SaaS.
  - Monitorar alternativas caso a precificação escale assimetricamente.
- **Ecossistema de Adapters (Foco em MCP e Frameworks):**
  - Fortalecer a distribuição nos maiores diretórios de LLMs (MCP.so, Smithery, ElizaOS, Langchain).

---

## Fase 3: Evolução de Modelo de Adoção ("AgentFi-as-a-Service")
*Mitigação de atrito para engenheiros focados unicamente em IA.*

- **Problema:** A exigência de conhecimentos DevOps (configurar vars, levantar nós, rodar banco de dados Postgres e BullMQ via Docker) pode ser uma fricção enorme para times focados só em IA.
- **Evolução Planejada:** Desenvolver paralelamente a versão totalmente gerenciada via nuvem (SaaS). 
- **Objetivo:** O operador se cadastra na plataforma AgentFi e adquire os endpoints e chaves imediatamente (Estilo infraestrutura "Stripe for Agents"), sem precisar lidar com rodar instâncias localmente ou se preocupar com uptime dos nós.

---

## Fase 4: O Frontier Market e Volume Autônomo
*Visão de longo prazo focada no resultado gerado como consequência.*

- Otimização extrema para volume institucional de agentes, consolidando o AgentFi como o protocolo de transações dominante.
- Integração profunda com governança distribuída baseada em agentes e expansão de DeFi actions sem fricção.
- Como estipulado no documento `VISION.md`, o lucro será derivado naturalmente do scale no longo prazo; o foco total permanece em liberar aos agentes a capacidade plena de executar atividades on-chain e orquestrar ideias financeiramente sustentáveis.
