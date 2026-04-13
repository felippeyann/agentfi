# Contributing to AgentFi

Thanks for your interest in contributing. AgentFi is open-source infrastructure for AI agents to participate in DeFi — contributions that push that mission forward are welcome.

> **Before contributing, read [VISION.md](VISION.md).** It explains the project's purpose, principles, and long-term direction. Every contribution should align with that vision.

---

## What we're looking for

Good contributions include:

- **New DeFi actions** — additional protocols (Balancer, Morpho, Compound, etc.)
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
  mcp-server/    MCP server — the 10 DeFi tools agents call
  admin/         Next.js operator dashboard
  contracts/     Solidity — AgentPolicyModule + AgentExecutor
  adapters/      Tool definitions for OpenAI, Anthropic, LangChain, ElizaOS
```

The backend is the source of truth. The MCP server is a thin adapter over the backend's REST API. Changes to DeFi behavior go in the backend; changes to how tools are presented to agents go in the MCP server.

---

## Making a change

1. **Fork** the repo and create a branch from `develop`:
   ```bash
   git checkout -b feat/your-feature develop
   ```

2. **Write tests** alongside your change. The test suite uses [Vitest](https://vitest.dev). Unit tests live next to source files (`*.test.ts`). E2E tests are in `packages/backend/src/__tests__/e2e/`.

3. **Run the full check** before pushing:
   ```bash
   npm run typecheck
   npm test
   cd packages/contracts && forge test -vvv
   ```

4. **Open a PR** against `develop`, not `main`. Fill in the PR template.

---

## PR expectations

- Keep PRs focused — one logical change per PR
- TypeScript: no `any` without a comment explaining why
- Tests required for new service methods and new API routes
- Solidity changes must include Foundry test coverage
- Commits should be readable: `feat:`, `fix:`, `chore:`, `docs:` prefixes

---

## Reporting bugs

Open a GitHub issue with:
- The route or tool that failed
- Request body (redact any keys)
- The error returned
- Chain ID and transaction type if relevant

---

## Security issues

Do **not** open a public issue for security vulnerabilities. Email the maintainers directly. Include a description of the issue and steps to reproduce. We'll respond within 48 hours.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
