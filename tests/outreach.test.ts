import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, setRuntimeEnv } from '../src/config.js';
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
    name: 'Test',
    kind: 'studio',
    language: 'en',
    targetType: 'studio_named',
    forKind: null,
    subject: 'Front-end for {{company}}',
    intro: null,
    body: 'Hi {{first_name}},\n\nSaw {{domain}}.\n\nOlena',
    note: null,
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

beforeAll(async () => {
  // Sending refuses without a From name, see checkSend.
  setRuntimeEnv({ GMAIL_FROM_NAME: 'Test Sender' });
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

describe('template choice', () => {
  it('a vacancy beats everything else', () => {
    expect(pickTargetType({ hasVacancy: true, contactName: null, contactEmail: 'hello@a.com' })).toBe(
      'vacancy',
    );
  });

  it('a named contact with a personal address gives studio_named', () => {
    expect(
      pickTargetType({ hasVacancy: false, contactName: 'Anton', contactEmail: 'anton@a.com' }),
    ).toBe('studio_named');
  });

  it('a name on a generic mailbox is still studio_generic', () => {
    expect(
      pickTargetType({ hasVacancy: false, contactName: 'Anton', contactEmail: 'hello@a.com' }),
    ).toBe('studio_generic');
  });

  it('no contact means studio_generic', () => {
    expect(pickTargetType({ hasVacancy: false })).toBe('studio_generic');
  });
});

describe('generic mailbox', () => {
  it.each(['hello@a.com', 'info@a.com', 'jobs@a.com', 'hr.team@a.com', 'careers@a.com'])(
    '%s is read by a manager',
    (email) => {
      expect(isGenericEmail(email)).toBe(true);
    },
  );

  it.each(['anton@a.com', 'a.malyy@a.com', 'cto@a.com'])('%s is personal', (email) => {
    expect(isGenericEmail(email)).toBe(false);
  });

  it('an empty address counts as generic, no named letter comes from it', () => {
    expect(isGenericEmail(null)).toBe(true);
  });
});

describe('language', () => {
  it.each(['UA', 'ua', 'Ukraine', 'Україна'])('%s means uk', (country) => {
    expect(pickLanguage(country)).toBe('uk');
  });

  it.each(['PL', 'Germany', null, ''])('%s means en', (country) => {
    expect(pickLanguage(country)).toBe('en');
  });
});

describe('contact choice', () => {
  it('a named contact with an email beats a generic mailbox', () => {
    const picked = pickContact([
      contact({ id: 1, name: null, email: 'hello@acme.com' }),
      contact({ id: 2, name: 'Anton', email: 'anton@acme.com' }),
    ]);
    expect(picked?.id).toBe(2);
  });

  it('a contact without an email will not do, there is nowhere to send', () => {
    expect(pickContact([contact({ email: null })])).toBeNull();
  });
});

describe('building a draft', () => {
  it('fills in the values and leaves no error', () => {
    const draft = buildDraft(candidate(), template(), 'en');
    expect(draft.subject).toBe('Front-end for Acme Studio');
    expect(draft.body).toContain('Hi Anton,');
    expect(draft.error).toBeNull();
  });

  it('an empty placeholder makes the draft problematic rather than a "Hi ," letter', () => {
    const draft = buildDraft(candidate({ contact: contact({ name: null }) }), template(), 'en');
    expect(draft.error).toContain('first_name');
    expect(draft.body).not.toContain('Hi ,');
  });

  it('an empty template is an error, not an empty letter', () => {
    const draft = buildDraft(candidate(), template({ body: '   ' }), 'en');
    expect(draft.error).toContain('template is empty');
  });

  it('a square bracket marker means the text is not finished yet', () => {
    const draft = buildDraft(
      candidate(),
      template({ body: 'Hi {{first_name}},\n\n[second paragraph]' }),
      'en',
    );
    expect(draft.error).toContain('markers');
  });

  it('without an address the draft is not ready', () => {
    const draft = buildDraft(candidate({ contact: contact({ email: null }) }), template(), 'en');
    expect(draft.error).toContain('no address');
  });

  it('an unknown token is a typo, not a silent empty string', () => {
    const draft = buildDraft(candidate(), template({ body: 'Hi {{firstname}}' }), 'en');
    expect(draft.error).toContain('unknown placeholders');
  });
});

describe('starter templates', () => {
  it('are added once, a repeated call adds nothing', async () => {
    const added = await seedOutreachTemplates();
    expect(added).toBe(8);
    expect(await seedOutreachTemplates()).toBe(0);
  });

  it('cover every case in two languages', async () => {
    const list = await outreachTemplates();
    for (const target of ['vacancy', 'studio_named', 'studio_generic', 'followup'] as const) {
      expect(matchTemplate(list, target, 'uk')).not.toBeNull();
      expect(matchTemplate(list, target, 'en')).not.toBeNull();
    }
  });

  it('come with markers instead of text, so the owner has to finish them', async () => {
    const list = await outreachTemplates();
    const draft = buildDraft(candidate(), matchTemplate(list, 'studio_named', 'en')!, 'en');
    expect(draft.error).toContain('markers');
  });
});

describe('letter candidates', () => {
  it('a blacklisted company is not a candidate', async () => {
    const list = await draftCandidates(50);
    expect(list.map((row) => row.companyId)).not.toContain(blocked.id);
  });

  it('a vacancy above the threshold is attached to the company', async () => {
    const list = await draftCandidates(50);
    const row = list.find((item) => item.companyId === ukrainian.id);
    expect(row?.vacancyTitle).toBe('Senior Frontend');
    expect(row?.vacancyStack).toEqual(['react', 'typescript']);
  });

  it('a studio gets its named contact', async () => {
    const list = await draftCandidates(50);
    expect(list.find((item) => item.companyId === studio.id)?.contact?.email).toBe('anton@acme.com');
  });
});

describe('preparing drafts', () => {
  it('dry-run writes nothing to the database', async () => {
    const report = await prepareDrafts({ dryRun: true });
    expect(report.drafts.length).toBeGreaterThan(0);
    expect(report.created).toBe(0);
    expect(await listDrafts()).toHaveLength(0);
  });

  it('creates drafts and picks the template by language and case', async () => {
    const report = await prepareDrafts({});
    expect(report.created).toBe(2);

    const drafts = await listDrafts();
    const ua = drafts.find((row) => row.companyId === ukrainian.id);
    const pl = drafts.find((row) => row.companyId === studio.id);
    expect(ua?.templateUsed).toBe('send_vacancy_uk');
    expect(ua?.language).toBe('uk');
    expect(pl?.templateUsed).toBe('send_studio_named_en');
  });

  it('a draft does not count as a sent letter', async () => {
    const rows = await getDb().select().from(outreach);
    expect(rows.every((row) => row.status === 'draft' && row.sentAt === null)).toBe(true);
  });

  it('companies with a draft are not taken twice', async () => {
    const report = await prepareDrafts({});
    expect(report.created).toBe(0);
  });

  it('a template with markers makes the draft problematic', async () => {
    const drafts = await listDrafts();
    expect(drafts.every((row) => row.error !== null)).toBe(true);
  });
});

describe('company without an address', () => {
  /*
   * A draft without an address used to land in the queue marked "no address to write to",
   * and the owner saw a letter that would go nowhere until they ran contact collection
   * separately. Now the site crawl comes before the letter is built, and if there is still
   * no address after it, no draft is created at all.
   *
   * `enrichLimit: 0` keeps the test off the network.
   */
  it('does not reach the queue, and the reason is given', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Silent', domain: 'silent.io', source: 'test' })).company;

    /*
     * There is an address, but it is dead after a hard bounce. Exactly such companies produced
     * broken drafts: candidate selection only checks that an email exists, contact choice also
     * checks that it is usable, and a letter slipped through between the two checks.
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
    expect(report.skipped.find((row) => row.company === 'Silent')?.reason).toContain('address');

    await db.delete(companies).where(eq(companies.id, empty.id));
  });
});

describe('swapping the template on a draft', () => {
  it('the text is rebuilt and the first paragraph stays', async () => {
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

  it('an unknown template is an error, not a silent swap', async () => {
    const [draft] = await listDrafts();
    await expect(retemplateDraft(draft!.id, 'no_such_template')).rejects.toThrow('no template');
  });
});

describe('draft from the Queue button', () => {
  /*
   * A template picked by hand on the card used to go nowhere: the code picked its own by
   * role and language, and the owner got a draft with a completely different text.
   *
   * The company here is the test's own rather than shared: a company has exactly one draft,
   * so a test on a shared one would get in the way of its neighbours.
   */
  it('uses the template picked on the card, not the one chosen by code', async () => {
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
    // The template is remembered by id, otherwise intro regeneration would not know what to build from.
    expect(row!.templateId).not.toBeNull();

    await db.delete(outreach).where(eq(outreach.companyId, own.id));
    await db.delete(contacts).where(eq(contacts.companyId, own.id));
    await db.delete(companies).where(eq(companies.id, own.id));
  });

  it('a missing template is not silently replaced by another', async () => {
    const db = getDb();
    const own = (await upsertCompany({ name: 'NoTpl', domain: 'notpl.ua', country: 'UA', source: 'test' }))
      .company;
    await db.insert(contacts).values({ companyId: own.id, name: 'Ola', email: 'ola@notpl.ua' });

    const result = await draftForCompany(own.id, null, { templateSlug: 'no_such_template' });
    expect(result.id).toBeNull();
    expect(result.reason).toContain('no_such_template');

    await db.delete(contacts).where(eq(contacts.companyId, own.id));
    await db.delete(companies).where(eq(companies.id, own.id));
  });

  it('does not create a second draft for the same company', async () => {
    const first = await draftForCompany(studio.id);
    expect(first.id).not.toBeNull();

    const second = await draftForCompany(studio.id);
    expect(second.id).toBe(first.id);
    expect(second.reason).toContain('already queued');
  });

  /*
   * Without an address the draft still lands in the queue, with an empty address field. This
   * used to be a refusal, and the company dropped out of sight, although finding the email on
   * their site by eye often takes a minute. It does not open sending, `checkSend` holds that.
   */
  it('without an address the draft is created with an empty field and an explanation', async () => {
    const db = getDb();
    const empty = (await upsertCompany({ name: 'Ghost', domain: 'ghost.io', source: 'test' })).company;
    // enrich: false keeps the test off the network.
    const result = await draftForCompany(empty.id, null, { enrich: false });

    expect(result.id).not.toBeNull();
    expect(result.reason).toContain('type the email by hand');
    expect(result.draft?.contactEmail).toBeNull();
    // There is an error, so the draft sits in the "Need attention" tab rather than being ready to send.
    expect(result.draft?.error).not.toBeNull();

    await db.delete(outreach).where(eq(outreach.companyId, empty.id));
    await db.delete(companies).where(eq(companies.id, empty.id));
  });

  /*
   * An address typed by hand does not stay inside the letter: it becomes a company contact,
   * so it shows on the studio page too, and next time the radar no longer thinks there is
   * nowhere to write.
   */
  it('an address typed into a draft becomes a company contact', async () => {
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

  /*
   * The subtlest part of address choice. A letter is built once, and `{{first_name}}` in it
   * has long become a specific "Hi Anna". Moving the draft to Ihor's address and leaving the
   * text as is means silently greeting Anna: no error, no placeholders, the letter goes.
   */
  it('changing the contact rewrites the name in the subject and the body', async () => {
    const db = getDb();
    const company = (await upsertCompany({ name: 'Swap', domain: 'swap.io', source: 'test' })).company;
    await db
      .insert(contacts)
      .values({ companyId: company.id, name: 'Anna Koval', email: 'anna@swap.io' });
    const created = await draftForCompany(company.id, null, { enrich: false });

    await updateDraft(created.id!, {
      subject: 'Anna, front-end for Swap',
      body: 'Hi Anna,\n\nSaw swap.io.\n\nOlena',
      contactEmail: 'anna@swap.io',
      contactName: 'Anna Koval',
    });

    const updated = await updateDraft(created.id!, {
      contactEmail: 'ihor@swap.io',
      contactName: 'Ihor Bondar',
    });

    expect(updated?.body).toContain('Hi Ihor,');
    expect(updated?.body).not.toContain('Anna');
    expect(updated?.subject).toBe('Ihor, front-end for Swap');
    expect(updated?.error).toBeNull();

    await db.delete(outreach).where(eq(outreach.companyId, company.id));
    await db.delete(contacts).where(eq(contacts.companyId, company.id));
    await db.delete(companies).where(eq(companies.id, company.id));
  });

  /*
   * There is no new name, and the old one is still in the text. There is nothing to build a
   * greeting from, so the draft honestly becomes problematic instead of going out with someone else's name.
   */
  it('an address without a name keeps the draft problematic instead of staying silent', async () => {
    const db = getDb();
    const company = (await upsertCompany({ name: 'Orphan', domain: 'orphan.io', source: 'test' })).company;
    await db
      .insert(contacts)
      .values({ companyId: company.id, name: 'Anna Koval', email: 'anna@orphan.io' });
    const created = await draftForCompany(company.id, null, { enrich: false });

    await updateDraft(created.id!, {
      subject: 'Front-end for Orphan',
      body: 'Hi Anna,\n\nSaw orphan.io.\n\nOlena',
      contactEmail: 'anna@orphan.io',
      contactName: 'Anna Koval',
    });

    const updated = await updateDraft(created.id!, {
      contactEmail: 'hello@orphan.io',
      contactName: null,
    });

    expect(updated?.error).toContain('Anna');

    await db.delete(outreach).where(eq(outreach.companyId, company.id));
    await db.delete(contacts).where(eq(contacts.companyId, company.id));
    await db.delete(companies).where(eq(companies.id, company.id));
  });

  /*
   * The address list travels with the draft, otherwise picking another one would mean
   * recalling it from memory. Named first: a letter to hello@ is read by a manager, not a tech lead.
   */
  it('a draft carries every company address, named ones first', async () => {
    const db = getDb();
    const company = (await upsertCompany({ name: 'Many', domain: 'many.io', source: 'test' })).company;
    await db.insert(contacts).values([
      { companyId: company.id, email: 'hello@many.io' },
      { companyId: company.id, name: 'Olena Marchuk', role: 'CTO', email: 'olena@many.io' },
      { companyId: company.id, name: 'No Email' },
    ]);
    const created = await draftForCompany(company.id, null, { enrich: false });

    const row = (await listDrafts()).find((item) => item.id === created.id);
    expect(row?.companyContacts.map((item) => item.email)).toEqual(['olena@many.io', 'hello@many.io']);
    expect(row?.companyContacts[0]?.role).toBe('CTO');

    await db.delete(outreach).where(eq(outreach.companyId, company.id));
    await db.delete(contacts).where(eq(contacts.companyId, company.id));
    await db.delete(companies).where(eq(companies.id, company.id));
  });
});

describe('editing a draft', () => {
  it('finished text clears the problem flag', async () => {
    const [draft] = await listDrafts();
    const updated = await updateDraft(draft!.id, {
      subject: 'Front-end',
      body: 'Вітаю.\n\nКоротко про справу.\n\nOlena',
    });
    expect(updated?.error).toBeNull();
  });

  it('an unfilled placeholder keeps the draft problematic', async () => {
    const [draft] = await listDrafts();
    const updated = await updateDraft(draft!.id, { body: 'Вітаю, {{first_name}}.' });
    expect(updated?.error).toContain('first_name');
  });

  it('a sent letter cannot be edited, it is a snapshot of what went out', async () => {
    const [draft] = await listDrafts();
    await getDb().update(outreach).set({ status: 'sent', sentAt: Date.now() }).where(eq(outreach.id, draft!.id));
    await expect(updateDraft(draft!.id, { body: 'new text' })).rejects.toThrow('only a draft');
  });
});

describe('deleting a draft', () => {
  it('a draft can be removed', async () => {
    const drafts = await listDrafts();
    expect(await discardDraft(drafts[0]!.id)).toEqual({ deleted: true });
  });

  it('a sent letter is not deleted', async () => {
    const [sent] = await getDb().select().from(outreach).where(eq(outreach.status, 'sent'));
    await expect(discardDraft(sent!.id)).rejects.toThrow('only a draft');
  });
});

/*
 * The signature is the same in every letter, so it lives apart from the templates. Templates
 * written before the placeholder existed are not left without it: it is appended on its own.
 */
describe('signature in a letter', () => {
  const signature = 'Olena Koval\nolena.dev';

  it('is appended at the end when the template has no placeholder', () => {
    const built = buildDraft(candidate(), template({ body: 'Hi.\n\nSaw {{domain}}.' }), 'en', null, signature);
    expect(built.body.endsWith(signature)).toBe(true);
  });

  it('the placeholder puts it where it stands, and there is no second copy', () => {
    const built = buildDraft(
      candidate(),
      template({ body: 'Hi.\n\n{{signature}}\n\nP.S. one line.' }),
      'en',
      null,
      signature,
    );

    expect(built.body).toContain(`${signature}\n\nP.S. one line.`);
    expect(built.body.split('olena.dev')).toHaveLength(2);
  });

  it('a signature already typed into the template by hand is not duplicated', () => {
    const built = buildDraft(
      candidate(),
      template({ body: `Hi.\n\nSaw {{domain}}.\n\n${signature}` }),
      'en',
      null,
      signature,
    );

    expect(built.body.split('olena.dev')).toHaveLength(2);
  });

  it('an empty signature appends nothing', () => {
    const built = buildDraft(candidate(), template({ body: 'Hi.\n\nSaw {{domain}}.' }), 'en', null, '');
    expect(built.body).toBe('Hi.\n\nSaw acme.com.');
  });
});
