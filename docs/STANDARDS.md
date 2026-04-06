# AgentFi Documentation Standards (v1)

This document establishes the standards for all documentation within the AgentFi project. It is intended to be followed by both human contributors and AI agents.

## 🌟 Principles

1.  **Agent-First Clarity**: Documents should be structured with clear headings, consistent terminology, and unambiguous instructions to facilitate easy parsing by LLMs.
2.  **Single Source of Truth**: Avoid duplicating technical details. Link to the primary source (e.g., the architecture doc or the code itself) rather than re-stating values that might change.
3.  **Actionable Examples**: Always include concrete examples (CURL commands, JSON schemas, or code snippets) for technical features.
4.  **Operational Safety**: Highlight critical security steps (like handling private keys or API secrets) with ⚠️ callouts.

## 📂 Structure

- **Pathing**: Follow the established directory structure in `docs/`:
  - `architecture/`: For deep technical design and diagrams.
  - `operations/`: For setup, deployment, and day-to-day management.
  - `agents/`: For agent-specific quickstarts and interaction guides.
  - `project/`: For high-level roadmap and project status.
- **Root Files**: Only essential project entry points (`README.md`, `VISION.md`, `CONTRIBUTING.md`, `LICENSE`) should live in the root directory. All other documentation must reside in `docs/`.

## ✍️ Writing Style

- **Language**: All documentation must be in **English**. If a non-English tutorial is required, provide an English translation first.
- **Tone**: Professional, direct, and senior-engineer focused. Avoid marketing fluff.
- **Markdown**: Use GitHub Flavored Markdown (GFM). Ensure all code blocks have correct language tags (e.g., ```typescript).

## 🤖 Special Instructions for AI Agents

When asked to update documentation or create new docs, agents should:
1.  **Scan for existing content**: Check if a similar document exists to avoid redundancy.
2.  **Verify internal links**: Ensure that links to other documents or code files are valid relative paths.
3.  **Update the Hub**: If creating a significant new document, add a link to it in `docs/README.md`.
4.  **Preserve the Vision**: Ensure that new documentation aligns with the core principles defined in `VISION.md`.

---

*Last Updated: April 2026*
