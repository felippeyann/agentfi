import { describe, expect, it, vi } from 'vitest';
import {
  getMaxLoginAttempts,
  getLoginAttemptContext,
  isLoginBlocked,
  registerLoginFailure,
} from './login-rate-limit';

const headers = {
  'x-forwarded-for': '203.0.113.42',
  'user-agent': 'vitest-agent',
};

describe('login-rate-limit', () => {
  it('collects login attempt context from headers', () => {
    const context = getLoginAttemptContext(headers);
    expect(context.ip).toBe('203.0.113.42');
    expect(context.userAgent).toBe('vitest-agent');
  });

  it('locks after repeated failures and eventually unblocks', () => {
    vi.useFakeTimers();

    const username = `operator-${Date.now()}`;
    const maxAttempts = getMaxLoginAttempts();

    for (let i = 0; i < maxAttempts - 1; i += 1) {
      const state = registerLoginFailure(username, headers);
      expect(state.locked).toBe(false);
      expect(state.remainingAttempts).toBe(maxAttempts - 1 - i);
    }

    const finalFailure = registerLoginFailure(username, headers);
    expect(finalFailure.locked).toBe(true);
    expect(finalFailure.remainingAttempts).toBe(0);

    const blockedNow = isLoginBlocked(username, headers);
    expect(blockedNow.blocked).toBe(true);
    expect(blockedNow.retryAfterMs).toBeGreaterThan(0);

    vi.advanceTimersByTime(31 * 60 * 1000);

    const blockedAfterWindow = isLoginBlocked(username, headers);
    expect(blockedAfterWindow.blocked).toBe(false);

    vi.useRealTimers();
  });
});
