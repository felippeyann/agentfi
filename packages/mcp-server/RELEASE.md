# Release Guide - @agent_fi/mcp-server

This document describes how to publish the standalone AgentFi MCP server to
npm.

Current source version: **0.4.0**
Current published npm version: **0.3.0**
Status: **0.4.0 is ready in source, but publish is blocked until an npm account
with access to the `@agent_fi` org can authenticate.**

## Prerequisites

- npm account with publish access to the `@agent_fi` organization
- Local clone of `felippeyann/agentfi`, on `main`, up to date
- Clean git workspace
- npm auth completed and verified:

```bash
npm login --scope=@agent_fi
npm whoami
```

If passkey login fails, use npm account recovery in the browser first. Do not
force a publish from an unauthenticated or unrelated account; the package scope
must stay `@agent_fi`.

## Publish 0.4.0

From the repo root:

```bash
git checkout main
git pull --ff-only origin main

npm view @agent_fi/mcp-server version
npm run build -w packages/mcp-server
npm publish -w packages/mcp-server --access public --dry-run
npm publish -w packages/mcp-server --access public
```

If npm asks for two-factor authentication:

```bash
npm publish -w packages/mcp-server --access public --otp 123456
```

Replace `123456` with the current one-time code from the npm account.

## Tag and GitHub Release

After npm publish succeeds:

```bash
git tag mcp-server-v0.4.0
git push origin mcp-server-v0.4.0

gh release create mcp-server-v0.4.0 \
  --title "mcp-server v0.4.0" \
  --notes "Adds get_my_agent_profile and get_my_pnl MCP tools. See CHANGELOG.md for details."
```

## Verify the Publish

```bash
npm view @agent_fi/mcp-server version
# Expected: 0.4.0

npx @agent_fi/mcp-server --help
```

Also verify the package metadata page:

- https://www.npmjs.com/package/@agent_fi/mcp-server

## Versioning

- Patch (`0.4.0` -> `0.4.1`): bug fixes, docs/package metadata, no tool shape changes
- Minor (`0.4.0` -> `0.5.0`): new MCP tools or non-breaking additions
- Major/pre-1.0 minor (`0.4.0` -> `0.5.0`): breaking tool signature changes, removals, or renamed tools

For pre-1.0 releases, treat breaking changes as a clean minor bump and keep the
release focused on that one reason.

## Current Tool Inventory (0.4.0)

28 tools across DeFi execution, A2A collaboration, trust, policy, and P&L.

**Wallet & balances (2):** `get_wallet_info`, `get_token_price`

**Swaps (3):** `simulate_swap`, `execute_swap`, `swap_curve`

**Transfers (1):** `transfer_token`

**Yield - Aave V3 (3):** `deposit_aave`, `withdraw_aave`, `get_defi_rates`

**Yield - Compound V3 (2):** `supply_compound`, `withdraw_compound`

**Yield - ERC-4626 generic (2):** `deposit_erc4626`, `withdraw_erc4626`

**Transaction status and policy (2):** `get_transaction_status`, `get_policy`

**Agent-to-Agent economy (13):** `get_my_agent_profile`, `get_my_pnl`,
`search_agents`, `get_agent_manifest`, `set_my_manifest`,
`get_agent_trust_report`, `post_job`, `check_inbox`, `update_job_status`,
`pay_agent`, `update_policy`, `sign_handshake`, `verify_handshake`

## Troubleshooting

### `npm publish` returns `ENEEDAUTH`

The machine is not logged in to npm. Run:

```bash
npm login --scope=@agent_fi
npm whoami
```

If passkey login fails, recover the npm account/passkey in the npm website. This
is an account-level blocker, not a repo or package problem.

### `npm publish` returns `E403`

The authenticated account does not have publish access to `@agent_fi`. Add the
account to the npm organization/package with publish rights, then retry.

### `npm publish` returns `EOTP`

The account requires 2FA for publish. Re-run with `--otp <code>`.

### `npm publish` returns `404`

The package scope is not visible to the authenticated account, or the org/package
permissions are wrong. Confirm the package page and org access in npm.

### TypeScript build fails

Run from the repo root:

```bash
npm ci
npm run typecheck --workspaces --if-present
npm run build -w packages/mcp-server
```

## Directory Follow-Ups

After `0.4.0` is published:

1. Update the mcp.so listing so the install config no longer points at the stale
   `@agent_fi/mcp-server@0.2.0` package reference.
2. Check https://github.com/punkpeye/awesome-mcp-servers/pull/5091 and update
   the PR if maintainers request changes.

Suggested listing:

- **Name:** AgentFi MCP Server
- **Package:** `@agent_fi/mcp-server`
- **Description:** Crypto transaction and A2A economy tools for AI agents:
  swaps, yield, transfers, policy, trust, jobs, and P&L on Ethereum/Base/
  Arbitrum/Polygon
- **GitHub:** https://github.com/felippeyann/agentfi
- **npm:** https://www.npmjs.com/package/@agent_fi/mcp-server
