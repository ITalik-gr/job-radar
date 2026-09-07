import { beforeEach, describe, expect, it } from 'vitest';
import { setRuntimeEnv } from '../src/config.js';
import { gmailStatus, loadToken, redirectUri, saveToken } from '../src/lib/gmail.js';

/**
 * Робота без файлової системи: саме так модуль живе на Cloudflare Workers.
 * Рефреш-токен приходить секретом, короткоживучий access token лежить у памʼяті.
 */

beforeEach(async () => {
  setRuntimeEnv({
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    GMAIL_FROM_EMAIL: 'italik@example.com',
    GMAIL_REFRESH_TOKEN: 'refresh-123',
    GMAIL_REDIRECT_URI: 'https://job-radar.example.workers.dev/api/gmail/callback',
  });
  // Імпорт реєструє сховище, тому робиться після того, як середовище готове.
  await import('../src/lib/gmail-store.env.js');
});

describe('прод-режим пошти', () => {
  it('redirect_uri береться з середовища, а не з localhost', () => {
    expect(redirectUri()).toBe('https://job-radar.example.workers.dev/api/gmail/callback');
  });

  it('токен читається з секрету, без файлу на диску', () => {
    expect(loadToken()?.refreshToken).toBe('refresh-123');
  });

  it('підключення видно як робоче', () => {
    expect(gmailStatus()).toMatchObject({ configured: true, connected: true, hint: null });
  });

  it('access token тримається в памʼяті між викликами', () => {
    saveToken({ refreshToken: 'refresh-123', accessToken: 'ya29.x', expiresAt: 123 });
    expect(loadToken()).toMatchObject({ accessToken: 'ya29.x', expiresAt: 123 });
  });

  it('зіпсована адреса відправника видно окремо від підключення', () => {
    setRuntimeEnv({ GMAIL_FROM_EMAIL: 'шефдшлювум' });
    const status = gmailStatus();
    expect(status.emailValid).toBe(false);
    expect(status.connected).toBe(true);
    expect(status.hint).toContain('розкладки');
    setRuntimeEnv({ GMAIL_FROM_EMAIL: 'italik@example.com' });
  });

  it('без секрету підключення не вважається робочим', () => {
    setRuntimeEnv({ GMAIL_REFRESH_TOKEN: '' });
    expect(loadToken()).toBeNull();
    expect(gmailStatus().hint).toContain('підключити');
  });
});
