import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { localClock, localDay } from '../lib/time.js';
import { getDb } from '../db/client.js';
import { companyState, outreach, sendLog } from '../db/schema.js';
import { BLOCKED_STATUSES, RECONTACT_DAYS } from './outreach.js';

/**
 * Sending guards, section 9 of OUTREACH.md.
 *
 * Each is a separate function with its own test, and none lives inside a UI handler. The reason
 * is simple: a check written into a button handler exists only until someone adds a second
 * button. And the cost of a mistake here is not an interface bug but a ruined sender reputation
 * and a blocked personal Gmail.
 */

/**
 * The daily cap is a constant, not a setting in the interface. On purpose: a field that can be
 * raised in a moment of excitement is not a guard.
 */
export const DAILY_SEND_LIMIT = 20;

/** Warmup: 5 letters a day for the first three days, 10 on days 4-7, then the full cap. */
export const WARMUP_STEPS: { untilDay: number; limit: number }[] = [
  { untilDay: 3, limit: 5 },
  { untilDay: 7, limit: 10 },
];

export const MIN_GAP_MS = 3 * 60_000;
export const MAX_WORDS = 160;
export const MAX_LINKS = 3;
export const BOUNCE_WINDOW = 50;
export const BOUNCE_RATE_LIMIT = 0.03;
export const QUIET_HOUR_START = 22;
export const QUIET_HOUR_END = 8;

export interface Blocker {
  code: string;
  message: string;
  /** When the check releases itself. For the timer in the interface. */
  retryAt?: number;
}

export { localClock, localDay } from '../lib/time.js';

/**
 * Working window: a weekday from 08:00 to 22:00 in the owner's time zone.
 *
 * A letter sent on a Saturday night looks like a bot even when a person wrote it, and that is
 * exactly how the recipient will read it.
 */
export function isSendWindow(date: Date): boolean {
  const { hour, weekday } = localClock(date);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= QUIET_HOUR_END && hour < QUIET_HOUR_START;
}

/** How many letters are allowed today, taking warmup into account. */
export function dailyLimit(daysSinceFirstSend: number): number {
  const day = Math.max(1, daysSinceFirstSend);
  for (const step of WARMUP_STEPS) {
    if (day <= step.untilDay) return step.limit;
  }
  return DAILY_SEND_LIMIT;
}

/** Difference in calendar days, not in 24-hour periods: warmup counts by dates. */
export function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** File extensions and technology names that look like a domain but are not. */
const TECH_SUFFIXES = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'json',
  'css',
  'scss',
  'html',
  'md',
  'py',
  'sh',
  'sql',
  'yml',
  'yaml',
  'env',
  'lock',
]);

/** Links count both as http and as a bare domain: to a spam filter they are the same. */
export function countLinks(text: string): number {
  // An email in the signature is not a link, so addresses are removed before counting:
  // otherwise olena@example.com would give two "extra" domain mentions at once.
  const withoutEmails = text.replace(/[^\s<>()]+@[^\s<>()]+/g, ' ');
  const matches = withoutEmails.match(/(https?:\/\/\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/gi) ?? [];
  const unique = new Set(
    matches
      .map((item) => item.replace(/^https?:\/\//i, '').replace(/[.,);]+$/, '').toLowerCase())
      // next.js, node.js and friends are technology names, not links. Without this a letter that
      // mentions the stack would be blocked for "two links" out of nothing.
      .filter((item) => item.startsWith('http') || !TECH_SUFFIXES.has(item.split('/')[0]!.split('.').pop()!)),
  );
  return unique.size;
}

export function hasUnfilledPlaceholder(text: string): boolean {
  return /\{\{\s*[a-z_]+\s*\}\}/i.test(text) || /\[[^\]\n]{3,}\]/.test(text);
}

export function bounceRate(rows: { bounceType: string | null; status: string }[]): number {
  if (rows.length === 0) return 0;
  const bounced = rows.filter((row) => row.bounceType === 'hard' || row.status === 'bounced');
  return bounced.length / rows.length;
}

/**
 * The letter text on its own, without the database. These three checks are needed both in the
 * template editor and before sending, which is exactly why they stand apart.
 */
export function letterBlockers(subject: string, body: string): Blocker[] {
  const blockers: Blocker[] = [];
  if (!subject.trim()) blockers.push({ code: 'subject', message: 'empty subject' });
  if (!body.trim()) blockers.push({ code: 'body', message: 'empty letter body' });
  if (hasUnfilledPlaceholder(`${subject}\n${body}`)) {
    blockers.push({ code: 'placeholder', message: 'the letter still has an unfilled placeholder' });
  }
  if (wordCount(body) > MAX_WORDS) {
    blockers.push({ code: 'length', message: `the letter is longer than ${MAX_WORDS} words` });
  }
  if (countLinks(body) > MAX_LINKS) {
    blockers.push({ code: 'links', message: `more than ${MAX_LINKS} links in the body` });
  }
  return blockers;
}

export interface SendCounters {
  day: string;
  sentToday: number;
  limit: number;
  /** When the three minute pause ends. null means sending is allowed right now. */
  nextAllowedAt: number | null;
  bounceRate: number;
  /** Whether sending is open at all right now: time, limit, bounces. */
  windowOpen: boolean;
}

/**
 * Counters for the page header. Separate from checking a specific letter, because the interface
 * has to show "sent 7 of 20" before anything is selected.
 */
export async function sendCounters(now = new Date()): Promise<SendCounters> {
  const db = getDb();
  const day = localDay(now);

  const [todayRow] = await db.select().from(sendLog).where(eq(sendLog.day, day));
  const [firstRow] = await db.select().from(sendLog).orderBy(sendLog.day).limit(1);

  const limit = dailyLimit(firstRow ? daysBetween(firstRow.day, day) : 1);
  const lastSentAt = todayRow?.lastSentAt ?? null;
  const nextAllowedAt =
    lastSentAt && lastSentAt + MIN_GAP_MS > now.getTime() ? lastSentAt + MIN_GAP_MS : null;

  const recent = await db
    .select({ bounceType: outreach.bounceType, status: outreach.status })
    .from(outreach)
    .where(isNotNull(outreach.sentAt))
    .orderBy(desc(outreach.sentAt))
    .limit(BOUNCE_WINDOW);

  const sentToday = todayRow?.count ?? 0;
  const rate = bounceRate(recent);

  return {
    day,
    sentToday,
    limit,
    nextAllowedAt,
    bounceRate: rate,
    windowOpen:
      sentToday < limit && nextAllowedAt === null && isSendWindow(now) && rate <= BOUNCE_RATE_LIMIT,
  };
}

/**
 * The full list of reasons this letter will not go out now. A list, not the first found: the
 * owner has to see all three problems at once, not one per click.
 */
export async function checkSend(draftId: number, now = new Date()): Promise<Blocker[]> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, draftId));
  if (!draft) return [{ code: 'missing', message: `no draft ${draftId}` }];

  const blockers: Blocker[] = [];

  if (draft.status !== 'draft' && draft.status !== 'approved') {
    blockers.push({ code: 'status', message: `the letter is already ${draft.status}` });
  }
  if (!draft.contactEmail) {
    blockers.push({ code: 'address', message: 'no recipient address' });
  }
  blockers.push(...letterBlockers(draft.subjectFinal ?? '', draft.bodyFinal ?? ''));
  /*
   * The personal defaults were emptied for forks, so a fresh install would send from a bare
   * address with no name, which reads as a mailing. Better to stop and say what is missing.
   */
  if (!config.gmail.fromName.trim()) {
    blockers.push({ code: 'from_name', message: 'GMAIL_FROM_NAME is empty, the letter would go out from a bare address' });
  }

  const [state] = await db
    .select()
    .from(companyState)
    .where(eq(companyState.companyId, draft.companyId));

  if (state && BLOCKED_STATUSES.includes(state.status)) {
    blockers.push({ code: 'company_status', message: `the company is ${state.status}` });
  }

  /*
   * A repeat letter to the same company. After a quarter that is fine, after a week it is not,
   * and the difference is not about politeness: a second cold letter in a row most often lands in
   * spam along with all further correspondence.
   */
  const [lastSent] = await db
    .select()
    .from(outreach)
    .where(and(eq(outreach.companyId, draft.companyId), isNotNull(outreach.sentAt)))
    .orderBy(desc(outreach.sentAt))
    .limit(1);

  if (lastSent?.sentAt) {
    const days = Math.floor((now.getTime() - lastSent.sentAt) / 86_400_000);
    if (days < RECONTACT_DAYS && lastSent.id !== draft.followupOf) {
      blockers.push({
        code: 'recontact',
        message: `this company was contacted ${days} days ago, a repeat is allowed after ${RECONTACT_DAYS}`,
        retryAt: lastSent.sentAt + RECONTACT_DAYS * 86_400_000,
      });
    }
  }

  // An address that already hard bounced is dead for good, however often you write to it.
  if (draft.contactEmail) {
    const [dead] = await db
      .select({ id: outreach.id })
      .from(outreach)
      .where(and(eq(outreach.contactEmail, draft.contactEmail), eq(outreach.bounceType, 'hard')))
      .limit(1);
    if (dead) blockers.push({ code: 'hard_bounce', message: 'this address already hard bounced' });
  }

  // Exactly one follow-up. A second one is persistence that works against you.
  if (draft.followupOf) {
    const [existing] = await db
      .select({ n: sql<number>`count(*)` })
      .from(outreach)
      .where(and(eq(outreach.followupOf, draft.followupOf), isNotNull(outreach.sentAt)));
    if ((existing?.n ?? 0) > 0) {
      blockers.push({ code: 'followup', message: 'a follow-up to this company has already gone out' });
    }
  }

  const counters = await sendCounters(now);
  if (counters.sentToday >= counters.limit) {
    blockers.push({
      code: 'daily_limit',
      message: `daily limit reached: ${counters.sentToday} of ${counters.limit}`,
    });
  }
  if (counters.nextAllowedAt) {
    blockers.push({
      code: 'gap',
      message: '3 minutes must pass since the previous letter',
      retryAt: counters.nextAllowedAt,
    });
  }
  if (!isSendWindow(now)) {
    blockers.push({
      code: 'quiet_hours',
      message: 'it is night or a weekend in your time zone, the letter would look like a bot',
    });
  }
  if (counters.bounceRate > BOUNCE_RATE_LIMIT) {
    blockers.push({
      code: 'bounce_rate',
      message: `bounces at ${Math.round(counters.bounceRate * 100)} percent over the last ${BOUNCE_WINDOW} letters, sending is paused until unblocked by hand`,
    });
  }

  return blockers;
}

/** Record the fact of sending: the daily counter and the time of the last letter. */
export async function noteSent(now = new Date()): Promise<void> {
  const db = getDb();
  const day = localDay(now);
  await db
    .insert(sendLog)
    .values({ day, count: 1, lastSentAt: now.getTime() })
    .onConflictDoUpdate({
      target: sendLog.day,
      set: { count: sql`${sendLog.count} + 1`, lastSentAt: now.getTime() },
    });
}
