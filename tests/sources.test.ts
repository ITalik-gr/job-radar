import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseGreenhouse } from '../src/sources/boards/greenhouse.js';
import { parse as parseLever } from '../src/sources/boards/lever.js';
import { parse as parseAshby } from '../src/sources/boards/ashby.js';
import { parse as parseRemoteOk } from '../src/sources/boards/remoteok.js';
import { feedConfigs } from '../src/sources/boards/feeds.js';
import { createRssSource } from '../src/sources/boards/rss.js';
import type { RawVacancy } from '../src/sources/registry.js';

const fixture = (path: string) => readFileSync(`fixtures/${path}`, 'utf8');

/** Shared invariants: without them, an adapter is considered broken. */
function expectSane(items: RawVacancy[], source: string, min = 3) {
  expect(items.length).toBeGreaterThanOrEqual(min);
  for (const item of items) {
    expect(item.source).toBe(source);
    expect(item.title, `empty title in ${source}`).toBeTruthy();
    expect(item.url).toMatch(/^https?:\/\//);
    expect(item.rawText.length, `empty rawText in ${source}: ${item.title}`).toBeGreaterThan(50);
    expect(item.rawText).not.toMatch(/<(div|p|script|span)\b/i);
    expect(item.rawText).not.toMatch(/&lt;|&nbsp;/);
  }
}

describe('greenhouse', () => {
  const items = parseGreenhouse(fixture('greenhouse/vercel-jobs.json'));

  it('parses the fixture', () => expectSane(items, 'greenhouse'));

  it('extracts the title, id, location and company', () => {
    const job = items[0]!;
    expect(job.externalId).toMatch(/^\d+$/);
    expect(job.companyName).toBe('Vercel');
    expect(job.location).toBeTruthy();
    expect(job.postedAt).toBeGreaterThan(Date.parse('2020-01-01'));
  });

  it('unescapes double-escaped description HTML', () => {
    expect(items[0]!.rawText).toContain('Vercel');
  });

  it('an empty board is an empty array, not an exception', () => {
    expect(parseGreenhouse('{"jobs":[],"meta":{"total":0}}')).toEqual([]);
  });
});

describe('lever', () => {
  const items = parseLever(fixture('lever/spotify-postings.json'));

  it('parses the fixture', () => expectSane(items, 'lever'));

  it('joins several locations and reads workplaceType', () => {
    const job = items[0]!;
    expect(job.url).toContain('jobs.lever.co');
    expect(job.location).toBeTruthy();
    expect([true, false, null]).toContain(job.remote);
  });

  it('throws on an unexpected response shape', () => {
    expect(() => parseLever('{"postings":[]}')).toThrow();
  });
});

describe('ashby', () => {
  const items = parseAshby(fixture('ashby/ramp-board.json'));

  it('parses the fixture', () => expectSane(items, 'ashby'));

  it('takes the salary range from compensation and the isRemote flag', () => {
    const withSalary = items.find((i) => i.rawText.includes('Compensation:'));
    expect(withSalary).toBeDefined();
    expect(items.some((i) => i.remote === true)).toBe(true);
  });

  it('drops unpublished vacancies', () => {
    const payload = JSON.stringify({
      jobs: [{ id: 'x', title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/x/1', isListed: false }],
    });
    expect(parseAshby(payload)).toEqual([]);
  });
});

describe('remoteok', () => {
  const items = parseRemoteOk(fixture('remoteok/api.json'));

  it('parses the fixture', () => expectSane(items, 'remoteok'));

  it('drops the legal notice from the first item', () => {
    expect(items.every((i) => i.title !== null)).toBe(true);
    expect(items.some((i) => i.rawText.includes('API Terms of Service'))).toBe(false);
  });

  it('adds tags and the salary range to the text', () => {
    expect(items.some((i) => i.rawText.includes('Tags:'))).toBe(true);
  });
});

describe('rss', () => {
  const byId = Object.fromEntries(feedConfigs.map((f) => [f.id, f]));
  const files: Record<string, string> = {
    'rss:weworkremotely': 'rss/weworkremotely.xml',
    'rss:himalayas': 'rss/himalayas.xml',
    'rss:remotive': 'rss/remotive.xml',
  };

  for (const [id, file] of Object.entries(files)) {
    describe(id, () => {
      const source = createRssSource(byId[id]!);
      const items = source.parse(fixture(file));

      it('parses the fixture', () => expectSane(items, id, 3));

      it('determines the company', () => {
        expect(items.every((i) => Boolean(i.companyName))).toBe(true);
      });

      it('has a posted date', () => {
        expect(items.every((i) => typeof i.postedAt === 'number')).toBe(true);
      });
    });
  }

  it('weworkremotely cuts the company off the title', () => {
    const source = createRssSource(byId['rss:weworkremotely']!);
    const items = source.parse(fixture('rss/weworkremotely.xml'));
    expect(items[0]!.companyName).toBe('Vercel');
    expect(items[0]!.title).not.toContain(':');
  });

  it('an empty feed gives an empty array', () => {
    const source = createRssSource(byId['rss:remotive']!);
    expect(source.parse('<rss><channel><title>x</title></channel></rss>')).toEqual([]);
  });
});
