#!/usr/bin/env node
// Relative-link checker for Markdown entry docs.
//
//   node scripts/check-md-links.mjs [file.md ...]
//
// Default files: README.md, docs/README.md, CONTRIBUTING.md, SECURITY.md,
// docs/feedback.md, docs/project/roadmap-alpha.md, docs/project/history.md.
// Checks that every relative link target exists and that `#anchor` fragments
// match a heading in the target (GitHub-style slugs). Skips fenced code,
// inline code and external (http/https/mailto) links.
//
// Targets owned by other in-flight PRs are reported as "pending", not as
// failures. Remove them from PENDING once those PRs are merged.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PENDING = new Set(['docs/alpha/quickstart.md', 'docs/integrations/compatibility.md']);
const DEFAULT_FILES = [
  'README.md',
  'docs/README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/feedback.md',
  'docs/project/roadmap-alpha.md',
  'docs/project/history.md',
  'docs/operations/github-metadata-alpha.md',
  'docs/operations/mcp-0.6.0-release-package.md',
];

const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

function headings(path) {
  const set = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    let s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    set.add(n === 0 ? s : `${s}-${n}`);
  }
  return set;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES.filter((f) => existsSync(resolve(ROOT, f)));
let failures = 0;
let pending = 0;
let checked = 0;

for (const f of files) {
  const abs = resolve(ROOT, f);
  let fence = false;
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      let target = m[1].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
      const [pathPart, frag] = target.split('#');
      const dest = pathPart ? resolve(dirname(abs), decodeURI(pathPart)) : abs;
      const rel = relative(ROOT, dest).split('\\').join('/');
      checked++;
      if (PENDING.has(rel) && !existsSync(dest)) {
        pending++;
        console.log(`PENDING  ${f}:${i + 1}  ${target}`);
        continue;
      }
      if (!existsSync(dest)) {
        failures++;
        console.log(`MISSING  ${f}:${i + 1}  ${target}`);
        continue;
      }
      if (frag && statSync(dest).isFile() && dest.endsWith('.md') && !headings(dest).has(frag.toLowerCase())) {
        failures++;
        console.log(`ANCHOR   ${f}:${i + 1}  ${target}`);
      }
    }
  });
}

console.log(`\n${checked} relative links in ${files.length} files: ${failures} broken, ${pending} pending (allowed).`);
process.exit(failures ? 1 : 0);
