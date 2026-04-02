interface AdminAuditEvent {
  event:
    | 'admin_login_success'
    | 'admin_login_invalid_credentials'
    | 'admin_login_blocked'
    | 'admin_login_config_invalid';
  username?: string;
  ip?: string;
  userAgent?: string;
  remainingAttempts?: number;
  retryAfterMs?: number;
  maxAttempts?: number;
}

function maskUsername(username: string): string {
  const normalized = username.trim();
  if (!normalized) return 'unknown';
  if (normalized.length <= 2) return '*'.repeat(normalized.length);
  return `${normalized[0]}***${normalized[normalized.length - 1]}`;
}

export function logAdminAuthEvent(payload: AdminAuditEvent): void {
  const logPayload = {
    ...payload,
    username: payload.username ? maskUsername(payload.username) : undefined,
    timestamp: new Date().toISOString(),
  };

  const line = `[admin-auth-audit] ${JSON.stringify(logPayload)}`;

  if (payload.event === 'admin_login_success') {
    console.info(line);
    return;
  }

  console.warn(line);
}
