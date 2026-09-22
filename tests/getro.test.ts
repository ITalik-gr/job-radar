import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GETRO_NETWORKS, GETRO_QUERIES, nextGetroNetwork, parseGetro } from '../src/sources/boards/getro.js';

const listing = readFileSync('fixtures/getro/techstars-frontend.html', 'utf8');
const featured = readFileSync('fixtures/getro/techstars-jobs.html', 'utf8');

describe('getro', () => {
  it('parses the search page and does not return zero', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    // Rule 3 in CLAUDE.md: an empty result is an error, not a success.
    expect(rows.length).toBeGreaterThan(5);
  });

  it('takes the title, link and external id', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    const row = rows[0]!;

    expect(row.source).toBe('getro');
    expect(row.title).toBeTruthy();
    expect(row.url).toMatch(/^https:\/\/jobs\.techstars\.com\/companies\/[a-z0-9._-]+\/jobs\/\d+/);
    expect(row.externalId).toMatch(/^\d+$/);
    expect(row.companySlug).toBeTruthy();
  });

  it('extracts the company name and location from labeled fields', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    expect(rows.some((row) => row.companyName)).toBe(true);
    expect(rows.some((row) => row.location)).toBe(true);
  });

  it('marks remote vacancies from the location text', () => {
    const rows = parseGetro(listing, 'jobs.techstars.com');
    for (const row of rows) {
      if (row.location && /remote/i.test(row.location)) expect(row.remote).toBe(true);
    }
  });

  it('the company domain from the list is unknown and honestly stays null', () => {
    // Getro does not show the site in the list. The domain is added later by a separate fetch,
    // and it cannot be guessed from the board's own domain: that would break dedup.
    const rows = parseGetro(listing, 'jobs.techstars.com');
    expect(rows.every((row) => row.companyDomain === null)).toBe(true);
  });

  it('one vacancy is not duplicated even if the link appears twice', () => {
    const rows = parseGetro(listing + listing, 'jobs.techstars.com');
    const urls = rows.map((row) => row.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('a page without search also parses', () => {
    expect(parseGetro(featured, 'jobs.techstars.com').length).toBeGreaterThan(0);
  });

  it('empty html gives an empty list, not a crash', () => {
    expect(parseGetro('<html><body>nothing</body></html>', 'jobs.techstars.com')).toEqual([]);
  });

  it('the networks and queries are described by config, not hardcoded', () => {
    expect(GETRO_NETWORKS.length).toBeGreaterThan(1);
    expect(GETRO_QUERIES).toContain('frontend');
  });

  it('all networks have unique ids and different hosts', () => {
    const ids = GETRO_NETWORKS.map((network) => network.id);
    const hosts = GETRO_NETWORKS.map((network) => network.host);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('the number of requests per pass stays reasonable', () => {
    /*
     * Every request is a trip to someone else's site. The ceiling exists so that adding
     * networks does not silently turn into a hundred requests per pass. Company domains
     * are not counted here: they sit in a permanent cache and are fetched only once.
     */
    expect(GETRO_NETWORKS.length * GETRO_QUERIES.length).toBeLessThanOrEqual(40);
  });
});

/*
 * Networks are gone through one at a time: twelve in one go would be three dozen requests
 * to other people's sites plus a company page for every new domain, and the worker's
 * time budget cannot take a pass like that. The cursor is tracked by the server so the
 * network order lives in one place instead of being duplicated in the frontend.
 */
describe('network cursor', () => {
  it('starts with the first network when there is no current one', () => {
    expect(nextGetroNetwork()).toBe(GETRO_NETWORKS[0]!.id);
    expect(nextGetroNetwork(null)).toBe(GETRO_NETWORKS[0]!.id);
  });

  it('returns the next one in the list and null at the end', () => {
    expect(nextGetroNetwork(GETRO_NETWORKS[0]!.id)).toBe(GETRO_NETWORKS[1]!.id);
    expect(nextGetroNetwork(GETRO_NETWORKS.at(-1)!.id)).toBeNull();
  });

  it('an unfamiliar network does not restart the pass from the beginning', () => {
    expect(nextGetroNetwork('not-a-network')).toBeNull();
  });
});
