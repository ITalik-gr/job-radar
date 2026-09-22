import { beforeEach, describe, expect, it } from 'vitest';
import { setRuntimeEnv } from '../src/config.js';
import { gmailStatus, loadToken, redirectUri, saveToken } from '../src/lib/gmail.js';

/**
 * Running without a filesystem: exactly how the module lives on Cloudflare Workers.
 * The refresh token arrives as a secret, the short-lived access token sits in memory.
 */

beforeEach(async () => {
  setRuntimeEnv({
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    GMAIL_FROM_EMAIL: 'olena@example.com',
    GMAIL_REFRESH_TOKEN: 'refresh-123',
    GMAIL_REDIRECT_URI: 'https://job-radar.example.workers.dev/api/gmail/callback',
  });
  // The import registers the store, so it happens after the environment is ready.
  await import('../src/lib/gmail-store.env.js');
});

describe('production mail mode', () => {
  it('redirect_uri comes from the environment, not from localhost', () => {
    expect(redirectUri()).toBe('https://job-radar.example.workers.dev/api/gmail/callback');
  });

  it('the token is read from the secret, with no file on disk', () => {
    expect(loadToken()?.refreshToken).toBe('refresh-123');
  });

  it('the connection shows as working', () => {
    expect(gmailStatus()).toMatchObject({ configured: true, connected: true, hint: null });
  });

  it('the access token is kept in memory between calls', () => {
    saveToken({ refreshToken: 'refresh-123', accessToken: 'ya29.x', expiresAt: 123 });
    expect(loadToken()).toMatchObject({ accessToken: 'ya29.x', expiresAt: 123 });
  });

  it('a broken sender address shows separately from the connection', () => {
    // A Latin address typed on a Ukrainian keyboard layout, the exact slip the check exists for.
    setRuntimeEnv({ GMAIL_FROM_EMAIL: 'шефдшлювум' });
    const status = gmailStatus();
    expect(status.emailValid).toBe(false);
    expect(status.connected).toBe(true);
    expect(status.hint).toContain('keyboard layout');
    setRuntimeEnv({ GMAIL_FROM_EMAIL: 'olena@example.com' });
  });

  it('without the secret the connection is not considered working', () => {
    setRuntimeEnv({ GMAIL_REFRESH_TOKEN: '' });
    expect(loadToken()).toBeNull();
    expect(gmailStatus().hint).toContain('connect');
  });
});
