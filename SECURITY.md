# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly at **security@agentfi.io** (or the email listed in `package.json`). We aim to acknowledge reports within **48 hours** and provide a fix or mitigation plan within **7 days**.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected component (backend, contracts, admin, MCP server)
- Potential impact assessment
- Suggested fix (if any)

### Process

1. You report the vulnerability privately.
2. We acknowledge receipt within 48 hours.
3. We investigate and develop a fix.
4. We release the fix and credit you (unless you prefer anonymity).
5. We publish a security advisory after the fix is deployed.

### Scope

The following are in scope for security reports:

- Smart contracts (`packages/contracts/`)
- Backend API (`packages/backend/`)
- Admin dashboard (`packages/admin/`)
- MCP server (`packages/mcp-server/`)
- CI/CD pipeline and deployment configurations

### Out of Scope

- Issues in third-party dependencies (report to the upstream project)
- Social engineering attacks
- Denial of service attacks against test/staging environments

## Security Best Practices

- All API keys are hashed with SHA-256 before storage
- Transaction simulation via Tenderly before on-chain execution
- On-chain policy enforcement via AgentPolicyModule (Safe module)
- MPC wallet infrastructure via Turnkey (no raw private keys)
- Rate limiting on all API endpoints
- Input validation via Zod on all routes
