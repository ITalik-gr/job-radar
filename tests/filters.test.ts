import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/api/index.js';
import { config, setRuntimeEnv } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, companyState, contacts, outreach, settings, siteAudits, type Company } from '../src/db/schema.js';
import { bulkUpdateCompanies, setCompanyStatus, upsertCompany } from '../src/pipeline/companies.js';
import { dailyQueue, pickAcrossSegments, QUEUE_KEY } from '../src/pipeline/daily-queue.js';
import { filterFromQuery, filterToQuery, parseFilter, type CompanyFilter } from '../src/pipeline/filters.js';
import { rememberContact } from '../src/pipeline/outreach.js';
import { resetRules, rules, saveRules } from '../src/pipeline/rules.js';
import { deleteSavedFilter, listSavedFilters, saveFilter } from '../src/pipeline/saved-filters.js';
import { studioPage, type StudioCard } from '../src/pipeline/studios.js';

let clinic: Company;
let studio: Company;
let startup: Company;
let shop: Company;
let product: Company;

const ids = async (filter: CompanyFilter) =>
  (await studioPage({ ...filter, scope: 'all', minScore: filter.minScore ?? -1000 })).cards
    .map((card) => card.companyId)
    .sort((a, b) => a - b);

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  ({ company: clinic } = await upsertCompany({
    name: 'Smile Dental',
    domain: 'smile.ua',
    country: 'UA',
    city: 'Kyiv',
    industry: 'dental',
    kind: 'smb',
    phone: '+380441234567',
    source: 'places',
    tags: ['Clinic'],
  }));
  ({ company: studio } = await upsertCompany({
    name: 'Pixel Studio',
    domain: 'pixel.studio',
    country: 'PL',
    city: 'Warsaw',
    kind: 'studio',
    sizeHint: '10 - 49',
    source: 'clutch',
    tags: ['Web Development', 'Web Design'],
    rating: 4.9,
  }));
  ({ company: startup } = await upsertCompany({
    name: 'Rocket AI',
    domain: 'rocket.ai',
    country: 'US',
    kind: 'startup',
    source: 'yc',
    tags: ['SaaS', 'Generative AI'],
  }));
  ({ company: shop } = await upsertCompany({
    name: 'Kava Shop',
    domain: 'kava.com.ua',
    country: 'UA',
    city: 'Lviv',
    industry: 'retail',
    kind: 'ecommerce',
    source: 'places',
  }));
  ({ company: product } = await upsertCompany({
    name: 'Big Product',
    domain: 'bigproduct.com',
    country: 'US',
    kind: 'product',
    source: 'dou',
  }));

  await rememberContact(studio.id, 'anna@pixel.studio', 'Anna Nowak', 'CEO');
  await rememberContact(startup.id, 'hello@rocket.ai', null, null);
  await rememberContact(shop.id, 'dead@kava.com.ua', null, null);
  await getDb().update(contacts).set({ emailValid: false }).where(eq(contacts.email, 'dead@kava.com.ua'));

  await getDb().insert(siteAudits).values([
    { companyId: clinic.id, url: 'https://smile.ua', checkedAt: 1, issues: ['loads 9 s on a phone'] },
    // A later clean audit wins over an older one with issues.
    { companyId: shop.id, url: 'https://kava.com.ua', checkedAt: 1, issues: ['no https'] },
    { companyId: shop.id, url: 'https://kava.com.ua', checkedAt: 2, issues: [] },
  ]);
  await getDb()
    .update(companies)
    .set({ hiringDevs: true, hiringRoles: 2, hiringSeenAt: Date.now() })
    .where(eq(companies.id, startup.id));
});

describe('filter parsing', () => {
  it('reads URL parameters: lists, booleans, numbers', () => {
    expect(
      filterFromQuery({ kind: 'smb, studio', hasEmail: '1', hiring: 'false', minScore: '3', search: '', city: 'Kyiv' }),
    ).toEqual({ kind: ['smb', 'studio'], hasEmail: true, hiring: false, minScore: 3, city: 'Kyiv' });
  });

  it('throws on an unknown field or a bad value instead of widening the list', () => {
    expect(() => filterFromQuery({ segment: 'smb' })).toThrow(/segment/);
    expect(() => filterFromQuery({ hasEmail: 'yes' })).toThrow(/hasEmail/);
    expect(() => filterFromQuery({ minScore: 'high' })).toThrow(/minScore/);
    expect(() => parseFilter({ status: ['maybe'] })).toThrow(/status/);
  });

  it('round trips through the query string', () => {
    const filter: CompanyFilter = { market: 'ua', kind: ['smb'], hasAuditIssues: true, maxScore: 10 };
    expect(filterFromQuery(filterToQuery(filter))).toEqual(filter);
  });
});

describe('filter conditions', () => {
  it('market, country, city', async () => {
    expect(await ids({ market: 'ua' })).toEqual([clinic.id, shop.id]);
    expect(await ids({ country: 'pl' })).toEqual([studio.id]);
    expect(await ids({ city: 'kyiv' })).toEqual([clinic.id]);
  });

  it('segment and industry take any of their values', async () => {
    expect(await ids({ kind: ['smb', 'ecommerce'] })).toEqual([clinic.id, shop.id]);
    expect(await ids({ industry: ['Dental'] })).toEqual([clinic.id]);
  });

  it('source and tags match JSON array elements, tags ignoring case', async () => {
    expect(await ids({ source: 'places' })).toEqual([clinic.id, shop.id]);
    expect(await ids({ tags: ['clinic'] })).toEqual([clinic.id]);
    expect(await ids({ tags: ['web design', 'web development'] })).toEqual([studio.id]);
    expect(await ids({ tags: ['web design', 'saas'] })).toEqual([]);
  });

  it('has email skips bounced addresses, named contact needs a name', async () => {
    expect(await ids({ hasEmail: true })).toEqual([studio.id, startup.id]);
    expect(await ids({ hasNamedContact: true })).toEqual([studio.id]);
    expect(await ids({ hasNamedContact: false, kind: ['startup'] })).toEqual([startup.id]);
  });

  it('audit issues read only the latest audit', async () => {
    expect(await ids({ hasAuditIssues: true })).toEqual([clinic.id]);
  });

  it('hiring, rating and score range', async () => {
    expect(await ids({ hiring: true })).toEqual([startup.id]);
    expect(await ids({ minRating: 4.5 })).toEqual([studio.id]);
    const studioScore = (await studioPage({ scope: 'all', search: 'pixel', minScore: -1000 })).cards[0]!.score;
    expect(await ids({ minScore: studioScore, maxScore: studioScore, search: 'pixel' })).toEqual([studio.id]);
  });

  it('status filters by state, a company without a state row counts as new', async () => {
    await getDb().delete(companyState).where(eq(companyState.companyId, product.id));
    expect(await ids({ status: ['new'], kind: ['product'] })).toEqual([product.id]);
  });

  it('the lead list hides product companies and handled ones, the directory does not', async () => {
    await setCompanyStatus(clinic.id, { status: 'rejected_by_me' });
    const leads = (await studioPage({ scope: 'leads', minScore: -1000 })).cards.map((card) => card.companyId);
    expect(leads).not.toContain(product.id);
    expect(leads).not.toContain(clinic.id);
    expect(await ids({})).toEqual(expect.arrayContaining([product.id, clinic.id]));

    const asked = (await studioPage({ scope: 'leads', minScore: -1000, status: ['rejected_by_me'] })).cards;
    expect(asked.map((card) => card.companyId)).toEqual([clinic.id]);
    await setCompanyStatus(clinic.id, { status: 'new' });
  });

  it('a card carries the latest audit', async () => {
    const [card] = (await studioPage({ scope: 'all', search: 'smile', minScore: -1000 })).cards;
    expect(card!.audit?.issues).toEqual(['loads 9 s on a phone']);
  });
});

describe('API', () => {
  const TOKEN = 'test-filters-token';
  const get = (path: string) => app.request(path, { headers: { 'x-radar-token': TOKEN } });
  beforeAll(() => setRuntimeEnv({ RADAR_TOKEN: TOKEN }));
  afterAll(() => setRuntimeEnv({ RADAR_TOKEN: '' }));

  it('GET /api/companies applies the filter and answers 400 on a bad one', async () => {
    const ok = await get('/api/companies?market=ua&sort=name');
    const body = (await ok.json()) as { cards: { name: string }[] };
    expect(body.cards.map((card) => card.name)).toEqual(['Kava Shop', 'Smile Dental']);

    const bad = await get('/api/companies?segment=smb');
    expect(bad.status).toBe(400);
  });

  it('facets list known values with counts', async () => {
    const body = (await (await get('/api/companies/facets')).json()) as Record<string, { key: string; count: number }[]>;
    expect(body.market).toEqual(expect.arrayContaining([{ key: 'ua', count: 2 }]));
    expect(body.source).toEqual(expect.arrayContaining([{ key: 'places', count: 2 }]));
    expect(body.tags).toEqual(expect.arrayContaining([{ key: 'clinic', count: 1 }]));
  });

  it('GET /api/companies/card/:key finds a company by domain or by id, with its score', async () => {
    const byDomain = (await (await get('/api/companies/card/pixel.studio')).json()) as StudioCard;
    expect(byDomain.companyId).toBe(studio.id);
    expect(byDomain.why.length).toBeGreaterThan(0);

    const byId = (await (await get(`/api/companies/card/id-${clinic.id}`)).json()) as StudioCard;
    expect(byId.name).toBe('Smile Dental');

    // A product company is hidden from Leads, but its own page still opens.
    expect((await get('/api/companies/card/bigproduct.com')).status).toBe(200);
    expect((await get('/api/companies/card/nobody.example')).status).toBe(404);
  });
});

describe('saved filters', () => {
  it('saves, replaces by name and deletes', async () => {
    const first = await saveFilter('UA clinics', { market: 'ua', industry: ['dental'] });
    expect(first.before).toBeNull();
    const second = await saveFilter('ua clinics', { market: 'ua', industry: ['dental'], hasEmail: true });
    expect(second.before?.query).toEqual({ market: 'ua', industry: ['dental'] });
    expect(second.after.id).toBe(first.after.id);
    expect(await listSavedFilters()).toHaveLength(1);

    await expect(saveFilter('broken', { segment: 'smb' })).rejects.toThrow(/segment/);
    await expect(saveFilter('  ', {})).rejects.toThrow(/name/);

    expect((await deleteSavedFilter(first.after.id)).deleted?.name).toBe('ua clinics');
    expect(await listSavedFilters()).toEqual([]);
  });
});

describe('bulk update', () => {
  it('sets status and tags, never downgrading a contacted company', async () => {
    await setCompanyStatus(studio.id, { status: 'contacted' });
    const result = await bulkUpdateCompanies({
      ids: [clinic.id, studio.id, 999_999],
      status: 'interesting',
      addTags: ['call back'],
      removeTags: ['CLINIC'],
    });
    expect(result.missing).toEqual([999_999]);
    expect(result.kept.map((row) => row.companyId)).toEqual([studio.id]);
    expect(result.changed).toBe(2);

    const [row] = await getDb().select().from(companies).where(eq(companies.id, clinic.id));
    expect(row!.tags).toEqual(['call back']);
    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, studio.id));
    expect(state!.status).toBe('contacted');

    await bulkUpdateCompanies({ ids: [clinic.id, studio.id], status: 'new', removeTags: ['call back'] });
  });

  it('refuses an empty change', async () => {
    await expect(bulkUpdateCompanies({ ids: [clinic.id] })).rejects.toThrow(/nothing/);
    await expect(bulkUpdateCompanies({ ids: [] })).rejects.toThrow(/no companies/);
  });
});

describe('pickAcrossSegments', () => {
  const card = (companyId: number, kind: string, score: number) => ({ companyId, kind, score }) as StudioCard;

  it('takes one per segment per round, the strongest segment first', () => {
    const cards = [card(1, 'studio', 10), card(2, 'studio', 9), card(3, 'studio', 8), card(4, 'smb', 7), card(5, 'startup', 3)];
    expect(pickAcrossSegments(cards, 4).map((row) => row.companyId)).toEqual([1, 4, 5, 2]);
    expect(pickAcrossSegments(cards, 10)).toHaveLength(5);
    expect(pickAcrossSegments(cards, 0)).toEqual([]);
  });
});

describe('daily queue', () => {
  // Every test company clears a threshold this low, so the queue is decided by the queue rules alone.
  beforeAll(async () => {
    await saveRules({ ...rules(), companies: { ...rules().companies, threshold: -1000 }, queue: { size: 2 } });
  });
  afterAll(async () => {
    await resetRules();
  });
  beforeEach(async () => {
    await getDb().delete(settings).where(eq(settings.key, QUEUE_KEY));
  });

  const day = (date: string) => new Date(`${date}T09:00:00Z`);
  const queueIds = async (date: string) => (await dailyQueue(day(date))).cards.map((row) => row.companyId);

  it('only reachable, open companies, no product companies, at most the size', async () => {
    const queue = await dailyQueue(day('2026-10-20'));
    expect(queue.size).toBe(2);
    // Reachable: the clinic by phone, the studio and the startup by email. The shop has only a
    // bounced address, the product company is never a lead.
    expect(queue.eligible).toBe(3);
    expect(queue.cards).toHaveLength(2);
    // Two segments, one card each: the mix wins over two cards of one kind.
    expect(new Set(queue.cards.map((row) => row.kind)).size).toBe(2);
    for (const row of queue.cards) expect(row.done).toBe(false);
  });

  it('is fixed for the day: an acted on card stays, marked done, and nothing is topped up', async () => {
    const first = await dailyQueue(day('2026-10-20'));
    const [target, other] = first.cards;
    await setCompanyStatus(target!.companyId, { status: 'rejected_by_me' });

    const again = await dailyQueue(day('2026-10-20'));
    expect(again.cards.map((row) => row.companyId)).toEqual([target!.companyId, other!.companyId]);
    expect(again.cards[0]!.done).toBe(true);
    expect(again.cards[1]!.done).toBe(false);

    // The next day the done card is gone and the untouched one comes first.
    const next = await dailyQueue(day('2026-10-21'));
    expect(next.carried).toBe(1);
    expect(next.cards[0]!.companyId).toBe(other!.companyId);
    expect(next.cards.map((row) => row.companyId)).not.toContain(target!.companyId);

    await setCompanyStatus(target!.companyId, { status: 'new' });
  });

  it('a company written to more than 90 days ago comes back, a recent one does not', async () => {
    await saveRules({ ...rules(), queue: { size: 10 } });
    await setCompanyStatus(studio.id, { status: 'contacted' });
    const [letter] = await getDb()
      .insert(outreach)
      .values({ companyId: studio.id, channel: 'email', status: 'sent', sentAt: Date.now() - 10 * 86_400_000 })
      .returning();
    expect(await queueIds('2026-10-20')).not.toContain(studio.id);

    await getDb().delete(settings).where(eq(settings.key, QUEUE_KEY));
    await getDb().update(outreach).set({ sentAt: Date.now() - 100 * 86_400_000 }).where(eq(outreach.id, letter!.id));
    expect(await queueIds('2026-10-20')).toContain(studio.id);

    await getDb().delete(outreach).where(eq(outreach.id, letter!.id));
    await setCompanyStatus(studio.id, { status: 'new' });
    await saveRules({ ...rules(), queue: { size: 2 } });
  });
});
