# Release Guide - @agent_fi/mcp-server

This document describes how to publish the standalone AgentFi MCP server to
npm. The prepared 0.6.0 package, with the checked changelog entry, the tarball
check and the tag plan, is in
[`docs/operations/mcp-0.6.0-release-package.md`](../../docs/operations/mcp-0.6.0-release-package.md).

Current source version: **0.5.0** (the field in `package.json`; the bump to 0.6.0 is part of the release commit)
Current published npm version: **0.5.0** (2026-05-15, 31 tools, no x402)
Status: **0.6.0 prepared, not published. Source on `main` has 35 tools (adds `pay_for_resource`, `get_job`, `check_outbox`, `contest_job`). Publishing, the tag and the GitHub release are owner decisions.**

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

## What ships

`package.json` has `"files": ["dist", "README.md", "LICENSE"]`, and `prepack`
deletes `dist` and rebuilds it with `tsc -p tsconfig.build.json` (no tests in
`dist`) on every `npm pack` and `npm publish`. Check before publishing:

```bash
cd packages/mcp-server && npm pack --dry-run     # 71 files, no src/ and no tests
```

## Bump commit (before publishing, through a PR)

Four edits in one commit: `packages/mcp-server/package.json` `version`, the
`packages/mcp-server` entry of `package-lock.json`, `SERVER_VERSION` in
`src/server.ts` (it is what `initialize` reports; `src/__tests__/version.test.ts`
fails if it differs from `package.json`), and the changelog entry in the root
`CHANGELOG.md`. Exact steps: section 5.1 of the release package page.

## Publish

From the repo root, on `main` after the bump PR is merged:

```bash
git checkout main
git pull --ff-only origin main

npm ci
npm view @agent_fi/mcp-server version
npm publish -w packages/mcp-server --access public --dry-run
npm publish -w packages/mcp-server --access public
```

If npm asks for two-factor authentication:

```bash
npm publish -w packages/mcp-server --access public --otp 123456
```

Replace `123456` with the current one-time code from the npm account.

## Tag and GitHub Release

No workflow reacts to a tag or a release (checked in
`.github/workflows/*.yml`); the tag plan, including the repository alpha tag,
is in section 6 of the release package page. After npm publish succeeds:

```bash
git tag mcp-server-v0.6.0 <bump-commit-sha>
git push origin mcp-server-v0.6.0

gh release create mcp-server-v0.6.0 --verify-tag --title "mcp-server v0.6.0" --notes-file <notes-file>
```

## Verify the Publish

```bash
npm view @agent_fi/mcp-server version
# Expected: 0.6.0
```

The server has no `--help` flag: it starts the stdio server. Check the tool
list over stdio instead, from an empty directory:

```bash
npm init -y && npm install @agent_fi/mcp-server@0.6.0
# send initialize + tools/list on stdin of `npx agentfi-mcp`; expect 35 tools
# (the probe used for the 0.6.0 check is described in section 4 of the release package page)
```

Also verify the package metadata page:

- https://www.npmjs.com/package/@agent_fi/mcp-server

## Versioning

- Patch (`0.4.0` -> `0.4.1`): bug fixes, docs/package metadata, no tool shape changes
- Minor (`0.4.0` -> `0.5.0`): new MCP tools or non-breaking additions
- Major/pre-1.0 minor (`0.4.0` -> `0.5.0`): breaking tool signature changes, removals, or renamed tools

For pre-1.0 releases, treat breaking changes as a clean minor bump and keep the
release focused on that one reason.

## Current Tool Inventory (source on `main`, 0.6.0)

35 tools across DeFi execution, A2A collaboration and escrow jobs, x402
payments, trust, policy, and P&L. (npm 0.5.0 has the 31 tools without the four
marked **new**.)

**Wallet & balances (2):** `get_wallet_info`, `get_token_price`

**Swaps (3):** `simulate_swap`, `execute_swap`, `swap_curve`

**Transfers (1):** `transfer_token`

**Yield - Aave V3 (3):** `deposit_aave`, `withdraw_aave`, `get_defi_rates`

**Yield - Compound V3 (2):** `supply_compound`, `withdraw_compound`

**Yield - ERC-4626 generic (2):** `deposit_erc4626`, `withdraw_erc4626`

**Perpetuals - GMX V2 (3):** `list_gmx_markets`, `open_gmx_position`, `close_gmx_position`

**Transaction status and policy (2):** `get_transaction_status`, `get_policy`

**Agent-to-Agent economy and escrow jobs (17):** `get_my_agent_profile`, `get_my_pnl`,
`search_agents`, `get_agent_manifest`, `set_my_manifest`,
`get_agent_trust_report`, `post_job`, `check_inbox`, `update_job_status`,
`pay_agent`, `update_policy`, `sign_handshake`, `verify_handshake`,
**new:** `get_job`, `check_outbox`, `contest_job`, `pay_for_resource`

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

After `0.6.0` is published:

1. Update the mcp.so listing to reference `@agent_fi/mcp-server@0.6.0` and
   mention `pay_for_resource` and the escrow job tools (35 tools).
2. Update the awesome-mcp-servers PR #5091 tool count (31 -> 35).

Suggested listing:

- **Name:** AgentFi MCP Server
- **Package:** `@agent_fi/mcp-server`
- **Description:** Spend controls and x402 payments for AI agents over MCP:
  budgeted pay-per-resource calls, escrowed A2A jobs, policy, trust, and P&L
  (developer alpha, self-hosted)
- **GitHub:** https://github.com/felippeyann/agentfi
- **npm:** https://www.npmjs.com/package/@agent_fi/mcp-server
