interface AttemptState {
  count: number;
  windowStartMs: number;
  lockedUntilMs: number;
}

const attemptsByKey = new Map<string, AttemptState>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const MAX_ATTEMPTS = parsePositiveInt(process.env['ADMIN_AUTH_MAX_ATTEMPTS'], 5);
const WINDOW_MS = parsePositiveInt(process.env['ADMIN_AUTH_WINDOW_MS'], 10 * 60 * 1000);
const LOCKOUT_MS = parsePositiveInt(process.env['ADMIN_AUTH_LOCKOUT_MS'], 30 * 60 * 1000);

type HeaderMap = Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderMap | undefined, name: string): string {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function getClientIp(headers: HeaderMap | undefined): string {
  const forwarded = readHeader(headers, 'x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }

  const realIp = readHeader(headers, 'x-real-ip').trim();
  return realIp || 'unknown';
}

function buildAttemptKey(username: string, headers: HeaderMap | undefined): string {
  const identity = username.trim().toLowerCase() || 'unknown-user';
  const ip = getClientIp(headers);
  return `${identity}|${ip}`;
}

export function isLoginBlocked(username: string, headers: HeaderMap | undefined): boolean {
  const key = buildAttemptKey(username, headers);
  const now = Date.now();
  const state = attemptsByKey.get(key);
  if (!state) return false;

  if (state.lockedUntilMs > now) {
    return true;
  }

  if (state.lockedUntilMs <= now && state.lockedUntilMs !== 0) {
    state.lockedUntilMs = 0;
    state.count = 0;
    state.windowStartMs = now;
    attemptsByKey.set(key, state);
  }

  return false;
}

export function registerLoginFailure(username: string, headers: HeaderMap | undefined): void {
  const key = buildAttemptKey(username, headers);
  const now = Date.now();

  const current = attemptsByKey.get(key);
  if (!current || now - current.windowStartMs > WINDOW_MS) {
    attemptsByKey.set(key, {
      count: 1,
      windowStartMs: now,
      lockedUntilMs: 0,
    });
    return;
  }

  const nextCount = current.count + 1;
  const shouldLock = nextCount >= MAX_ATTEMPTS;

  attemptsByKey.set(key, {
    count: shouldLock ? 0 : nextCount,
    windowStartMs: current.windowStartMs,
    lockedUntilMs: shouldLock ? now + LOCKOUT_MS : current.lockedUntilMs,
  });
}

export function clearLoginFailures(username: string, headers: HeaderMap | undefined): void {
  const key = buildAttemptKey(username, headers);
  attemptsByKey.delete(key);
}
