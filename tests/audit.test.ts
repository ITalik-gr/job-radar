import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, setRuntimeEnv } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, companyState, runs, siteAudits } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  audit,
  auditIssues,
  candidatesForAudit,
  cmsFrom,
  PageUnreachableError,
  pageSpeedUrl,
  parsePageSpeed,
} from '../src/pipeline/audit.js';

/*
 * `webflow-site.json` is a recorded Lighthouse 13 response, trimmed to the fields the parser reads.
 * `quota-error.json` is a real keyless response. `slow-site.json` and `unreachable.json` are made up
 * in the same shape: a failing viewport and a dead domain are hard to find on demand.
 */
const recorded = readFileSync('fixtures/pagespeed/webflow-site.json', 'utf8');
const slow = readFileSync('fixtures/pagespeed/slow-site.json', 'utf8');
const unreachable = readFileSync('fixtures/pagespeed/unreachable.json', 'utf8');
const quota = readFileSync('fixtures/pagespeed/quota-error.json', 'utf8');

describe('PageSpeed parsing', () => {
  it('a recorded response: field LCP, viewport insight, platform from requests', () => {
    expect(parsePageSpeed(recorded)).toEqual({
      finalUrl: 'https://www.newscatcherapi.com/',
      perfScore: 61,
      lcpMs: 9806,
      fieldLcpMs: 3588,
      mobileOk: true,
      https: true,
      cms: 'webflow',
    });
  });

  it('a slow site without a viewport and https', () => {
    expect(parsePageSpeed(slow)).toEqual({
      finalUrl: 'http://slow-clinic.example.ua/',
      perfScore: 31,
      lcpMs: 12422,
      fieldLcpMs: null,
      mobileOk: false,
      https: false,
      cms: 'wordpress',
    });
  });

  it('a page Lighthouse could not load is its own error', () => {
    expect(() => parsePageSpeed(unreachable)).toThrow(PageUnreachableError);
    expect(() => parsePageSpeed(unreachable)).toThrow('FAILED_DOCUMENT_REQUEST');
  });

  it('an error response and garbage fail loudly', () => {
    expect(() => parsePageSpeed(quota)).toThrow('Quota exceeded');
    expect(() => parsePageSpeed('<html>')).toThrow('not JSON');
  });

  it('a missing audit stays null instead of a guess', () => {
    const bare = JSON.stringify({ lighthouseResult: { categories: {}, audits: {} } });
    expect(parsePageSpeed(bare)).toEqual({
      finalUrl: null,
      perfScore: null,
      lcpMs: null,
      fieldLcpMs: null,
      mobileOk: null,
      https: null,
      cms: null,
    });
  });

  it('the key never goes into the URL', () => {
    const url = pageSpeedUrl('clinic.ua');
    expect(url).not.toContain('key=');
    expect(url).toContain('url=http%3A%2F%2Fclinic.ua');
    expect(url).toContain('strategy=mobile');
    expect(url).toContain('category=performance');
  });
});

describe('Audit issues', () => {
  const measured = {
    finalUrl: 'http://a.ua/',
    perfScore: 31,
    lcpMs: 12422,
    fieldLcpMs: null,
    mobileOk: false,
    https: false,
    cms: null,
  };

  it('Ukrainian phrases, most convincing first, the lab number named as a test', () => {
    expect(auditIssues({ ...measured, copyrightYear: 2019, year: 2026 }, 'uk')).toEqual([
      'сайт не має мобільної версії',
      'у тесті Google PageSpeed головна сторінка вантажиться 12,4 с на телефоні',
      'сайт відкривається без HTTPS',
      'у футері досі copyright 2019',
    ]);
  });

  it('English phrases for a non UA company', () => {
    expect(auditIssues({ ...measured, copyrightYear: null, year: 2026 }, 'en')).toEqual([
      'the site has no mobile layout',
      'in the Google PageSpeed test the home page takes 12.4 s to load on a phone',
      'the site opens without HTTPS',
    ]);
  });

  it('real visitors outrank the lab, both ways', () => {
    const slowField = auditIssues({ ...measured, mobileOk: true, https: true, fieldLcpMs: 5200, copyrightYear: null }, 'uk');
    expect(slowField).toEqual(['відвідувачі з телефона чекають на головну сторінку 5,2 с (дані Chrome)']);
    // stripe.com: 6.7 s in the lab, fine for real visitors. Not a sentence for a letter.
    const fastField = auditIssues({ ...measured, mobileOk: true, https: true, fieldLcpMs: 2100, copyrightYear: null }, 'uk');
    expect(fastField).toEqual([]);
  });

  it('a lab LCP under 10 s is not an issue, a very low score is', () => {
    const base = { ...measured, mobileOk: true, https: true, lcpMs: 8000, copyrightYear: 2025, year: 2026 };
    expect(auditIssues({ ...base, perfScore: 38 }, 'uk')).toEqual([]);
    expect(auditIssues({ ...base, perfScore: 22 }, 'uk')).toEqual(['Google PageSpeed оцінює швидкість сайту на телефоні в 22 зі 100']);
  });

  it('a good site and unknown fields give no issues', () => {
    const good = { ...measured, perfScore: 92, lcpMs: 1800, mobileOk: true, https: true };
    expect(auditIssues({ ...good, copyrightYear: 2026, year: 2026 }, 'uk')).toEqual([]);
    const unknown = { ...measured, perfScore: null, lcpMs: null, mobileOk: null, https: null };
    expect(auditIssues({ ...unknown, copyrightYear: null }, 'uk')).toEqual([]);
  });

  it('the platform comes from request URLs, not from words', () => {
    expect(cmsFrom(['https://a.ua/wp-content/themes/x.css', 'https://cdn.tailwindcss.com/'])).toBe('wordpress');
    expect(cmsFrom(['https://static.tildacdn.com/js/tilda.js'])).toBe('tilda');
    expect(cmsFrom(['https://a.ua/app.js'])).toBeNull();
  });
});

describe('Audit run', () => {
  const responses = new Map<string, string | (() => Response)>();
  const keys: (string | null)[] = [];

  beforeAll(async () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
    runMigrations().sqlite.close();
    setRuntimeEnv({ PAGESPEED_API_KEY: 'test-psi-key' });

    const db = getDb();
    const add = async (name: string, domain: string, patch: Partial<typeof companies.$inferInsert>) => {
      const { company: { id } } = await upsertCompany({ name, domain, source: 'places' });
      await db.update(companies).set(patch).where(eq(companies.id, id));
      return id;
    };
    await add('Agency', 'agency.example.com', { kind: 'studio', country: 'US', market: 'intl' });
    await add('Clinic', 'slow-clinic.example.ua', {
      kind: 'smb',
      country: 'UA',
      market: 'ua',
      copyrightYear: 2019,
      // Words on the site, not its platform: the audit takes the platform from requests.
      techHints: ['shopify'],
    });
    await add('Down', 'down.example.ua', { kind: 'smb', country: 'UA', market: 'ua' });
    const rejected = await add('Rejected', 'rejected.example.ua', { kind: 'smb', country: 'UA', market: 'ua' });
    await db.update(companyState).set({ status: 'rejected_by_them' }).where(eq(companyState.companyId, rejected));
    await upsertCompany({ name: 'No site', placeId: 'ChIJnosite', source: 'places' });

    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('x-goog-api-key'));
      const target = new URL(input).searchParams.get('url')!;
      const answer = responses.get(new URL(target).hostname) ?? slow;
      if (typeof answer === 'function') return answer();
      return new Response(answer, { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterEach(() => {
    keys.length = 0;
    responses.clear();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    setRuntimeEnv({ PAGESPEED_API_KEY: '' });
  });

  it('businesses first, no empty domain, no rejected company', async () => {
    const order = (await candidatesForAudit({ limit: 10 })).map((company) => company.domain);
    expect(order).toEqual(['slow-clinic.example.ua', 'down.example.ua', 'agency.example.com']);
  });

  it('stores measured fields and letter-ready issues, the key only in a header', async () => {
    responses.set('down.example.ua', unreachable);
    const stats = await audit({ limit: 10 });

    expect(stats).toMatchObject({ itemsFound: 3, audited: 2, withIssues: 2, remaining: 0 });
    expect(stats.errors).toEqual([expect.stringContaining('down.example.ua: PageSpeed: FAILED_DOCUMENT_REQUEST')]);
    expect(keys.every((key) => key === 'test-psi-key')).toBe(true);

    const db = getDb();
    const [clinic] = await db.select().from(companies).where(eq(companies.domain, 'slow-clinic.example.ua'));
    const [row] = await db.select().from(siteAudits).where(eq(siteAudits.companyId, clinic!.id));
    expect(row).toMatchObject({
      url: 'http://slow-clinic.example.ua/',
      https: false,
      mobileOk: false,
      perfScore: 31,
      lcpMs: 12422,
      fieldLcpMs: null,
      cms: 'wordpress',
      copyrightYear: 2019,
    });
    expect(row!.issues[0]).toBe('сайт не має мобільної версії');

    // The run log must never hold the key.
    const logged = await db.select().from(runs).where(eq(runs.source, 'audit'));
    expect(JSON.stringify(logged)).not.toContain('test-psi-key');
  });

  it('an unreachable site waits a quarter instead of heading the next batch', async () => {
    expect(await candidatesForAudit({ limit: 10 })).toEqual([]);
    const db = getDb();
    const [down] = await db.select().from(companies).where(eq(companies.domain, 'down.example.ua'));
    const [row] = await db.select().from(siteAudits).where(eq(siteAudits.companyId, down!.id));
    expect(row).toMatchObject({ perfScore: null, mobileOk: null, https: null, issues: [] });
  });

  it('a quota error stops the run instead of burning through the batch', async () => {
    await getDb().delete(siteAudits);
    for (const index of [1, 2, 3]) {
      await upsertCompany({ name: `Extra ${index}`, domain: `extra${index}.example.com`, source: 'places' });
    }
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      calls.push(input);
      return new Response(quota, { status: 429, headers: { 'content-type': 'application/json' } });
    });
    const stats = await audit({ limit: 10 });
    expect(stats.itemsFound).toBe(6);
    expect(stats.audited).toBe(0);
    expect(stats.errors[0]).toContain('Quota exceeded');
    // The three already in flight finish, none of the other three starts.
    expect(new Set(calls).size).toBe(3);
  });

  it('without a key the audit refuses to run', async () => {
    setRuntimeEnv({ PAGESPEED_API_KEY: '' });
    await expect(audit()).rejects.toThrow('PAGESPEED_API_KEY');
    setRuntimeEnv({ PAGESPEED_API_KEY: 'test-psi-key' });
  });
});
