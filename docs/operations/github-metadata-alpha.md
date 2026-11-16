# GitHub repository metadata for the alpha (PREPARED, NOT APPLIED)

Prepared 2026-11-16. Changing the public repository's About box, topics and labels is a **publication gate for the owner**. Nothing here was run against GitHub. State read on 2026-11-16 with `gh api repos/felippeyann/agentfi`: description empty, homepage `https://agentfi-admin.vercel.app` (stale), topics none, issues enabled, discussions disabled, private vulnerability reporting **enabled**, labels `bug documentation duplicate enhancement good first issue help wanted invalid question wontfix`.

## 1. About description (<= 160 characters)

```text
Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only.
```

(156 characters. Honest on stage and scope: alpha, self-hosted, local. Check the count again if the wording changes: `printf %s "<text>" | wc -c`.)

## 2. Homepage

- **Proposal:** `https://www.agentfi.cc`, **only after** the landing publication gate passes: on 2026-11-16 the live page still carries the old claims (26 MCP tools, MPC shards, Safe modules), so linking it from the repo now would send visitors to text that contradicts the README.
- **Meanwhile:** clear the homepage (leave it empty) instead of keeping the stale `https://agentfi-admin.vercel.app`.

## 3. Topics (<= 20)

```text
x402 ai-agents mcp model-context-protocol agentic-payments usdc base budget-controls spend-controls reconciliation agent-wallets typescript self-hosted
```

13 topics. Left out on purpose: `defi`, `trading`, `mainnet`, `hosted`, anything implying a live service.

## 4. Commands (owner runs; each changes public metadata)

Run now (description and topics; homepage cleared):

```bash
gh repo edit felippeyann/agentfi \
  --description "Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only." \
  --homepage "" \
  --add-topic x402 --add-topic ai-agents --add-topic mcp --add-topic model-context-protocol \
  --add-topic agentic-payments --add-topic usdc --add-topic base --add-topic budget-controls \
  --add-topic spend-controls --add-topic reconciliation --add-topic agent-wallets \
  --add-topic typescript --add-topic self-hosted
```

Run later, after the landing publication gate:

```bash
gh repo edit felippeyann/agentfi --homepage "https://www.agentfi.cc"
```

Equivalent `gh api` forms (if `gh repo edit` flags differ in your version):

```bash
gh api -X PATCH repos/felippeyann/agentfi -f description="Developer alpha: self-hosted API/MCP spend controls for AI agents that buy services via x402. Budgets, payment/delivery records, reconciliation. Local only." -f homepage=""
gh api -X PUT repos/felippeyann/agentfi/topics -H "Accept: application/vnd.github+json" \
  -f "names[]=x402" -f "names[]=ai-agents" -f "names[]=mcp" -f "names[]=model-context-protocol" \
  -f "names[]=agentic-payments" -f "names[]=usdc" -f "names[]=base" -f "names[]=budget-controls" \
  -f "names[]=spend-controls" -f "names[]=reconciliation" -f "names[]=agent-wallets" \
  -f "names[]=typescript" -f "names[]=self-hosted"
```

Verify afterwards:

```bash
gh api repos/felippeyann/agentfi --jq '{description, homepage, topics}'
```

## 5. Labels used by the issue forms and the feedback guide

`bug` and `enhancement` exist already. The forms apply `alpha-feedback` and `integration-request`; GitHub does not apply a label that does not exist, so create them before the forms are live on `main` (the PR itself is harmless without them).

```bash
gh label create alpha-feedback        --repo felippeyann/agentfi --color 5319E7 --description "Report from the developer-alpha feedback form"
gh label create integration-request   --repo felippeyann/agentfi --color 0E8A16 --description "Request to support a framework, SDK or client"
gh label create first-flow-completed  --repo felippeyann/agentfi --color 1D76DB --description "Reporter completed the first flow"
gh label create first-flow-blocked    --repo felippeyann/agentfi --color D93F0B --description "Reporter could not complete the first flow"
gh label create needs-repro           --repo felippeyann/agentfi --color FBCA04 --description "Needs steps or environment to reproduce"
```

## 6. Other settings checked (no change proposed)

- Private vulnerability reporting: enabled (`gh api repos/felippeyann/agentfi/private-vulnerability-reporting` returns `{"enabled":true}`), so the link in `SECURITY.md` and in the issue chooser works.
- Discussions: disabled. The alpha uses issue forms only; enable discussions only if the volume asks for it.
- The stale `develop` branch has nothing `main` lacks (0 commits ahead, 420 behind); `CONTRIBUTING.md` now says to open PRs against `main`.
