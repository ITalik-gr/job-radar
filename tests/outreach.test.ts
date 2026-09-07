import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  templates,
  vacancies,
  type Company,
  type Contact,
  type Template,
} from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  buildDraft,
  discardDraft,
  draftCandidates,
  isGenericEmail,
  listDrafts,
  matchTemplate,
  outreachTemplates,
  pickContact,
  pickLanguage,
  draftForCompany,
  pickTargetType,
  prepareDrafts,
  seedOutreachTemplates,
  updateDraft,
  type DraftCandidate,
} from '../src/pipeline/outreach.js';

let studio: Company;
let ukrainian: Company;
let blocked: Company;

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: 1,
    companyId: 1,
    name: 'Anton Malyy',
    role: 'CTO',
    email: 'anton@acme.com',
    emailValid: true,
    telegram: null,
    xHandle: null,
    linkedin: null,
    sourceUrl: null,
    firstSeen: Date.now(),
    ...over,
  };
}

function candidate(over: Partial<DraftCandidate> = {}): DraftCandidate {
  return {
    companyId: 1,
    company: 'Acme Studio',
    domain: 'acme.com',
    country: 'PL',
    city: 'Warsaw',
    kind: 'studio',
    sizeHint: null,
    techHints: ['react'],
    tags: [],
    description: null,
    vacancyId: null,
    vacancyTitle: null,
    vacancyStack: [],
    contact: contact(),
    ...over,
  };
}

function template(over: Partial<Template> = {}): Template {
  return {
    id: 1,
    slug: 'test_tpl',
    name: 'Тест',
    kind: 'studio',
    language: 'en',
    targetType: 'studio_named',
    forKind: null,
    subject: 'Front-end for {{company}}',
    intro: null,
    body: 'Hi {{first_name}},\n\nSaw {{domain}}.\n\nAlex',
    note: null,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  const db = getDb();
  studio = (await upsertCompany({ name: 'Acme Studio', domain: 'acme.com', source: 'test' })).company;
  ukrainian = (await upsertCompany({ name: 'Кодуємо', domain: 'koduemo.ua', country: 'UA', source: 'test' })).company;
  blocked = (await upsertCompany({ name: 'Bad Corp', domain: 'bad.com', source: 'test' })).company;

  await db
    .insert(contacts)
    .values([
      { companyId: studio.id, name: 'Anton Malyy', role: 'CTO', email: 'anton@acme.com' },
      { companyId: studio.id, name: null, role: null, email: 'hello@acme.com' },
      { companyId: ukrainian.id, name: null, role: null, email: 'info@koduemo.ua' },
      { companyId: blocked.id, name: 'Ivan', role: 'CEO', email: 'ivan@bad.com' },
    ]);

  await db
    .insert(companyState)
    .values({ companyId: blocked.id, status: 'blacklist' })
    .onConflictDoUpdate({
      target: companyState.companyId,
      set: { status: 'blacklist' },
    });

  await db.insert(vacancies).values({
    companyId: ukrainian.id,
    source: 'test',
    url: 'https://koduemo.ua/jobs/1',
    title: 'Senior Frontend',
    stack: ['react', 'typescript'],
    score: 18,
    dedupeKey: 'koduemo|senior-frontend|w',
  });
});

describe('вибір шаблона', () => {
  it('вакансія перебиває все інше', () => {
    expect(pickTargetType({ hasVacancy: true, contactName: null, contactEmail: 'hello@a.com' })).toBe(
      'vacancy',
    );
  });

  it('іменний контакт і особиста пошта дають studio_named', () => {
    expect(
      pickTargetType({ hasVacancy: false, contactName: 'Anton', contactEmail: 'anton@a.com' }),
    ).toBe('studio_named');
  });

  it('імʼя при загальній пошті це все одно studio_generic', () => {
    expect(
      pickTargetType({ hasVacancy: false, contactName: 'Anton', contactEmail: 'hello@a.com' }),
    ).toBe('studio_generic');
  });

  it('без контакту studio_generic', () => {
    expect(pickTargetType({ hasVacancy: false })).toBe('studio_generic');
  });
});

describe('загальна пошта', () => {
  it.each(['hello@a.com', 'info@a.com', 'jobs@a.com', 'hr.team@a.com', 'careers@a.com'])(
    '%s читає менеджер',
    (email) => {
      expect(isGenericEmail(email)).toBe(true);
    },
  );

  it.each(['anton@a.com', 'a.malyy@a.com', 'cto@a.com'])('%s іменна', (email) => {
    expect(isGenericEmail(email)).toBe(false);
  });

  it('порожня адреса вважається загальною, іменного листа з неї не буде', () => {
    expect(isGenericEmail(null)).toBe(true);
  });
});

describe('мова', () => {
  it.each(['UA', 'ua', 'Ukraine', 'Україна'])('%s означає uk', (country) => {
    expect(pickLanguage(country)).toBe('uk');
  });

  it.each(['PL', 'Germany', null, ''])('%s означає en', (country) => {
    expect(pickLanguage(country)).toBe('en');
  });
});

describe('вибір контакту', () => {
  it('іменний контакт з поштою важливіший за загальну скриньку', () => {
    const picked = pickContact([
      contact({ id: 1, name: null, email: 'hello@acme.com' }),
      contact({ id: 2, name: 'Anton', email: 'anton@acme.com' }),
    ]);
    expect(picked?.id).toBe(2);
  });

  it('без пошти контакт не годиться, лист нікуди слати', () => {
    expect(pickContact([contact({ email: null })])).toBeNull();
  });
});

describe('складання чернетки', () => {
  it('підставляє значення і не лишає помилки', () => {
    const draft = buildDraft(candidate(), template(), 'en');
    expect(draft.subject).toBe('Front-end for Acme Studio');
    expect(draft.body).toContain('Hi Anton,');
    expect(draft.error).toBeNull();
  });

  it('порожній плейсхолдер робить чернетку проблемною, а не листом "Hi ,"', () => {
    const draft = buildDraft(candidate({ contact: contact({ name: null }) }), template(), 'en');
    expect(draft.error).toContain('first_name');
    expect(draft.body).not.toContain('Hi ,');
  });

  it('порожній шаблон це помилка, а не порожній лист', () => {
    const draft = buildDraft(candidate(), template({ body: '   ' }), 'en');
    expect(draft.error).toContain('шаблон порожній');
  });

  it('мітка в квадратних дужках означає, що текст ще не дописали', () => {
    const draft = buildDraft(
      candidate(),
      template({ body: 'Hi {{first_name}},\n\n[другий абзац]' }),
      'en',
    );
    expect(draft.error).toContain('мітки');
  });

  it('без адреси чернетка не готова', () => {
    const draft = buildDraft(candidate({ contact: contact({ email: null }) }), template(), 'en');
    expect(draft.error).toContain('немає адреси');
  });

  it('невідомий токен це друкарська помилка, а не мовчазний порожній рядок', () => {
    const draft = buildDraft(candidate(), template({ body: 'Hi {{firstname}}' }), 'en');
    expect(draft.error).toContain('невідомі плейсхолдери');
  });
});

describe('стартові шаблони', () => {
  it('доливаються один раз, повторний виклик нічого не додає', async () => {
    const added = await seedOutreachTemplates();
    expect(added).toBe(8);
    expect(await seedOutreachTemplates()).toBe(0);
  });

  it('покривають усі випадки на двох мовах', async () => {
    const list = await outreachTemplates();
    for (const target of ['vacancy', 'studio_named', 'studio_generic', 'followup'] as const) {
      expect(matchTemplate(list, target, 'uk')).not.toBeNull();
      expect(matchTemplate(list, target, 'en')).not.toBeNull();
    }
  });

  it('приходять з міткою замість тексту, тому власник мусить їх дописати', async () => {
    const list = await outreachTemplates();
    const draft = buildDraft(candidate(), matchTemplate(list, 'studio_named', 'en')!, 'en');
    expect(draft.error).toContain('мітки');
  });
});

describe('кандидати на лист', () => {
  it('компанія в блеклисті не потрапляє в кандидати', async () => {
    const list = await draftCandidates(50);
    expect(list.map((row) => row.companyId)).not.toContain(blocked.id);
  });

  it('вакансія вище порогу підтягується до компанії', async () => {
    const list = await draftCandidates(50);
    const row = list.find((item) => item.companyId === ukrainian.id);
    expect(row?.vacancyTitle).toBe('Senior Frontend');
    expect(row?.vacancyStack).toEqual(['react', 'typescript']);
  });

  it('для студії береться іменний контакт', async () => {
    const list = await draftCandidates(50);
    expect(list.find((item) => item.companyId === studio.id)?.contact?.email).toBe('anton@acme.com');
  });
});

describe('підготовка чернеток', () => {
  it('dry-run нічого не пише в базу', async () => {
    const report = await prepareDrafts({ dryRun: true });
    expect(report.drafts.length).toBeGreaterThan(0);
    expect(report.created).toBe(0);
    expect(await listDrafts()).toHaveLength(0);
  });

  it('створює чернетки і вибирає шаблон під мову і випадок', async () => {
    const report = await prepareDrafts({});
    expect(report.created).toBe(2);

    const drafts = await listDrafts();
    const ua = drafts.find((row) => row.companyId === ukrainian.id);
    const pl = drafts.find((row) => row.companyId === studio.id);
    expect(ua?.templateUsed).toBe('send_vacancy_uk');
    expect(ua?.language).toBe('uk');
    expect(pl?.templateUsed).toBe('send_studio_named_en');
  });

  it('чернетка не рахується надісланим листом', async () => {
    const rows = await getDb().select().from(outreach);
    expect(rows.every((row) => row.status === 'draft' && row.sentAt === null)).toBe(true);
  });

  it('компанії з чернеткою вдруге не беруться', async () => {
    const report = await prepareDrafts({});
    expect(report.created).toBe(0);
  });

  it('шаблон із мітками робить чернетку проблемною', async () => {
    const drafts = await listDrafts();
    expect(drafts.every((row) => row.error !== null)).toBe(true);
  });
});

describe('чернетка по кнопці з Черги', () => {
  it('другу чернетку тій самій компанії не створює', async () => {
    const first = await draftForCompany(studio.id);
    expect(first.id).not.toBeNull();

    const second = await draftForCompany(studio.id);
    expect(second.id).toBe(first.id);
    expect(second.reason).toContain('вже лежить');
  });

  it('без жодної адреси чернетки не буде, і причина названа', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Ghost', domain: 'ghost.io', source: 'test' })).company;
    // enrich: false, щоб тест не ходив у мережу. Кнопка в інтерфейсі, навпаки,
    // спершу обходить сайт компанії і лише потім здається.
    const result = await draftForCompany(empty.id, null, { enrich: false });
    expect(result.id).toBeNull();
    expect(result.reason).toContain('адреси');
    await db.delete(companies).where(eq(companies.id, empty.id));
  });
});

describe('правка чернетки', () => {
  it('дописаний текст знімає позначку про проблему', async () => {
    const [draft] = await listDrafts();
    const updated = await updateDraft(draft!.id, {
      subject: 'Front-end',
      body: 'Вітаю.\n\nКоротко про справу.\n\nAlex',
    });
    expect(updated?.error).toBeNull();
  });

  it('незаповнений плейсхолдер лишає чернетку проблемною', async () => {
    const [draft] = await listDrafts();
    const updated = await updateDraft(draft!.id, { body: 'Вітаю, {{first_name}}.' });
    expect(updated?.error).toContain('first_name');
  });

  it('надісланий лист правити не можна, це знімок того, що пішло', async () => {
    const [draft] = await listDrafts();
    await getDb().update(outreach).set({ status: 'sent', sentAt: Date.now() }).where(eq(outreach.id, draft!.id));
    await expect(updateDraft(draft!.id, { body: 'нове' })).rejects.toThrow('чернетку');
  });
});

describe('видалення чернетки', () => {
  it('чернетку можна прибрати', async () => {
    const drafts = await listDrafts();
    expect(await discardDraft(drafts[0]!.id)).toEqual({ deleted: true });
  });

  it('надісланий лист не видаляється', async () => {
    const [sent] = await getDb().select().from(outreach).where(eq(outreach.status, 'sent'));
    await expect(discardDraft(sent!.id)).rejects.toThrow('чернетку');
  });
});
