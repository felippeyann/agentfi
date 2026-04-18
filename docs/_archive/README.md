# Archive

**Historical docs — not current project state. Do not act on anything in here as if it were live guidance.**

This directory contains docs that described the project at a specific point in time and have since been superseded. They're preserved for provenance and context, not for operational use. The live project state lives in:

- [VISION.md](../../VISION.md) — *why* the project exists
- [STATE.md](../../STATE.md) — *what* the project is today
- [HANDOFF.md](../../HANDOFF.md) — *live* pending tasks
- [docs/project/roadmap.md](../project/roadmap.md) — forward-looking plan

## What's in here

| File | What it was | Why archived |
|---|---|---|
| `go-live-status-v0.1.0.md` | Snapshot of the v0.1.0 release in April 2026 | Frozen-in-time; real current state is in STATE.md |
| `release-notes-hitl.md` | Phase 2 release notes (HITL approval framework) | Feature shipped and documented in the main code; notes are retrospective |
| `railway_logs/` | Post-mortems from Railway deployment attempts | Project shifted to provider-agnostic self-hosted posture in [PR #39](https://github.com/felippeyann/agentfi/pull/39); these logs describe infrastructure that was removed |

## Rule for future archives

When a doc becomes stale:

1. If it's still conceptually useful but outdated → **update in place**.
2. If it's a historical snapshot / retrospective / superseded plan → **move here**, add a row to the table above.
3. If it's straight-up wrong and has no historical value → **delete**.

The goal is that an LLM or new contributor reading the live docs never gets polluted by obsolete context.
