import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { rejectForeignWrites } from '../src/api/index';

/**
 * Cross-site writes. CORS hides the answer from a foreign page but does not stop a
 * "simple" POST, so without this guard any site the owner visits could change the radar.
 */
function appWithGuard() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => rejectForeignWrites(['http://localhost:5173'])(c, next));
  app.onError((error, c) => c.json({ error: error.message }, ((error as { status?: number }).status ?? 500) as 403));
  app.post('/api/companies/1/state', (c) => c.json({ ok: true }));
  app.post('/api/import/catalog', (c) => c.json({ ok: true }));
  app.get('/api/companies', (c) => c.json([]));
  return app;
}

const post = (path: string, headers: Record<string, string> = {}) =>
  appWithGuard().request(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: '{"status":"blacklist"}',
  });

describe('foreign origin writes', () => {
  it('a POST from another site is refused', async () => {
    const response = await post('/api/companies/1/state', { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('the interface origin passes', async () => {
    const response = await post('/api/companies/1/state', { origin: 'http://localhost:5173' });
    expect(response.status).toBe(200);
  });

  it('the interface on another local port passes too: vite moves on when 5173 is taken', async () => {
    const response = await post('/api/companies/1/state', { origin: 'http://localhost:5174' });
    expect(response.status).toBe(200);
  });

  it('same origin passes, as on the worker where the interface is served by the API itself', async () => {
    const response = await post('/api/companies/1/state', { origin: 'http://127.0.0.1:3000' });
    expect(response.status).toBe(200);
  });

  it('a request without Origin passes: the CLI and curl send none', async () => {
    const response = await post('/api/companies/1/state');
    expect(response.status).toBe(200);
  });

  it('catalog import stays open to the extension on a catalog page', async () => {
    const response = await post('/api/import/catalog', { origin: 'https://clutch.co' });
    expect(response.status).toBe(200);
  });

  it('reads are not affected', async () => {
    const response = await appWithGuard().request('http://127.0.0.1:3000/api/companies', {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(200);
  });
});

describe('the radar token', () => {
  it('compares equal strings as equal and anything else as different', async () => {
    const { sameSecret } = await import('../src/lib/secret');
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });

  it('the OAuth state is stable and does not contain the token', async () => {
    const { oauthState } = await import('../src/lib/secret');
    const state = await oauthState('my-radar-token');
    expect(state).toBe(await oauthState('my-radar-token'));
    expect(state).not.toContain('my-radar-token');
    expect(state).not.toBe(await oauthState('another-token'));
  });

  it('the shallow health check is open, the deep one wants the token', async () => {
    const { requireToken } = await import('../src/api/index');
    const app = new Hono();
    app.use('/api/*', async (c, next) => requireToken('secret')(c, next));
    app.onError((error, c) => c.json({}, ((error as { status?: number }).status ?? 500) as 401));
    app.get('/api/health', (c) => c.json({ ok: true }));

    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/health?deep=1')).status).toBe(401);
    expect((await app.request('/api/health?deep=1', { headers: { 'x-radar-token': 'secret' } })).status).toBe(200);
  });
});

describe('D1 parameter slices', () => {
  it('slices stay under a hundred parameters', async () => {
    const { chunk, rowsPerQuery } = await import('../src/lib/chunk');
    expect(rowsPerQuery(7)).toBe(14);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
