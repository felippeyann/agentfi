# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Migration 0004: ON DELETE CASCADE for Job to Agent foreign keys
- SECURITY.md vulnerability disclosure policy
- CHANGELOG.md release history
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- GitHub issue templates (bug report, feature request)
- GitHub pull request template
- Dependabot configuration for automated dependency updates
- `prisma migrate deploy` step in CI Backend Tests job
- E2E polling helpers: `waitForFeeEvent()` and `waitForDailyVolume()`

### Changed
- A2A handshake endpoints now return 501 until proper Turnkey/EIP-1271 integration
- Branch consolidation: all development unified on `main` (default), `master` deleted
- CI workflow triggers updated from `master` to `main`
- Next.js upgraded from v14 to v16 (admin dashboard)
- Dockerfiles now run as non-root user (`appuser:1001`)

### Fixed
- FK constraint violation in test cleanup (Job records blocking Agent deletion)
- Test cleanup order in agent.search.test.ts and transaction.e2e.ts
- NODE_ENV validation: added 'test' to accepted enum values
- CI Backend Tests: database migrations now applied before running unit tests
- E2E flaky test: FeeEvent assertion now uses polling instead of 2s setTimeout
- npm dependency vulnerabilities (path-to-regexp, picomatch, Next.js HIGH severity)

### Removed
- `desktop.ini` from repository (added to .gitignore)
- Placeholder A2A signature generation (security risk)
- Placeholder A2A verification returning `valid: true` unconditionally

## [0.1.0] - 2026-03-25

### Added
- Initial release
- Agent registration with Turnkey MPC wallets
- Safe smart wallet deployment per agent
- Transaction pipeline: API, Policy, Fee, Queue, Submit, Monitor
- AgentPolicyModule and AgentExecutor smart contracts (Solidity 0.8.24)
- Protocol fee engine (FREE: 30bps, PRO: 15bps, ENTERPRISE: 5bps)
- Human-in-the-Loop (HITL) approval system for high-value transactions
- A2A (Agent-to-Agent) job queue with reputation tracking
- X402 payment protocol with nonce replay protection
- Admin dashboard (Next.js 14)
- MCP server with 10+ DeFi tools
- Multi-chain support (Ethereum, Base, Arbitrum, Polygon)
- E2E test suite with local Anvil node
- Foundry contract tests with coverage
- CI/CD pipeline (GitHub Actions + Railway)
- Documentation hub with operator guides and agent quickstart

[Unreleased]: https://github.com/felippeyann/agentfi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/felippeyann/agentfi/releases/tag/v0.1.0
