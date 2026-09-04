import { isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { outreach } from '../db/schema.js';
import { recentBounceRate } from './replies.js';

/**
 * Статистика розсилки, доповнення до розділу 7 OUTREACH.md.
 *
 * Найважливіше тут не конверсія, а частка відкатів валідації з розбивкою по
 * причинах: вище 30 відсотків означає поганий промпт, і без цієї цифри це
 * помітно лише через сотню посередніх листів.
 */

export interface TemplateConversion {
  template: string;
  sent: number;
  replied: number;
  positive: number;
}

export interface OutreachStats {
  byTemplate: TemplateConversion[];
  ai: { sent: number; replied: number; positive: number };
  static: { sent: number; replied: number; positive: number };
  fallbacks: { reason: string; count: number }[];
  fallbackShare: number;
  bounceRate: number;
  /** Медіана, а не середнє: один лист з відповіддю через місяць зсуває середнє. */
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

export async function outreachStats(): Promise<OutreachStats> {
  const db = getDb();
  const sent = await db.select().from(outreach).where(isNotNull(outreach.sentAt));

  const byTemplate = new Map<string, TemplateConversion>();
  for (const row of sent) {
    const key = row.templateUsed ?? 'без шаблона';
    const entry = byTemplate.get(key) ?? { template: key, sent: 0, replied: 0, positive: 0 };
    entry.sent += 1;
    if (row.replyAt) entry.replied += 1;
    if (row.replyType === 'positive') entry.positive += 1;
    byTemplate.set(key, entry);
  }

  const bucket = (rows: typeof sent) => ({
    sent: rows.length,
    replied: rows.filter((row) => row.replyAt).length,
    positive: rows.filter((row) => row.replyType === 'positive').length,
  });

  const fallbackRows = await db
    .select({ reason: outreach.aiFallbackReason, count: sql<number>`count(*)` })
    .from(outreach)
    .where(isNotNull(outreach.aiFallbackReason))
    .groupBy(outreach.aiFallbackReason);

  /*
   * Причини складаються в групи за першим словом: "слів 84" і "слів 12" це та
   * сама проблема промпта, і в розрізі по точному тексту вона розпадається на
   * десяток однакових рядків по одному.
   */
  const grouped = new Map<string, number>();
  for (const row of fallbackRows) {
    const reason = (row.reason ?? '').split(':')[0]!.replace(/\s+\d.*$/, '').trim() || 'інше';
    grouped.set(reason, (grouped.get(reason) ?? 0) + Number(row.count));
  }

  const fallbacks = [...grouped.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const attempted = fallbacks.reduce((sum, item) => sum + item.count, 0);
  const aiUsed = sent.filter((row) => row.aiUsed).length;

  const replyHours = sent
    .filter((row) => row.replyAt && row.sentAt)
    .map((row) => (row.replyAt! - row.sentAt!) / 3_600_000);

  const drafts = await db
    .select({ error: outreach.error })
    .from(outreach)
    .where(sql`${outreach.status} = 'draft'`);

  return {
    byTemplate: [...byTemplate.values()].sort((a, b) => b.sent - a.sent),
    ai: bucket(sent.filter((row) => row.aiUsed)),
    static: bucket(sent.filter((row) => !row.aiUsed)),
    fallbacks,
    fallbackShare: attempted + aiUsed === 0 ? 0 : attempted / (attempted + aiUsed),
    bounceRate: await recentBounceRate(),
    medianReplyHours: median(replyHours),
    drafts: drafts.length,
    needsAttention: drafts.filter((row) => row.error).length,
  };
}
