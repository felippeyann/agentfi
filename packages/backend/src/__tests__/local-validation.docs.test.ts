/**
 * `docs/operations/local-validation.md` (#184): every command it gives for a
 * suite that EMPTIES its database (the E2E on Anvil, the ERC-8183 fork
 * rehearsal) names that database with `E2E_DATABASE_URL`, and the page's
 * setup creates it (review of #184, P2).
 *
 * The finding: the fork rehearsal's command set no `E2E_DATABASE_URL`, so
 * the harness (`readEscrowForkConfig`) fell back to its default
 * `agentfi_e2e_escrow` — a database the page never creates. (Checked
 * 2026-10-14: `prisma migrate deploy`, the harness's first step, creates a
 * missing database, so the run does not fail; it migrates and TRUNCATEs a
 * shared default database instead of "a database of your own", and two
 * people or agents following the page wipe each other's rehearsal.)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEscrowForkConfig } from './e2e/escrow-fork.harness.js';

const PAGE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/operations/local-validation.md');
const text = readFileSync(PAGE, 'utf8');
const lines = text.split(/\r?\n/);

/** Databases the page's commands create. */
const created = new Set([...text.matchAll(/CREATE DATABASE ([A-Za-z0-9_<>]+)/g)].map((m) => m[1]!));

/** The page's lines that run a suite which empties its database. */
const e2eCommands = lines.filter((line) => /test:e2e|vitest\.config\.e2e/.test(line));

function databaseUrlIn(line: string): string | undefined {
  return /E2E_DATABASE_URL=([^\s`]+)/.exec(line)?.[1];
}

describe('local-validation.md: the E2E suites run on a database the page creates (review of #184)', () => {
  it('finds the E2E on Anvil and the fork rehearsal commands', () => {
    expect(e2eCommands.some((l) => l.includes('vitest.config.e2e.ts'))).toBe(true);
    expect(e2eCommands.some((l) => l.includes('test:e2e:escrow-fork'))).toBe(true);
  });

  it.each(e2eCommands.map((line) => [line.slice(0, 60), line]))('%s… sets E2E_DATABASE_URL to a database created in §1', (_label, line) => {
    const url = databaseUrlIn(line);
    expect(url, `no E2E_DATABASE_URL in: ${line}`).toBeDefined();
    const name = /^postgresql:\/\/[^/]+\/([A-Za-z0-9_<>]+)$/.exec(url!)?.[1];
    expect(name, `E2E_DATABASE_URL=${url} names no database`).toBeDefined();
    expect([...created], `${name} is not created on the page`).toContain(name);
  });

  it('with the rehearsal command\'s variables, the harness uses that database (not its default agentfi_e2e_escrow)', () => {
    const line = e2eCommands.find((l) => l.includes('test:e2e:escrow-fork'))!;
    const env = Object.fromEntries([...line.matchAll(/\b([A-Z0-9_]+)=([^\s`]+)/g)].map((m) => [m[1]!, m[2]!]));
    const config = readEscrowForkConfig(env as NodeJS.ProcessEnv);
    expect(config?.databaseUrl).toBe(env['E2E_DATABASE_URL']);
    expect(config?.databaseUrl).not.toMatch(/agentfi_e2e_escrow/);
  });
});
