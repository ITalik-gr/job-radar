import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RobotsDisallowedError, fetchJson, fetchText, resetHttpCaches } from '../src/lib/http.js';

let server: Server;
let base: string;
let hits = 0;
const timestamps: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    if (url.startsWith('/private')) {
      res.writeHead(200).end('secret');
      return;
    }
    if (url === '/flaky') {
      hits += 1;
      if (hits < 3) {
        res.writeHead(500).end('failed');
        return;
      }
      res.writeHead(200).end('ok');
      return;
    }
    if (url === '/gone') {
      res.writeHead(404).end('gone');
      return;
    }
    if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"jobs":[{"id":1}]}');
      return;
    }
    timestamps.push(Date.now());
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetHttpCaches();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchText', () => {
  it('reads a page', async () => {
    const res = await fetchText(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('hello');
  });

  it('respects robots.txt', async () => {
    await expect(fetchText(`${base}/private/page`)).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('ignoreRobots bypasses the check only explicitly', async () => {
    const res = await fetchText(`${base}/private/page`, { ignoreRobots: true });
    expect(res.body).toBe('secret');
  });

  it('retries 5xx and eventually gets a response', async () => {
    const res = await fetchText(`${base}/flaky`, { retries: 3 });
    expect(res.body).toBe('ok');
    expect(hits).toBe(3);
  });

  it('does not retry 404', async () => {
    await expect(fetchText(`${base}/gone`, { retries: 3 })).rejects.toThrow('404');
  });

  it('keeps a pause between requests to the same domain', async () => {
    // The pause comes from config.http.domainDelayMs, 50ms in tests (vitest.config.ts).
    // We check the total time of three requests, not the gaps between them: a single
    // gap depends on when the server managed to record the timestamp and gives false failures.
    timestamps.length = 0;
    const started = Date.now();
    await Promise.all([fetchText(`${base}/a`), fetchText(`${base}/b`), fetchText(`${base}/c`)]);
    const elapsed = Date.now() - started;

    expect(timestamps).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });
});

describe('fetchJson', () => {
  it('parses JSON', async () => {
    const data = await fetchJson<{ jobs: { id: number }[] }>(`${base}/json`);
    expect(data.jobs[0]!.id).toBe(1);
  });
});
