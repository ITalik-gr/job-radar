import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, llmCache, outreach, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';
import { listFacts } from './facts.js';
import { hash } from './normalize.js';
import {
  matchTemplate,
  outreachTemplates,
  pickContact,
  pickLanguage,
  pickTargetType,
  type Language,
  type OutreachTarget,
} from './outreach.js';
import { scoreCompany } from './company-score.js';

/**
 * The company verdict: which template to approach it with and what to hook onto.
 *
 * This is an adviser, not part of sending. Template choice in `outreach.ts` stays deterministic,
 * and that is what decides what goes into a draft: a model gives different answers on the same
 * data, and "why did this studio get this text" would then have no answer. Here the task and the
 * cost of a mistake are different: the owner looks at the card, presses a button and reads an
 * opinion about a specific company with the deterministic choice next to it. A disagreement
 * between them is a signal to think, not an error, and a person decides either way.
 *
 * No letter text is generated here, section 11 of CLAUDE.md. The model sees the templates in
 * order to choose among them, and returns a key, not text.
 */

/** v2 moved the prompt to English and asks for English prose in the answer. */
export const VERDICT_PROMPT_VERSION = 'verdict-v2';

export const verdictSchema = z.object({
  /** Key of the chosen template. null means none fits. */
  template_slug: z.string().nullable(),
  alternative_slug: z.string().nullable().default(null),
  language: z.enum(['uk', 'en']),
  confidence: z.number().min(0).max(100),
  /** What to hook onto in the letter, one sentence. Material for the owner, not letter text. */
  angle: z.string(),
  why: z.string(),
  risks: z.array(z.string()).default([]),
  /** Which contact to write to. A name from the list, or null. */
  contact: z.string().nullable().default(null),
  skip: z.boolean().default(false),
  skip_reason: z.string().nullable().default(null),
});

export type Verdict = z.infer<typeof verdictSchema>;

export interface VerdictReport {
  companyId: number;
  domain: string;
  /** cache | llm | budget | invalid. An empty verdict always has a reason. */
  source: 'cache' | 'llm' | 'budget' | 'invalid';
  verdict: Verdict | null;
  /**
   * What sending would pick without the model. Shown alongside on purpose: without this pair
   * there is no telling whether the model saw something or just repeated the obvious.
   */
  fallbackSlug: string | null;
  fallbackTarget: OutreachTarget;
  language: Language;
  error: string | null;
}

/** The company as the model sees it. Only what the database already holds. */
interface CompanyBlock {
  name: string;
  domain: string;
  kind: string;
  country: string | null;
  city: string | null;
  size: string | null;
  founded_year: number | null;
  rating: number | null;
  reviews_count: number | null;
  min_project: string | null;
  hourly_rate: string | null;
  tech_hints: string[];
  /** Signs of life: the copyright year and the date of the latest post. */
  copyright_year: number | null;
  last_post_at: string | null;
  careers_url: string | null;
  careers_kind: string;
  description: string | null;
  catalogs: string[];
  status: string;
  score: number;
  score_reasons: string[];
  contacts: { name: string | null; role: string | null; email: string | null }[];
  open_vacancies: { title: string; stack: string[]; seniority: string | null; remote: boolean | null }[];
  previous_outreach: { sent_at: string; template: string | null; reply: string | null }[];
}

/**
 * A template description for the model. The body is truncated: the choice is about tone and
 * purpose, and tone shows in the first lines. Whole letters in the prompt just make a pricier request.
 */
const TEMPLATE_BODY_CHARS = 600;

interface TemplateBlock {
  slug: string;
  name: string;
  kind: string;
  for_kind: string | null;
  language: string;
  target_type: string | null;
  note: string | null;
  body: string;
}

export async function collectCompany(companyId: number): Promise<CompanyBlock> {
  const db = getDb();

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`no company ${companyId}`);

  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, companyId));
  const people = await db.select().from(contacts).where(eq(contacts.companyId, companyId));

  const open = await db
    .select()
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNull(vacancies.closedAt)))
    .orderBy(desc(vacancies.score))
    .limit(5);

  const history = await db
    .select()
    .from(outreach)
    .where(eq(outreach.companyId, companyId))
    .orderBy(desc(outreach.sentAt))
    .limit(3);

  const breakdown = scoreCompany({
    company,
    openVacancies: open.length,
    status: state?.status ?? null,
  });

  const day = (value: number | null) => (value ? new Date(value).toISOString().slice(0, 10) : null);

  return {
    name: company.name,
    domain: company.domain,
    kind: company.kind,
    country: company.country,
    city: company.city,
    size: company.sizeHint,
    founded_year: company.foundedYear,
    rating: company.rating,
    reviews_count: company.reviewsCount,
    min_project: company.minProject,
    hourly_rate: company.hourlyRate,
    tech_hints: company.techHints,
    copyright_year: company.copyrightYear,
    last_post_at: day(company.lastPostAt),
    careers_url: company.careersUrl,
    careers_kind: company.careersKind,
    description: company.description ? company.description.slice(0, 600) : null,
    catalogs: company.sources,
    status: state?.status ?? 'new',
    score: breakdown.score,
    score_reasons: [...breakdown.positives, ...breakdown.negatives].map(
      (item) => `${item.weight > 0 ? '+' : ''}${item.weight} ${item.reason}`,
    ),
    contacts: people
      .slice(0, 8)
      .map((row) => ({ name: row.name, role: row.role, email: row.email })),
    open_vacancies: open.map((row) => ({
      title: row.title ?? 'untitled',
      stack: row.stack,
      seniority: row.seniority,
      remote: row.remote,
    })),
    previous_outreach: history.map((row) => ({
      sent_at: day(row.sentAt) ?? 'unknown',
      template: row.templateUsed,
      reply: row.replyType,
    })),
  };
}

/**
 * The system block: rules, templates and the allowed facts about the owner.
 *
 * It is stable across companies, which is exactly why the templates live here rather than in the
 * user part: when going through studios in a row Anthropic serves it from cache at a tenth of the
 * price. The order is deliberate too: the cache is a byte-for-byte match of the request start, so
 * everything that varies must come after this block.
 */
export function buildSystem(list: TemplateBlock[], ownerFacts: string[]): string {
  return [
    'You advise a developer on which cold letter template to use for a specific company.',
    'Reply STRICTLY with a single JSON object, no preamble and no markdown fence.',
    '',
    'Rules:',
    '1. Choose ONLY among the templates below and return their `slug` verbatim. Do not invent keys.',
    '2. Do NOT write letter text. Your job is choosing a template and one sentence about the hook.',
    '3. Rely only on the COMPANY block. What is not there does not exist: do not assume',
    '   projects, clients, news or technologies.',
    '4. `angle` is the reason to write to this particular company: their stack, type of work, market,',
    '   an open vacancy. No compliments and no judgement of their work.',
    '5. `language`: uk for companies in Ukraine, en for everyone else.',
    '6. `contact` is a name from the company contact list, or null. A named person beats',
    '   a generic mailbox, a technical role beats a managerial one.',
    '7. `risks` are what may make the letter fail: a dead site, a foreign stack,',
    '   a recent contact without a reply. An empty array if no risks are visible.',
    '8. `skip` is true if writing is not worth it at all. Then `skip_reason` explains why.',
    '9. `confidence` is an integer from 0 to 100: how sure you are about the choice.',
    '10. Write `angle`, `why`, `risks` and `skip_reason` in English.',
    '',
    ...(ownerFacts.length > 0
      ? ['About the sender you may take into account only this:', ...ownerFacts.map((item) => `- ${item}`), '']
      : []),
    'Templates:',
    JSON.stringify(list, null, 1),
    '',
    'Response format:',
    '{"template_slug":"...","alternative_slug":null,"language":"en","confidence":0,',
    '"angle":"...","why":"...","risks":[],"contact":null,"skip":false,"skip_reason":null}',
  ].join('\n');
}

async function templateBlocks(): Promise<TemplateBlock[]> {
  const rows = await outreachTemplates();

  /*
   * The order is fixed by key rather than by how the database returned them. The prompt cache is
   * a byte-for-byte match, and swapping two templates would silently cost a full request instead
   * of a cached one.
   */
  return rows
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      for_kind: row.forKind,
      language: row.language,
      target_type: row.targetType,
      note: row.note,
      body: `${row.intro ? `${row.intro}\n` : ''}${row.body}`.slice(0, TEMPLATE_BODY_CHARS),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface VerdictOptions {
  /** Replaces the model call in tests. */
  caller?: (system: string, user: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  skipCache?: boolean;
}

export async function companyVerdict(
  companyId: number,
  options: VerdictOptions = {},
): Promise<VerdictReport> {
  const db = getDb();
  const company = await collectCompany(companyId);
  const list = await templateBlocks();

  /*
   * The deterministic choice is always computed, even when the model answers. It is also the
   * fallback: no path in this function may leave the owner without an answer to "which template
   * to write with".
   */
  const language = pickLanguage(company.country);
  const people = await db.select().from(contacts).where(eq(contacts.companyId, companyId));
  const contact = pickContact(people);
  const fallbackTarget = pickTargetType({
    hasVacancy: company.open_vacancies.length > 0,
    contactName: contact?.name,
    contactEmail: contact?.email,
  });
  const rows = await outreachTemplates();
  const fallbackSlug = matchTemplate(rows, fallbackTarget, language)?.slug ?? null;

  const base: VerdictReport = {
    companyId,
    domain: company.domain,
    source: 'invalid',
    verdict: null,
    fallbackSlug,
    fallbackTarget,
    language,
    error: null,
  };

  if (list.length === 0) {
    return { ...base, error: 'there are no sending templates at all: nothing to choose from' };
  }

  const facts = await listFacts();
  const ownerFacts = facts
    .filter((row) => row.isActive)
    .map((row) => (language === 'uk' ? row.textUk : row.textEn))
    .filter(Boolean);

  const system = buildSystem(list, ownerFacts);
  const user = `COMPANY:\n${JSON.stringify(company, null, 1)}`;

  /*
   * The cache key is the model, the prompt version, the templates and the company itself. So
   * pressing the button again costs nothing, while a template edit or a newly found email gives a
   * new verdict by itself, with no "recompute" button.
   */
  const key = hash(`${config.llm.verdictModel}|${VERDICT_PROMPT_VERSION}|${system}|${user}`);

  if (!options.skipCache) {
    const [cached] = await db.select().from(llmCache).where(eq(llmCache.key, key));
    if (cached) {
      const parsed = verdictSchema.safeParse(cached.response);
      if (parsed.success) return { ...base, source: 'cache', verdict: parsed.data };
      await db.delete(llmCache).where(eq(llmCache.key, key));
    }
  }

  if ((await remainingBudget()) <= 0) {
    log.warn({ companyId, limit: config.llm.dailyCallLimit }, 'daily model call limit reached');
    return { ...base, source: 'budget', error: 'daily model call limit reached' };
  }

  const known = new Set(list.map((item) => item.slug));
  const caller =
    options.caller ??
    ((sys: string, text: string) => callModelWith(sys, text, 0, config.llm.verdictModel, true));

  let lastError = '';

  // One retry, as in classification: an invalid answer is no reason to run the model in circles.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: { text: string; inputTokens: number; outputTokens: number };
    try {
      raw = await caller(system, user);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await noteLlmCall(0, 0, true);
      log.warn({ companyId, attempt, err: lastError }, 'verdict model call failed');
      continue;
    }

    await noteLlmCall(raw.inputTokens, raw.outputTokens, false);

    try {
      const parsed = verdictSchema.parse(extractJson(raw.text));

      /*
       * The key is checked by code, not trusted. The model regularly returns a similar but
       * non-existent slug, and a silently accepted verdict would lead to a template that does not
       * exist: at that moment the button looks like it works and does not.
       */
      if (parsed.template_slug && !known.has(parsed.template_slug)) {
        lastError = `the model named a non-existent template ${parsed.template_slug}`;
        log.warn({ companyId, attempt, slug: parsed.template_slug }, lastError);
        continue;
      }
      if (parsed.alternative_slug && !known.has(parsed.alternative_slug)) parsed.alternative_slug = null;

      await db
        .insert(llmCache)
        .values({
          key,
          model: config.llm.verdictModel,
          promptVersion: VERDICT_PROMPT_VERSION,
          response: parsed,
        })
        .onConflictDoNothing();

      log.info(
        { companyId, domain: company.domain, slug: parsed.template_slug, fallbackSlug },
        'company verdict ready',
      );
      return { ...base, source: 'llm', verdict: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn({ companyId, attempt, err: lastError }, 'verdict failed validation');
    }
  }

  /*
   * Rule 3 of CLAUDE.md: an empty result is an error, not a success. The button has to say what
   * exactly went wrong and keep the deterministic choice as a working answer.
   */
  log.warn({ companyId, err: lastError }, 'verdict failed, the deterministic choice stands');
  return { ...base, source: 'invalid', error: lastError || 'the model did not answer' };
}
