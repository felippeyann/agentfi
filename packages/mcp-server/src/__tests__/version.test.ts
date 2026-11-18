import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../server.js';

const pkgUrl = new URL('../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files?: string[];
};

describe('package metadata', () => {
  // `initialize` reports SERVER_VERSION to every client. It is a constant in
  // server.ts, so a release that bumps package.json and forgets it would
  // publish a package that announces the previous version.
  it('SERVER_VERSION equals the package.json version', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  // Without an explicit list npm publishes src/, the tests and the config files
  // too (checked with `npm pack --dry-run` before 0.6.0). The runtime is dist/.
  it('ships only dist, the README and the licence', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('the bin target is inside the shipped dist', () => {
    expect(pkg.bin['agentfi-mcp']).toBe('dist/index.js');
  });
});
