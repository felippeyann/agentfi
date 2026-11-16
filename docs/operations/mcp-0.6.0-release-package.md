# `@agent_fi/mcp-server` 0.6.0 — release package (PREPARED, NOT PUBLISHED)

Prepared 2026-11-16 on `origin/main` `0173409`. **Nothing here was published, tagged or version-bumped.** `packages/mcp-server/package.json` still says `0.5.0`. Publishing is an explicit distribution gate for the owner, not a consequence of merging this page.

Until 0.6.0 is published, the install path for the x402 features is a **git checkout or tag** (section 6).

## 1. State of the package

| | |
|---|---|
| npm `latest` | `0.5.0`, last modified 2026-05-15 (checked 2026-11-16 with `npm view`); **31 tools, no x402** |
| source on `main` | version field `0.5.0`; **35 tools** (verified: a built `dist/index.js` answers `tools/list` with 35) |
| tools added since `mcp-server-v0.5.0` | `pay_for_resource`, `get_job`, `check_outbox`, `contest_job` |
| tests | `npx vitest run` in `packages/mcp-server`: 9 files, 163 tests passed on this checkout |

## 2. Draft CHANGELOG entry (to paste under `## [0.6.0]` at release time)

Derived from `git log mcp-server-v0.5.0..HEAD -- packages/mcp-server` (73 commits) and the existing `[Unreleased]` entries of `CHANGELOG.md`.

```markdown
## [@agent_fi/mcp-server 0.6.0] — YYYY-MM-DD

### Added
- `pay_for_resource` — the provider of an ACCEPTED job pays an x402 (HTTP 402) resource within the job's remaining USDC budget, under the agent's policy (`POST /v1/jobs/{id}/pay-resource`). Structured refusals (`BUDGET_EXCEEDED`, `POLICY_VIOLATION`, `PAYMENT_OUTCOME_UNKNOWN`, ...) are passed through. Job-scoped only: there is no standalone purchase tool.
- `get_job`, `check_outbox`, `contest_job` — the ERC-8183 escrow job flow (read a job with its `escrow` object, list jobs I posted, dispute a submitted deliverable).
- Every tool carries a `title` and the four MCP annotations (`annotations.ts`).
- `update_policy` / `get_policy` expose the Q8 fields (`maxValuePerTxUsd`, `allowedRecipients`) and `maxOutflowPerTxUsd`.
- `transfer_token` takes an optional `idempotency_key`.

### Changed (breaking for callers)
- `post_job`: a paid job must name its chain and token (`chain_id`; USDC by default).
- `sign_handshake` / `verify_handshake`: handshakes are a domain-separated EIP-712 envelope.
- `pay_agent` sends the transfer route's `TransferRequest` (`to` plus ETH or a registry address); native `"ETH"` is refused where the chain's native asset is not ETH; transfer addresses are validated with viem's strict rule.

### Fixed
- Tool errors are sanitized before they reach the client (no RPC keys, internal hosts or paths).
- Token map: Polygon USDT, Arbitrum WBTC and other mistyped third-party addresses corrected.

### Notes
- Still not available through this package: Safe mode, a hosted service, anything on a public network.
- npm 0.5.0 users: the tool set above is new; update the client config and re-list tools.
```

Before publishing, re-check each bullet against the diff of `packages/mcp-server/src` and the `[Unreleased]` entries; this draft was assembled from commit subjects and CHANGELOG text, not from a line-by-line review of every commit.

## 3. `npm pack --dry-run` (run 2026-11-16 after `npm run build -w packages/mcp-server`)

```text
name: @agent_fi/mcp-server   version: 0.5.0 (current field; will be 0.6.0 after the bump)
package size: 208.6 kB   unpacked size: 1.0 MB   total files: 102
```

Contents: `dist/**` (JS, `.d.ts`, maps: the runtime), `package.json`, `nixpacks.toml`, `tsconfig*.json`, `vitest.config.ts`, and **`src/**` including `src/__tests__/*` and `src/api.generated.ts` (216 kB)**. `README.md` and `RELEASE.md` are included by npm by default.

Findings:

1. **There is no `files` field in `package.json`**, so source, tests, `nixpacks.toml` and config files ship in the tarball. Harmless but wasteful (it also publishes the test fixtures). Recommended before 0.6.0: `"files": ["dist", "README.md"]` (the build excludes tests from `dist`, verified: `dist/__tests__` does not exist). This is a package change and was **not** made here.
2. `dist/index.js` starts with `#!/usr/bin/env node` and `bin.agentfi-mcp` points at it, so `npx @agent_fi/mcp-server` runs the stdio server. Verified locally with a JSON-RPC `initialize` + `tools/list` over stdin against `node dist/index.js`.
3. `npx @agent_fi/mcp-server --help` (as written in the old `RELEASE.md` "Verify the Publish") does **not** print help: `src/index.ts` does no argument parsing. Use the `tools/list` check below instead.
4. `tsx` is listed under `dependencies` (used by the `start` script); the published runtime only needs `dist`. Not a blocker.

## 4. Validation commands

From the repository root, on a clean checkout of the release commit:

```bash
npm ci
npm run build -w packages/mcp-server
(cd packages/mcp-server && npx vitest run)
npm run spec:check            # api.generated.ts matches docs/api/openapi.yaml
(cd packages/mcp-server && npm pack --dry-run)
# tool count over stdio (expects 35)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node packages/mcp-server/dist/index.js | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=s.trim().split('\n').map(JSON.parse).find(x=>x.id===2);console.log(r.result.tools.length)})"
```

## 5. Publish commands (LEFT FOR THE GATE — do not run before the owner's go)

Preconditions: owner approval for distribution; `npm whoami` is the account with publish access to the `@agent_fi` scope; clean tree on `main`; CI green; the `files` decision above; `packages/mcp-server/RELEASE.md` header refreshed (it still says "published 0.4.0 / 0.5.0 ready to publish", which is stale).

```bash
git checkout main && git pull --ff-only origin main
npm version 0.6.0 --no-git-tag-version -w packages/mcp-server
# edit CHANGELOG.md: paste section 2; refresh package-lock.json if npm changed it
git add -A && git commit -m "chore(release): @agent_fi/mcp-server 0.6.0"   # via a PR, per the repo's rules
npm run build -w packages/mcp-server
npm publish -w packages/mcp-server --access public --dry-run
npm publish -w packages/mcp-server --access public            # add --otp <code> if asked
git tag mcp-server-v0.6.0 && git push origin mcp-server-v0.6.0
gh release create mcp-server-v0.6.0 --title "mcp-server v0.6.0" --notes-file <notes-file>
npm view @agent_fi/mcp-server version                          # expect 0.6.0
```

After publishing: update the README install section to say the x402 tools are in the package, and drop the "0.5.0 / 31 tools" caveats in `README.md`, `packages/mcp-server/README.md` and `STATE.md`.

## 6. Alternative: reproducible path by checkout or tag (works today)

```bash
git clone https://github.com/felippeyann/agentfi && cd agentfi
git checkout <tag-or-commit>        # the commit the alpha quickstart names
npm ci
npm run build -w packages/mcp-server
AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=<agent key> node packages/mcp-server/dist/index.js
```

In an MCP client config use `"command": "node", "args": ["<abs path>/packages/mcp-server/dist/index.js"]` with the same two environment variables. The environment variable for the backend is `AGENTFI_API_URL` (not a `--backend` flag; the server has no CLI flags).

## 7. Install claims in the docs, checked 2026-11-16

| Claim | Where | Result |
|---|---|---|
| `npm install @agent_fi/mcp-server` / `npx @agent_fi/mcp-server` | `packages/mcp-server/README.md` | exists (0.5.0); installs 31 tools **without** x402. README already carries a source-vs-npm note |
| `npx -y @agent_fi/mcp-server --backend ... --api-key ...` | `docs/operations/production-deploy.md` | **wrong**: no CLI flags exist; fixed to `AGENTFI_API_URL` / `AGENTFI_API_KEY` |
| `npx @agentfi/mcp-server` (no underscore) | `docs/agents/claude-instructions.md` | **wrong scope**; the package is `@agent_fi/mcp-server`; fixed |
| `pip install agentfi-langchain` | `docs/agents/claude-instructions.md` | **does not exist** on PyPI (`pip index versions`: no matching distribution); marked as not published |
| `npm install @agentfi/adapters` | `packages/adapters/README.md` | **does not exist** on npm (E404); the code names it `@agentfi/adapters`, not `@agent_fi/adapters`. Owned by the interop front; reported, not changed here |
| `npx -y <package>` via `AGENTFI_MCP_PACKAGE` | `docs/demos/claude-desktop-mcp.md` | placeholder by design; default path is the checkout |
| `pip install graphifyy` | `docs/graphify.md` | developer tooling, not an AgentFi package; not checked |
