import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, type Company } from '../db/schema.js';
import { cosine, embedTexts, packVector, unpackVector } from '../lib/embeddings.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';

/**
 * Пошук схожих компаній за змістом, а не за тегами.
 *
 * Навіщо: теги каталогів грубі і різні на кожному сайті, а власник відбирає студії
 * на око, за описом і стеком. Коли він позначив кілька як цікаві, найдешевший спосіб
 * знайти ще таких це порівняти описи, а не перебирати теги руками.
 *
 * Вектори лежать у `companies.embedding`, повний перебір іде в памʼяті: компаній
 * сотні, і це мілісекунди. Окрема векторна база тут була б зайвою залежністю.
 */

/** Що саме описує компанію для моделі. Порядок від найважливішого до загального. */
export function companyText(company: Pick<Company, 'name' | 'description' | 'tags' | 'techHints' | 'kind'>): string {
  return [
    company.name,
    company.description ?? '',
    company.tags.join(', '),
    company.techHints.join(', '),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export interface EmbedStats {
  itemsFound: number;
  itemsNew: number;
  errors: string[];
}

/**
 * Порахувати вектори тим компаніям, у яких їх ще немає.
 *
 * Пачками по 25: Workers AI приймає масив текстів за раз, і один запит на компанію
 * був би і повільніше, і дорожче в нейронах.
 */
export async function embedCompanies(limit = 200, batchSize = 25): Promise<EmbedStats> {
  return withRun('embed', async () => {
    const db = getDb();
    const stats: EmbedStats = { itemsFound: 0, itemsNew: 0, errors: [] };

    const targets = await db
      .select()
      .from(companies)
      .where(and(isNull(companies.embedding), sql`${companies.domain} <> ''`))
      .limit(limit);

    stats.itemsFound = targets.length;
    if (targets.length === 0) return stats;

    for (let index = 0; index < targets.length; index += batchSize) {
      const batch = targets.slice(index, index + batchSize);
      const texts = batch.map(companyText);

      try {
        const vectors = await embedTexts(texts);
        for (const [position, company] of batch.entries()) {
          const vector = vectors[position];
          if (!vector) continue;
          await db
            .update(companies)
            .set({ embedding: packVector(vector), embeddedAt: Date.now() })
            .where(eq(companies.id, company.id));
          stats.itemsNew += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.errors.push(`пачка ${index / batchSize + 1}: ${message}`);
        // Немає сенсу довбати ту саму помилку двадцять разів поспіль.
        if (/CLOUDFLARE_|401|403/.test(message)) break;
      }
    }

    log.info(stats, 'вектори компаній порахувано');
    return stats;
  });
}

export interface SimilarCompany {
  companyId: number;
  name: string;
  domain: string;
  kind: string;
  similarity: number;
}

/**
 * Схожі на задану. Поріг навмисно не нульовий: без нього у видачу лізе вся база,
 * відсортована за дрібними відмінностями, і список виглядає осмисленим, хоча ним не є.
 */
export async function similarCompanies(
  companyId: number,
  limit = 6,
  minSimilarity = 0.6,
): Promise<SimilarCompany[]> {
  const db = getDb();

  const [source] = await db.select().from(companies).where(eq(companies.id, companyId));
  const vector = unpackVector(source?.embedding ?? null);
  if (!vector) return [];

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      kind: companies.kind,
      embedding: companies.embedding,
    })
    .from(companies)
    .where(and(isNotNull(companies.embedding), sql`${companies.id} <> ${companyId}`));

  return rows
    .map((row) => ({
      companyId: row.id,
      name: row.name,
      domain: row.domain,
      kind: row.kind,
      similarity: Math.round(cosine(vector, unpackVector(row.embedding) ?? []) * 1000) / 1000,
    }))
    .filter((row) => row.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
