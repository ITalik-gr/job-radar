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
  retemplateDraft,
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

describe('компанія без адреси', () => {
  /*
   * Чернетка без адреси раніше лягала в чергу з позначкою "немає адреси, куди писати",
   * і власник бачив лист, який нікуди не піде, доки не запустить збір контактів окремо.
   * Тепер обхід сайту йде до складання листа, а якщо адреси немає і після нього,
   * чернетка не створюється зовсім.
   *
   * `enrichLimit: 0` тут для того, щоб тест не ходив у мережу.
   */
  it('у чергу не потрапляє, а причина називається', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Silent', domain: 'silent.io', source: 'test' })).company;

    /*
     * Адреса є, але мертва після hard bounce. Саме такі компанії і давали зіпсовані
     * чернетки: відбір кандидатів дивиться лише на наявність пошти, а вибір контакту
     * ще й на її придатність, і між цими двома перевірками лист устигав створитись.
     */
    await db.insert(contacts).values({
      companyId: empty.id,
      name: 'Dead Box',
      email: 'dead@silent.io',
      emailValid: false,
    });

    const before = (await listDrafts()).length;
    const report = await prepareDrafts({ enrichLimit: 0 });

    expect((await listDrafts()).length).toBe(before);
    expect(report.skipped.some((row) => row.company === 'Silent')).toBe(true);
    expect(report.skipped.find((row) => row.company === 'Silent')?.reason).toContain('адреси');

    await db.delete(companies).where(eq(companies.id, empty.id));
  });
});

describe('заміна шаблона в чернетці', () => {
  it('текст збирається заново, а перший абзац лишається', async () => {
    const db = getDb();
    const [draft] = await listDrafts();
    const was = draft!.templateUsed;

    const other = (await db.select().from(templates).where(eq(templates.slug, 'send_studio_generic_en')))[0]!;
    const updated = await retemplateDraft(draft!.id, other.slug);

    expect(updated?.templateUsed).toBe(other.slug);
    expect(updated?.templateUsed).not.toBe(was);
    expect(updated?.language).toBe(other.language);

    const [row] = await db.select().from(outreach).where(eq(outreach.id, draft!.id));
    expect(row!.templateId).toBe(other.id);
  });

  it('невідомий шаблон це помилка, а не тиха заміна', async () => {
    const [draft] = await listDrafts();
    await expect(retemplateDraft(draft!.id, 'нема_такого')).rejects.toThrow('немає');
  });
});

describe('чернетка по кнопці з Черги', () => {
  /*
   * Шаблон, вибраний руками на картці, раніше нікуди не йшов: код підбирав свій
   * за роллю і мовою, і власник отримував чернетку зовсім іншим текстом.
   *
   * Компанія тут своя, а не спільна: чернетка на компанію буває рівно одна, тому
   * тест на спільній заважав би сусіднім.
   */
  it('бере шаблон, вибраний на картці, а не підібраний кодом', async () => {
    const db = getDb();
    const own = (await upsertCompany({ name: 'Choice', domain: 'choice.ua', country: 'UA', source: 'test' }))
      .company;
    await db.insert(contacts).values({ companyId: own.id, name: 'Ola', email: 'ola@choice.ua' });

    const auto = await draftForCompany(own.id);
    expect(auto.draft?.templateSlug).toBe('send_studio_named_uk');
    await db.delete(outreach).where(eq(outreach.companyId, own.id));

    const manual = await draftForCompany(own.id, null, { templateSlug: 'send_studio_generic_en' });
    expect(manual.draft?.templateSlug).toBe('send_studio_generic_en');
    expect(manual.draft?.language).toBe('en');

    const [row] = await db.select().from(outreach).where(eq(outreach.id, manual.id!));
    expect(row!.templateUsed).toBe('send_studio_generic_en');
    // Шаблон запамʼятався номером, інакше перегенерація абзацу не знає, з чого збирати.
    expect(row!.templateId).not.toBeNull();

    await db.delete(outreach).where(eq(outreach.companyId, own.id));
    await db.delete(contacts).where(eq(contacts.companyId, own.id));
    await db.delete(companies).where(eq(companies.id, own.id));
  });

  it('неіснуючий шаблон не підміняється тихо іншим', async () => {
    const db = getDb();
    const own = (await upsertCompany({ name: 'NoTpl', domain: 'notpl.ua', country: 'UA', source: 'test' }))
      .company;
    await db.insert(contacts).values({ companyId: own.id, name: 'Ola', email: 'ola@notpl.ua' });

    const result = await draftForCompany(own.id, null, { templateSlug: 'нема_такого' });
    expect(result.id).toBeNull();
    expect(result.reason).toContain('нема_такого');

    await db.delete(contacts).where(eq(contacts.companyId, own.id));
    await db.delete(companies).where(eq(companies.id, own.id));
  });

  it('другу чернетку тій самій компанії не створює', async () => {
    const first = await draftForCompany(studio.id);
    expect(first.id).not.toBeNull();

    const second = await draftForCompany(studio.id);
    expect(second.id).toBe(first.id);
    expect(second.reason).toContain('вже лежить');
  });

  /*
   * Без адреси чернетка все одно лягає в чергу, з порожнім полем адреси. Раніше тут
   * була відмова, і компанія зникала з поля зору, хоча знайти пошту очима на їхньому
   * сайті часто справа хвилини. Відправку це не відкриває, її тримає `checkSend`.
   */
  it('без адреси чернетка створюється з порожнім полем і поясненням', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Ghost', domain: 'ghost.io', source: 'test' })).company;
    // enrich: false, щоб тест не ходив у мережу.
    const result = await draftForCompany(empty.id, null, { enrich: false });

    expect(result.id).not.toBeNull();
    expect(result.reason).toContain('впиши пошту руками');
    expect(result.draft?.contactEmail).toBeNull();
    // Помилка є, тобто чернетка лежить у вкладці "Потребують уваги", а не готова до відправки.
    expect(result.draft?.error).not.toBeNull();

    await db.delete(outreach).where(eq(outreach.companyId, empty.id));
    await db.delete(companies).where(eq(companies.id, empty.id));
  });

  /*
   * Вписана руками адреса не лишається всередині листа: вона заводиться контактом
   * компанії, тому видно її і на сторінці студії, і наступного разу радар уже не
   * вважає, що писати нікуди.
   */
  it('вписана в чернетці адреса стає контактом компанії', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Manual', domain: 'manual.io', source: 'test' })).company;
    const created = await draftForCompany(empty.id, null, { enrich: false });

    const updated = await updateDraft(created.id!, { contactEmail: 'Hello@Manual.io ', contactName: 'Ola' });
    expect(updated?.contactEmail).toBe('hello@manual.io');
    expect(updated?.error).toBeNull();

    const rows = await db.select().from(contacts).where(eq(contacts.companyId, empty.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'hello@manual.io', name: 'Ola', emailValid: true });

    await db.delete(outreach).where(eq(outreach.companyId, empty.id));
    await db.delete(contacts).where(eq(contacts.companyId, empty.id));
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

/*
 * Підпис однаковий у всіх листах, тому живе окремо від шаблонів. Шаблони, написані
 * до появи мітки, не лишаються без нього: він дописується в кінець сам.
 */
describe('підпис у листі', () => {
  const signature = 'Alex Example\nexample.dev';

  it('дописується в кінець, якщо мітки в шаблоні немає', () => {
    const built = buildDraft(candidate(), template({ body: 'Hi.\n\nSaw {{domain}}.' }), 'en', null, signature);
    expect(built.body.endsWith(signature)).toBe(true);
  });

  it('мітка ставить його туди, де вона стоїть, і другого разу не буде', () => {
    const built = buildDraft(
      candidate(),
      template({ body: 'Hi.\n\n{{signature}}\n\nP.S. one line.' }),
      'en',
      null,
      signature,
    );

    expect(built.body).toContain(`${signature}\n\nP.S. one line.`);
    expect(built.body.split('example.dev')).toHaveLength(2);
  });

  it('підпис, уже вписаний у шаблон руками, не дублюється', () => {
    const built = buildDraft(
      candidate(),
      template({ body: `Hi.\n\nSaw {{domain}}.\n\n${signature}` }),
      'en',
      null,
      signature,
    );

    expect(built.body.split('example.dev')).toHaveLength(2);
  });

  it('порожній підпис нічого не дописує', () => {
    const built = buildDraft(candidate(), template({ body: 'Hi.\n\nSaw {{domain}}.' }), 'en', null, '');
    expect(built.body).toBe('Hi.\n\nSaw acme.com.');
  });
});
