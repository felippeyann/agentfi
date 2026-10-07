/**
 * Error sanitizer for MCP tool results.
 *
 * Every tool call goes through one dispatcher (server.ts), and every error it
 * catches is turned into a tool result here. The result keeps what an agent
 * needs to act — the backend's validation/business message, its `code`
 * (BUDGET_EXCEEDED, ESCROW_NOT_FUNDED, VALIDATION_FAILED, …), HTTP status and
 * structured details — and strips what must not leave the process: internal
 * and credentialed URLs, stack frames, file paths, secret env values, API
 * keys, bearer tokens and private-key-shaped hex. A short random `traceId` is
 * added to the result, and the full original error is logged to stderr with
 * the same id (stdout is the MCP stdio channel and must stay clean).
 */
import { randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from './api-error.js';

// ─── Context ───────────────────────────────────────────────────────────────

export interface SanitizeContext {
  /** Exact values that must never appear in a result (API key, secret env values). */
  secrets: readonly string[];
  /** Origins treated as internal, e.g. the configured AgentFi backend URL. */
  internalOrigins: readonly string[];
  /** Host names (with optional port) treated as internal when they appear bare. */
  internalHosts: readonly string[];
}

/** Env var names whose values are secrets wherever they show up. */
const SENSITIVE_ENV_NAME =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|MNEMONIC|SEED|AUTH|DATABASE_URL|REDIS_URL|RPC_URL|DSN/i;
const MIN_SECRET_LENGTH = 8;

export function sanitizeContextFromEnv(env: NodeJS.ProcessEnv = process.env): SanitizeContext {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (SENSITIVE_ENV_NAME.test(name) && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  }
  // The agent's own key is never echoed, whatever its length.
  const apiKey = env['AGENTFI_API_KEY'];
  if (apiKey && apiKey.length >= 4) secrets.add(apiKey);

  const internalOrigins: string[] = [];
  const internalHosts: string[] = [];
  const apiUrl = env['AGENTFI_API_URL'];
  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      internalOrigins.push(parsed.origin.toLowerCase());
      internalHosts.push(parsed.host.toLowerCase());
    } catch {
      // Not a URL — still never echo it verbatim.
      if (apiUrl.length >= 4) secrets.add(apiUrl);
    }
  }
  return {
    secrets: [...secrets].sort((a, b) => b.length - a.length),
    internalOrigins,
    internalHosts,
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
  status?: number;
  details?: unknown;
}

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}

function isZodLikeError(err: unknown): err is Error & { issues: ZodLikeIssue[] } {
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
 * Typed refusals about the agent's OWN outbound target (pay_for_resource,
 * S4): `INVALID_URL` carries `refusal` / `hostname` (the agent's hostname or
 * private literal; since S5 the backend no longer sends the `address` a name
 * resolved to) and `REDIRECT_REFUSED` carries the third party's redirect
 * `location` (already stripped of query and userinfo by the backend). Those
 * values are the agent's input or a third party's answer, not AgentFi
 * infrastructure, and the agent needs them to fix its request — so the
 * network-location rules are not applied to them. Every secret rule still
 * is. The backend applies the same set (packages/backend/src/api/errors/sanitize.ts).
 */
export const TARGET_REFUSAL_CODES: ReadonlySet<string> = new Set(['INVALID_URL', 'REDIRECT_REFUSED']);

/** Backends that put the code in `error` (e.g. `{ error: 'ESCROW_NOT_FUNDED' }`). */
const CODE_LIKE = /^[A-Z][A-Z0-9_]{2,}$/;

function omitKeys(body: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

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

/** Extracts message / code / status / details from anything that was thrown. */
export function describeError(err: unknown): DescribedError {
  if (err instanceof ApiError) {
    const bodyError = err.body['error'];
    const code = err.code ?? (typeof bodyError === 'string' && CODE_LIKE.test(bodyError) ? bodyError : undefined);
    const details = omitKeys(err.body, ['error', 'code']);
    return {
      message: err.message,
      status: err.status,
      ...(code !== undefined ? { code } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }
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
  if (err instanceof Error) return { message: err.message || err.name || 'Error' };
  return { message: stringifyUnknown(err) };
}

function recommendationFor(described: DescribedError, traceId: string): string {
  const { code, status } = described;
  if (code === 'INVALID_INPUT' || status === 400 || status === 422) {
    return 'Fix the input parameters (see error and details) and try again.';
  }
  if (status === 401) return 'The AgentFi API key was rejected. Check the AGENTFI_API_KEY configured for this server.';
  if (status === 403) {
    return 'Refused by the agent policy or permissions. Do not retry unchanged; ask the operator if limits must change.';
  }
  if (status === 404) return 'The referenced resource was not found. Check the id and try again.';
  if (status === 409) return 'The request conflicts with the current state (see code and details). Resolve that before retrying.';
  if (status === 429) return 'A rate or tier limit was reached. Wait before retrying.';
  if (status !== undefined && status < 500) return 'The request was refused (see code and details). Do not retry unchanged.';
  return `Unexpected error. Retry later; if it persists, contact the AgentFi operator and quote traceId ${traceId}.`;
}

// ─── Tool result ───────────────────────────────────────────────────────────

/** Short random id shared by the tool result and the stderr log line. */
export function newTraceId(): string {
  return randomBytes(6).toString('hex');
}

export type ErrorLogger = (traceId: string, tool: string, err: unknown) => void;

/** Default logger: stderr only — stdout carries the MCP stdio protocol. */
export const stderrErrorLogger: ErrorLogger = (traceId, tool, err) => {
  console.error(`[AgentFi MCP] traceId=${traceId} tool=${tool} failed:`, err);
};

export interface ToolErrorPayload {
  error: string;
  code?: string;
  status?: number;
  details?: unknown;
  tool: string;
  traceId: string;
  recommendation: string;
}

export interface ToolErrorOptions {
  tool: string;
  log?: ErrorLogger;
  context?: SanitizeContext;
  traceId?: string;
}

export function buildToolErrorPayload(err: unknown, options: ToolErrorOptions): ToolErrorPayload {
  const ctx = options.context ?? sanitizeContextFromEnv();
  const traceId = options.traceId ?? newTraceId();
  const described = describeError(err);
  const rules: SanitizeOptions = {
    keepNetworkLocations: described.code !== undefined && TARGET_REFUSAL_CODES.has(described.code),
  };
  const message = sanitizeText(described.message, ctx, rules) || 'Unknown error';
  const details = described.details !== undefined ? sanitizeValue(described.details, ctx, rules) : undefined;
  return {
    error: message,
    ...(described.code !== undefined ? { code: sanitizeText(described.code, ctx) } : {}),
    ...(described.status !== undefined ? { status: described.status } : {}),
    ...(details !== undefined ? { details } : {}),
    tool: options.tool,
    traceId,
    recommendation: recommendationFor(described, traceId),
  };
}

/**
 * Turns anything a tool threw into a safe `isError` tool result and logs the
 * original error (unsanitized, with stack) to stderr under the same traceId.
 */
export function toolErrorResult(err: unknown, options: ToolErrorOptions): CallToolResult {
  const payload = buildToolErrorPayload(err, options);
  try {
    (options.log ?? stderrErrorLogger)(payload.traceId, options.tool, err);
  } catch {
    // Logging must never turn a tool error into a protocol error.
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
