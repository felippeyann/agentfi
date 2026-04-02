import { describe, expect, it, vi } from 'vitest';
import { logAdminAuthEvent } from './admin-audit';

describe('admin-audit', () => {
  it('logs success events to info with masked username', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logAdminAuthEvent({
      event: 'admin_login_success',
      username: 'operator',
      ip: '203.0.113.42',
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[admin-auth-audit]');
    expect(line).toContain('o***r');

    infoSpy.mockRestore();
  });

  it('logs non-success events to warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logAdminAuthEvent({
      event: 'admin_login_blocked',
      username: 'operator',
      retryAfterMs: 1200,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('admin_login_blocked');

    warnSpy.mockRestore();
  });
});
