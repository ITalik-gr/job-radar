import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseGreenhouse } from '../src/sources/boards/greenhouse.js';
import { parse as parseLever } from '../src/sources/boards/lever.js';
import { parse as parseAshby } from '../src/sources/boards/ashby.js';
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
