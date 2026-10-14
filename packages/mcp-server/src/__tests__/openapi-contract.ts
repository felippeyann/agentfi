/**
 * Reads one request-body schema from the repository's OpenAPI spec
 * (`docs/api/openapi.yaml`, the source of `api.generated.ts`) so a test can
 * check the body a tool sends against the documented route contract at run
 * time, not against a hand-written copy.
 *
 * Deliberately narrow: it understands the shape the spec uses for flat
 * request objects under `components.schemas` —
 *
 *     Name:
 *       type: object
 *       required: [a, b]
 *       properties:
 *         a: { type: string }
 *         b:
 *           type: integer
 *
 * — and throws on anything else (an `allOf`, a `$ref`, a block `required:`
 * list), so a reshaped schema fails the test loudly instead of being read
 * wrongly.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FlatObjectSchema {
  required: string[];
  properties: Record<string, { type: string }>;
}

const SPEC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/api/openapi.yaml');

const indentOf = (line: string) => line.length - line.trimStart().length;

export function readComponentSchema(name: string, specPath: string = SPEC_PATH): FlatObjectSchema {
  const lines = readFileSync(specPath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line === `    ${name}:`);
  if (start < 0) throw new Error(`components.schemas.${name} not found in ${specPath}`);

  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= 4) break;
    if (line.trim() !== '') block.push(line);
  }

  if (!block.some((line) => line === '      type: object')) {
    throw new Error(`${name}: expected a flat "type: object" schema`);
  }
  const requiredLine = block.find((line) => line.startsWith('      required:'));
  const requiredMatch = requiredLine ? /^ {6}required: \[([^\]]*)\]$/.exec(requiredLine) : null;
  if (!requiredMatch) throw new Error(`${name}: expected a flow-style "required: [...]" list`);
  const required = requiredMatch[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const propsAt = block.indexOf('      properties:');
  if (propsAt < 0) throw new Error(`${name}: no properties`);
  const properties: Record<string, { type: string }> = {};
  let current: string | undefined;
  for (const line of block.slice(propsAt + 1)) {
    const indent = indentOf(line);
    if (indent <= 6) break;
    if (indent === 8) {
      const prop = /^ {8}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!prop) throw new Error(`${name}: unreadable property line "${line.trim()}"`);
      current = prop[1]!;
      const inline = prop[2]!;
      if (inline.includes('$ref')) throw new Error(`${name}.${current}: $ref properties are not supported here`);
      const type = /type:\s*([a-z]+)/.exec(inline);
      if (inline !== '' && !type) throw new Error(`${name}.${current}: inline schema without a type`);
      if (type) properties[current] = { type: type[1]! };
      continue;
    }
    // A nested block property: its own `type:` line, one level deeper.
    const nestedType = /^ {10}type:\s*([a-z]+)\s*$/.exec(line);
    if (current && nestedType && !properties[current]) properties[current] = { type: nestedType[1]! };
  }
  for (const key of required) {
    if (!properties[key]) throw new Error(`${name}: required "${key}" has no typed property`);
  }
  return { required, properties };
}

/**
 * Problems of `body` against `schema`: a required key missing, a key the
 * schema does not define (the route's zod object strips unknown keys
 * silently — that is how `pay_agent`'s `recipient` and `reason` were lost),
 * or a value of the wrong JSON type. Empty when the body conforms.
 */
export function contractViolations(body: Record<string, unknown>, schema: FlatObjectSchema): string[] {
  const problems: string[] = [];
  for (const key of schema.required) {
    if (body[key] === undefined) problems.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(body)) {
    const prop = schema.properties[key];
    if (!prop) {
      problems.push(`unknown key "${key}"`);
      continue;
    }
    const ok =
      prop.type === 'string'
        ? typeof value === 'string'
        : prop.type === 'integer'
          ? Number.isInteger(value)
          : prop.type === 'number'
            ? typeof value === 'number'
            : prop.type === 'boolean'
              ? typeof value === 'boolean'
              : true;
    if (!ok) problems.push(`"${key}" is not a ${prop.type}`);
  }
  return problems;
}
