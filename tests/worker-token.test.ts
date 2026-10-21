import { describe, expect, it } from 'vitest';
import worker from '../src/worker';

/*
 * An empty token is "no password" on loopback, but on a worker it opened the contacts and the
 * send button to the internet. The worker refuses instead.
 */
describe('worker without RADAR_TOKEN', () => {
  const env = { DB: {}, RADAR_TOKEN: '' } as never;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

  it('API routes answer 503 with what to do', async () => {
    const response = await worker.fetch(new Request('https://radar.example/api/companies'), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('RADAR_TOKEN');
  });

  it('the MCP endpoint and the OAuth routes stay closed too', async () => {
    for (const path of ['/mcp', '/api/oauth/authorize', '/api/oauth/token', '/.well-known/oauth-authorization-server']) {
      const response = await worker.fetch(new Request(`https://radar.example${path}`), env, ctx);
      expect(response.status, path).toBe(503);
    }
  });
});

describe('worker without the OAUTH_KV namespace', () => {
  const env = { DB: {}, RADAR_TOKEN: 'secret' } as never;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

  it('/mcp falls back to the plain bearer check', async () => {
    const response = await worker.fetch(new Request('https://radar.example/mcp', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });
});

describe('source rotation on the worker', () => {
  it('every source gets to be first in turn', async () => {
    const { rotate } = await import('../src/lib/rotate');
    expect(rotate(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotate([], 3)).toEqual([]);
  });
});
