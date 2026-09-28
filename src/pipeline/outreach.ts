import { chunk, rowsPerQuery } from '../lib/chunk.js';
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  templates,
  vacancies,
  type Contact,
  type Template,
} from '../db/schema.js';
import { renderLetter, type LetterContext } from '../lib/letter.js';
import { log } from '../lib/log.js';
import { readSetting, writeSetting } from '../lib/settings-store.js';
import { rules } from './rules.js';
import { generateParagraph } from './ai-paragraph.js';
import { enrich } from './enrich.js';

/**
 * Preparing sending drafts. The module is described in OUTREACH.md.
 *
 * There is neither sending nor model calls here: a draft is built from a template the owner
 * wrote and from facts already in the database. Sending is a separate step, and between it
 * and this file there is always a person with a button.
 *
 * Template choice is deterministic on purpose. A model that picks the tone of a letter gives
 * different results on the same data, and understanding why a particular studio got this
 * particular text becomes impossible.
 */

export const OUTREACH_TARGETS = ['vacancy', 'studio_named', 'studio_generic', 'followup'] as const;
export type OutreachTarget = (typeof OUTREACH_TARGETS)[number];

export type Language = 'uk' | 'en';

/** Companies in these states are never written to, section 9 of OUTREACH.md. */
export const BLOCKED_STATUSES = ['blacklist', 'rejected_by_me', 'rejected_by_them'];

/** Contacting again is allowed after a quarter, not after a week. */
export const RECONTACT_DAYS = 90;

/**
 * Mailboxes read by a manager rather than a tech lead. The difference is not cosmetic: a
 * named contact gets a different text, so this is a decision, not decoration.
 */
const GENERIC_MAILBOXES = new Set([
  'hello',
  'info',
  'contact',
  'contacts',
  'office',
  'mail',
  'team',
  'sales',
  'support',
  'admin',
  'hr',
  'jobs',
  'career',
  'careers',
  'work',
  'recruiting',
  'talent',
  'pr',
  'marketing',
  'business',
  'bd',
  'partnership',
  'partnerships',
]);

/**
 * A `[like this]` marker in a template is a spot where the owner has not written their text
 * yet. Starter templates come exactly like that: structure from the tool, words from the
 * person. A letter with a marker in the body is not sent, it sits in "Need attention".
 */
const UNFILLED_MARKER = /\[[^\]\n]{3,}\]/g;

export function isGenericEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const local = email.split('@')[0]?.toLowerCase().replace(/[._-].*$/, '') ?? '';
  return GENERIC_MAILBOXES.has(local);
}

/**
 * Letter language. Country UA means Ukrainian, everything else English.
 *
 * The site language is deliberately not guessed: a studio with a Polish site and an
 * English-speaking sales team is common, and a letter in Polish from someone who does not
 * know Polish ends the conversation on the first line.
 */
export function pickLanguage(country: string | null | undefined): Language {
  const value = (country ?? '').trim().toLowerCase();
  return value === 'ua' || value === 'ukraine' || value === 'україна' ? 'uk' : 'en';
}

export interface TargetInput {
  hasVacancy: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
}

/** Three cases, three templates. No in-between states and no model in the decision. */
export function pickTargetType(input: TargetInput): OutreachTarget {
  if (input.hasVacancy) return 'vacancy';
  const named = Boolean(input.contactName?.trim()) && !isGenericEmail(input.contactEmail);
  return named ? 'studio_named' : 'studio_generic';
}

/**
 * A named contact is worth more than a generic mailbox, section 9 of CLAUDE.md, so the order
 * is: named with an email, then anyone with an email, then anyone.
 */
export function pickContact(list: Contact[]): Contact | null {
  // An address after a hard bounce is dead: writing to it hurts the sender reputation.
  const withEmail = list.filter((row) => row.email && row.emailValid);
  const named = withEmail.filter((row) => row.name && !isGenericEmail(row.email));
  return named[0] ?? withEmail[0] ?? null;
}

export interface DraftCandidate {
  companyId: number;
  company: string;
  domain: string;
  country: string | null;
  city: string | null;
  kind: string | null;
  sizeHint: string | null;
  techHints: string[];
  tags: string[];
  description: string | null;
  vacancyId: number | null;
  vacancyTitle: string | null;
  vacancyStack: string[];
  contact: Contact | null;
}

export interface PreparedDraft {
  companyId: number;
  vacancyId: number | null;
  contactId: number | null;
  templateId: number;
  templateSlug: string;
  targetType: OutreachTarget;
  language: Language;
  subject: string;
  body: string;
  contactName: string | null;
  contactEmail: string | null;
  /** Whether the model wrote the first paragraph. Stored separately as material for comparison. */
  aiUsed: boolean;
  aiParagraph: string | null;
  aiFallbackReason: string | null;
  /** Why the draft is not ready to send. null means ready. */
  error: string | null;
}

/**
 * Building one letter from a template. Kept apart from writing to the database so that the
 * preview on the Templates page and a real draft run the same code: otherwise the owner sees
 * one text in the preview while another goes into the mail.
 */
export function buildDraft(
  candidate: DraftCandidate,
  template: Template,
  language: Language,
  /** A ready first paragraph. Empty means the static text from the template. */
  intro?: string | null,
  /** The shared signature. Empty means letters go out without one. */
  signature?: string | null,
): Omit<
  PreparedDraft,
  'companyId' | 'vacancyId' | 'contactId' | 'aiUsed' | 'aiParagraph' | 'aiFallbackReason'
> {
  const context: LetterContext = {
    company: candidate.company,
    domain: candidate.domain,
    contactName: candidate.contact?.name ?? null,
    kind: candidate.kind,
    stack: candidate.vacancyStack.length > 0 ? candidate.vacancyStack : candidate.techHints,
    vacancyTitle: candidate.vacancyTitle,
    city: candidate.city,
    country: candidate.country,
    language: template.language,
    intro: intro ?? template.intro ?? '',
    signature: signature ?? '',
  };

  const subject = renderLetter(template.subject ?? '', context);

  /*
   * The signature is appended if the template does not place it with a placeholder and it is
   * not already there. The placeholder is the right way, but older templates were written
   * before it existed, and leaving them unsigned would mean silently sending letters that
   * stop mid-sentence.
   */
  const hasToken = /\{\{\s*signature\s*\}\}/i.test(template.body);
  const firstLine = (signature ?? '').split('\n')[0]?.trim() ?? '';
  const needsTail =
    Boolean(signature?.trim()) && !hasToken && (!firstLine || !template.body.includes(firstLine));

  const body = renderLetter(needsTail ? `${template.body}\n\n{{signature}}` : template.body, context);

  const missing = [...new Set([...subject.missing, ...body.missing])];
  const unknown = [...new Set([...subject.unknown, ...body.unknown])];

  /*
   * Checks go from coarsest to finest. A letter reading "Hi ," must not exist even as a
   * draft, so an empty placeholder is an error, not a warning: otherwise it survives until
   * sending, because a blank in the text is easy to miss at a glance.
   */
  const unfilled = body.text.match(UNFILLED_MARKER) ?? [];

  let error: string | null = null;
  if (!template.body.trim()) error = 'the template is empty, the owner writes the letter text';
  else if (unfilled.length > 0) error = `the template still has markers: ${unfilled.join(' ')}`;
  else if (!candidate.contact?.email) error = 'no address to write to';
  else if (missing.length > 0) error = `empty placeholders: ${missing.join(', ')}`;
  else if (unknown.length > 0) error = `unknown placeholders: ${unknown.join(', ')}`;
  else if (!subject.text.trim()) error = 'empty letter subject';

  return {
    templateId: template.id,
    templateSlug: template.slug,
    targetType: (template.targetType as OutreachTarget) ?? 'studio_generic',
    language,
    subject: subject.text,
    body: body.text,
    contactName: candidate.contact?.name ?? null,
    contactEmail: candidate.contact?.email ?? null,
    error,
  };
}

/**
 * Starter sending templates: four cases in two languages.
 *
 * There is no letter text here on purpose. The tool gives a skeleton: greeting, signature,
 * placeholders and spots in square brackets, and the owner writes the words. The reason is
 * section 11 of CLAUDE.md, and the fact that the second paragraph of a cold letter is facts
 * about a person: generated, it would mean made-up experience in a letter to a stranger.
 *
 * The Ukrainian seeds keep Ukrainian greetings, subjects and bracket notes: that is the
 * letter language, not interface copy.
 */
export const SIGNATURE_KEY = 'outreach.signature';

/**
 * Default signature: empty on purpose.
 *
 * It used to carry the author's own name, title and site. In a fork that meant
 * a stranger installs the radar, writes a letter and sends it signed by someone
 * else, silently, because nothing in the flow asks about it. Empty is the only
 * safe default: the letter is signed by whoever fills it in on the Templates page.
 */
export const DEFAULT_SIGNATURE = '';

const SIGNATURE = DEFAULT_SIGNATURE;

export async function readSignature(): Promise<string> {
  return (await readSetting<string>(SIGNATURE_KEY, DEFAULT_SIGNATURE)) || '';
}

export async function saveSignature(value: string): Promise<string> {
  await writeSetting(SIGNATURE_KEY, value);
  return value;
}

interface OutreachSeed {
  slug: string;
  name: string;
  targetType: OutreachTarget;
  language: Language;
  subject: string;
  greeting: string;
  hint: string;
}

const OUTREACH_SEEDS: OutreachSeed[] = [
  {
    slug: 'send_vacancy_uk',
    name: 'Vacancy, Ukrainian',
    targetType: 'vacancy',
    language: 'uk',
    subject: '{{vacancy_title}}, {{company}}',
    greeting: 'Вітаю.',
    hint: 'вакансія {{vacancy_title}}, стек {{their_stack}}',
  },
  {
    slug: 'send_vacancy_en',
    name: 'Vacancy, English',
    targetType: 'vacancy',
    language: 'en',
    subject: '{{vacancy_title}} at {{company}}',
    greeting: 'Hello,',
    hint: 'role {{vacancy_title}}, stack {{their_stack}}',
  },
  {
    slug: 'send_studio_named_uk',
    name: 'Studio, named contact, Ukrainian',
    targetType: 'studio_named',
    language: 'uk',
    subject: 'Фронтенд для {{company}}',
    greeting: 'Вітаю, {{first_name}}.',
    hint: 'студія {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_named_en',
    name: 'Studio, named contact, English',
    targetType: 'studio_named',
    language: 'en',
    subject: 'Front-end help for {{company}}',
    greeting: 'Hi {{first_name}},',
    hint: 'studio {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_generic_uk',
    name: 'Studio, shared inbox, Ukrainian',
    targetType: 'studio_generic',
    language: 'uk',
    subject: 'Фронтенд для {{company}}',
    greeting: 'Вітаю.',
    hint: 'студія {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_generic_en',
    name: 'Studio, shared inbox, English',
    targetType: 'studio_generic',
    language: 'en',
    subject: 'Front-end help for {{company}}',
    greeting: 'Hello,',
    hint: 'studio {{company}}, {{domain}}',
  },
  {
    slug: 'send_followup_uk',
    name: 'Follow-up, Ukrainian',
    targetType: 'followup',
    language: 'uk',
    // The subject is empty on purpose: a follow-up goes in the same thread under the original subject.
    subject: '',
    greeting: 'Вітаю ще раз.',
    hint: 'два речення, не більше',
  },
  {
    slug: 'send_followup_en',
    name: 'Follow-up, English',
    targetType: 'followup',
    language: 'en',
    subject: '',
    greeting: 'Hello again,',
    hint: 'two sentences, no more',
  },
];

function seedBody(seed: OutreachSeed): { intro: string; body: string } {
  const first =
    seed.language === 'uk'
      ? `[перший абзац про компанію, 2 речення: ${seed.hint}]`
      : `[first paragraph about the company, 2 sentences: ${seed.hint}]`;
  const second =
    seed.language === 'uk'
      ? '[другий абзац: ваш досвід і стек. Пишеться один раз і далі не міняється]'
      : '[second paragraph: your experience and stack. Written once, then left alone]';
  const third =
    seed.language === 'uk'
      ? '[третій абзац: одне посилання і одне питання]'
      : '[third paragraph: one link and one question]';

  /*
   * The first paragraph sits in the body as a placeholder, not as text. That paragraph and
   * only that one is what the model rewrites, so a single value gets substituted rather than
   * a piece of a string found by matching.
   */
  const parts =
    seed.targetType === 'followup'
      ? [seed.greeting, '{{intro}}']
      : [seed.greeting, '{{intro}}', second, third];

  return { intro: first, body: `${parts.join('\n\n')}\n\n${SIGNATURE}\n` };
}

/**
 * Adds the missing sending templates by key.
 *
 * Unlike `seedTemplates`, this is "whichever are missing" rather than "when the table is
 * empty": the owner already has hand-made letter templates, and the sending set has to sit
 * next to them. A deleted template will come back, and that is a deliberate trade-off:
 * without at least one template per case, drafts simply are not created.
 */
export async function seedOutreachTemplates(): Promise<number> {
  const db = getDb();
  const existing = await db.select({ slug: templates.slug }).from(templates);
  const known = new Set(existing.map((row) => row.slug));
  const missing = OUTREACH_SEEDS.filter((seed) => !known.has(seed.slug));
  if (missing.length === 0) return 0;

  // Sliced for D1's hundred parameter limit: eight seeds of a dozen columns sat right at it.
  for (const slice of chunk(missing, rowsPerQuery(12))) {
    await db.insert(templates).values(
      slice.map((seed) => ({
        slug: seed.slug,
        name: seed.name,
        kind: seed.targetType === 'vacancy' ? 'vacancy' : 'studio',
        targetType: seed.targetType,
        language: seed.language,
        subject: seed.subject,
        ...seedBody(seed),
        note: 'Starter skeleton. Replace the text in square brackets with your own.',
      })),
    );
  }

  log.info({ added: missing.length }, 'sending templates added');
  return missing.length;
}

/** Active sending templates, grouped by case and language. */
export async function outreachTemplates(): Promise<Template[]> {
  const db = getDb();
  return db
    .select()
    .from(templates)
    .where(and(eq(templates.archived, false), sql`${templates.targetType} is not null`));
}

export function matchTemplate(
  list: Template[],
  target: OutreachTarget,
  language: Language,
): Template | null {
  const byTarget = list.filter((row) => row.targetType === target);
  return byTarget.find((row) => row.language === language) ?? null;
}

/**
 * Letter candidates: a company not yet written to and not rejected.
 *
 * The best open vacancy above the threshold is taken. If there is none, that is no reason to
 * skip the company: studios get letters without a vacancy too, which is what the separate
 * templates are for.
 */
export async function draftCandidates(limit = 20): Promise<DraftCandidate[]> {
  const db = getDb();
  const threshold = rules().threshold;
  const since = Date.now() - RECONTACT_DAYS * 86_400_000;

  const rows = await db
    .select({ company: companies, state: companyState })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      and(
        or(
          isNull(companyState.status),
          and(
            notInArray(companyState.status, BLOCKED_STATUSES),
            or(
              isNull(companyState.snoozedUntil),
              sql`${companyState.snoozedUntil} < ${Date.now()}`,
            ),
          ),
        ),
        // Neither a recent letter nor a draft already waiting for a press.
        sql`not exists (
          select 1 from ${outreach}
          where ${outreach.companyId} = ${companies.id}
            and (${outreach.status} = 'draft' or coalesce(${outreach.sentAt}, 0) > ${since})
        )`,
        /*
         * A company without any address is filtered out here rather than marked on a draft.
         * There is nowhere to send such a letter, and a hundred unreadable stubs in the "Need
         * attention" tab hide the few that really need finishing.
         */
        sql`exists (
          select 1 from ${contacts}
          where ${contacts.companyId} = ${companies.id} and ${contacts.email} is not null
        )`,
      ),
    )
    // A company with an open vacancy above the threshold beats a cold studio.
    .orderBy(
      sql`exists (
        select 1 from ${vacancies}
        where ${vacancies.companyId} = ${companies.id}
          and ${vacancies.closedAt} is null
          and coalesce(${vacancies.score}, -100) >= ${threshold}
      ) desc`,
    )
    .limit(limit);

  const result: DraftCandidate[] = [];
  for (const { company } of rows) {
    const [vacancy] = await db
      .select()
      .from(vacancies)
      .where(
        and(
          eq(vacancies.companyId, company.id),
          isNull(vacancies.closedAt),
          // null means classification has not happened yet: such a vacancy is still a candidate.
          sql`coalesce(${vacancies.isVacancy}, 1) = 1`,
          sql`coalesce(${vacancies.score}, -100) >= ${threshold}`,
        ),
      )
      .orderBy(desc(vacancies.score))
      .limit(1);

    const list = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

    result.push({
      companyId: company.id,
      company: company.name,
      domain: company.domain,
      country: company.country,
      city: company.city,
      kind: company.kind,
      sizeHint: company.sizeHint,
      techHints: company.techHints,
      tags: company.tags,
      description: company.description,
      vacancyId: vacancy?.id ?? null,
      vacancyTitle: vacancy?.title ?? null,
      vacancyStack: vacancy?.stack ?? [],
      contact: pickContact(list),
    });
  }

  return result;
}

export interface PrepareReport {
  candidates: number;
  created: number;
  needsAttention: number;
  skipped: { company: string; reason: string }[];
  drafts: PreparedDraft[];
}

/**
 * Prepares drafts and stores them in `outreach` with `status = draft`.
 *
 * `dryRun` is not for tests but for real use: before the first run the owner wants to see
 * what exactly will go to people, without getting a hundred rows in the database if the
 * template turned out wrong.
 */
export async function prepareDrafts(
  options: { limit?: number; dryRun?: boolean; ai?: boolean; enrichLimit?: number } = {},
): Promise<PrepareReport> {
  const db = getDb();
  const limit = options.limit ?? 20;
  const list = await outreachTemplates();
  const candidates = await draftCandidates(limit);

  /*
   * How many sites this pass may crawl. The crawl happens before the letter is built, not
   * after: a draft without an address used to land in the queue marked "no address to write
   * to", and the owner saw a letter that would go nowhere until they ran contact collection
   * separately. Now the order is reversed, and the budget keeps the pass from hitting the
   * worker time limit on hundreds of companies.
   */
  let enrichBudget = options.dryRun ? 0 : (options.enrichLimit ?? 5);

  // One read for the whole pass: the signature is the same in every letter of this batch.
  const signature = await readSignature();

  const report: PrepareReport = {
    candidates: candidates.length,
    created: 0,
    needsAttention: 0,
    skipped: [],
    drafts: [],
  };

  for (let candidate of candidates) {
    /*
     * No address means the company site has not been crawled yet, not that there is nowhere
     * to write. One site is a few pages, so going there now is cheaper than queueing a
     * broken draft.
     */
    let walked = false;
    if (!candidate.contact?.email && enrichBudget > 0) {
      enrichBudget -= 1;
      walked = true;
      try {
        await enrich({ domain: candidate.domain, limit: 1 });
        const [refreshed] = await draftCandidatesFor([candidate.companyId]);
        if (refreshed) candidate = { ...refreshed, vacancyId: candidate.vacancyId, vacancyTitle: candidate.vacancyTitle, vacancyStack: candidate.vacancyStack };
      } catch (error) {
        log.warn({ domain: candidate.domain, err: String(error) }, 'crawling the site before the letter failed');
      }
    }

    /*
     * Without an address no draft is created at all. It used to land in the queue with an
     * error, and the queue filled up with letters that would go nowhere.
     */
    if (!candidate.contact?.email) {
      report.skipped.push({
        company: candidate.company,
        reason: walked
          ? 'crawled the site, no address on it'
          : 'no address, and a site crawl does not fit into this pass',
      });
      continue;
    }

    const language = pickLanguage(candidate.country);
    const target = pickTargetType({
      hasVacancy: candidate.vacancyId !== null,
      contactName: candidate.contact?.name,
      contactEmail: candidate.contact?.email,
    });

    const template = matchTemplate(list, target, language);
    if (!template) {
      report.skipped.push({
        company: candidate.company,
        reason: `no ${target} template in ${language}`,
      });
      continue;
    }

    /*
     * The model paragraph is fetched before the letter is built, and exactly once per company.
     * A fallback blocks nothing: the template holds a static first paragraph, and the letter
     * goes out with it.
     */
    const ai = options.ai
      ? await generateParagraph(candidate, language, { letter: template.body, subject: template.subject })
      : { paragraph: null, used: false, reason: null, confidence: null };

    const built = buildDraft(candidate, template, language, ai.paragraph, signature);
    const draft: PreparedDraft = {
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      ...built,
    };
    report.drafts.push(draft);
    if (draft.error) report.needsAttention += 1;

    if (options.dryRun) continue;

    await db.insert(outreach).values({
      companyId: draft.companyId,
      vacancyId: draft.vacancyId,
      contactId: draft.contactId,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: Date.now(),
      templateId: draft.templateId,
      templateUsed: draft.templateSlug,
      language: draft.language,
      subjectFinal: draft.subject,
      bodyFinal: draft.body,
      contactName: draft.contactName,
      contactEmail: draft.contactEmail,
      aiUsed: draft.aiUsed,
      aiParagraph: draft.aiParagraph,
      aiFallbackReason: draft.aiFallbackReason,
      error: draft.error,
    });
    report.created += 1;
  }

  log.info(
    { candidates: report.candidates, created: report.created, attention: report.needsAttention },
    'drafts prepared',
  );
  return report;
}

export interface DraftRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  vacancyTitle: string | null;
  contactName: string | null;
  contactEmail: string | null;
  templateUsed: string | null;
  language: string | null;
  subject: string | null;
  body: string | null;
  aiUsed: boolean;
  aiFallbackReason: string | null;
  error: string | null;
  queuedAt: number | null;
  /**
   * Every address the radar found for this company.
   *
   * They travel with the draft on purpose: without them the only way to set another address
   * was to type it in, recalling what is already in the database. Dead addresses are here
   * too, but marked: the list has to explain why that one will not do rather than hide it.
   */
  companyContacts: { name: string | null; role: string | null; email: string; emailValid: boolean }[];
}

/** Drafts for the Outbox page. Ready and problematic together, the UI splits them. */
export async function listDrafts(): Promise<DraftRow[]> {
  const db = getDb();
  const rows = await db
    .select({ row: outreach, company: companies.name, domain: companies.domain, title: vacancies.title })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .leftJoin(vacancies, eq(vacancies.id, outreach.vacancyId))
    .where(inArray(outreach.status, ['draft', 'approved']))
    .orderBy(desc(outreach.queuedAt));

  /*
   * Contacts come in one query for all drafts rather than one per card: there are dozens of
   * cards on the screen, and a query each would turn opening the page into a queue of fifty
   * database calls.
   */
  const companyIds = [...new Set(rows.map(({ row }) => row.companyId))];
  // In slices: D1 takes at most a hundred bound parameters, and a long Outbox exceeded it.
  const people: (typeof contacts.$inferSelect)[] = [];
  for (const slice of chunk(companyIds, 90)) {
    people.push(...(await db.select().from(contacts).where(inArray(contacts.companyId, slice))));
  }

  const byCompany = new Map<number, DraftRow['companyContacts']>();
  for (const person of people) {
    if (!person.email) continue;
    const list = byCompany.get(person.companyId) ?? [];
    list.push({
      name: person.name,
      role: person.role,
      email: person.email,
      emailValid: person.emailValid,
    });
    byCompany.set(person.companyId, list);
  }

  // Named addresses first: a letter to hello@ is read by a manager, section 9 of CLAUDE.md.
  for (const list of byCompany.values()) {
    list.sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)));
  }

  return rows.map(({ row, company, domain, title }) => ({
    id: row.id,
    companyId: row.companyId,
    companyContacts: byCompany.get(row.companyId) ?? [],
    company,
    domain,
    vacancyTitle: title,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    templateUsed: row.templateUsed,
    language: row.language,
    subject: row.subjectFinal,
    body: row.bodyFinal,
    aiUsed: row.aiUsed,
    aiFallbackReason: row.aiFallbackReason,
    error: row.error,
    queuedAt: row.queuedAt,
  }));
}

/** A human edit of the text. Whatever is saved here goes into the mail unchanged. */
export async function updateDraft(
  id: number,
  patch: { subject?: string; body?: string; contactEmail?: string | null; contactName?: string | null },
): Promise<DraftRow | null> {
  const db = getDb();
  const [existing] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!existing) throw new Error(`no draft ${id}`);
  if (existing.status !== 'draft') throw new Error('only a draft can be edited');

  let subject = patch.subject ?? existing.subjectFinal ?? '';
  let body = patch.body ?? existing.bodyFinal ?? '';

  /*
   * An address can be typed right into the draft, and it does not stay inside the letter:
   * the same contact is added to the company. Otherwise an address spotted on their site would
   * have to be entered a second time on the studio page, and next time the radar would again
   * think there is no address.
   */
  const email = patch.contactEmail === undefined ? existing.contactEmail : normalizeEmail(patch.contactEmail);
  const name = patch.contactName === undefined ? existing.contactName : patch.contactName?.trim() || null;

  if (email && email !== existing.contactEmail) {
    await rememberContact(existing.companyId, email, name);
  }

  /*
   * Changing the address changes the person, and the name is already baked into the text.
   *
   * A letter is built once, and `{{first_name}}` in it has long since become a specific
   * "Hi Anna". Moving the draft to another address and leaving the text as is means greeting
   * Anna in a letter to Ihor, silently: the text looks fine, there is no error, the letter
   * goes. So the name changes together with the address, and it is a word for word swap,
   * not a model rewriting the letter.
   */
  const wasCalled = firstName(existing.contactName);
  const nowCalled = firstName(name);

  let renamed: string | null = null;
  if (wasCalled && wasCalled !== nowCalled) {
    const pattern = `\\b${escapeForRegExp(wasCalled)}\\b`;

    if (nowCalled) {
      subject = subject.replace(new RegExp(pattern, 'g'), nowCalled);
      body = body.replace(new RegExp(pattern, 'g'), nowCalled);
    } else if (new RegExp(pattern).test(`${subject}\n${body}`)) {
      /*
       * There is no new name, and the old one is still in the text. It cannot be left there
       * silently, and there is nothing to build a greeting from, so the draft honestly becomes
       * problematic: the owner either types the name or rebuilds the letter with another template.
       */
      renamed = `the text still has the name ${wasCalled}, but the address changed`;
    }
  }

  /*
   * After a manual edit the error is recomputed: the owner may have typed the name in, and
   * then the draft is ready. Keeping the old flag would leave a ready letter in the "Need
   * attention" tab forever.
   */
  const leftover = [...`${subject}\n${body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]);
  let error: string | null = null;
  if (!body.trim()) error = 'empty letter body';
  else if (!subject.trim()) error = 'empty letter subject';
  else if (leftover.length > 0) error = `unfilled placeholders: ${leftover.join(', ')}`;
  else if (!email) error = 'no address to write to';
  else if (renamed) error = renamed;

  await db
    .update(outreach)
    .set({ subjectFinal: subject, bodyFinal: body, contactEmail: email, contactName: name, error })
    .where(eq(outreach.id, id));

  const list = await listDrafts();
  return list.find((row) => row.id === id) ?? null;
}

/**
 * Regenerate the first paragraph of an existing draft. Only on an explicit button: there are
 * no background regenerations, because each is a paid model call with no way to tell whether
 * the new text is better than the old.
 */
export async function regenerateIntro(id: number): Promise<DraftRow | null> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) throw new Error(`no draft ${id}`);
  if (draft.status !== 'draft') throw new Error('only a draft can be regenerated');
  if (!draft.templateId) throw new Error('the draft does not remember its template');

  const [template] = await db.select().from(templates).where(eq(templates.id, draft.templateId));
  if (!template) throw new Error('the template was deleted, the draft has to be rebuilt');

  const [candidate] = (await draftCandidatesFor([draft.companyId])) ?? [];
  if (!candidate) throw new Error('company not found');

  const language = (draft.language as Language) ?? pickLanguage(candidate.country);
  const ai = await generateParagraph(candidate, language, {
    letter: template.body,
    subject: template.subject,
  });
  const built = buildDraft(
    { ...candidate, vacancyId: draft.vacancyId },
    template,
    language,
    ai.paragraph,
    await readSignature(),
  );

  await db
    .update(outreach)
    .set({
      subjectFinal: built.subject,
      bodyFinal: built.body,
      error: built.error,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
    })
    .where(eq(outreach.id, id));

  const list = await listDrafts();
  return list.find((row) => row.id === id) ?? null;
}

/**
 * A different template for an existing draft.
 *
 * Code picks the sending template by role and language, and that is the right default. But a
 * person sees the specific company and knows things the database does not, so they must be
 * able to move the letter onto another text without rebuilding the draft or losing the
 * first paragraph already written.
 *
 * No model calls here: the paragraph, if it came from the model, carries over as is.
 */
export async function retemplateDraft(id: number, slug: string): Promise<DraftRow | null> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) throw new Error(`no draft ${id}`);
  if (draft.status !== 'draft') throw new Error('the template can only be changed on a draft');

  const [template] = await db.select().from(templates).where(eq(templates.slug, slug));
  if (!template) throw new Error(`no template ${slug}`);

  const [candidate] = await draftCandidatesFor([draft.companyId]);
  if (!candidate) throw new Error('company not found');

  const language = (template.language as Language) ?? (draft.language as Language);
  const built = buildDraft(
    { ...candidate, vacancyId: draft.vacancyId },
    template,
    language,
    draft.aiParagraph,
    await readSignature(),
  );

  await db
    .update(outreach)
    .set({
      templateId: template.id,
      templateUsed: template.slug,
      language,
      subjectFinal: built.subject,
      bodyFinal: built.body,
      error: built.error,
    })
    .where(eq(outreach.id, id));

  const list = await listDrafts();
  return list.find((row) => row.id === id) ?? null;
}

/** The same candidate data, but for known companies: regeneration needs it. */
export async function draftCandidatesFor(companyIds: number[]): Promise<DraftCandidate[]> {
  const db = getDb();
  const result: DraftCandidate[] = [];

  for (const companyId of companyIds) {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) continue;

    const [vacancy] = await db
      .select()
      .from(vacancies)
      .where(and(eq(vacancies.companyId, company.id), isNull(vacancies.closedAt)))
      .orderBy(desc(vacancies.score))
      .limit(1);

    const list = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

    result.push({
      companyId: company.id,
      company: company.name,
      domain: company.domain,
      country: company.country,
      city: company.city,
      kind: company.kind,
      sizeHint: company.sizeHint,
      techHints: company.techHints,
      tags: company.tags,
      description: company.description,
      vacancyId: vacancy?.id ?? null,
      vacancyTitle: vacancy?.title ?? null,
      vacancyStack: vacancy?.stack ?? [],
      contact: pickContact(list),
    });
  }

  return result;
}

/**
 * A draft for a specific company, from the button on Queue or Studios.
 *
 * This is the same path as the nightly preparation: the same templates, the same choice of
 * language and contact, the same checks. Separate "quick letter" logic would be a second set
 * of rules that drifts away from the first over time.
 */
export async function draftForCompany(
  companyId: number,
  vacancyId?: number | null,
  options: { ai?: boolean; enrich?: boolean; templateSlug?: string | null } = {},
): Promise<{ draft: PreparedDraft | null; id: number | null; reason: string | null }> {
  const db = getDb();

  const [existing] = await db
    .select({ id: outreach.id })
    .from(outreach)
    .where(and(eq(outreach.companyId, companyId), eq(outreach.status, 'draft')));
  if (existing) {
    return { draft: null, id: existing.id, reason: 'a draft for this company is already queued' };
  }

  let [candidate] = await draftCandidatesFor([companyId]);
  if (!candidate) return { draft: null, id: null, reason: 'company not found' };

  /*
   * No address is not a refusal yet: the company site simply has not been crawled. Instead of
   * sending the person off to run enrichment by hand and come back, we go to the site right
   * now. One company is a few pages, not minutes.
   *
   * A named contact may not turn up, and that is fine: a generic mailbox from the site is an
   * address too, with its own template. We will not invent hello@domain: either it is on the
   * site, or there is no letter.
   */
  let enriched = false;
  if (!candidate.contact?.email && options.enrich !== false) {
    await enrich({ domain: candidate.domain, limit: 1 });
    enriched = true;
    [candidate] = await draftCandidatesFor([companyId]);
    if (!candidate) return { draft: null, id: null, reason: 'company not found' };
  }

  /*
   * Still no address even after crawling the site. The draft is created anyway, with an empty
   * address field: the letter is built, the text is visible, and what remains is typing the
   * email on the Outbox page. This used to be a refusal, and the company simply dropped out
   * of sight, although finding the address on their site by eye often takes a minute.
   *
   * This does not open sending: `checkSend` without an address keeps the button disabled.
   */
  const missingEmail = !candidate.contact?.email;

  if (vacancyId) {
    const [vacancy] = await db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
    if (vacancy) {
      candidate.vacancyId = vacancy.id;
      candidate.vacancyTitle = vacancy.title;
      candidate.vacancyStack = vacancy.stack;
    }
  }

  const language = pickLanguage(candidate.country);
  const target = pickTargetType({
    hasVacancy: candidate.vacancyId !== null,
    contactName: candidate.contact?.name,
    contactEmail: candidate.contact?.email,
  });

  /*
   * A template picked by hand on the card beats choosing by role and language. That choice
   * used to go nowhere: the owner set a template in the select, pressed "To outbox" and got a
   * draft with a completely different text, because the code picked its own. Automatic
   * choice stays what it was: the default.
   */
  const chosen = options.templateSlug
    ? (await db.select().from(templates).where(eq(templates.slug, options.templateSlug)))[0]
    : undefined;

  if (options.templateSlug && !chosen) {
    return { draft: null, id: null, reason: `no template ${options.templateSlug}` };
  }

  const template = chosen ?? matchTemplate(await outreachTemplates(), target, language);
  if (!template) {
    return { draft: null, id: null, reason: `no ${target} template in ${language}` };
  }

  // The language follows the template: the person picked a text, and it is written in one specific language.
  const letterLanguage = chosen ? ((chosen.language as Language) ?? language) : language;

  const ai = options.ai
    ? await generateParagraph(candidate, letterLanguage, {
        letter: template.body,
        subject: template.subject,
      })
    : { paragraph: null, used: false, reason: null, confidence: null };

  const built = buildDraft(candidate, template, letterLanguage, ai.paragraph, await readSignature());
  const [row] = await db
    .insert(outreach)
    .values({
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: Date.now(),
      templateId: built.templateId,
      templateUsed: built.templateSlug,
      language: built.language,
      subjectFinal: built.subject,
      bodyFinal: built.body,
      contactName: built.contactName,
      contactEmail: built.contactEmail,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      error: built.error,
    })
    .returning({ id: outreach.id });

  return {
    draft: {
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      ...built,
    },
    id: row!.id,
    reason: missingEmail
      ? enriched
        ? 'crawled the site, found no address. The draft is queued, type the email by hand'
        : 'no address. The draft is queued, type the email by hand'
      : null,
  };
}

/** Addresses are normalised, otherwise the same email gets added twice. */
/** The first word of the name: that is what the letter shows as `{{first_name}}`. */
function firstName(value: string | null | undefined): string | null {
  return (value ?? '').trim().split(/\s+/)[0] || null;
}

/** The name goes into a regex, and names contain dots and hyphens. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/**
 * Remember an address for a company. No duplicate is created, and a dead address comes back
 * to life: if the owner typed it in by hand, they checked it.
 */
export async function rememberContact(
  companyId: number,
  email: string,
  name: string | null = null,
  role: string | null = null,
): Promise<{ created: boolean }> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), eq(contacts.email, email)));

  if (existing) {
    await db
      .update(contacts)
      .set({ emailValid: true, name: existing.name ?? name, role: existing.role ?? role })
      .where(eq(contacts.id, existing.id));
    return { created: false };
  }

  await db.insert(contacts).values({ companyId, email, name, role, emailValid: true });
  return { created: true };
}

/** Skip a company: the draft is erased, history is left alone. */
export async function discardDraft(id: number): Promise<{ deleted: boolean }> {
  const db = getDb();
  const [existing] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!existing) return { deleted: false };
  if (existing.status !== 'draft') throw new Error('only a draft can be deleted');
  await db.delete(outreach).where(eq(outreach.id, id));
  return { deleted: true };
}
