/**
 * Payer authorization audit: the route inventory.
 *
 * docs/architecture/payer-authorization.md classifies EVERY route of the
 * backend for the payer credential (an agent API key). This test keeps that
 * page true without booting the server: it reads the route registrations from
 * the source and fails when
 *   - a route exists that the page does not list (a new route cannot ship
 *     unclassified: add its row to section 2 and decide what an agent key may
 *     do there),
 *   - the page lists a route that no longer exists,
 *   - an `/admin/*` handler does not start with the `requireAdmin` guard (the
 *     agent-key hook skips `/admin*`, so that guard is the ONLY control),
 *   - the agent-key hook stops short-circuiting `/admin` / the operator secret
 *     is accepted on any route besides `POST /v1/agents` and the policy PATCH.
 *
 * Detection limits (static, on purpose: no server boot, no mocks): only
 * `fastify.<method>('<literal path>'` registrations in `api/routes/*.ts` and
 * `index.ts` are seen. A route added through `fastify.route({...})`, with a
 * computed path, on an instance not called `fastify`, or in another directory
 * is invisible here — and the guard check looks at the first statement of the
 * handler in `admin.ts` only (a guard moved into a hook would need this test
 * rewritten, not deleted).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');
const DOC = resolve(SRC, '..', '..', '..', 'docs', 'architecture', 'payer-authorization.md');

const ROUTE_REGISTRATION = /fastify\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*'([^']+)'/g;

function routesIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(ROUTE_REGISTRATION)].map((m) => `${(m[1] as string).toUpperCase()} ${m[2]}`);
}

function sourceRoutes(): string[] {
  const dir = join(SRC, 'api', 'routes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
  files.push(join(SRC, 'index.ts'));
  return files.flatMap(routesIn).sort();
}

function documentedRoutes(): Set<string> {
  const text = readFileSync(DOC, 'utf8');
  const keys = new Set<string>();
  for (const m of text.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE)) (\/[^`\s]*)`/g)) keys.add(`${m[1]} ${m[2]}`);
  return keys;
}

describe('payer authorization inventory', () => {
  it('finds the route registrations (guards the extraction itself)', () => {
    const routes = sourceRoutes();
    expect(routes).toContain('PATCH /v1/agents/:id/policy');
    expect(routes).toContain('POST /v1/jobs/:id/pay-resource');
    expect(routes).toContain('GET /admin/stats');
    expect(routes.length).toBeGreaterThan(70);
  });

  it('every route of the backend is classified in docs/architecture/payer-authorization.md', () => {
    const documented = documentedRoutes();
    const missing = sourceRoutes().filter((route) => !documented.has(route));
    expect(missing, `routes missing from the authorization matrix: ${missing.join(', ')}`).toEqual([]);
  });

  it('the page lists no route that does not exist', () => {
    const actual = new Set(sourceRoutes());
    const stale = [...documentedRoutes()].filter((route) => !actual.has(route));
    expect(stale, `documented routes that are not registered: ${stale.join(', ')}`).toEqual([]);
  });

  it('every /admin handler starts with the requireAdmin guard (the agent-key hook skips /admin*)', () => {
    const text = readFileSync(join(SRC, 'api', 'routes', 'admin.ts'), 'utf8');
    const registrations = [...text.matchAll(/fastify\.(?:get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*'(\/admin[^']*)'/g)];
    expect(registrations.length).toBeGreaterThan(25);
    for (const [index, registration] of registrations.entries()) {
      const start = registration.index as number;
      const end = registrations[index + 1]?.index ?? text.length;
      const body = text.slice(start, end);
      // the guard is the first statement of the handler body (after the `async (request, reply) => {` line)
      const handler = body.slice(body.indexOf('async (request'));
      const firstStatement = handler.slice(handler.indexOf('{') + 1).trimStart();
      expect(firstStatement.startsWith('if (!requireAdmin(request, reply)) return;'), `${registration[1]} must call requireAdmin first`).toBe(true);
    }
  });

  it('every /admin route is registered in admin.ts (the only file whose handlers are checked for the guard)', () => {
    const dir = join(SRC, 'api', 'routes');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'admin.ts').map((f) => join(dir, f));
    files.push(join(SRC, 'index.ts'));
    const strays = files.flatMap((file) => routesIn(file).filter((route) => route.split(' ')[1]?.startsWith('/admin')).map((route) => `${route} (${file})`));
    expect(strays, `admin routes outside admin.ts: ${strays.join(', ')}`).toEqual([]);
    for (const route of routesIn(join(dir, 'admin.ts'))) expect(route.split(' ')[1]).toMatch(/^\/admin\//);
  });

  it('the auth hook: /admin is skipped by name (so requireAdmin is the control) and the operator secret has two entry points only', () => {
    const auth = readFileSync(join(SRC, 'api', 'middleware', 'auth.ts'), 'utf8');
    expect(auth).toContain("routeUrl?.startsWith('/admin')");
    expect(auth).toMatch(/OPERATOR_CAPABLE_ROUTES: ReadonlySet<string> = new Set\(\['PATCH \/v1\/agents\/:id\/policy'\]\)/);
    // isOperatorKey is consulted for registration and the allow-list, nowhere else
    expect([...auth.matchAll(/isOperatorKey\(request/g)].length).toBe(2);
  });
});
