import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { getDb } from '../db/client.js';
import { companies, companyState, leads, type Company, type Lead } from '../db/schema.js';
import {
  activeDecisionModel,
  BudgetExhaustedError,
  cachedAnswers,
  decide,
  decisionKey,
  type Answer,
  type Question,
} from '../lib/decide.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import classifyConfig from '../../config/classify.json' with { type: 'json' };

/**
 * Model classification, stage 5 of CLAUDE.md: industry and segment for companies the rules could
 * not place, and fit for tenders. Section 11, "free filters before the model": only companies
 * still missing a field and carrying some text are asked, and an input asked before is skipped
 * by its cache key, so a batch never repeats itself.
 *
 * An answer is applied only when it is decisive, see `isDecisive`. Otherwise the field stays as it
 * was: a guess the model itself doubts is worse than an empty field (rule 6).
 */

const settings = {
  minProbability: classifyConfig.minProbability,
  minMargin: classifyConfig.minMargin,
  kindIndustry: stripComments(classifyConfig.kindIndustry),
  industries: stripComments(classifyConfig.industries),
  kinds: stripComments(classifyConfig.kinds),
  leadFit: classifyConfig.leadFit,
};

function stripComments(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith('_')));
}

/** Parallel calls. Clef answers in a fraction of a second; a few at once keep a batch short. */
const PARALLEL = 4;

/** A company with less than this to read gives the model nothing but a name. */
const MIN_TEXT = 40;

/** The record the model reads. Empty fields are left out, so they do not look like data. */
export function companyRecord(company: Company): Record<string, unknown> {
  const state: Record<string, unknown> = {
    name: company.name,
    site: company.domain || null,
    description: company.description?.slice(0, 800) ?? null,
    catalog_tags: company.tags.slice(0, 20),
    sources: company.sources,
    country: company.country,
    city: company.city,
    size: company.sizeHint,
  };
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0)),
  );
}

/**
 * Both questions every time, even when one field is already known. The cache key covers the
 * questions, so asking only for what is missing changed the key the moment one answer was applied,
 * and the company was asked a second time. Only the missing field is written either way.
 */
export function companyQuestions(): Record<string, Question> {
  return {
    industry: {
      type: 'choice',
      instructions: 'Which industry does this company work in? Judge by what it does, not by who its clients are.',
      criteria: settings.industries,
    },
    kind: {
      type: 'choice',
      instructions: 'What kind of company is this?',
      criteria: settings.kinds,
    },
  };
}

/**
 * Whether a choice is clear enough to write: the picked option is likely and well ahead of the
 * runner-up. Clef's `confidence` is entropy over every option, which punishes long lists: an
 * obvious "agency" among 26 industries (0.6 against 0.05) came back at 0.3 to 0.5.
 */
export function isDecisive(answer: Extract<Answer, { type: 'choice' }>): boolean {
  const [first = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
  return first >= settings.minProbability && first - second >= settings.minMargin;
}

export function hasEnoughText(company: Pick<Company, 'description' | 'tags'>): boolean {
  return (company.description?.trim().length ?? 0) >= MIN_TEXT || company.tags.length > 0;
}

export interface ClassifyStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  decided: number;
  industrySet: number;
  kindSet: number;
  /** Industry set from the segment alone, no model call. */
  industryFromKind: number;
  /** Answers not decisive enough, left unapplied. */
  unsure: number;
  /** Companies updated from an answer cached earlier, after a threshold or list change. */
  fromCache: number;
  remaining: number;
}

export interface Target<T> {
  row: T;
  state: unknown;
  questions: Record<string, Question>;
}

/** Targets split into those never asked and those with an answer already cached. */
export async function splitByCache<T>(targets: Target<T>[]) {
  const model = activeDecisionModel();
  const keys = targets.map((target) => decisionKey(model, target.state, target.questions));
  const answers = await cachedAnswers(keys);
  const fresh: Target<T>[] = [];
  const cached: { target: Target<T>; answers: Record<string, Answer> }[] = [];
  targets.forEach((target, index) => {
    const found = answers.get(keys[index]!);
    if (found) cached.push({ target, answers: found });
    else fresh.push(target);
  });
  return { fresh, cached };
}

/** What to write for a company from its answers: only missing fields, only decisive answers. */
export function companyPatch(
  company: Pick<Company, 'industry' | 'kind'>,
  answers: Record<string, Answer>,
): { patch: Partial<Company>; unsure: number } {
  const patch: Partial<Company> = {};
  let unsure = 0;

  const industry = company.industry ? undefined : answers.industry;
  if (industry?.type === 'choice') {
    if (isDecisive(industry)) patch.industry = industry.choice;
    else unsure += 1;
  }
  const kind = company.kind === 'unknown' ? answers.kind : undefined;
  if (kind?.type === 'choice') {
    // "other" is an answer for the cache, not a segment: the company stays unknown.
    if (!isDecisive(kind)) unsure += 1;
    else if (kind.choice !== 'other') patch.kind = kind.choice;
  }
  return { patch, unsure };
}

async function savePatch(id: number, patch: Partial<Company>, stats: ClassifyStats): Promise<boolean> {
  if (Object.keys(patch).length === 0) return false;
  await getDb().update(companies).set(patch).where(eq(companies.id, id));
  stats.itemsNew += 1;
  if (patch.industry) stats.industrySet += 1;
  if (patch.kind) stats.kindSet += 1;
  return true;
}

async function companyTargets(): Promise<Target<Company>[]> {
  const rows = await getDb()
    .select({ company: companies })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      and(
        or(isNull(companies.industry), eq(companies.kind, 'unknown')),
        sql`coalesce(${companyState.status}, 'new') <> 'blacklist'`,
      ),
    )
    .orderBy(companies.id);

  return rows
    .map(({ company }) => company)
    .filter(hasEnoughText)
    .map((company) => ({ row: company, state: companyRecord(company), questions: companyQuestions() }));
}

/**
 * An agency's industry is the agency itself: no reason to pay a model to say so for each of
 * hundreds of catalog studios. Free filters before the model, section 11.
 */
async function industryFromKind(): Promise<number> {
  let set = 0;
  for (const [kind, industry] of Object.entries(settings.kindIndustry)) {
    const updated = await getDb()
      .update(companies)
      .set({ industry })
      .where(and(eq(companies.kind, kind), isNull(companies.industry)))
      .returning({ id: companies.id });
    set += updated.length;
  }
  return set;
}

export async function classifyCompanies(options: { limit?: number } = {}): Promise<ClassifyStats> {
  return withRun('classify', async () => {
    const fromKind = await industryFromKind();
    const { fresh: pending, cached } = await splitByCache(await companyTargets());
    const batch = pending.slice(0, options.limit ?? 50);
    const stats: ClassifyStats = {
      itemsFound: batch.length,
      itemsNew: fromKind,
      errors: [],
      decided: 0,
      industrySet: 0,
      kindSet: 0,
      industryFromKind: fromKind,
      unsure: 0,
      fromCache: 0,
      remaining: pending.length - batch.length,
    };

    for (const { target, answers } of cached) {
      if (await savePatch(target.row.id, companyPatch(target.row, answers).patch, stats)) stats.fromCache += 1;
    }

    const limit = pLimit(PARALLEL);
    let stopped = false;
    await Promise.all(
      batch.map((target) =>
        limit(async () => {
          if (stopped) return;
          try {
            const decision = await decide(target.state, target.questions);
            stats.decided += 1;
            const { patch, unsure } = companyPatch(target.row, decision.answers);
            stats.unsure += unsure;
            await savePatch(target.row.id, patch, stats);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            stats.errors.push(`${target.row.domain || target.row.name}: ${message}`);
            if (error instanceof BudgetExhaustedError) stopped = true;
          }
        }),
      ),
    );

    log.info({ ...stats, errors: stats.errors.length }, 'company classification done');
    return stats;
  });
}

export function leadQuestion(): Record<string, Question> {
  return {
    fit: {
      type: 'score',
      instructions:
        'This is a public tender. How well does it fit a solo full-stack web developer who builds sites, web apps and integrations?',
      criteria: settings.leadFit,
    },
  };
}

export function leadState(lead: Pick<Lead, 'title' | 'text' | 'budget' | 'currency'>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      title: lead.title,
      text: lead.text?.slice(0, 1500) ?? null,
      budget: lead.budget,
      currency: lead.currency,
    }).filter(([, value]) => value !== null),
  );
}

/** A score level index into 0 to 100: the last level is 100. */
export function fitPercent(score: number, levels: number): number {
  return Math.round(Math.min(Math.max(score / (levels - 1), 0), 1) * 100);
}

export interface LeadFitStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  remaining: number;
}

/**
 * Fit for open tenders without one. Only Prozorro: a funding news item is not a request for
 * work, and the rubric is written for tenders.
 */
export async function classifyLeads(options: { limit?: number } = {}): Promise<LeadFitStats> {
  return withRun('classify:leads', async () => {
    const rows = await getDb()
      .select()
      .from(leads)
      .where(and(eq(leads.source, 'prozorro'), isNull(leads.fit), isNull(leads.closedAt), ne(leads.status, 'skipped')))
      .orderBy(leads.id);

    const questions = leadQuestion();
    const batch = rows.slice(0, options.limit ?? 50);
    const stats: LeadFitStats = { itemsFound: batch.length, itemsNew: 0, errors: [], remaining: rows.length - batch.length };

    const limit = pLimit(PARALLEL);
    let stopped = false;
    await Promise.all(
      batch.map((lead) =>
        limit(async () => {
          if (stopped) return;
          try {
            const answer = (await decide(leadState(lead), questions)).answers.fit;
            if (answer?.type !== 'score') throw new Error('no fit score in the answer');
            await getDb()
              .update(leads)
              .set({ fit: fitPercent(answer.score, settings.leadFit.length) })
              .where(eq(leads.id, lead.id));
            stats.itemsNew += 1;
          } catch (error) {
            stats.errors.push(`lead ${lead.id}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof BudgetExhaustedError) stopped = true;
          }
        }),
      ),
    );

    return stats;
  });
}
