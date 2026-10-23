import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, contacts, leads } from '../src/db/schema.js';
import { listLeads, saveLeads, setLeadStatus } from '../src/pipeline/leads.js';
import {
  cleanLocality,
  cleanPhone,
  isDevTender,
  parseSearch,
  parseSummary,
  parseTender,
} from '../src/sources/leads/prozorro.js';

/*
 * Real responses saved on 2026-10-21: one search page of open tenders by IT codes, the summary of
 * one tender and the same tender from the official API. The contact person is replaced with
 * made up values, the repository is public.
 */
const search = readFileSync('fixtures/prozorro/search-it-tendering.json', 'utf8');
const summary = readFileSync('fixtures/prozorro/summary.json', 'utf8');
const tender = readFileSync('fixtures/prozorro/tender.json', 'utf8');

describe('Prozorro parsing', () => {
  it('reads a search page: twenty hits out of the total', () => {
    const page = parseSearch(search);
    expect(page.total).toBe(52);
    expect(page.hits).toHaveLength(20);
    expect(page.hits[0]!.tenderID).toMatch(/^UA-2026-/);
  });

  it('keeps development work and drops licences and support contracts', () => {
    const kept = parseSearch(search).hits.filter((hit) => isDevTender(hit.title)).map((hit) => hit.tenderID);
    expect(kept).toContain('UA-2026-10-16-009360-a');
    expect(kept).toContain('UA-2026-10-15-008127-a');
    expect(kept).not.toContain('UA-2026-10-21-012948-a');
    expect(kept.length).toBeGreaterThanOrEqual(5);
    expect(kept.length).toBeLessThanOrEqual(8);

    expect(isDevTender('Розробка веб-сайту закладу')).toBe(true);
    expect(isDevTender('Створення сайту громади')).toBe(true);
    expect(isDevTender('Постачання ліцензій на програмне забезпечення')).toBe(false);
    expect(isDevTender('Послуги з технічної підтримки інформаційної системи')).toBe(false);
    expect(isDevTender('Програмне забезпечення віртуалізації для модернізації')).toBe(false);
  });

  it('the summary gives the internal id', () => {
    expect(parseSummary(summary)).toBe('5d56fb75d9b0439baa9ecef5879483dc');
  });

  it('a tender becomes a lead with its buyer and contact person', () => {
    const lead = parseTender(tender);
    expect(lead).toMatchObject({
      source: 'prozorro',
      externalId: 'UA-2026-10-16-009360-a',
      url: 'https://prozorro.gov.ua/tender/UA-2026-10-16-009360-a',
      currency: 'UAH',
    });
    expect(lead.title).toMatch(/Доопрацювання програмного забезпечення/);
    expect(lead.budget).toBeGreaterThan(0);
    expect(lead.deadlineAt).toBeGreaterThan(Date.parse('2026-10-16'));
    expect(lead.company).toMatchObject({
      registryCode: '40081258',
      domain: 'uz.gov.ua',
      country: 'UA',
      city: 'Київ',
      kind: 'public',
    });
    expect(lead.contact).toEqual({
      name: 'Петренко Олена Іванівна',
      role: 'tender contact person',
      email: 'tenders@example.gov.ua',
      phone: '+380440000000',
    });
  });

  it('small cleanups', () => {
    expect(cleanLocality('місто Харків')).toBe('Харків');
    expect(cleanLocality('м. Київ')).toBe('Київ');
    expect(cleanPhone('380444650931')).toBe('+380444650931');
    expect(cleanPhone('(044) 465-09-31')).toBe('+380444650931');
    expect(cleanPhone('12')).toBeNull();
  });

  it('broken payloads fail with an explanation, not a silent zero', () => {
    expect(() => parseSearch('<html>')).toThrow('not JSON');
    expect(() => parseSearch('{}')).toThrow('data');
    expect(() => parseTender('{"data":{}}')).toThrow('no id');
  });
});

describe('saving leads', () => {
  beforeAll(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
    runMigrations().sqlite.close();
  });

  it('creates the buyer, the lead and the contact, and a second run updates instead of duplicating', async () => {
    const lead = parseTender(tender);
    const first = await saveLeads([lead]);
    expect(first).toMatchObject({ itemsFound: 1, itemsNew: 1, companiesNew: 1, contactsNew: 1, errors: [] });

    const second = await saveLeads([{ ...lead, deadlineAt: lead.deadlineAt! + 86_400_000 }]);
    expect(second).toMatchObject({ itemsNew: 0, updated: 1, companiesNew: 0, contactsNew: 0 });

    const [company] = await getDb().select().from(companies).where(eq(companies.registryCode, '40081258'));
    expect(company).toMatchObject({ kind: 'public', market: 'ua', country: 'UA', sources: ['prozorro'] });
    const rows = await getDb().select().from(leads);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deadlineAt).toBe(lead.deadlineAt! + 86_400_000);
    const people = await getDb().select().from(contacts).where(eq(contacts.companyId, company!.id));
    expect(people).toEqual([expect.objectContaining({ email: 'tenders@example.gov.ua', phone: '+380440000000' })]);
  });

  it('a buyer without a site is identified by its register code', async () => {
    const lead = parseTender(tender);
    const siteless = {
      ...lead,
      externalId: 'UA-TEST-1',
      company: { ...lead.company!, domain: null, registryCode: '12345678', name: 'Сільська рада' },
    };
    await saveLeads([siteless, { ...siteless, externalId: 'UA-TEST-2' }]);
    const rows = await getDb().select().from(companies).where(eq(companies.registryCode, '12345678'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.domain).toBe('');
  });

  it('open leads come by deadline, a status change returns before and after', async () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const open = await listLeads({ source: 'prozorro' }, now);
    expect(open.length).toBe(3);
    expect(open[0]!.companyName).toBeTruthy();
    expect(await listLeads({ source: 'prozorro' }, Date.parse('2030-01-01'))).toEqual([]);

    expect(await setLeadStatus(open[0]!.id, 'interesting')).toMatchObject({ before: 'new', after: 'interesting' });
    await expect(setLeadStatus(open[0]!.id, 'maybe' as never)).rejects.toThrow('unknown');
  });

  it('filters by budget, fit, text and deadline; a lead without a budget or fit fails those bounds', async () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const base = parseTender(tender);
    const deadline = now + 5 * 86_400_000;
    await saveLeads([
      { ...base, externalId: 'UA-BUDGET-SMALL', title: 'Розробка веб-сайту бібліотеки', budget: 40_000, deadlineAt: deadline },
      { ...base, externalId: 'UA-BUDGET-BIG', title: 'Розробка порталу', budget: 900_000, deadlineAt: now + 40 * 86_400_000 },
      { ...base, externalId: 'UA-BUDGET-NONE', title: 'Сайт без бюджету', budget: null, deadlineAt: deadline },
    ]);
    const [small] = await getDb().select().from(leads).where(eq(leads.externalId, 'UA-BUDGET-SMALL'));
    await getDb().update(leads).set({ fit: 100 }).where(eq(leads.id, small!.id));

    const ids = async (query: Parameters<typeof listLeads>[0]) =>
      // Only the rows made here: the fixture tender above has a large budget of its own.
      (await listLeads({ source: 'prozorro', ...query }, now))
        .map((row) => row.externalId)
        .filter((id) => id.startsWith('UA-BUDGET'));

    expect(await ids({ maxBudget: 50_000 })).toEqual(['UA-BUDGET-SMALL']);
    expect(await ids({ minBudget: 500_000 })).toEqual(['UA-BUDGET-BIG']);
    expect(await ids({ minFit: 67 })).toEqual(['UA-BUDGET-SMALL']);
    expect(await ids({ search: 'бібліотеки' })).toEqual(['UA-BUDGET-SMALL']);
    expect(await ids({ deadlineDays: 7 })).toEqual(expect.arrayContaining(['UA-BUDGET-SMALL', 'UA-BUDGET-NONE']));
    expect(await ids({ deadlineDays: 7 })).not.toContain('UA-BUDGET-BIG');
    expect((await ids({ sort: 'budget' }))[0]).toBe('UA-BUDGET-BIG');
  });
});
