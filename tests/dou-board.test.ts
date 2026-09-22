import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOU_CATEGORIES, parseDou } from '../src/sources/boards/dou.js';

const frontend = readFileSync('fixtures/dou/vacancies-frontend.html', 'utf8');
const node = readFileSync('fixtures/dou/vacancies-node.html', 'utf8');

describe('dou as a vacancy board', () => {
  it('parses the category page and does not return zero', () => {
    // Rule 3 in CLAUDE.md: an empty result is an error, not a success.
    expect(parseDou(frontend).length).toBeGreaterThan(10);
    expect(parseDou(node).length).toBeGreaterThan(10);
  });

  it('takes the title, link, external id and company', () => {
    const row = parseDou(frontend)[0]!;

    expect(row.source).toBe('dou:vacancies');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/jobs\.dou\.ua\/companies\/[^/]+\/vacancies\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
    expect(row.companyName).toBeTruthy();
    expect(row.companySlug).toBeTruthy();
  });

  it('the company name has no leftover markup from the icon', () => {
    for (const row of parseDou(frontend)) {
      expect(row.companyName ?? '').not.toMatch(/<|img|src=/);
    }
  });

  it('the Ukrainian "remote" word is read as remote', () => {
    const rows = parseDou(frontend);
    const remote = rows.find((row) => /віддален/i.test(row.location ?? ''));

    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
  });

  it('the salary ends up in the text, since there is no separate field in the schema', () => {
    const rows = parseDou(frontend).concat(parseDou(node));
    const withSalary = rows.filter((row) => /\$|\d{3,}/.test(row.rawText));
    expect(withSalary.length).toBeGreaterThan(0);
  });

  it('the company domain from the list is unknown and honestly stays null', () => {
    // DOU does not show the site in the list. The domain is added later by a separate fetch.
    expect(parseDou(frontend).every((row) => row.companyDomain === null)).toBe(true);
  });

  it('empty html gives an empty list, not a crash', () => {
    expect(parseDou('<html><body>nothing</body></html>')).toEqual([]);
  });

  it('the categories are described by config, not hardcoded', () => {
    expect(DOU_CATEGORIES).toContain('Front End');
    expect(DOU_CATEGORIES.length).toBeGreaterThan(1);
  });
});
