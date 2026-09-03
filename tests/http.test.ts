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
      res.writeHead(200).end('секрет');
      return;
    }
    if (url === '/flaky') {
      hits += 1;
      if (hits < 3) {
        res.writeHead(500).end('впало');
        return;
      }
      res.writeHead(200).end('ок');
      return;
    }
    if (url === '/gone') {
      res.writeHead(404).end('нема');
      return;
    }
    if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"jobs":[{"id":1}]}');
      return;
    }
    timestamps.push(Date.now());
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>привіт</html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetHttpCaches();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchText', () => {
  it('читає сторінку', async () => {
    const res = await fetchText(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('привіт');
  });

  it('поважає robots.txt', async () => {
    await expect(fetchText(`${base}/private/page`)).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('ignoreRobots обходить перевірку тільки явно', async () => {
    const res = await fetchText(`${base}/private/page`, { ignoreRobots: true });
    expect(res.body).toBe('секрет');
  });

  it('повторює 5xx і зрештою отримує відповідь', async () => {
    const res = await fetchText(`${base}/flaky`, { retries: 3 });
    expect(res.body).toBe('ок');
    expect(hits).toBe(3);
  });

  it('не повторює 404', async () => {
    await expect(fetchText(`${base}/gone`, { retries: 3 })).rejects.toThrow('404');
  });

  it('тримає паузу між запитами до одного домену', async () => {
    // Пауза береться з config.http.domainDelayMs, у тестах це 50 мс (vitest.config.ts).
    // Перевіряємо сумарний час трьох запитів, а не проміжки між ними: окремий проміжок
    // залежить від того, коли сервер устиг записати мітку, і дає хибні падіння.
    timestamps.length = 0;
    const started = Date.now();
    await Promise.all([fetchText(`${base}/a`), fetchText(`${base}/b`), fetchText(`${base}/c`)]);
    const elapsed = Date.now() - started;

    expect(timestamps).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });
});

describe('fetchJson', () => {
  it('парсить JSON', async () => {
    const data = await fetchJson<{ jobs: { id: number }[] }>(`${base}/json`);
    expect(data.jobs[0]!.id).toBe(1);
  });
});
