import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, outreach, queueItems, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { todayKey } from './queue.js';

export const ACTIONS = ['interesting', 'not_interesting', 'contacted', 'blacklist', 'snooze'] as const;
export type Action = (typeof ACTIONS)[number];

/** An action on a card means the company's status, not the vacancy's: we write to the company, not the vacancy. */
const STATUS_BY_ACTION: Record<Action, string> = {
  interesting: 'interesting',
  not_interesting: 'rejected_by_me',
  contacted: 'contacted',
  blacklist: 'blacklist',
  snooze: 'snoozed',
};

export interface ActionInput {
  vacancyId: number;
  action: Action;
  note?: string | null;
  /** Only for snooze, defaults to 30 days. */
  days?: number;
  /** Only for contacted. */
  channel?: string;
  templateUsed?: string | null;
  /** Snapshot of the contact at the time of the letter: a year later it should still be clear who exactly was written to. */
  contactName?: string | null;
  contactEmail?: string | null;
}

export interface ActionResult {
  companyId: number;
  status: string;
  outreachId: number | null;
}

export async function applyAction(input: ActionInput): Promise<ActionResult> {
  const db = getDb();
  const [vacancy] = await db.select().from(vacancies).where(eq(vacancies.id, input.vacancyId));
  if (!vacancy) throw new Error(`vacancy ${input.vacancyId} does not exist`);

  // Validation here, not only in the API: the CLI and a future cron also call this function.
  const status = STATUS_BY_ACTION[input.action];
  if (!status) throw new Error(`unknown action: ${input.action}`);
  const snoozedUntil =
    input.action === 'snooze' ? Date.now() + (input.days ?? 30) * 86_400_000 : null;

  const [existing] = await db
    .select()
    .from(companyState)
    .where(eq(companyState.companyId, vacancy.companyId));

  if (existing) {
    await db
      .update(companyState)
      .set({ status, snoozedUntil, reason: input.note ?? existing.reason, updatedAt: Date.now() })
      .where(eq(companyState.companyId, vacancy.companyId));
  } else {
    await db
      .insert(companyState)
      .values({ companyId: vacancy.companyId, status, snoozedUntil, reason: input.note ?? null });
  }

  let outreachId: number | null = null;
  if (input.action === 'contacted') {
    const [row] = await db
      .insert(outreach)
      .values({
        companyId: vacancy.companyId,
        vacancyId: vacancy.id,
        channel: input.channel ?? 'email',
        // The "Wrote" button records a letter that was already sent, so it's sent right away.
        // Outreach drafts live in this same table with status = draft.
        status: 'sent',
        sentAt: Date.now(),
        templateUsed: input.templateUsed ?? null,
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        note: input.note ?? null,
      })
      .returning({ id: outreach.id });
    outreachId = row!.id;
  }

  await db
    .update(queueItems)
    .set({ decision: input.action, decidedAt: Date.now() })
    .where(and(eq(queueItems.vacancyId, input.vacancyId), isNull(queueItems.decision)));

  log.info({ vacancyId: input.vacancyId, action: input.action, status }, 'action applied');
  return { companyId: vacancy.companyId, status, outreachId };
}

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
  vacancyId: number | null;
  vacancyTitle: string | null;
  vacancyUrl: string | null;
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
      vacancyTitle: vacancies.title,
      vacancyUrl: vacancies.url,
    })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .leftJoin(vacancies, eq(vacancies.id, outreach.vacancyId))
    // A draft is not a letter yet. Its place is on the "To send" page, not in the history.
    .where(sql`${outreach.sentAt} is not null`)
    .orderBy(desc(outreach.sentAt));

  const now = Date.now();
  return rows.map(({ row, company, domain, vacancyTitle, vacancyUrl }) => ({
    id: row.id,
    companyId: row.companyId,
    company,
    domain,
    vacancyId: row.vacancyId,
    vacancyTitle,
    vacancyUrl,
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
  vacanciesOpen: number;
  shown: number;
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
    vacanciesOpen: await count(db.select({ n }).from(vacancies).where(isNull(vacancies.closedAt))),
    shown: await count(db.select({ n }).from(queueItems)),
    decided: await count(
      db.select({ n }).from(queueItems).where(sql`${queueItems.decision} is not null`),
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

export { todayKey };
