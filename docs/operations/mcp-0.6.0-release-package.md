# `@agent_fi/mcp-server` 0.6.0 — release package (PREPARED, NOT PUBLISHED)

First prepared 2026-11-16; reworked 2026-11-18 on `origin/main` `7e6d7fa` (tarball built and installed, changelog checked against the code, tag plan added). **Nothing here was published, tagged or version-bumped.** `packages/mcp-server/package.json` still says `0.5.0`. Publishing to npm, pushing a public tag and creating a GitHub release are explicit distribution gates for the owner, not a consequence of merging this page.

Until 0.6.0 is published, the install path for the x402 features is a **git checkout of a tag or commit** (section 7).

## 1. State of the package

| | |
|---|---|
| npm `latest` | `0.5.0`, last modified 2026-05-15 (`npm view @agent_fi/mcp-server`, re-checked 2026-11-18); **31 tools, no x402** |
| source on `main` | version field `0.5.0`; **35 tools** |
| tools added since `mcp-server-v0.5.0` | `pay_for_resource`, `get_job`, `check_outbox`, `contest_job` (31 + 4 = 35) |
| tests | `npm test` in `packages/mcp-server`: 10 files, 166 tests passed |
| package contents | explicit `files` list added in this PR (section 3): 71 files, 116.8 kB packed, instead of 102 files, 208.6 kB |
| tarball check | built, installed in an empty directory and started through `node`, `npx agentfi-mcp` and the Windows `.cmd` shim: 35 tools over stdio (section 4) |

## 2. CHANGELOG entry (paste under `## [@agent_fi/mcp-server 0.6.0]` at release time)

Checked 2026-11-18 against `git diff mcp-server-v0.5.0..origin/main -- packages/mcp-server/src` (the tool code, not only commit subjects) and the 76 commits of `git log mcp-server-v0.5.0..HEAD -- packages/mcp-server`. The 2026-11-16 draft was **incomplete**: it missed that `update_policy` can only tighten, that `verify_handshake` takes a new required input, that `pay_agent` lost its defaults, the stdout fix and the new Base Sepolia tokens. This version replaces it.

```markdown
## [@agent_fi/mcp-server 0.6.0] — YYYY-MM-DD

### Added
- `pay_for_resource` — the PROVIDER of an ACCEPTED job pays an x402 (HTTP 402) resource with its own USDC, capped by the job's remaining reward budget and an optional `max_amount`, under the agent's policy (`POST /v1/jobs/{id}/pay-resource`). Idempotent per `payment_id`. Typed refusals come back as tool output (`paid: false`, `code`, `httpStatus`, the backend's fields) instead of an error string: `BUDGET_EXCEEDED`, `PAYMENT_REFUSED`, `PAYMENT_OUTCOME_UNKNOWN`, `UNSUPPORTED_ASSET`, `UNSUPPORTED_BUDGET_TOKEN`, `PAYMENT_IN_PROGRESS`, `OUTSTANDING_AUTHORIZATION`, `POLICY_VIOLATION`. Job-scoped only: there is no standalone purchase tool.
- `get_job`, `check_outbox`, `contest_job` for the ERC-8183 escrow job flow: read one job with its `escrow` object, list the jobs I posted, dispute a submitted deliverable (requester only; the job is held for an operator decision). `check_inbox` and `update_job_status` now return the `escrow` object too.
- Every tool has a `title` and the four MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- `get_policy` / `update_policy` carry `maxValuePerTxUsd`, `maxOutflowPerTxUsd` and `allowedRecipients`.
- `transfer_token` and `pay_agent` take an optional `idempotency_key` (16-128 chars of `[A-Za-z0-9_-]`); a retry with the same key returns the first transfer.
- Token registry: Base Sepolia (84532) `WETH` and `USDC`.

### Changed (breaking for callers)
- `post_job`: a paid job must name `chain_id` (no default chain); `reward_token` now defaults to `USDC` (it was `ETH`); `chain_id` or `reward_token` without `reward_amount` is refused.
- `sign_handshake` / `verify_handshake`: the wallet signs a domain-separated EIP-712 `AgentFiHandshake{agent, message, issuedAt}` envelope, not the text as raw bytes. `verify_handshake` takes a new required `issued_at` and does not accept a plain `personal_sign`; messages are limited to 4096 characters.
- `pay_agent`: `chain_id` and `token_symbol` are required (the defaults `1` and `ETH` are gone). The tool now sends the transfer route's `TransferRequest` (`to` and `ETH` or the registry address of the symbol); an unknown symbol is refused before anything is sent. `reason` (max 500 characters) is echoed in the result only and is not sent to the backend. In 0.5.0 the request shape did not match the route, so the tool could not pay.
- `update_policy` can only TIGHTEN the agent's own policy; the backend rejects loosening with 403 and it needs the operator credential. `reason` (max 500) is sent to the backend's audit log.
- Native `"ETH"` is refused on chains whose native asset is not ETH (Polygon 137: POL) in `pay_agent` and `transfer_token`; use WETH there. Transfer addresses (`to`, `recipient_address`) are checked with viem's strict EIP-55 rule: a mixed-case address with a wrong checksum is refused.
- Input validation before any call: ids that go into a URL path must match `[A-Za-z0-9_-]{1,128}`; amounts are plain decimals; signatures and addresses are hex.
- `withdraw_erc4626` with `"max"` is refused (backend 503 `PRICE_UNAVAILABLE`) while the policy has a daily volume limit; pass an explicit amount.

### Fixed
- Tool errors are sanitized before they reach the client (no RPC keys, internal hosts, file paths or the API key).
- The stdio server no longer lets `dotenv` write its "injected env" banner to stdout, which is the JSON-RPC channel.
- Token map and GMX market addresses: Polygon USDT, Arbitrum WBTC (checksum) and the GMX `BTC/USD` market corrected.

### Notes
- Server `serverInfo.version` is the constant `SERVER_VERSION` in `src/server.ts`; it equals the package version.
- Not available through this package: Safe mode, a hosted service, contracts deployed for this version on a public network.
- npm 0.5.0 users: 31 tools and no x402. Update the client config and re-list the tools after upgrading; the payer client should keep a four-tool allowlist (`get_my_agent_profile`, `get_policy`, `get_job`, `pay_for_resource`), because the server also registers administrative tools.
```

Each bullet maps to code: `tools/agent.ts` (jobs, handshake, pay_agent, update_policy, post_job, pay_for_resource), `tools/defi.ts` (transfer idempotency, ETH refusal, `max` note), `tools/token-map.ts` (registry, native ETH), `annotations.ts` (+ `annotations.test.ts`), `api-client.ts` (dotenv `quiet`), `errors.ts` (sanitizer), `tools/gmx.ts`. Note: the old `check_inbox` description said it returned only PENDING and ACCEPTED jobs, but the route never filtered by status; only the description changed.

## 3. Package contents: explicit `files` list (done in this PR)

`packages/mcp-server/package.json` gains:

- `"files": ["dist", "README.md", "LICENSE"]`. `package.json` is always included by npm. `RELEASE.md`, `src/`, tests, `nixpacks.toml`, `tsconfig*.json` and `vitest.config.ts` no longer ship.
- `packages/mcp-server/LICENSE`: a copy of the root Apache-2.0 `LICENSE` (npm only auto-includes a LICENSE from the package directory; the manifest already says `Apache-2.0`).
- `"prepack": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && npm run build"`. With `files: ["dist"]` a package packed without a build would ship no code, so `npm pack` and `npm publish` now delete `dist` and rebuild it with `tsc -p tsconfig.build.json` (which excludes `src/__tests__` and `*.test.ts`) first. There was no `prepare` / `prepublishOnly` before: the old release steps relied on a manual `npm run build -w packages/mcp-server`.
- `src/__tests__/version.test.ts`: `SERVER_VERSION` equals the `package.json` version, the `files` list is the expected one, and `bin.agentfi-mcp` is `dist/index.js`.

Tarball (built 2026-11-18 from the tree above, version field `0.5.0`):

| | before (2026-11-16 dry run) | after |
|---|---|---|
| packed / unpacked | 208.6 kB / 1.0 MB | **116.8 kB / 616.7 kB** |
| files | 102 | **71** |
| contents | `dist/**`, `src/**` (including `src/__tests__/*` and the 216 kB `src/api.generated.ts`), config files, `nixpacks.toml`, `RELEASE.md`, README | `dist/**` (JS, `.d.ts`, maps), `package.json`, `README.md`, `LICENSE` |

Inspected: no `src/`, tests, `.env`, `nixpacks`, `tsconfig`, `vitest` or `RELEASE`; no key-like strings. `dist/api.generated.js` is an empty module and `dist/api.generated.d.ts` holds the types the other `.d.ts` files import; both are needed, the 216 kB source file is not. `dist/index.js` starts with `#!/usr/bin/env node`. The source maps name `../src/*.ts` files that do not ship (no `sourcesContent`): harmless, a debugger just cannot show the original.

Other findings:

1. `tsx` and `dotenv` are runtime `dependencies` (`tsx` is only used by the `start` script). Not a blocker; moving `tsx` to `devDependencies` would trim the install by about 100 packages (`npm install` of the tarball added 101 packages). Not changed: a dependency change is a product decision for the release owner.
2. `npx @agent_fi/mcp-server --help` (in the old `RELEASE.md` "Verify the Publish") does **not** print help: `src/index.ts` does no argument parsing and starts the stdio server. Use the `tools/list` check (section 4) instead.
3. `nixpacks.toml` (Railway) starts `node --import tsx/esm src/index.ts` from the repository; the `files` list does not touch that path.

## 4. Tarball check, as run on 2026-11-18

Transcript: `C:\Users\AAWZ 360\agentfi-notas\alpha-2026-11-18\mcp-0.6.0-tarball-check.txt`.

```bash
cd packages/mcp-server && npm pack --pack-destination <tmp>          # runs prepack: clean dist + build
mkdir <clean-dir-outside-any-repo> && cd <clean-dir> && npm init -y && npm install <tmp>/agent_fi-mcp-server-<version>.tgz
node examples/_stub-api/stub-api.mjs --port 39777 &                    # from the repository: harmless local stub, nothing is paid
AGENTFI_API_URL=http://127.0.0.1:39777 AGENTFI_API_KEY=agfi_stub_not_a_secret npx agentfi-mcp   # then JSON-RPC on stdin
```

The JSON-RPC probe sent `initialize`, `notifications/initialized`, `tools/list` and one `get_job` call. Result in all three launch forms (`node node_modules/@agent_fi/mcp-server/dist/index.js`, `npx agentfi-mcp`, `node_modules\.bin\agentfi-mcp.cmd`): **35 tools** including `pay_for_resource`, `get_job`, `check_outbox`, `contest_job`; stdout contained only JSON-RPC (0 non-JSON lines); stderr one line, `[AgentFi MCP] Started on stdio transport`; `get_job` returned the stub's job. The Windows `.cmd` shim and `npx` resolve the `bin` entry correctly (npm generates the shim; the shebang matters only on POSIX).

This does **not** change the claim "npm 0.5.0 lacks x402": the registry still serves 0.5.0 (31 tools, 2026-05-15). The tarball was built locally from source, with the version field still `0.5.0`; it is not what `npx @agent_fi/mcp-server` fetches until the owner publishes.

Repeatable check from the repository root on the release commit:

```bash
npm ci
(cd packages/mcp-server && npm test)                     # 10 files, 166 tests
npm run spec:check                                       # api.generated.ts matches docs/api/openapi.yaml
(cd packages/mcp-server && npm pack --dry-run)           # expect 71 files, no src/, no tests
node examples/_stub-api/mcp-check.mjs                    # stdio check of the built dist against the stub
```

## 5. Release steps (LEFT FOR THE GATE; do not run before the owner's go)

Preconditions: owner approval for distribution; `npm whoami` is the account with publish access to the `@agent_fi` scope; clean tree on `main`; CI green; the framework demo and the payer-authorization work are merged (section 6 gives the order).

**5.1 Bump commit, through a PR** (the runbook has no separate release branch; a bump is a normal reviewed change). Edit three places by hand and put the changelog in the same commit:

```bash
git checkout main && git pull --ff-only origin main && git checkout -b chore/release-mcp-server-0.6.0
# 1. packages/mcp-server/package.json   "version": "0.5.0" -> "0.6.0"
# 2. package-lock.json                  the "packages/mcp-server" entry, "version": "0.5.0" -> "0.6.0"
# 3. packages/mcp-server/src/server.ts  export const SERVER_VERSION = '0.5.0' -> '0.6.0'
# 4. CHANGELOG.md                       paste section 2 as the first block under the `## [Unreleased]` heading, with the date
git diff --stat                                              # exactly these four files
(cd packages/mcp-server && npm test)                         # version.test.ts fails if 1 and 3 disagree
git add -A && git commit -m "chore(release): @agent_fi/mcp-server 0.6.0"
```

`npm version 0.6.0 --no-git-tag-version -w packages/mcp-server` also works but rewrites `package.json` formatting (the `repository` object is expanded and the line endings change), and it does not touch `SERVER_VERSION`; the manual edit keeps the diff to four lines.

**5.2 After the bump PR is merged** (npm publish and the public tag are owner-only; do them from the merge commit):

```bash
git checkout main && git pull --ff-only origin main
npm ci
(cd packages/mcp-server && npm pack --dry-run)                # 71 files; prepack rebuilds dist
npm publish -w packages/mcp-server --access public --dry-run
npm publish -w packages/mcp-server --access public            # add --otp <code> if asked
npm view @agent_fi/mcp-server version                          # expect 0.6.0
```

Then the tags (section 6) and, if wanted, the release:

```bash
gh release create mcp-server-v0.6.0 --verify-tag --title "mcp-server v0.6.0" --notes-file <notes-file>
```

After publishing: update the README install text to say the x402 tools are in the package, and drop the "0.5.0 / 31 tools" caveats in `README.md`, `packages/mcp-server/README.md` (the "Source vs npm" note) and `STATE.md`; refresh `packages/mcp-server/RELEASE.md` ("Current published npm version").

## 6. Tag safety and tag plan

### 6.1 Does a tag or a release trigger anything? (read 2026-11-18)

**No automatic npm publish exists, and no workflow runs on a tag or a release.**

| Where | What it says |
|---|---|
| `.github/workflows/ci.yml:3-7` | `on: pull_request: branches: [main, develop]` and `push: branches: [develop, main]`. A branch filter alone does not match tag pushes. |
| `.github/workflows/deploy-staging.yml:7-9` | `on: push: branches: [develop]`; its only step (line 17) is `echo "Railway deploys automatically on push to develop..."`. It deploys nothing by itself. |
| `.github/workflows/e2e-testnet-smoke.yml:3-6` | `workflow_dispatch` and `schedule` cron `0 6 * * *`; reads `E2E_TESTNET_*` secrets (lines 17-19), skips with a notice when they are absent. |
| all of `.github/` | no `tags:`, no `release:` trigger, no `npm publish`, no `NPM_TOKEN` / `NODE_AUTH_TOKEN` (grep). The repository secrets are `ALCHEMY_API_KEY`, `DATABASE_URL`, `PROD_REDIS_URL`, `STAGING_HOST`, `STAGING_SSH_KEY`, `STAGING_USER`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_ORGANIZATION_ID` (`gh api repos/felippeyann/agentfi/actions/secrets`, names only): there is no npm token, so a workflow could not publish. |
| `scripts/release-v1.mjs:107-144` | local helper: creates `v<X.Y.Z>` and pushes it (`--push`) only when someone runs it. `scripts/gen-release-note.mjs` only writes a note file. Neither runs in CI. |
| `docs/operations/release-runbook.md:31,40-55` | says Railway (or another host) may deploy "on a push to `main` (or a tag, depending on provider config)". That is a setting **outside the repository**. |

Not verifiable from the repository or with the current `gh` token: (a) repository webhooks (`gh api repos/felippeyann/agentfi/hooks` needs the `admin:repo_hook` scope: HTTP 404 without it); (b) whether a Railway service is configured to deploy on tags (the repository only has `railway.json`, `nixpacks.toml`, `fly.toml`; the project's own notes say the Fly infrastructure is deactivated). GitHub's deployment list shows only Vercel (`vercel[bot]`) deployments: 24 production and 76 preview, all for commit SHAs, none for a tag. **Before the first public tag, the owner confirms in the Railway and Vercel dashboards that no service deploys on tags.** To avoid even that doubt, the alpha tag proposed below does not start with `v`, the prefix `release-v1.mjs` and the runbook use for deploy tags.

Creating a **GitHub release** (`gh release create`) triggers no workflow (there is no `release:` trigger). It does notify watchers and shows on the repository front page; that is the only side effect.

### 6.2 Existing tags

`v0.1.0` (2026-04-13, `c7f9e03`), `mcp-server-v0.2.0` (04-18), `mcp-server-v0.3.0` (04-18), `mcp-server-v0.4.0` (05-08), `mcp-server-v0.5.0` (05-15, `9ce8db6`). All lightweight tags. Each has a GitHub release (5 releases).

### 6.3 Naming proposal

- `mcp-server-v0.6.0`: the npm package. Same convention as the four previous package tags; points at the **bump commit** (section 5.1), because it names the source of the published artifact.
- `alpha-0.1`: the repository's developer-alpha entry point. The package convention does not fit (it is not a package release), and `v*` would be read as a `release-v1.mjs` / runbook deploy tag. The quickstart and the announcement name this tag.
- If the bump commit is the last commit on `main` when tagging, both tags can sit on the same SHA. If not, `alpha-0.1` goes on the last commit that contains the demo and the matching docs, `mcp-server-v0.6.0` on the bump commit.

### 6.4 Procedure (placeholder `<SHA>`; PRs still in flight land first)

Order: (1) the framework real-backend run PR and the payer-authorization PR are merged and CI is green on `main`; (2) `docs/alpha/quickstart.md` on `main` carries the final instructions; (3) the bump PR (5.1) is merged; (4) tag.

```bash
git fetch origin --tags
SHA=<FULL-40-CHAR-SHA>   # the merge commit on origin/main chosen for the tag, e.g. the bump merge (use the full SHA: gh run list --commit needs it)
git rev-parse --verify "$SHA^{commit}"
# it is on main, and CI is green on it
git merge-base --is-ancestor "$SHA" origin/main && echo "on main"
gh run list --branch main --commit "$SHA" --json conclusion,name --jq '.[]'
# the tag will contain the demo, the quickstart and the packaged MCP
git ls-tree -r --name-only "$SHA" | grep -E '^(scripts/alpha/demo\.mjs|scripts/alpha/guard\.mjs|docs/alpha/quickstart\.md|packages/mcp-server/LICENSE)$'   # 4 lines
git show "$SHA:package.json" | grep '"alpha:demo"'
git show "$SHA:packages/mcp-server/package.json" | grep -E '"version"|"files"'      # 0.6.0 only on the bump commit
git merge-base --is-ancestor 3a867c1 "$SHA" && echo "contains the #202 quickstart"   # the commit that names the first alpha:demo commit
git merge-base --is-ancestor 32b3593 "$SHA" && echo "contains #205 (alpha:demo)"
# nothing else carries these names yet
git tag -l 'alpha-0.1' 'mcp-server-v0.6.0'; git ls-remote --tags origin 'alpha-0.1' 'mcp-server-v0.6.0'    # both empty
```

Create locally (not pushed) and re-check:

```bash
git tag -a alpha-0.1 "$SHA" -m "AgentFi developer alpha 0.1: alpha:demo and quickstart; MCP server 0.6.0 (35 tools)"
git tag mcp-server-v0.6.0 "$SHA"           # lightweight, like the previous package tags; use -a to annotate
git show --stat --oneline alpha-0.1 | head -3
```

Push (owner, public; after the owner has confirmed that no host deploys on tags, section 6.1):

```bash
git push origin alpha-0.1
git push origin mcp-server-v0.6.0           # only after npm publish succeeded, like the 0.5.0 sequence
```

Undo before anyone has fetched it: `git push --delete origin alpha-0.1` and `git tag -d alpha-0.1`.

### 6.5 The quickstart edit once `alpha-0.1` exists (do NOT make it before; `docs/alpha/quickstart.md` belongs to another front)

In section 2 of `docs/alpha/quickstart.md`:

1. Line 43: replace "`<TAG>` is the release tag of the alpha; **until a tag exists, use the commit SHA** the alpha announcement names." with "The release tag of the alpha is `alpha-0.1`."
2. Line 48: replace `git checkout <TAG>            # a tag, or the commit SHA until a tag exists (see the note below)` with `git checkout alpha-0.1`.
3. Line 54: delete the whole note beginning "`<TAG>` must be a commit that **contains `alpha:demo`**..." and put in its place: "`alpha-0.1` points at `<SHA>`, which contains `alpha:demo` and this page. Any later commit on `main` also works."
4. Search the page for any other `<TAG>` or `32b3593` (`grep -n -E '<TAG>|32b3593' docs/alpha/quickstart.md`) and replace them with `alpha-0.1`.

Also: `docs/operations/mcp-0.6.0-release-package.md` section 7 below, and `README.md` if it names the commit.

## 7. Alternative until publication: reproducible path by checkout or tag (works today)

```bash
git clone https://github.com/felippeyann/agentfi && cd agentfi
git checkout <tag-or-commit>        # alpha-0.1 once cut; until then the commit the quickstart names
npm ci
npm run build -w packages/mcp-server
AGENTFI_API_URL=http://localhost:3000 AGENTFI_API_KEY=<agent key> node packages/mcp-server/dist/index.js
```

In an MCP client config use `"command": "node", "args": ["<abs path>/packages/mcp-server/dist/index.js"]` with the same two environment variables. The environment variable for the backend is `AGENTFI_API_URL` (not a `--backend` flag; the server has no CLI flags).

## 8. Install and tag claims in the docs, checked 2026-11-18

| Claim | Where | Result |
|---|---|---|
| `npm install @agent_fi/mcp-server` / `npx @agent_fi/mcp-server` | `packages/mcp-server/README.md:115,121`; `docs/agents/claude-instructions.md:652`; `docs/operations/production-deploy.md:298` | the package exists (0.5.0, 31 tools, no x402). The README carries a source-vs-npm note. After 0.6.0 is published these three places are correct for 35 tools |
| `git checkout 32b3593` / `<TAG>` | `docs/alpha/quickstart.md:43,48,54` | intentional placeholder until `alpha-0.1` exists; exact edit in 6.5 |
| `mcp-server-v0.5.0` tag and release commands | `packages/mcp-server/RELEASE.md` | refreshed in this PR to 0.6.0 |
| `npx @agent_fi/mcp-server --help` | old `RELEASE.md` | does not print help; replaced by the `tools/list` check |
| `npm install @agentfi/adapters`, `pip install agentfi-langchain` | `packages/adapters/README.md`, `docs/agents/claude-instructions.md` | not published (checked 2026-11-16); owned by the interop front |
| Railway deploy of `develop` | `.github/workflows/deploy-staging.yml` | the workflow only echoes; `develop` is 420 commits behind `main` and has nothing `main` lacks (2026-11-16). Whether a Railway service is still linked to `develop` is an open check in the dashboard, outside the repository |
