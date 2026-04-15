# Release Guide — @agent_fi/mcp-server

This document describes how to publish new versions of the MCP server to npm.

Current version: **0.2.0**

## Prerequisites

- npm account with access to the `@agent_fi` organization
- `npm login` completed (check with `npm whoami`)
- Local clone of the `felippeyann/agentfi` repo, on `main` branch, up to date

## Publishing a new version

### 1. Bump the version in `package.json`

Follow semver:
- **Patch** (`0.2.0` → `0.2.1`): bug fixes, doc updates, no behavior changes
- **Minor** (`0.2.0` → `0.3.0`): new MCP tools or non-breaking additions
- **Major** (`0.2.0` → `1.0.0`): breaking changes (tool signature changes, removals)

Update `packages/mcp-server/package.json`:
```json
"version": "0.3.0"
```

### 2. Update the keywords if new protocols are added

If new DeFi protocols are wrapped, add them to the `keywords` array:
```json
"keywords": ["mcp", "defi", "ethereum", "ai-agents", "uniswap", "aave", "compound", "curve", "erc4626", "yearn"]
```

### 3. Run the publish sequence

From the repo root:
```bash
# Pull latest main
git checkout main
git pull origin main

# Go to the package
cd packages/mcp-server

# Build the package
npm run build

# Dry run — inspect what will be published
npm publish --access public --dry-run

# Publish for real
npm publish --access public
```

### 4. Create a git tag and GitHub release

From the repo root:
```bash
# Tag the release (version-prefixed to avoid collision with root release tags)
git tag mcp-server-v0.3.0
git push origin mcp-server-v0.3.0

# Create a GitHub release
gh release create mcp-server-v0.3.0 \
  --title "mcp-server v0.3.0" \
  --notes "See CHANGELOG.md for details"
```

### 5. Verify the publish

```bash
npm view @agent_fi/mcp-server version
# Should output: 0.3.0

npx @agent_fi/mcp-server --help
# Should print the CLI help
```

## Current tool inventory (v0.2.0)

16 tools across 6 categories:

**Wallet & balances (3):** `get_wallet`, `get_balance`, `get_allowances`

**Swaps (3):** `simulate_swap`, `execute_swap`, `swap_curve`

**Transfers (1):** `execute_transfer`

**Yield — Aave V3 (2):** `supply_aave`, `withdraw_aave`

**Yield — Compound V3 (2):** `supply_compound`, `withdraw_compound`

**Yield — ERC-4626 generic (2):** `deposit_erc4626`, `withdraw_erc4626`

**Transaction status (2):** `get_transaction_status`, `list_transactions`

**Agent policy (1):** `get_agent_policy`

## Troubleshooting

### `npm publish` returns 404

The org `@agent_fi` may not exist yet on your npm account.  Create it at https://www.npmjs.com/org/create.

### Authentication fails

Run `npm login` and complete the browser flow. Verify with `npm whoami`.

### Typescript build fails

Run `npm ci && npm run typecheck` from repo root first to catch upstream issues.

## Submitting to MCP directories

After publishing to npm, submit the package to discovery directories:

1. **mcp.so** — https://mcp.so/submit
2. **Smithery** — https://smithery.ai/submit
3. **awesome-mcp-servers** — https://github.com/punkpeye/awesome-mcp-servers — open a PR adding AgentFi to the DeFi/Finance section

Suggested listing:

- **Name:** AgentFi MCP Server
- **Package:** `@agent_fi/mcp-server`
- **Description:** Crypto transaction tools for AI agents — swaps (Uniswap, Curve), yield (Aave, Compound, ERC-4626), transfers, and wallet management on Ethereum/Base/Arbitrum/Polygon
- **GitHub:** https://github.com/felippeyann/agentfi
- **npm:** https://www.npmjs.com/package/@agent_fi/mcp-server
