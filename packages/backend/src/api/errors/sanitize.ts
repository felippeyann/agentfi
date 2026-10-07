/**
 * Error sanitizer for everything the backend sends to a caller (S5).
 *
 * The MCP server sanitizes errors at its own tool dispatcher
 * (packages/mcp-server/src/errors.ts, S2), but that only protects MCP stdio
 * clients: agents calling the REST API directly — and the backend's own
 * `/mcp/sse` surface — got raw error text. viem errors embed the RPC URL, and
 * the Alchemy URL carries the operator's API key in its path
 * (`https://…alchemy.com/v2/<ALCHEMY_API_KEY>`), so any response that forwarded
 * `err.message` from a chain call could leak it to an agent.
 *
 * Used by the Fastify error handler (api/errors/handler.ts), by every route
 * field that carries a caught or upstream error (`reason`, `details`,
 * `message`, `escrowError`, a transaction's `error`, …) and by `/mcp/sse`.
 * Business messages and `code`s survive — agents act on them; what goes is
 * secret env values, credentialed or keyed URLs, internal hosts, stack frames
 * and file paths.
 *
 * WHY A COPY: the backend cannot import @agent_fi/mcp-server (separate rootDir,
 * separate Docker build, and the MCP package is published to npm on its own, so
 * a shared workspace package would have to be published or bundled too). The
 * "Text rules" and "Structured values" sections below are a VERBATIM copy of
 * packages/mcp-server/src/errors.ts; src/__tests__/errors.sanitize.sync.test.ts
 * fails if the two drift apart. Change both files together. The Context and
 * Error classification sections are backend-specific (backend env, viem and
 * Zod errors instead of the MCP client's ApiError).
 *
 * Pure module: reads `process.env` at call time, never `config/env.ts`, so it
 * can be imported anywhere (routes, services, tests) without side effects.
 */
import { randomBytes } from 'node:crypto';

// ─── Context ───────────────────────────────────────────────────────────────

export interface SanitizeContext {
  /** Exact values that must never appear in a result (API key, secret env values). */
  secrets: readonly string[];
  /** Origins treated as internal, e.g. the configured AgentFi backend URL. */
  internalOrigins: readonly string[];
  /** Host names (with optional port) treated as internal when they appear bare. */
  internalHosts: readonly string[];
}

/** Env var names whose values are secrets wherever they show up (same list as the MCP server). */
const SENSITIVE_ENV_NAME =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|MNEMONIC|SEED|AUTH|DATABASE_URL|REDIS_URL|RPC_URL|DSN/i;
const MIN_SECRET_LENGTH = 8;

/**
 * Env vars holding the URL of AgentFi's own infrastructure. Their host names
 * are internal wherever they show up bare (Prisma: "Can't reach database
 * server at `db.example.com`:`5432`"), even when they look public.
 */
const INFRA_URL_ENV = ['DATABASE_URL', 'DIRECT_URL', 'REDIS_URL', 'API_BASE_URL'] as const;

function addSecret(secrets: Set<string>, value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return;
  // A digits-only value (a window in ms, a port, a chain id) is not a secret
  // and would redact unrelated numbers from every message.
  if (/^\d+$/.test(value)) return;
  secrets.add(value);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The backend's context: every secret-named env value (ALCHEMY_API_KEY,
 * INFURA_API_KEY, TENDERLY_ACCESS_KEY, TURNKEY_API_PRIVATE_KEY,
 * ESCROW_EVALUATOR_PRIVATE_KEY, API_SECRET, ADMIN_SECRET, DATABASE_URL,
 * REDIS_URL, *_RPC_URL, …) plus the password inside any URL-valued one, and
 * the hosts of the database, Redis and the backend's own base URL.
 */
export function sanitizeContextFromEnv(env: NodeJS.ProcessEnv = process.env): SanitizeContext {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SENSITIVE_ENV_NAME.test(name)) continue;
    addSecret(secrets, value);
    const url = value.includes('://') ? parseUrl(value) : undefined;
    if (url?.password) addSecret(secrets, decodeURIComponent(url.password));
  }

  const internalOrigins = new Set<string>();
  const internalHosts = new Set<string>();
  for (const name of INFRA_URL_ENV) {
    const raw = env[name];
    const url = raw ? parseUrl(raw) : undefined;
    if (!url || !url.hostname) continue;
    if (url.protocol === 'http:' || url.protocol === 'https:') internalOrigins.add(url.origin.toLowerCase());
    // Only dotted names: a single-label host ("postgres", "redis", "api" in
    // docker-compose) is already internal inside a URL, and redacting the
    // bare word would mangle ordinary prose.
    const host = url.hostname.toLowerCase();
    if (host.includes('.') && !host.startsWith('[')) internalHosts.add(host);
  }
  return {
    secrets: [...secrets].sort((a, b) => b.length - a.length),
    internalOrigins: [...internalOrigins],
    internalHosts: [...internalHosts],
  };
}

// ─── Text rules ────────────────────────────────────────────────────────────

const MAX_INPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 4_000;

/** V8 stack frames: "    at fn (file:///x.js:1:2)", "    at async Promise.all (index 0)". */
const STACK_FRAME_LINE = /^[ \t]+at [^\n]*(?:\([^\n]*\)|:\d+:\d+|<anonymous>|native)[^\n]*(?:\n|$)/gm;

/** AgentFi agent API keys: `agfi_live_<hex>`. */
const AGENTFI_API_KEY = /\bagfi_[A-Za-z]+_[A-Za-z0-9]{8,}\b/g;

/** Authorization header values. */
const AUTH_SCHEME_TOKEN = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/g;

/**
 * `label: value` / `label=value` for credential-looking labels, in prose,
 * headers, query strings or JSON. A bare `token` label is deliberately not
 * included — in this domain it names an ERC-20 token.
 */
const LABELLED_SECRET =
  /\b((?:x-)?api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|private[_-]?key|authorization)\b(["']?\s*[:=]\s*["']?)(?!\[redacted|(?:Bearer|Basic|Token)\b)([^\s"'&,;}]+)/gi;

/**
 * 32-byte hex (`0x` + 64 hex, or 64 bare hex) is how both private keys and
 * public values (tx hashes, bytes32 ids, deliverable hashes) look, so it is
 * only redacted when a key-ish word precedes it in the same line (within
 * 32 chars). A tx hash in "transaction 0x… reverted" survives.
 */
const KEY_SHAPED_HEX =
  /(\b(?:private|priv|secret|mnemonic|seed|signing|signer|pk|key)\b[^\n]{0,32}?)(?<![0-9A-Fa-fx])(?:0x)?[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/gi;

/** http(s) and ws(s) URLs, up to whitespace or quotes (unbalanced closers trimmed later). */
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

/** `file://` URLs. */
const FILE_URL = /\bfile:\/\/\/?[^\s"'<>`)\]}]*/gi;

/** Any scheme with userinfo: postgresql://user:pass@db, redis://:pass@cache, https://u:p@host. */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>@/]*@[^\s"'<>`)\]}]*/gi;

/** Bare host names under private-network suffixes ("db.internal:5432"). */
const INTERNAL_SUFFIX_HOST = /\b[\w-]+(?:\.[\w-]+)*\.(?:internal|local|lan|svc)(?::\d{1,5})?\b/gi;

/** Windows drive paths, with either separator. */
const WINDOWS_PATH = /\b[A-Za-z]:[\\/](?:[^\s"'<>|\\/]+[\\/])*[^\s"'<>|]*/g;

/**
 * Unix absolute paths with at least two segments. Only redacted when they
 * look like the filesystem (a known root in FS_ROOT, `node_modules`, or a
 * source-file extension in SOURCE_FILE) so API routes such as
 * `/v1/jobs/abc/pay-resource` in a message survive.
 */
const UNIX_PATH = /(?<![\w.:/~@-])(?:\/[\w.@+-]+){2,}\/?(?::\d+(?::\d+)?)?/g;
const FS_ROOT =
  /^\/(?:app|home|Users|usr|var|opt|srv|root|tmp|etc|workspace|builds|mnt|private|proc|run|snap|nix|lib|bin|sbin)\//;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|prisma|node|sol|map|env|pem)(?::\d+(?::\d+)?)?$/i;

/** Private, loopback and link-local IPv4 (optionally with port) and IPv6 loopback. */
const PRIVATE_IPV4 =
  /\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0\.0\.0\.0)(?::\d{1,5})?\b/g;
const IPV6_LOOPBACK = /(?<![\w:])(?:\[::1\]|::1)(?::\d{1,5})?(?![\w:])/g;
const LOCALHOST = /\blocalhost(?::\d{1,5})?\b/gi;

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^(?:127|10)\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h) || /^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/\.(?:internal|local|lan|svc|cluster\.local)$/.test(h)) return true;
  // Single-label names ("backend", "redis") only resolve inside a private network.
  if (!h.includes('.') && !h.includes(':')) return true;
  return false;
}

/** A path segment that looks like an embedded credential (RPC keys in the path). */
function isCredentialLikeSegment(segment: string): boolean {
  return segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Splits sentence punctuation and unbalanced closing brackets off the end of
 * a URL match: "(see https://x.io/a)." → "https://x.io/a" + ").", while
 * "…?apiKey=[redacted]" keeps its balanced "]".
 */
function splitTrailing(raw: string): [string, string] {
  let end = raw.length;
  while (end > 0) {
    const ch = raw.charAt(end - 1);
    if ('.,;:!?'.includes(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSER_TO_OPENER[ch];
    if (opener) {
      const body = raw.slice(0, end - 1);
      if (body.split(opener).length <= body.split(ch).length) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return [raw.slice(0, end), raw.slice(end)];
}

function sanitizeUrl(raw: string, ctx: SanitizeContext, keepNetworkLocations: boolean): string {
  const [candidate, trailing] = splitTrailing(raw);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return '[redacted-url]' + trailing;
  }
  if (
    !keepNetworkLocations &&
    (ctx.internalOrigins.includes(url.origin.toLowerCase()) || isPrivateHostname(url.hostname))
  ) {
    return '[internal-url]' + trailing;
  }
  const hasCredentials = url.username !== '' || url.password !== '';
  const hasQueryOrFragment = url.search !== '' || url.hash !== '';
  const hasKeyInPath = url.pathname.split('/').some(isCredentialLikeSegment);
  if (hasCredentials || hasQueryOrFragment || hasKeyInPath) {
    return `${url.origin}/[redacted]${trailing}`;
  }
  return candidate + trailing;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SanitizeOptions {
  /**
   * Keep internal-looking URLs, host names and private IPs (the network
   * location rules). Only for typed refusals about the agent's OWN outbound
   * target — see TARGET_REFUSAL_CODES. Secret, credential, stack-frame and
   * file-path rules always apply.
   */
  keepNetworkLocations?: boolean;
}

/**
 * Strips secrets and internals from one string. Order matters: exact secrets
 * first (so a key inside a URL is gone before the URL rules look at it), then
 * the pattern rules, then paths and hosts.
 */
export function sanitizeText(
  input: string,
  ctx: SanitizeContext = sanitizeContextFromEnv(),
  options: SanitizeOptions = {},
): string {
  const keepNetworkLocations = options.keepNetworkLocations === true;
  let text = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;

  text = text.replace(STACK_FRAME_LINE, '');

  for (const secret of ctx.secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }

  text = text.replace(AGENTFI_API_KEY, '[redacted-api-key]');
  text = text.replace(AUTH_SCHEME_TOKEN, '$1 [redacted]');
  text = text.replace(LABELLED_SECRET, '$1$2[redacted]');
  text = text.replace(KEY_SHAPED_HEX, '$1[redacted-key]');

  text = text.replace(FILE_URL, '[path]');
  text = text.replace(CREDENTIAL_URL, '[redacted-url]');
  text = text.replace(URL_PATTERN, (raw) => sanitizeUrl(raw, ctx, keepNetworkLocations));

  if (!keepNetworkLocations) {
    for (const host of ctx.internalHosts) {
      text = text.replace(
        new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?::\\d{1,5})?(?![\\w.-])`, 'gi'),
        '[internal-host]',
      );
    }
    text = text.replace(INTERNAL_SUFFIX_HOST, '[internal-host]');
    text = text.replace(PRIVATE_IPV4, '[internal-host]');
    text = text.replace(IPV6_LOOPBACK, '[internal-host]');
    text = text.replace(LOCALHOST, '[internal-host]');
  }

  text = text.replace(WINDOWS_PATH, '[path]');
  text = text.replace(UNIX_PATH, (path) =>
    FS_ROOT.test(path) || path.includes('/node_modules/') || SOURCE_FILE.test(path) ? '[path]' : path,
  );

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated]`;
  return text;
}

// ─── Structured values ─────────────────────────────────────────────────────

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
/** Keys dropped from structured details (internals, never actionable). */
const DROPPED_KEYS = new Set(['stack', 'stackTrace', 'stacktrace']);
/** Keys whose value is always redacted. `token` is NOT here: it names an ERC-20. */
const SECRET_KEY =
  /^(?:x-)?api[_-]?key$|^apikey$|secret|password|passwd|private[_-]?key|^authorization$|access[_-]?token|refresh[_-]?token|mnemonic|seed[_-]?phrase/i;

/** Recursively sanitizes every string inside a JSON-like value. */
export function sanitizeValue(
  value: unknown,
  ctx: SanitizeContext = sanitizeContextFromEnv(),
  options: SanitizeOptions = {},
  depth = 0,
): unknown {
  if (typeof value === 'string') return sanitizeText(value, ctx, options);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, ctx, options, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items truncated]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(key)) continue;
      if (SECRET_KEY.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      const clean = sanitizeValue(inner, ctx, options, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

// ─── Error classification ──────────────────────────────────────────────────

/** What survives of an error, before sanitizing. */
export interface DescribedError {
  message: string;
  code?: string;
  details?: unknown;
}

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}

/** Duck-typed so the module stays free of a zod import (any zod copy matches). */
export function isZodLikeError(err: unknown): err is Error & { issues: ZodLikeIssue[] } {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function networkErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause as { code?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : (err as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return code;
  if (err instanceof TypeError && err.message === 'fetch failed') return 'FETCH_FAILED';
  return undefined;
}

/**
 * viem's `BaseError` keeps a one-line `shortMessage` and the node's own words
 * in `details`; its `message` adds the RPC URL (with the provider key in the
 * path), the JSON-RPC request body and the viem version. Same format as the
 * simulator's `describeSimulationError`. Duck-typed: no viem import here.
 */
function viemSummary(err: Error): string | undefined {
  const { shortMessage, details } = err as { shortMessage?: unknown; details?: unknown };
  if (typeof shortMessage !== 'string' || shortMessage === '') return undefined;
  const detail = typeof details === 'string' && details !== '' && details !== shortMessage ? ` (${details})` : '';
  return `${shortMessage}${detail}`;
}

/**
 * Typed refusals about the agent's OWN outbound target (pay-resource, S4):
 * `INVALID_URL` carries `refusal` / `hostname` (the agent's input) and
 * `REDIRECT_REFUSED` the third party's redirect `location` (already stripped
 * of query and userinfo). The agent needs them to fix its request, so the
 * network-location rules are not applied to them; every secret rule still
 * is. Same set as the MCP server. Since S5 `INVALID_URL` no longer carries
 * the resolved `address` (it stays in the warn log).
 */
export const TARGET_REFUSAL_CODES: ReadonlySet<string> = new Set(['INVALID_URL', 'REDIRECT_REFUSED']);

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return 'Unknown error (no details)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `Non-Error thrown: ${String(value)}`;
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}') return `Non-Error thrown: ${json}`;
  } catch {
    // circular — fall through
  }
  return `Non-Error thrown: ${Object.prototype.toString.call(value)}`;
}

/** Extracts message / code / details from anything that was thrown (not yet sanitized). */
export function describeError(err: unknown): DescribedError {
  if (isZodLikeError(err)) {
    const issues = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      ...(issue.code ? { code: issue.code } : {}),
    }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    return { message: `Invalid input: ${summary}`, code: 'INVALID_INPUT', details: { issues } };
  }
  const netCode = networkErrorCode(err);
  if (netCode) {
    return {
      message: `Network error: could not reach an upstream service (${netCode}).`,
      code: 'UPSTREAM_UNREACHABLE',
    };
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { message: 'Upstream request timed out.', code: 'UPSTREAM_TIMEOUT' };
  }
  if (err instanceof Error) return { message: viemSummary(err) ?? (err.message || err.name || 'Error') };
  return { message: stringifyUnknown(err) };
}

// ─── Helpers for routes ────────────────────────────────────────────────────

/** Short random id shared by a response and the log line that holds the full error. */
export function newTraceId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * What a caller may read about a caught error: viem's summary instead of its
 * full message, then every rule above. Use it for any `reason` / `details` /
 * `message` field built from a caught or upstream error.
 */
export function publicErrorMessage(
  err: unknown,
  options: SanitizeOptions = {},
  ctx: SanitizeContext = sanitizeContextFromEnv(),
): string {
  return sanitizeText(describeError(err).message, ctx, options) || 'Unknown error';
}

/**
 * For an error string persisted earlier (Job.escrowError, Transaction.error,
 * …): those were written from `err.message` by workers and may predate S5.
 */
export function sanitizeStoredError(value: string | null | undefined, ctx?: SanitizeContext): string | null {
  // The context is only built when there is something to clean: job and
  // transaction lists call this for every row.
  if (!value) return value ?? null;
  return sanitizeText(value, ctx ?? sanitizeContextFromEnv()) || null;
}

/** Keys that hold error text in response bodies and stored rows. */
const ERROR_TEXT_KEYS = new Set(['error', 'reason', 'message', 'details', 'escrowError', 'providerAgentIdError']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Sanitizes only the error-text fields of a response body (`error`, `reason`,
 * `message`, `details`, `escrowError`, `providerAgentIdError`, at any depth)
 * and leaves every other field byte-for-byte — ids, amounts, hashes, URLs the
 * agent itself supplied. Dates and other class instances are kept as they are.
 */
export function sanitizeErrorFields<T>(
  value: T,
  options: SanitizeOptions = {},
  ctx: SanitizeContext = sanitizeContextFromEnv(),
  depth = 0,
): T {
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorFields(item, options, ctx, depth + 1)) as T;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (ERROR_TEXT_KEYS.has(key) && inner !== null && inner !== undefined) {
      out[key] = typeof inner === 'string' ? sanitizeText(inner, ctx, options) : sanitizeValue(inner, ctx, options);
    } else {
      out[key] = sanitizeErrorFields(inner, options, ctx, depth + 1);
    }
  }
  return out as T;
}
