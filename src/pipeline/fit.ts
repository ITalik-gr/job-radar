import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { getDb } from '../db/client.js';
import { companies, companyState, type Company } from '../db/schema.js';
import { BudgetExhaustedError, decide, type Answer, type Question } from '../lib/decide.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';
import { companyRecord, fitPercent, hasEnoughText, isDecisive, splitByCache, type Target } from './classify.js';
import fitConfig from '../../config/fit.json' with { type: 'json' };
import { FIT_LEVELS, fitLevel, type FitLevel } from './fit-level.js';

/**
 * Lead fit: would this company buy what the owner sells. Three questions over the company record,
 * all picked from fixed lists in `config/fit.json`: how likely it is to pay an outside developer,
 * which service fits, what stage it is at. Clef answers with probabilities and writes nothing, so
 * the card can say "likely, MVP, early stage" without a single generated sentence (rule 6).
 *
 * Free filters before the model (section 11): companies with nothing to read, blacklisted or
 * rejected ones and product companies are never asked, and an input asked before is served from
 * the cache.
 */

const settings = {
  buyer: fitConfig.buyer,
  services: stripComments(fitConfig.services),
  stages: stripComments(fitConfig.stages),
};

function stripComments(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith('_')));
}

export { FIT_LEVELS, fitLevel, type FitLevel } from './fit-level.js';

/** Statuses the owner already decided on: asking the model about them spends a call for nothing. */
const SETTLED = ['blacklist', 'rejected_by_me', 'rejected_by_them'];

const PARALLEL = 4;

export function fitQuestions(): Record<string, Question> {
  return {
    buyer: {
      type: 'score',
      instructions:
        'The reader is a solo full-stack developer who sells development work to founders, small businesses and agencies. How likely is this company to pay such a developer for a project?',
      criteria: settings.buyer,
    },
    service: {
      type: 'choice',
      instructions: 'Which of these services would this company most likely need from that developer?',
      criteria: settings.services,
    },
    stage: {
      type: 'choice',
      instructions: 'What stage is this company at?',
      criteria: settings.stages,
    },
  };
}

/** The record the model reads: the classification one, plus what the company already is. */
export function fitRecord(company: Company): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    segment: company.kind === 'unknown' ? null : company.kind,
    industry: company.industry,
    site_stack: company.techHints.slice(0, 10),
    hiring_developers: company.hiringDevs || null,
    founded: company.foundedYear,
  };
  return {
    ...companyRecord(company),
    ...Object.fromEntries(
      Object.entries(extra).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)),
    ),
  };
}

/**
 * What to store from the answers. The likelihood is always stored: it is a calibrated level, and
 * the score weighs it. Service and stage only when decisive, otherwise null: an unsure pick is
 * not shown as a fact.
 */
export function fitPatch(answers: Record<string, Answer>, now = Date.now()): Partial<Company> {
  const patch: Partial<Company> = { fitAt: now };
  const buyer = answers.buyer;
  if (buyer?.type === 'score') patch.fit = fitPercent(buyer.score, settings.buyer.length);

  const service = answers.service;
  patch.fitService = service?.type === 'choice' && isDecisive(service) && service.choice !== 'none' ? service.choice : null;
  const stage = answers.stage;
  patch.fitStage = stage?.type === 'choice' && isDecisive(stage) && stage.choice !== 'unknown' ? stage.choice : null;
  return patch;
}

async function fitTargets(onlyId?: number): Promise<Target<Company>[]> {
  const rows = await getDb()
    .select({ company: companies })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      onlyId !== undefined
        ? eq(companies.id, onlyId)
        : and(
            isNull(companies.fitAt),
            notInArray(sql`coalesce(${companyState.status}, 'new')`, SETTLED),
            sql`${companies.kind} <> 'product'`,
          ),
    )
    // Startups and companies without a segment first: they are the ones the owner cannot read at a glance.
    .orderBy(sql`case ${companies.kind} when 'startup' then 0 when 'unknown' then 1 else 2 end`, companies.id);

  return rows
    .map(({ company }) => company)
    .filter(hasEnoughText)
    .map((company) => ({ row: company, state: fitRecord(company), questions: fitQuestions() }));
}

export interface FitStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
  fromCache: number;
  remaining: number;
}

async function save(id: number, patch: Partial<Company>): Promise<void> {
  await getDb().update(companies).set(patch).where(eq(companies.id, id));
}

/** A batch over companies never asked. Cached answers are applied for free first. */
export async function fitCompanies(options: { limit?: number } = {}): Promise<FitStats> {
  return withRun('fit', async () => {
    const { fresh, cached } = await splitByCache(await fitTargets());
    const batch = fresh.slice(0, options.limit ?? 50);
    const stats: FitStats = {
      itemsFound: batch.length,
      itemsNew: 0,
      errors: [],
      fromCache: 0,
      remaining: fresh.length - batch.length,
    };

    for (const { target, answers } of cached) {
      await save(target.row.id, fitPatch(answers));
      stats.fromCache += 1;
      stats.itemsNew += 1;
    }

    const limit = pLimit(PARALLEL);
    let stopped = false;
    await Promise.all(
      batch.map((target) =>
        limit(async () => {
          if (stopped) return;
          try {
            const decision = await decide(target.state, target.questions);
            await save(target.row.id, fitPatch(decision.answers));
            stats.itemsNew += 1;
          } catch (error) {
            stats.errors.push(`${target.row.domain || target.row.name}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof BudgetExhaustedError) stopped = true;
          }
        }),
      ),
    );

    log.info({ ...stats, errors: stats.errors.length }, 'lead fit done');
    return stats;
  });
}

export interface CompanyFit {
  companyId: number;
  fit: number | null;
  level: FitLevel | null;
  service: string | null;
  stage: string | null;
  source: 'model' | 'cache';
  /** Probabilities per option, so the card can show how sure the model was. */
  probabilities: { service: Record<string, number>; stage: Record<string, number> };
}

/**
 * One company on a button press, even one asked before (the answer then comes from the cache for
 * free, unless its record changed). Throws when there is nothing to read: a name alone is no input.
 */
export async function fitCompany(id: number): Promise<CompanyFit> {
  const [target] = await fitTargets(id);
  if (!target) throw new Error('not enough text to judge: no description and no tags. Refresh from site first');
  const decision = await decide(target.state, target.questions);
  const patch = fitPatch(decision.answers);
  await save(id, patch);
  const probabilities = (key: string) => {
    const answer = decision.answers[key];
    return answer?.type === 'choice' ? answer.probabilities : {};
  };
  return {
    companyId: id,
    fit: patch.fit ?? null,
    level: fitLevel(patch.fit ?? null),
    service: patch.fitService ?? null,
    stage: patch.fitStage ?? null,
    source: decision.source,
    probabilities: { service: probabilities('service'), stage: probabilities('stage') },
  };
}

/** Labels for the interface and MCP, from the same config the model reads. */
export function fitLabels(): { services: Record<string, string>; stages: Record<string, string>; levels: readonly string[] } {
  return { services: settings.services, stages: settings.stages, levels: FIT_LEVELS };
}
