import { chunk, rowsPerQuery } from '../lib/chunk.js';
import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  leads,
  siteAudits,
  templates,
  type Company,
  type Contact,
  type Template,
} from '../db/schema.js';
import { renderLetter, type LetterContext } from '../lib/letter.js';
import { log } from '../lib/log.js';
import { readSetting, writeSetting } from '../lib/settings-store.js';
import { marketOf } from './companies.js';
import { enrich } from './enrich.js';

/**
 * Preparing sending drafts. The rules are in section 7 of CLAUDE.md.
 *
 * There is neither sending nor model calls here: a draft is built from a template the owner
 * wrote and from data already in the database. The model never writes letter text. Sending is a separate step, and between it
 * and this file there is always a person with a button.
 *
 * Template choice is deterministic on purpose. A model that picks the tone of a letter gives
 * different results on the same data, and understanding why a particular studio got this
 * particular text becomes impossible.
 */

/**
 * Sending roles. The names are historical: `studio_named` means "a named person", whatever the
 * segment, `studio_generic` means "a shared mailbox". The segment is matched by `for_kind`.
 */
export const OUTREACH_TARGETS = ['studio_named', 'studio_generic', 'followup'] as const;
export type OutreachTarget = (typeof OUTREACH_TARGETS)[number];

export type Language = 'uk' | 'en';

/** Companies in these states are never written to, section 7 of CLAUDE.md. */
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
  return marketOf(country) === 'ua' ? 'uk' : 'en';
}

export interface TargetInput {
  contactName?: string | null;
  contactEmail?: string | null;
}

/** Two cases, two templates. No in-between states and no model in the decision. */
export function pickTargetType(input: TargetInput): OutreachTarget {
  const named = Boolean(input.contactName?.trim()) && !isGenericEmail(input.contactEmail);
  return named ? 'studio_named' : 'studio_generic';
}

/**
 * A named contact is worth more than a generic mailbox, section 5 of CLAUDE.md, so the order
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
  industry: string | null;
  sizeHint: string | null;
  techHints: string[];
  tags: string[];
  description: string | null;
  /** The first issue of the latest site audit. */
  finding: string | null;
  /** The open lead this letter would answer, if any. */
  leadId: number | null;
  leadTitle: string | null;
  contact: Contact | null;
}

export interface PreparedDraft {
  companyId: number;
  leadId: number | null;
  contactId: number | null;
  templateId: number;
  templateSlug: string;
  targetType: OutreachTarget;
  language: Language;
  subject: string;
  body: string;
  contactName: string | null;
  contactEmail: string | null;
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
  /** The shared signature. Empty means letters go out without one. */
  signature?: string | null,
): Omit<PreparedDraft, 'companyId' | 'leadId' | 'contactId'> {
  const context: LetterContext = {
    company: candidate.company,
    domain: candidate.domain,
    contactName: candidate.contact?.name ?? null,
    kind: candidate.kind,
    industry: candidate.industry,
    stack: candidate.techHints,
    finding: candidate.finding,
    leadTitle: candidate.leadTitle,
    city: candidate.city,
    country: candidate.country,
    language: template.language,
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

/** The settings key of the signature shared by all letters. */
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
}

/**
 * Starter skeletons. Greeting, placeholders with fallbacks and spots in square brackets: the
 * owner writes the words. A Ukrainian seed keeps a Ukrainian greeting, that is letter content.
 */
const OUTREACH_SEEDS: OutreachSeed[] = [
  {
    slug: 'send_named_uk',
    name: 'Named contact, Ukrainian',
    targetType: 'studio_named',
    language: 'uk',
    subject: '{{company}}: [тема]',
    greeting: 'Вітаю, {{first_name}}.',
  },
  {
    slug: 'send_named_en',
    name: 'Named contact, English',
    targetType: 'studio_named',
    language: 'en',
    subject: '{{company}}: [subject]',
    greeting: 'Hi {{first_name}},',
  },
  {
    slug: 'send_generic_uk',
    name: 'Shared inbox, Ukrainian',
    targetType: 'studio_generic',
    language: 'uk',
    subject: '{{company}}: [тема]',
    greeting: 'Вітаю.',
  },
  {
    slug: 'send_generic_en',
    name: 'Shared inbox, English',
    targetType: 'studio_generic',
    language: 'en',
    subject: '{{company}}: [subject]',
    greeting: 'Hello,',
  },
  {
    slug: 'send_followup_uk',
    name: 'Follow-up, Ukrainian',
    targetType: 'followup',
    language: 'uk',
    // The subject is empty on purpose: a follow-up goes in the same thread under the original subject.
    subject: '',
    greeting: 'Вітаю ще раз.',
  },
  {
    slug: 'send_followup_en',
    name: 'Follow-up, English',
    targetType: 'followup',
    language: 'en',
    subject: '',
    greeting: 'Hello again,',
  },
];

function seedBody(seed: OutreachSeed): string {
  const uk = seed.language === 'uk';
  const parts =
    seed.targetType === 'followup'
      ? [seed.greeting, uk ? '[два речення, не більше]' : '[two sentences, no more]']
      : [
          seed.greeting,
          uk
            ? '[перший абзац про {{company}}. {{finding|}} можна вставити як привід]'
            : '[first paragraph about {{company}}. {{finding|}} works as the reason to write]',
          uk ? '[другий абзац: що ви робите і для кого]' : '[second paragraph: what you do and for whom]',
          uk ? '[третій абзац: одне посилання і одне питання]' : '[third paragraph: one link and one question]',
        ];
  return `${parts.join('\n\n')}\n\n{{signature}}\n`;
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
        kind: 'studio',
        targetType: seed.targetType,
        language: seed.language,
        subject: seed.subject,
        body: seedBody(seed),
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

/**
 * The template for a role, a language and a segment. A template written for this exact segment
 * (`for_kind`) wins over a universal one: a clinic and a design studio get different letters.
 */
export function matchTemplate(
  list: Template[],
  target: OutreachTarget,
  language: Language,
  kind?: string | null,
): Template | null {
  const fitting = list.filter((row) => row.targetType === target && row.language === language);
  return (
    (kind ? fitting.find((row) => row.forKind === kind) : undefined) ??
    fitting.find((row) => !row.forKind) ??
    null
  );
}

/** Everything a letter needs about one company: the audit finding, the open lead, the contact. */
async function candidateFor(company: Company): Promise<DraftCandidate> {
  const db = getDb();
  const [audit] = await db
    .select({ issues: siteAudits.issues })
    .from(siteAudits)
    .where(eq(siteAudits.companyId, company.id))
    .orderBy(desc(siteAudits.checkedAt))
    .limit(1);
  const [lead] = await db
    .select({ id: leads.id, title: leads.title })
    .from(leads)
    .where(and(eq(leads.companyId, company.id), isNull(leads.closedAt), ne(leads.status, 'skipped')))
    .orderBy(sql`coalesce(${leads.deadlineAt}, 9e15)`)
    .limit(1);
  const list = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

  return {
    companyId: company.id,
    company: company.name,
    domain: company.domain,
    country: company.country,
    city: company.city,
    kind: company.kind,
    industry: company.industry,
    sizeHint: company.sizeHint,
    techHints: company.techHints,
    tags: company.tags,
    description: company.description,
    finding: audit?.issues[0] ?? null,
    leadId: lead?.id ?? null,
    leadTitle: lead?.title ?? null,
    contact: pickContact(list),
  };
}

/**
 * Letter candidates: a company not yet written to, not rejected, with an address. A company
 * with an open lead goes first: it asked for something.
 */
export async function draftCandidates(limit = 20): Promise<DraftCandidate[]> {
  const db = getDb();
  const since = Date.now() - RECONTACT_DAYS * 86_400_000;

  const rows = await db
    .select({ company: companies })
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
    .orderBy(
      sql`exists (
        select 1 from ${leads}
        where ${leads.companyId} = ${companies.id} and ${leads.closedAt} is null
      ) desc`,
    )
    .limit(limit);

  const result: DraftCandidate[] = [];
  for (const { company } of rows) result.push(await candidateFor(company));
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
  options: { limit?: number; dryRun?: boolean; enrichLimit?: number } = {},
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
        if (refreshed) candidate = refreshed;
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
      contactName: candidate.contact?.name,
      contactEmail: candidate.contact?.email,
    });

    const template = matchTemplate(list, target, language, candidate.kind);
    if (!template) {
      report.skipped.push({
        company: candidate.company,
        reason: `no ${target} template in ${language}`,
      });
      continue;
    }

    const built = buildDraft(candidate, template, language, signature);
    const draft: PreparedDraft = {
      companyId: candidate.companyId,
      leadId: candidate.leadId,
      contactId: candidate.contact?.id ?? null,
      ...built,
    };
    report.drafts.push(draft);
    if (draft.error) report.needsAttention += 1;

    if (options.dryRun) continue;

    await db.insert(outreach).values({
      companyId: draft.companyId,
      leadId: draft.leadId,
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
  leadTitle: string | null;
  contactName: string | null;
  contactEmail: string | null;
  templateUsed: string | null;
  language: string | null;
  subject: string | null;
  body: string | null;
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
    .select({ row: outreach, company: companies.name, domain: companies.domain, title: leads.title })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .leftJoin(leads, eq(leads.id, outreach.leadId))
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

  // Named addresses first: a letter to hello@ is read by a manager, section 5 of CLAUDE.md.
  for (const list of byCompany.values()) {
    list.sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)));
  }

  return rows.map(({ row, company, domain, title }) => ({
    id: row.id,
    companyId: row.companyId,
    companyContacts: byCompany.get(row.companyId) ?? [],
    company,
    domain,
    leadTitle: title,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    templateUsed: row.templateUsed,
    language: row.language,
    subject: row.subjectFinal,
    body: row.bodyFinal,
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
 * A different template for an existing draft.
 *
 * Code picks the sending template by role and language, and that is the right default. But a
 * person sees the specific company and knows things the database does not, so they must be
 * able to move the letter onto another text without rebuilding the draft or losing the
 * first paragraph already written.
 *
 * No model calls here.
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
  const built = buildDraft(candidate, template, language, await readSignature());

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

/** The same candidate data, but for known companies: a draft for one company needs it. */
export async function draftCandidatesFor(companyIds: number[]): Promise<DraftCandidate[]> {
  const db = getDb();
  const result: DraftCandidate[] = [];
  for (const companyId of companyIds) {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (company) result.push(await candidateFor(company));
  }
  return result;
}

/**
 * A draft for a specific company, from the button on a lead card.
 *
 * This is the same path as the nightly preparation: the same templates, the same choice of
 * language and contact, the same checks. Separate "quick letter" logic would be a second set
 * of rules that drifts away from the first over time.
 */
export async function draftForCompany(
  companyId: number,
  options: { enrich?: boolean; templateSlug?: string | null } = {},
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

  const language = pickLanguage(candidate.country);
  const target = pickTargetType({
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

  const template = chosen ?? matchTemplate(await outreachTemplates(), target, language, candidate.kind);
  if (!template) {
    return { draft: null, id: null, reason: `no ${target} template in ${language}` };
  }

  // The language follows the template: the person picked a text, and it is written in one specific language.
  const letterLanguage = chosen ? ((chosen.language as Language) ?? language) : language;

  const built = buildDraft(candidate, template, letterLanguage, await readSignature());
  const [row] = await db
    .insert(outreach)
    .values({
      companyId: candidate.companyId,
      leadId: candidate.leadId,
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
      error: built.error,
    })
    .returning({ id: outreach.id });

  return {
    draft: {
      companyId: candidate.companyId,
      leadId: candidate.leadId,
      contactId: candidate.contact?.id ?? null,
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
