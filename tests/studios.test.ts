import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, companyState, outreach } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { scoreCompany, sizeBucket } from '../src/pipeline/company-score.js';
import { applyStudioAction, studioQueue } from '../src/pipeline/studios.js';

async function company(over: Parameters<typeof upsertCompany>[0]) {
  const { company: row } = await upsertCompany(over);
  return row;
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  await company({
    name: 'Мала студія',
    domain: 'studio.ua',
    country: 'UA',
    sizeHint: '10 - 49',
    source: 'clutch',
    tags: ['Web Development', 'Web Design', '$50 - $99 / hr'],
  });
  await company({
    name: 'Величезний аутсорс',
    domain: 'giant.com',
    country: 'IN',
    sizeHint: '10,000+',
    source: 'clutch',
    tags: ['Web Development'],
  });
  await company({
    name: 'SEO контора',
    domain: 'seo.com',
    country: 'US',
    sizeHint: '10 - 49',
    source: 'clutch',
    tags: ['SEO', 'Pay Per Click', 'Social Media Marketing'],
  });

  await getDb()
    .update(companies)
    .set({ techHints: ['next.js', 'react'] })
    .where(eq(companies.domain, 'studio.ua'));
  await getDb()
    .update(companies)
    .set({ techHints: ['wordpress'] })
    .where(eq(companies.domain, 'giant.com'));
});

describe('sizeBucket', () => {
  it('розуміє формати каталогів', () => {
    expect(sizeBucket('10 - 49')).toBe('10 - 49');
    expect(sizeBucket('200...800 спеціалістів')).toBe('250 - 999');
    expect(sizeBucket('51-200 співробітників')).toBe('50 - 249');
    expect(sizeBucket('понад 1500 спеціалістів')).toBe('1,000 - 9,999');
    expect(sizeBucket(null)).toBeNull();
  });
});

describe('scoreCompany', () => {
  it('мала українська студія на React отримує високий рахунок', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'studio.ua'));
    const result = scoreCompany({ company: row! });
    expect(result.score).toBeGreaterThan(15);
    expect(result.positives.some((item) => item.reason.includes('10 - 49'))).toBe(true);
    expect(result.positives.some((item) => item.reason === 'країна UA')).toBe(true);
  });

  it('гігант на WordPress отримує мінуси за розмір і стек', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'giant.com'));
    const result = scoreCompany({ company: row! });
    expect(result.negatives.some((item) => item.reason.includes('10,000+'))).toBe(true);
    expect(result.negatives.some((item) => item.reason.includes('wordpress'))).toBe(true);
    expect(result.score).toBeLessThan(5);
  });

  it('маркетингова контора не потрапляє в чергу', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'seo.com'));
    const result = scoreCompany({ company: row! });
    expect(result.negatives.length).toBeGreaterThanOrEqual(3);
  });

  it('blacklist виключає повністю', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'studio.ua'));
    expect(scoreCompany({ company: row!, status: 'blacklist' }).score).toBe(-100);
  });
});

describe('вага за типом компанії', () => {
  it('стартап без тегів каталогу все одно набирає бали', async () => {
    /*
     * Getro не дає тегів і розміру, тому без ваги за типом стартап набирав майже
     * нуль і не проходив поріг, тобто сторінка Стартапи була б порожньою при повній базі.
     */
    const { scoreCompany } = await import('../src/pipeline/company-score.js');
    const bare = {
      id: 0,
      name: 'Bare Startup',
      domain: 'bare.dev',
      country: null,
      city: null,
      sizeHint: null,
      kind: 'startup',
      sources: ['getro'],
      careersUrl: null,
      careersKind: 'unknown',
      careersSlug: null,
      techHints: [],
      tags: [],
      description: null,
      sourceUrl: null,
      firstSeen: 0,
      lastChecked: null,
      lastChangeAt: null,
    } as never;

    expect(scoreCompany({ company: bare }).score).toBeGreaterThan(0);
  });

  it('аутстаф отримує мінус, туди писати сенсу немає', async () => {
    const { scoreCompany } = await import('../src/pipeline/company-score.js');
    const base = {
      id: 0,
      name: 'Middleman',
      domain: 'middleman.com',
      country: null,
      city: null,
      sizeHint: null,
      sources: [],
      careersUrl: null,
      careersKind: 'unknown',
      careersSlug: null,
      techHints: [],
      tags: [],
      description: null,
      sourceUrl: null,
      firstSeen: 0,
      lastChecked: null,
      lastChangeAt: null,
    };

    const outstaff = scoreCompany({ company: { ...base, kind: 'outstaff' } as never }).score;
    const studio = scoreCompany({ company: { ...base, kind: 'studio' } as never }).score;
    expect(outstaff).toBeLessThan(studio);
  });
});

describe('фільтр за іменним контактом', () => {
  it('без фільтра показуються всі, з фільтром лише ті, де є людина', async () => {
    const { contacts } = await import('../src/db/schema.js');
    const all = await studioQueue({ includeContacted: true, minScore: -100 });
    expect(all.length).toBeGreaterThan(0);

    // Жодного іменного контакту ще немає, тому фільтр має віддати порожньо.
    expect(
      await studioQueue({ includeContacted: true, minScore: -100, withNamedContact: true }),
    ).toHaveLength(0);

    await getDb().insert(contacts).values({
      companyId: all[0]!.companyId,
      name: 'Марія Технічна',
      role: 'CTO',
      email: 'maria@studio.ua',
    });

    const named = await studioQueue({
      includeContacted: true,
      minScore: -100,
      withNamedContact: true,
    });
    expect(named).toHaveLength(1);
    expect(named[0]!.companyId).toBe(all[0]!.companyId);
  });

  it('загальна скринька без імені не рахується за контакт', async () => {
    const { contacts } = await import('../src/db/schema.js');
    const all = await studioQueue({ includeContacted: true, minScore: -100 });
    const target = all.find((card) => card.contacts.length === 0);
    if (!target) return;

    await getDb().insert(contacts).values({
      companyId: target.companyId,
      name: null,
      role: 'general',
      email: 'hello@example.com',
    });

    const named = await studioQueue({
      includeContacted: true,
      minScore: -100,
      withNamedContact: true,
    });
    expect(named.some((card) => card.companyId === target.companyId)).toBe(false);
  });
});

describe('тип компанії у списку', () => {
  it('продуктові компанії не показуються без явного фільтра', async () => {
    // Холодний лист "можу допомогти з проєктом" у Stripe не працює, для них є Черга.
    const cards = await studioQueue({ includeContacted: true, minScore: -100 });
    expect(cards.every((card) => card.kind !== 'product')).toBe(true);
  });

  it('фільтр за типом віддає рівно свій тип', async () => {
    const cards = await studioQueue({ kind: 'startup', includeContacted: true, minScore: -100 });
    expect(cards.every((card) => card.kind === 'startup')).toBe(true);
  });
});

describe('studioQueue', () => {
  it('сортує за рахунком і відсікає нижче порогу', async () => {
    const cards = await studioQueue();
    expect(cards[0]!.domain).toBe('studio.ua');
    expect(cards.every((card) => card.score >= 5)).toBe(true);
    expect(cards.some((card) => card.domain === 'giant.com')).toBe(false);
  });

  it('пояснює рахунок кожної картки', async () => {
    const [card] = await studioQueue();
    expect(card!.why.length).toBeGreaterThan(2);
    expect(card!.why[0]!.weight).toBeGreaterThan(0);
  });

  it('пошук працює за назвою, доменом і тегом', async () => {
    expect((await studioQueue({ search: 'studio.ua' }))).toHaveLength(1);
    expect((await studioQueue({ search: 'web design' }))).toHaveLength(1);
    expect((await studioQueue({ search: 'нічого такого' }))).toHaveLength(0);
  });

  it('фільтр за країною', async () => {
    const cards = await studioQueue({ country: 'UA' });
    expect(cards.every((card) => card.country === 'UA')).toBe(true);
  });
});

describe('applyStudioAction', () => {
  it('"написав" ставить статус і створює запис листування без вакансії', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'studio.ua'));
    const result = await applyStudioAction({
      companyId: row!.id,
      action: 'contacted',
      templateUsed: 'studio_pitch',
    });

    expect(result.status).toBe('contacted');
    const [sent] = await getDb().select().from(outreach).where(eq(outreach.id, result.outreachId!));
    expect(sent!.vacancyId).toBeNull();
    expect(sent!.templateUsed).toBe('studio_pitch');
  });

  it('після "написав" студія зникає з черги, але видно з прапорцем all', async () => {
    expect((await studioQueue({ search: 'studio.ua' }))).toHaveLength(0);
    expect((await studioQueue({ search: 'studio.ua', includeContacted: true }))).toHaveLength(1);
  });

  it('відкладена студія не показується до кінця терміну', async () => {
    const [row] = await getDb().select().from(companies).where(eq(companies.domain, 'seo.com'));
    await applyStudioAction({ companyId: row!.id, action: 'snooze', days: 60 });

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, row!.id));
    expect(state!.snoozedUntil!).toBeGreaterThan(Date.now());
    expect((await studioQueue({ search: 'seo.com', includeContacted: true, minScore: -100 }))).toHaveLength(0);
  });

  it('невідома дія відхиляється', async () => {
    await expect(applyStudioAction({ companyId: 1, action: 'вигадана' as never })).rejects.toThrow();
  });
});
