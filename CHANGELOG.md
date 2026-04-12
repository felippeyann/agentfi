# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Migration 0004: ON DELETE CASCADE for Job to Agent foreign keys
- SECURITY.md vulnerability disclosure policy
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- GitHub issue and PR templates
- Dependabot configuration for automated dependency updates

### Changed
- A2A handshake endpoints now return 501 until proper Turnkey/EIP-1271 integration
- CI workflow triggers updated from master to main

### Fixed
- FK constraint violation in test cleanup (Job records blocking Agent deletion)
- Test cleanup order in agent.search.test.ts and transaction.e2e.ts
- npm dependency vulnerabilities (path-to-regexp, picomatch)

### Security
- Disabled placeholder A2A signature generation (was returning fake signatures)
- Disabled placeholder A2A verification (was returning valid true unconditionally)

## [0.1.0] - 2026-03-25

### Added
- Initial release
- Agent registration with Turnkey MPC wallets
- Safe smart wallet deployment per agent
- Transaction pipeline: API to Policy to Fee to Queue to Submit to Monitor
- AgentPolicyModule and AgentExecutor smart contracts
- Protocol fee engine (FREE: 30bps, PRO: 15bps, ENTERPRISE: 5bps)
- Admin dashboard (Next.js)
- MCP server with 10+ DeFi tools
- Multi-chain support (Ethereum, Base, Arbitrum, Polygon)
- E2E test suite with local Anvil
- CI/CD pipeline (GitHub Actions + Railway)
- Documentation hub

[Unreleased]: https://github.com/felippeyann/agentfi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/felippeyann/agentfi/releases/tag/v0.1.0
