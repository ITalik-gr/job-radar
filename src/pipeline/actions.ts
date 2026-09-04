import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, outreach, queueItems, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { todayKey } from './queue.js';

export const ACTIONS = ['interesting', 'not_interesting', 'contacted', 'blacklist', 'snooze'] as const;
export type Action = (typeof ACTIONS)[number];

/** Дія на картці означає стан компанії, а не вакансії: пишемо ж компанії, не вакансії. */
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
  /** Тільки для snooze, за замовчуванням 30 днів. */
  days?: number;
  /** Тільки для contacted. */
  channel?: string;
  templateUsed?: string | null;
  /** Знімок контакту на момент листа: через рік має бути видно, кому саме писали. */
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
  if (!vacancy) throw new Error(`вакансії ${input.vacancyId} немає`);

  // Валідація тут, а не тільки в API: функцію викликає ще CLI і майбутній cron.
  const status = STATUS_BY_ACTION[input.action];
  if (!status) throw new Error(`невідома дія: ${input.action}`);
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
        // Кнопка "Написав" це запис про вже надісланий лист, тому одразу sent.
        // Чернетки розсилки живуть у цій же таблиці зі status = draft.
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

  log.info({ vacancyId: input.vacancyId, action: input.action, status }, 'дія застосована');
  return { companyId: vacancy.companyId, status, outreachId };
}

export const REPLY_TYPES = ['positive', 'rejection', 'auto'] as const;
export type ReplyType = (typeof REPLY_TYPES)[number];

/** Відповідь змінює і стан компанії, інакше вона назавжди лишиться contacted. */
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
  if (!row) throw new Error(`контакту ${outreachId} немає`);

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
  /** Текст того, що реально пішло. Інтерфейс показує його на розкритті рядка. */
  subject: string | null;
  body: string | null;
  isFollowup: boolean;
  templateUsed: string | null;
  /** Кому писали. Знімок на момент листа, а не звʼязок із таблицею контактів. */
  contactName: string | null;
  contactEmail: string | null;
  replyAt: number | null;
  replyType: string | null;
  note: string | null;
  /** Днів без відповіді. null, якщо відповідь уже є. */
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
    // Чернетка це ще не лист. Її місце на сторінці "До відправки", а не в історії.
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

/** Кому писали понад N днів тому і відповіді немає. Основа нагадувань. */
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
  // Воронка міряє надіслані листи. Чернетка ще нікуди не пішла і в неї не входить.
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
