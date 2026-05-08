# Graphify Code Graph

This repo includes a Graphify knowledge graph in [`graphify-out/`](../graphify-out/):

- `GRAPH_REPORT.md` — quick navigation report for agents and humans.
- `graph.json` — queryable graph data.
- `graph.html` — local interactive visualization.

The graph was generated with the official PyPI package `graphifyy`; the CLI
command is `graphify`.

## Install

Use one of:

```bash
uv tool install graphifyy
pipx install graphifyy
pip install graphifyy
```

On PowerShell, run `graphify .` or `graphify update .`; do not use `/graphify .`
because a leading slash is parsed as a path separator.

## Update

After code changes:

```bash
graphify update .
```

This refreshes the AST/code graph locally with no LLM/API cost. Use `--force`
only after large refactors that intentionally remove nodes.

## Query

Useful commands:

```bash
graphify query "how does agent registration connect to wallet provisioning?"
graphify path "agentRoutes()" "LocalWalletService"
graphify explain "transactionRoutes()"
```

## Codex Integration

`AGENTS.md` tells Codex to read `graphify-out/GRAPH_REPORT.md` before broad
codebase exploration. You can additionally install local hooks:

```bash
graphify codex install
```

That command writes machine-local hook config under `.codex/`, which is ignored
by git. Do not commit `.codex/hooks.json`; it contains absolute paths to your
local `graphify` executable.
