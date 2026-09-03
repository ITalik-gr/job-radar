import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { rules } from './rules.js';
import { scoreVacancy } from './score.js';

export interface RecalcStats {
  переглянуто: number;
  змінено: number;
  'відсіяно гео': number;
  'відсіяно роллю': number;
  'вище порогу': number;
}

/**
 * Перерахунок рахунків після правки config/scoring.json.
 * Модель не викликається: у базі вже є все, що вона колись повернула.
 */
export async function recalcScores(): Promise<RecalcStats> {
  const db = getDb();
  const rows = await db
    .select({ vacancy: vacancies, status: companyState.status, company: companies })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .leftJoin(companyState, eq(companyState.companyId, vacancies.companyId));

  const stats: RecalcStats = {
    переглянуто: rows.length,
    змінено: 0,
    'відсіяно гео': 0,
    'відсіяно роллю': 0,
    'вище порогу': 0,
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

    if (breakdown.rejectedBy?.startsWith('гео')) stats['відсіяно гео'] += 1;
    if (breakdown.rejectedBy?.startsWith('не та роль')) stats['відсіяно роллю'] += 1;
    if (breakdown.score >= rules().threshold) stats['вище порогу'] += 1;

    if (breakdown.score !== vacancy.score) {
      await db.update(vacancies).set({ score: breakdown.score }).where(eq(vacancies.id, vacancy.id));
      stats.змінено += 1;
    }
  }

  log.info(stats, 'рахунки перераховано');
  return stats;
}
