import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, outreach } from '../db/schema.js';

export const REPLY_TYPES = ['positive', 'rejection', 'auto'] as const;
export type ReplyType = (typeof REPLY_TYPES)[number];

/** A reply also changes the company's status, otherwise it would stay contacted forever. */
const STATUS_BY_REPLY: Record<ReplyType, string | null> = {
  positive: 'replied',
  rejection: 'rejected_by_them',
  auto: null,
};

export async function markReply(
  outreachId: number,
  replyType: ReplyType,
  note?: string | null,
): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(outreach).where(eq(outreach.id, outreachId));
  if (!row) throw new Error(`outreach entry ${outreachId} does not exist`);

  await db
    .update(outreach)
    .set({ replyAt: Date.now(), replyType, note: note ?? row.note })
    .where(eq(outreach.id, outreachId));

  const status = STATUS_BY_REPLY[replyType];
  if (status) {
    await db
      .update(companyState)
      .set({ status, updatedAt: Date.now() })
      .where(eq(companyState.companyId, row.companyId));
  }
}

export interface OutreachRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  channel: string;
  sentAt: number | null;
  status: string;
  language: string | null;
  aiUsed: boolean;
  bounceType: string | null;
  /** The text that actually went out. The UI shows it when the row is expanded. */
  subject: string | null;
  body: string | null;
  isFollowup: boolean;
  templateUsed: string | null;
  /** Who was written to. A snapshot at the time of the letter, not a link to the contacts table. */
  contactName: string | null;
  contactEmail: string | null;
  replyAt: number | null;
  replyType: string | null;
  note: string | null;
  /** Days without a reply. null if there already is one. */
  waitingDays: number | null;
}

export async function listOutreach(): Promise<OutreachRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      row: outreach,
      company: companies.name,
      domain: companies.domain,
    })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    // A draft is not a letter yet. Its place is on the "To send" page, not in the history.
    .where(sql`${outreach.sentAt} is not null`)
    .orderBy(desc(outreach.sentAt));

  const now = Date.now();
  return rows.map(({ row, company, domain }) => ({
    id: row.id,
    companyId: row.companyId,
    company,
    domain,
    channel: row.channel,
    sentAt: row.sentAt,
    status: row.status,
    language: row.language,
    aiUsed: row.aiUsed,
    bounceType: row.bounceType,
    subject: row.subjectFinal,
    body: row.bodyFinal,
    isFollowup: row.followupOf !== null,
    templateUsed: row.templateUsed,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    replyAt: row.replyAt,
    replyType: row.replyType,
    note: row.note,
    waitingDays:
      row.replyAt || !row.sentAt ? null : Math.floor((now - row.sentAt) / 86_400_000),
  }));
}

/** Who was written to more than N days ago with no reply. The basis for reminders. */
export async function followUps(days = 7): Promise<OutreachRow[]> {
  const rows = await listOutreach();
  return rows.filter((row) => row.waitingDays !== null && row.waitingDays >= days);
}

export interface FunnelStats {
  companies: number;
  /** Companies the owner has looked at and decided on. */
  decided: number;
  contacted: number;
  replied: number;
  positive: number;
  waitingReply: number;
}

export async function funnel(): Promise<FunnelStats> {
  const db = getDb();
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const n = sql<number>`count(*)`;
  // The funnel measures sent letters. A draft hasn't gone anywhere yet and isn't counted.
  const sent = sql`${outreach.sentAt} is not null`;

  return {
    companies: await count(db.select({ n }).from(companies)),
    decided: await count(
      db.select({ n }).from(companyState).where(sql`${companyState.status} <> 'new'`),
    ),
    contacted: await count(db.select({ n }).from(outreach).where(sent)),
    replied: await count(
      db.select({ n }).from(outreach).where(and(sent, sql`${outreach.replyAt} is not null`)),
    ),
    positive: await count(
      db.select({ n }).from(outreach).where(and(sent, eq(outreach.replyType, 'positive'))),
    ),
    waitingReply: await count(
      db.select({ n }).from(outreach).where(and(sent, isNull(outreach.replyAt))),
    ),
  };
}

