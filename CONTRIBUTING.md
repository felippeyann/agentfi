# Contributing to AgentFi

Thanks for your interest in contributing. AgentFi is a developer alpha: an open-source, self-hosted API/MCP layer for agents that buy services (x402 spend control, payment and delivery records, reconciliation). Contributions that make that first flow easier to run, safer or better documented are the most useful right now.

> **Before contributing, read the [README](README.md) (current scope) and the [alpha roadmap](docs/project/roadmap-alpha.md).** Every contribution should align with both. [VISION.md](VISION.md) is the long-term background, kept as history.

---

## What we're looking for

Good contributions include:

- **Alpha feedback and integration reports** — try the [quickstart](docs/alpha/quickstart.md) and tell us where it broke ([feedback guide](docs/feedback.md))
- **Integration examples** — a framework example is only listed once it was run on a fixed version (see the [compatibility matrix](docs/integrations/compatibility.md))
- **New DeFi actions** (experimental area) — additional protocols (Balancer, Morpho, etc.)
- **New chain support** — RPC config, contract addresses, decimal handling
- **MCP tool improvements** — better descriptions, input validation, error messages
- **Adapter packages** — tool definitions for new LLM frameworks
- **Bug fixes** — especially around transaction edge cases, error handling, and policy enforcement
- **Documentation** — quickstarts, integration guides, examples with real agent frameworks

Things that are better as a discussion first (open an issue before coding):

- Changes to the fee model or smart contract interfaces
- New queue/worker architectures
- Auth model changes in the admin or backend
- Anything that affects the database schema

---

## Setup

**Requirements:** Node.js 22+, Docker, [Foundry](https://book.getfoundry.sh/getting-started/installation)

```bash
git clone https://github.com/felippeyann/agentfi
cd agentfi
npm install

# Start Postgres and Redis
docker compose up postgres redis -d

# Run migrations
cd packages/backend
npm run db:migrate
cd ../..

# Verify everything works
npm run typecheck
npm test
cd packages/contracts && forge test -vvv
```

You do **not** need Turnkey, Alchemy, or Tenderly credentials to run unit tests. The test suite mocks all external SaaS. You will need them to run the E2E tests against a live fork — see [`packages/backend/src/__tests__/e2e/`](packages/backend/src/__tests__/e2e/).

---

## Project structure

```
packages/
  backend/       Fastify API — transaction pipeline, policy, billing, queues
  mcp-server/    MCP server — the tools agents call (35 in source; includes pay_for_resource)
  admin/         Next.js operator dashboard
  contracts/     Solidity — AgentPolicyModule, AgentExecutor, AgentJobEscrow, ReputationHook
  adapters/      Legacy DeFi-only tool definitions (OpenAI, Anthropic, LangChain, ElizaOS); not published
```

The backend is the source of truth. The MCP server is a thin adapter over the backend's REST API. Changes to DeFi behavior go in the backend; changes to how tools are presented to agents go in the MCP server.

---

## Making a change

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature main
   ```

2. **Write tests** alongside your change. The test suite uses [Vitest](https://vitest.dev). Unit tests live next to source files (`*.test.ts`). E2E tests are in `packages/backend/src/__tests__/e2e/`.

3. **Run the full check** before pushing:
   ```bash
   npm run typecheck
   npm test
   cd packages/contracts && forge test -vvv
   ```
   Every layer (unit, real Postgres, MCP, admin, Anvil E2E, fork rehearsals, the dev smoke), the test environment, the order that matters locally and the known Windows quirks are in [docs/operations/local-validation.md](docs/operations/local-validation.md).

4. **Open a PR** against `main`. Fill in the PR template.

---

## PR expectations

- Keep PRs focused — one logical change per PR
- TypeScript: no `any` without a comment explaining why
- Tests required for new service methods and new API routes
- Solidity changes must include Foundry test coverage
- Commits should be readable: `feat:`, `fix:`, `chore:`, `docs:` prefixes

---

## Reporting bugs and giving feedback

Use the [issue forms](https://github.com/felippeyann/agentfi/issues/new/choose): *Bug report*, *Alpha feedback*, *Integration request* or *Feature request* (blank issues are off). For a bug include the route or tool that failed, the error returned and the mode and chain, with any key redacted.

**Never paste prompts, API keys, private keys, seeds, customer data or logs with secrets.** There is no telemetry; what we ask and never collect is in [docs/feedback.md](docs/feedback.md).

---

## Security issues

Do **not** open a public issue for security vulnerabilities. Use the [private vulnerability reporting form](https://github.com/felippeyann/agentfi/security/advisories/new) (see [SECURITY.md](SECURITY.md)). Include a description of the issue and steps to reproduce. We aim to acknowledge within 48 hours.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
