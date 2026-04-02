#!/usr/bin/env node
/**
 * Generate a timestamped release-note stub under docs/release-notes/.
 *
 * Usage:
 *   node scripts/gen-release-note.mjs                     # auto-generates v<date>-<seq>
 *   node scripts/gen-release-note.mjs v1.2.0              # named release
 *   npm run release:note                                   # via npm script
 *   npm run release:note -- v1.2.0                         # named via npm
 */

import { mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const RELEASE_DIR = join(import.meta.dirname, '..', 'docs', 'release-notes');

// Ensure directory exists
mkdirSync(RELEASE_DIR, { recursive: true });

const arg = process.argv[2];
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

let tag;
if (arg) {
  tag = arg;
} else {
  // Auto-generate sequential tag for today
  const existing = readdirSync(RELEASE_DIR).filter(f => f.startsWith(today));
  const seq = existing.length + 1;
  tag = `${today}-${seq}`;
}

const filename = `${tag}.md`;
const filepath = join(RELEASE_DIR, filename);

// Get recent commits for the stub
let recentCommits = '';
try {
  recentCommits = execSync('git log --oneline -10', { encoding: 'utf8' }).trim();
} catch {
  recentCommits = '(unable to read git log)';
}

const content = `# Release ${tag}

**Date:** ${today}
**Author:** <!-- your name -->
**Go/No-Go:** <!-- PASS / FAIL -->

---

## Changes

<!-- Summarize what shipped in this release -->

### Recent Commits
\`\`\`
${recentCommits}
\`\`\`

## Pre-Deploy Checklist

- [ ] All CI checks pass (typecheck, tests, e2e, contracts)
- [ ] Deploy preflight scenarios pass (\`npm run preflight:deploy-scenarios\`)
- [ ] Go/no-go template completed (see docs/release-go-no-go-template.md)
- [ ] Database migrations reviewed (if any)
- [ ] Environment variables verified in Railway

## Post-Deploy Verification

- [ ] \`/health\` returns 200
- [ ] \`/health/ready\` returns all dependencies healthy
- [ ] Admin dashboard accessible
- [ ] Smoke test: simulate a swap via MCP

## Rollback Plan

See [production-release-runbook.md](../production-release-runbook.md) for rollback procedures.

## Notes

<!-- Any additional context, known issues, or follow-ups -->
`;

writeFileSync(filepath, content);
console.log(`Created: docs/release-notes/${filename}`);
