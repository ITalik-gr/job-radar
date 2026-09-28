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
});

describe('source rotation on the worker', () => {
  it('every source gets to be first in turn', async () => {
    const { rotate } = await import('../src/lib/rotate');
    expect(rotate(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotate([], 3)).toEqual([]);
  });
});
