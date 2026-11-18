# GitHub repository metadata for the alpha (PREPARED, NOT APPLIED)

Prepared 2026-11-16, verified read-only again 2026-11-18. Changing the public repository's About box, topics, labels and the conduct contact is a **publication gate for the owner**. Nothing here was run against GitHub.

State read on 2026-11-18 (`gh api repos/felippeyann/agentfi`): description empty, homepage `https://agentfi-admin.vercel.app` (stale), topics none, issues enabled, discussions disabled, default branch `main`.

## 0. What was verified on 2026-11-18 (read-only)

| Check | Result |
|---|---|
| Private vulnerability reporting | `gh api repos/felippeyann/agentfi/private-vulnerability-reporting` returns `{"enabled":true}` |
| Signed-out visitor, `https://github.com/felippeyann/agentfi/security` | HTTP 200; the page shows **Report a vulnerability**, **Security Policy** and `SECURITY.md` |
| Signed-out visitor, `.../security/policy` | HTTP 200; shows the policy rendered from `SECURITY.md` and the **Report a vulnerability** button |
| Signed-out visitor, `.../security/advisories` | HTTP 200 (the public advisory list; empty is normal) |
| Signed-out visitor, `.../security/advisories/new` | HTTP 302 to `https://github.com/login?return_to=...`. This is the expected behaviour: the reporter must sign in to GitHub. `SECURITY.md` and the issue chooser say so ("Sign in to GitHub and select **Report a vulnerability**"). A reporter without a GitHub account has no channel until the owner names a monitored address (section 6) |
| `SECURITY.md` detected | the Security tab links `SECURITY.md` as the policy. `community/profile` has no `security_policy` key; it lists `code_of_conduct_file`, `contributing`, `license`, `pull_request_template`, `readme`, health 85 |
| Issue forms on `main` | `alpha-feedback.yml`, `bug_report.yml`, `feature_request.yml`, `integration-request.yml` all parse (js-yaml on the raw files served by `gh api`; no duplicate ids; `name`, `description`, `body` present); `config.yml` has `blank_issues_enabled: false` and three contact links (advisory form, `docs/README.md`, `docs/feedback.md`). `community/profile` reports `issue_template: null` because that endpoint only recognises Markdown templates; it does not mean the forms are broken |
| Labels the forms apply | `bug` (exists), `enhancement` (exists), **`alpha-feedback` (missing)**, **`integration-request` (missing)** |
| Labels named in `docs/feedback.md` | also missing: `first-flow-completed`, `first-flow-blocked`, `needs-repro` |
| Existing labels | `bug documentation duplicate enhancement good first issue help wanted invalid question wontfix` |

Missing labels, in total: `alpha-feedback`, `integration-request`, `first-flow-completed`, `first-flow-blocked`, `needs-repro`.

## 1. About description (<= 160 characters)

```text
Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only.
```

(156 characters. Honest on stage and scope: alpha, self-hosted, local. Check the count again if the wording changes: `printf %s "<text>" | wc -c`.)

## 2. Homepage rule

- Set `https://www.agentfi.cc` **only when the landing is live and says the same as the README**. How to check, from a signed-out shell:

  ```bash
  curl -sI https://www.agentfi.cc | head -1                  # expect HTTP/2 200
  curl -s https://www.agentfi.cc | grep -i -c -E "26 MCP tools|MPC shard|Safe module"   # expect 0 (old claims)
  curl -s https://www.agentfi.cc | grep -i -c -E "alpha"                                # expect >= 1
  ```

  On 2026-11-16 the live page still carried the old claims (26 MCP tools, MPC shards, Safe modules); the owner or the landing front confirms the new page is published before this step.
- **Until then:** clear the homepage (empty) instead of keeping the stale `https://agentfi-admin.vercel.app`.

## 3. Topics (<= 20)

```text
x402 ai-agents mcp model-context-protocol agentic-payments usdc base budget-controls spend-controls reconciliation typescript self-hosted
```

12 topics. Left out on purpose: `defi`, `trading`, `mainnet`, `hosted`, anything implying a live service.

## 4. Ordered checklist (the owner runs it; every command changes public state)

Run from any shell with `gh` authenticated as a repository admin. Do the steps in this order: labels first (the forms reference them), then About and topics, then the conduct contact, then the homepage.

**Step 1. Labels** (idempotent: `--force` updates a label that already exists)

```bash
gh label create alpha-feedback       --repo felippeyann/agentfi --force --color 5319E7 --description "Report from the developer-alpha feedback form"
gh label create integration-request  --repo felippeyann/agentfi --force --color 0E8A16 --description "Request to support a framework, SDK or client"
gh label create first-flow-completed --repo felippeyann/agentfi --force --color 1D76DB --description "Reporter completed the first flow"
gh label create first-flow-blocked   --repo felippeyann/agentfi --force --color D93F0B --description "Reporter could not complete the first flow"
gh label create needs-repro          --repo felippeyann/agentfi --force --color FBCA04 --description "Needs steps or environment to reproduce"
```

Verify: `gh label list --repo felippeyann/agentfi --limit 100` lists the five names.

**Step 2. About description, homepage cleared, topics**

```bash
gh repo edit felippeyann/agentfi \
  --description "Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only." \
  --homepage "" \
  --add-topic x402 --add-topic ai-agents --add-topic mcp --add-topic model-context-protocol \
  --add-topic agentic-payments --add-topic usdc --add-topic base --add-topic budget-controls \
  --add-topic spend-controls --add-topic reconciliation \
  --add-topic typescript --add-topic self-hosted
```

Equivalent `gh api` forms (if the `gh repo edit` flags differ in your version):

```bash
gh api -X PATCH repos/felippeyann/agentfi -f description="Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only." -f homepage=""
gh api -X PUT repos/felippeyann/agentfi/topics -H "Accept: application/vnd.github+json" \
  -f "names[]=x402" -f "names[]=ai-agents" -f "names[]=mcp" -f "names[]=model-context-protocol" \
  -f "names[]=agentic-payments" -f "names[]=usdc" -f "names[]=base" -f "names[]=budget-controls" \
  -f "names[]=spend-controls" -f "names[]=reconciliation" \
  -f "names[]=typescript" -f "names[]=self-hosted"
```

Verify: `gh api repos/felippeyann/agentfi --jq '{description, homepage, topics}'`.

**Step 3. Conduct contact** (decision in section 6; commit the chosen replacement to `CODE_OF_CONDUCT.md` through a PR)

**Step 4. Homepage, only after the check in section 2 passes**

```bash
gh repo edit felippeyann/agentfi --homepage "https://www.agentfi.cc"
gh api repos/felippeyann/agentfi --jq '.homepage'
```

**Step 5. Final read-back**

```bash
gh api repos/felippeyann/agentfi --jq '{description, homepage, topics}'
gh api repos/felippeyann/agentfi/private-vulnerability-reporting      # {"enabled":true}
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/felippeyann/agentfi/security/policy   # 200
```

## 5. Other settings checked (no change proposed)

- Discussions: disabled. The alpha uses issue forms only; enable discussions only if the volume asks for it.
- The stale `develop` branch has nothing `main` lacks (0 commits ahead, 420 behind at 2026-11-16); `CONTRIBUTING.md` says to open PRs against `main`. See `docs/operations/mcp-0.6.0-release-package.md` section 8 for the one workflow that still names `develop`.

## 6. Conduct and security contact: owner decision (not made here)

`conduct@agentfi.io` and `security@agentfi.io` do not exist (owner, 2026-10-15). `CODE_OF_CONDUCT.md` currently says a monitored contact "is being set up" (lines 47-49 of the current file: "A monitored contact for conduct reports is being set up and will be published here. The address this file used to list (`conduct@agentfi.io`) is not monitored, so do not use it."). The owner chooses one option; the exact replacement for those three lines (the whole paragraph, ending before "All complaints will be reviewed...") is:

**Option A. Name a monitored address.** Replace `<ADDRESS>` with an inbox the owner reads (it must exist and be monitored before this is merged):

```text
Report conduct concerns by email to <ADDRESS>. Please do not use any other address for this purpose. Reports are handled confidentially.
```

**Option B. Use the private advisory form.** No new inbox; the reporter needs a GitHub account:

```text
Report conduct concerns privately through GitHub: open https://github.com/felippeyann/agentfi/security/advisories/new (sign in, then select **Report a vulnerability**) and start the report with "Code of Conduct". Reports are visible only to the maintainers.
```

Option B caveat: that form is built for security reports and may be read as such; it is the only private channel that exists today. Option A is the only one that works for a reporter without a GitHub account. The same choice applies to `SECURITY.md`, which already uses the private advisory form and needs no further change under either option.
