import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DJINNI_KEYWORDS, parseDjinni } from '../src/sources/boards/djinni.js';

const javascript = readFileSync('fixtures/djinni/jobs-javascript.html', 'utf8');
const fullstack = readFileSync('fixtures/djinni/jobs-fullstack.html', 'utf8');

describe('djinni', () => {
  it('parses the search page and does not return zero', () => {
    // Rule 3 in CLAUDE.md: an empty result is an error, not a success.
    expect(parseDjinni(javascript).length).toBeGreaterThan(5);
    expect(parseDjinni(fullstack).length).toBeGreaterThan(5);
  });

  it('takes the title, link and external id', () => {
    const row = parseDjinni(javascript)[0]!;

    expect(row.source).toBe('djinni');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/djinni\.co\/jobs\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
  });

  it('takes the company name when it is not hidden', () => {
    expect(parseDjinni(javascript).some((row) => row.companyName)).toBe(true);
  });

  it('the Ukrainian "remote only" phrase is read as remote', () => {
    const rows = parseDjinni(javascript);
    const remote = rows.find((row) => /тільки віддалено/i.test(row.rawText));

    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
  });

  it('a number instead of a company name is not a company', () => {
    // In anonymous vacancies a view counter sits in that spot.
    for (const row of parseDjinni(javascript).concat(parseDjinni(fullstack))) {
      if (row.companyName) expect(row.companyName).not.toMatch(/^\d+$/);
    }
  });

  it('the company domain stays null: Djinni does not link to the employer site', () => {
    // The domain cannot be guessed from the board's own address, that would merge all vacancies into one company.
    expect(parseDjinni(javascript).every((row) => row.companyDomain === null)).toBe(true);
  });

  it('the card text ends up in rawText, since there is no separate salary field', () => {
    for (const row of parseDjinni(javascript)) {
      expect(row.rawText.length).toBeGreaterThan(row.title!.length);
    }
  });

  it('empty html gives an empty list, not a crash', () => {
    expect(parseDjinni('<html><body>nothing</body></html>')).toEqual([]);
  });

  it('the keywords are described by config, not hardcoded', () => {
    expect(DJINNI_KEYWORDS).toContain('JavaScript');
    expect(DJINNI_KEYWORDS.length).toBeGreaterThan(1);
  });
});
