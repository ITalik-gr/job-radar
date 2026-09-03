import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { classifyText, type ClassifyOptions } from './classify.js';
import { scoreVacancy } from './score.js';

export interface ReclassifyStats {
  taken: number;
  classified: number;
  needsReview: number;
}

/**
 * Догнати вакансії, які лежать у базі без класифікації: збережені під час --skip-llm,
 * при вичерпаному бюджеті або після невдалої відповіді моделі.
 * Беруться зверху за рахунком, бо бюджет обмежений і найцінніші мають пройти першими.
 */
export async function classifyPending(limit = 20, options: ClassifyOptions = {}): Promise<ReclassifyStats> {
  const db = getDb();
  const rows = await db
    .select({ vacancy: vacancies, company: companies })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .where(
      and(
        isNull(vacancies.closedAt),
        gt(vacancies.score, 0),
        or(isNull(vacancies.llmRelevance), eq(vacancies.needsReview, true)),
      ),
    )
    .orderBy(desc(vacancies.score))
    .limit(limit);

  const stats: ReclassifyStats = { taken: rows.length, classified: 0, needsReview: 0 };

  for (const { vacancy: row, company } of rows) {
    const result = await classifyText(`${row.title ?? ''}\n${row.rawText ?? ''}`.slice(0, 12000), options);
    const llm = result.classification;
    if (result.needsReview) stats.needsReview += 1;
    if (!llm) {
      await db.update(vacancies).set({ needsReview: true }).where(eq(vacancies.id, row.id));
      continue;
    }

    const breakdown = scoreVacancy({
      text: row.rawText ?? '',
      companyDomain: company.domain,
      companySizeHint: company.sizeHint,
      title: llm.title ?? row.title,
      location: llm.location ?? row.location,
      remote: llm.remote ?? row.remote,
      salaryMin: llm.salary_min,
      salaryMax: llm.salary_max,
      seniority: llm.seniority,
      englishLevelRequired: llm.english_level_required,
      llmRelevance: llm.relevance,
    });

    await db
      .update(vacancies)
      .set({
        title: llm.title ?? row.title,
        stack: llm.stack,
        seniority: llm.seniority,
        remote: llm.remote ?? row.remote,
        location: llm.location ?? row.location,
        salaryMin: llm.salary_min,
        salaryMax: llm.salary_max,
        currency: llm.currency,
        englishLevelRequired: llm.english_level_required,
        llmRelevance: llm.relevance,
        llmWhy: llm.why,
        isVacancy: llm.is_vacancy,
        needsReview: false,
        score: breakdown.score,
      })
      .where(eq(vacancies.id, row.id));

    stats.classified += 1;
    log.debug({ id: row.id, score: breakdown.score, relevance: llm.relevance }, 'вакансію докласифіковано');
  }

  return stats;
}
