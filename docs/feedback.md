# Feedback guide (developer alpha)

AgentFi is an alpha. The most useful thing you can do is try it and tell us, in a public issue, **where it worked and where it did not**. This page says what we ask, what we never collect and how we triage.

## What we ask

Open an issue from [the issue chooser](https://github.com/felippeyann/agentfi/issues/new/choose):

| Form | Use it when |
|---|---|
| **Alpha feedback** | you tried to install and/or run the first flow: did it install, did you complete the flow, which mode, where you got stuck, would you use it again (voluntary), your OS and Node version |
| **Integration request** | you want AgentFi to work with a framework, SDK, client or service; say the version and transport you need |
| **Bug report** | something that should work does not |
| **Feature request** | you want a capability that does not exist |

Vulnerabilities do **not** go here. Use the [private advisory form](https://github.com/felippeyann/agentfi/security/advisories/new); see [SECURITY.md](../SECURITY.md).

## What we never collect

- **No telemetry.** The software sends nothing to us. There is no analytics in the alpha.
- **No prompts, secrets or customer data.** Do not paste prompts, API keys, private keys, seed phrases, customer data, or logs that contain any of them. Redact before pasting. If you pasted one by mistake, rotate it and edit or delete the issue text.
- No outbound contact: we do not email or message people who open issues, and we do not scrape who starred or installed.

## What counts as demand

Stars, forks and download counts are **not** treated as demand. What we count is voluntary, concrete reports: someone tried to install, completed (or did not complete) the first flow, named a blocker, or asked for a specific integration. Zero reports is not read as approval or rejection of the technology.

## How maintainers triage

Small label set (create it once, see below):

| Label | Meaning |
|---|---|
| `alpha-feedback` | report from the alpha feedback form |
| `integration-request` | request to support a framework, SDK or client |
| `first-flow-completed` | the reporter finished the first flow (set by the maintainer from the form) |
| `first-flow-blocked` | the reporter could not finish it; the blocker is the thing to fix |
| `needs-repro` | we cannot act without steps or environment details |
| `bug`, `enhancement` | existing labels, used by the bug and feature forms |

Order of work: blockers in the install/first-flow path, then integration requests with a named framework and version, then everything else. A reply says what was understood and what happens next; we may close with "no action" and say why.

### Creating the labels (maintainer, one time)

These commands change the public repository, so they are an owner action. They are listed here, not run from CI:

```bash
gh label create alpha-feedback        --repo felippeyann/agentfi --color 5319E7 --description "Report from the developer-alpha feedback form"
gh label create integration-request   --repo felippeyann/agentfi --color 0E8A16 --description "Request to support a framework, SDK or client"
gh label create first-flow-completed  --repo felippeyann/agentfi --color 1D76DB --description "Reporter completed the first flow"
gh label create first-flow-blocked    --repo felippeyann/agentfi --color D93F0B --description "Reporter could not complete the first flow"
gh label create needs-repro           --repo felippeyann/agentfi --color FBCA04 --description "Needs steps or environment to reproduce"
```

(`bug` and `enhancement` already exist.) The same commands are in [github-metadata-alpha.md](operations/github-metadata-alpha.md).
