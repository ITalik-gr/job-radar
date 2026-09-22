import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { rules } from './rules.js';
import { scoreVacancy } from './score.js';

export interface RecalcStats {
  reviewed: number;
  changed: number;
  rejectedGeo: number;
  rejectedRole: number;
  aboveThreshold: number;
}

/**
 * Recalculating scores after editing config/scoring.json.
 * The model is not called: the database already has everything it ever returned.
 */
export async function recalcScores(): Promise<RecalcStats> {
  const db = getDb();
  const rows = await db
    .select({ vacancy: vacancies, status: companyState.status, company: companies })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId));

  const stats: RecalcStats = {
    reviewed: rows.length,
    changed: 0,
    rejectedGeo: 0,
    rejectedRole: 0,
    aboveThreshold: 0,
  };

  for (const { vacancy, status, company } of rows) {
    const breakdown = scoreVacancy({
      text: vacancy.rawText ?? '',
      companyDomain: company.domain,
      companySizeHint: company.sizeHint,
      title: vacancy.title,
      location: vacancy.location,
      remote: vacancy.remote,
      salaryMin: vacancy.salaryMin,
      salaryMax: vacancy.salaryMax,
      seniority: vacancy.seniority,
      englishLevelRequired: vacancy.englishLevelRequired,
      llmRelevance: vacancy.llmRelevance,
      blacklisted: status === 'blacklist',
    });

    if (breakdown.rejectedBy?.startsWith('geo')) stats.rejectedGeo += 1;
    if (breakdown.rejectedBy?.startsWith('wrong role')) stats.rejectedRole += 1;
    if (breakdown.score >= rules().threshold) stats.aboveThreshold += 1;

    if (breakdown.score !== vacancy.score) {
      await db.update(vacancies).set({ score: breakdown.score }).where(eq(vacancies.id, vacancy.id));
      stats.changed += 1;
    }
  }

  log.info(stats, 'scores recalculated');
  return stats;
}
