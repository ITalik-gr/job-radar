import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, type Company } from '../db/schema.js';
import { cosine, embedTexts, packVector, unpackVector } from '../lib/embeddings.js';
import { log } from '../lib/log.js';
import { withRun } from '../lib/runs.js';

/**
 * Finding companies similar by content, not by tags.
 *
 * Why: catalog tags are coarse and different on every site, while the owner picks
 * studios by eye, by description and stack. Once several are marked interesting, the
 * cheapest way to find more like them is to compare descriptions, not go through tags by hand.
 *
 * Vectors live in `companies.embedding`, a full scan runs in memory: there are hundreds
 * of companies, and that's milliseconds. A separate vector database here would be an unneeded dependency.
 */

/** What describes a company for the model. Ordered from most to least important. */
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
 * Compute vectors for companies that don't have one yet.
 *
 * In batches of 25: Workers AI accepts an array of texts at once, and one request per
 * company would be both slower and more expensive in neurons.
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
        stats.errors.push(`batch ${index / batchSize + 1}: ${message}`);
        // No point hitting the same error twenty times in a row.
        if (/CLOUDFLARE_|401|403/.test(message)) break;
      }
    }

    log.info(stats, 'company vectors computed');
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
 * Similar to the given one. The threshold is deliberately non-zero: without it the
 * whole database creeps into the result, sorted by tiny differences, and the list
 * looks meaningful while not being one.
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
