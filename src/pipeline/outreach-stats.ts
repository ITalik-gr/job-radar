import { eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, outreach } from '../db/schema.js';
import { recentBounceRate } from './replies.js';

/**
 * Outreach statistics, a supplement to section 7 of CLAUDE.md: which template and which
 * segment actually answer. Small numbers, so plain counts rather than rates with decimals.
 */

export interface Conversion {
  key: string;
  sent: number;
  replied: number;
  positive: number;
}

export interface OutreachStats {
  byTemplate: Conversion[];
  /** By company segment: does a clinic answer more often than a studio. */
  byKind: Conversion[];
  bounceRate: number;
  /** Median, not mean: one letter answered a month later would skew the mean. */
  medianReplyHours: number | null;
  drafts: number;
  needsAttention: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function tally<T extends { replyAt: number | null; replyType: string | null }>(
  rows: T[],
  keyOf: (row: T) => string,
): Conversion[] {
  const map = new Map<string, Conversion>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? { key, sent: 0, replied: 0, positive: 0 };
    entry.sent += 1;
    if (row.replyAt) entry.replied += 1;
    if (row.replyType === 'positive') entry.positive += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.sent - a.sent);
}

export async function outreachStats(): Promise<OutreachStats> {
  const db = getDb();
  const sent = await db
    .select({
      templateUsed: outreach.templateUsed,
      replyAt: outreach.replyAt,
      replyType: outreach.replyType,
      sentAt: outreach.sentAt,
      kind: companies.kind,
    })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .where(isNotNull(outreach.sentAt));

  const replyHours = sent
    .filter((row) => row.replyAt && row.sentAt)
    .map((row) => (row.replyAt! - row.sentAt!) / 3_600_000);

  const drafts = await db
    .select({ error: outreach.error })
    .from(outreach)
    .where(sql`${outreach.status} = 'draft'`);

  return {
    byTemplate: tally(sent, (row) => row.templateUsed ?? 'no template'),
    byKind: tally(sent, (row) => row.kind),
    bounceRate: await recentBounceRate(),
    medianReplyHours: median(replyHours),
    drafts: drafts.length,
    needsAttention: drafts.filter((row) => row.error).length,
  };
}
