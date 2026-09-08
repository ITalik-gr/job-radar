import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companyState, outreach, sendLog } from '../db/schema.js';
import { BLOCKED_STATUSES, RECONTACT_DAYS } from './outreach.js';

/**
 * Запобіжники відправки, розділ 9 OUTREACH.md.
 *
 * Кожен це окрема функція з окремим тестом, і жоден не живе всередині
 * UI-хендлера. Причина проста: перевірка, вписана в обробник кнопки, існує рівно
 * доти, доки ніхто не додав другу кнопку. А ціна помилки тут не бага в інтерфейсі,
 * а зіпсована репутація відправника і заблокований особистий Gmail.
 */

/**
 * Денна стеля зашита константою, а не налаштуванням в інтерфейсі. Це навмисно:
 * поле, яке можна підняти в момент азарту, не є запобіжником.
 */
export const DAILY_SEND_LIMIT = 20;

/** Прогрів: перші три дні по 5 листів, дні 4-7 по 10, далі повна стеля. */
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
  /** Коли перевірка сама себе відпустить. Для таймера в інтерфейсі. */
  retryAt?: number;
}

/** Київський календарний день у форматі YYYY-MM-DD. Доба ліміту саме київська. */
export function kyivDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

interface KyivClock {
  hour: number;
  /** 0 це неділя, як у Date.getDay. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function kyivClock(date: Date): KyivClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const weekday = WEEKDAYS.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? 'Mon');
  // 24 замість 0 віддає Intl опівночі, і без цього нічна перевірка мовчки ламається.
  return { hour: hour === 24 ? 0 : hour, weekday };
}

/**
 * Робоче вікно: будній день з 08:00 до 22:00 за Києвом.
 *
 * Лист у суботу вночі виглядає як бот навіть тоді, коли текст написала людина,
 * і саме так його прочитає одержувач.
 */
export function isSendWindow(date: Date): boolean {
  const { hour, weekday } = kyivClock(date);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= QUIET_HOUR_END && hour < QUIET_HOUR_START;
}

/** Скільки листів дозволено сьогодні з урахуванням прогріву. */
export function dailyLimit(daysSinceFirstSend: number): number {
  const day = Math.max(1, daysSinceFirstSend);
  for (const step of WARMUP_STEPS) {
    if (day <= step.untilDay) return step.limit;
  }
  return DAILY_SEND_LIMIT;
}

/** Різниця в календарних днях, а не в добах: прогрів рахується по датах. */
export function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Розширення файлів і назв технологій, які виглядають як домен, але ним не є. */
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

/** Посилання рахуються і як http, і як голий домен: в очах фільтра це те саме. */
export function countLinks(text: string): number {
  // Пошта в підписі це не посилання, тому адреси прибираються до підрахунку:
  // інакше you@example.com дає одразу дві "зайві" згадки домену.
  const withoutEmails = text.replace(/[^\s<>()]+@[^\s<>()]+/g, ' ');
  const matches = withoutEmails.match(/(https?:\/\/\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)/gi) ?? [];
  const unique = new Set(
    matches
      .map((item) => item.replace(/^https?:\/\//i, '').replace(/[.,);]+$/, '').toLowerCase())
      // next.js, node.js і сусіди це назви технологій, а не посилання. Без цього
      // лист, де згадано стек, блокувався б за "два посилання" на порожньому місці.
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
 * Текст листа сам по собі, без бази. Ці три перевірки потрібні і в редакторі
 * шаблонів, і перед відправкою, і саме тому вони окремо.
 */
export function letterBlockers(subject: string, body: string): Blocker[] {
  const blockers: Blocker[] = [];
  if (!subject.trim()) blockers.push({ code: 'subject', message: 'порожня тема' });
  if (!body.trim()) blockers.push({ code: 'body', message: 'порожнє тіло листа' });
  if (hasUnfilledPlaceholder(`${subject}\n${body}`)) {
    blockers.push({ code: 'placeholder', message: 'у листі лишився незаповнений плейсхолдер' });
  }
  if (wordCount(body) > MAX_WORDS) {
    blockers.push({ code: 'length', message: `лист довший за ${MAX_WORDS} слів` });
  }
  if (countLinks(body) > MAX_LINKS) {
    blockers.push({ code: 'links', message: `більше ніж ${MAX_LINKS} посилання в тілі` });
  }
  return blockers;
}

export interface SendCounters {
  day: string;
  sentToday: number;
  limit: number;
  /** Коли мине пауза в три хвилини. null означає, що можна слати вже. */
  nextAllowedAt: number | null;
  bounceRate: number;
  /** Чи відправка взагалі відкрита зараз: час, ліміт, баунси. */
  windowOpen: boolean;
}

/**
 * Лічильники для шапки сторінки. Окремо від перевірки конкретного листа, бо
 * інтерфейс має показувати "надіслано 7 з 20" ще до того, як щось вибрали.
 */
export async function sendCounters(now = new Date()): Promise<SendCounters> {
  const db = getDb();
  const day = kyivDay(now);

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
 * Повний перелік причин, чому цей лист зараз не піде. Саме перелік, а не перша
 * знайдена: власник має бачити всі три проблеми одразу, а не по одній на клік.
 */
export async function checkSend(draftId: number, now = new Date()): Promise<Blocker[]> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, draftId));
  if (!draft) return [{ code: 'missing', message: `чернетки ${draftId} немає` }];

  const blockers: Blocker[] = [];

  if (draft.status !== 'draft' && draft.status !== 'approved') {
    blockers.push({ code: 'status', message: `лист уже в стані ${draft.status}` });
  }
  if (!draft.contactEmail) {
    blockers.push({ code: 'address', message: 'немає адреси одержувача' });
  }
  blockers.push(...letterBlockers(draft.subjectFinal ?? '', draft.bodyFinal ?? ''));

  const [state] = await db
    .select()
    .from(companyState)
    .where(eq(companyState.companyId, draft.companyId));

  if (state && BLOCKED_STATUSES.includes(state.status)) {
    blockers.push({ code: 'company_status', message: `компанія в стані ${state.status}` });
  }

  /*
   * Повторний лист тій самій компанії. Через квартал це нормально, через тиждень
   * ні, і різниця тут не в ввічливості: другий холодний лист поспіль найчастіше
   * летить у спам разом з усією подальшою перепискою.
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
        message: `цій компанії писали ${days} днів тому, повтор дозволений через ${RECONTACT_DAYS}`,
        retryAt: lastSent.sentAt + RECONTACT_DAYS * 86_400_000,
      });
    }
  }

  // Адреса, яка вже дала hard bounce, мертва назавжди, скільки в неї не пиши.
  if (draft.contactEmail) {
    const [dead] = await db
      .select({ id: outreach.id })
      .from(outreach)
      .where(and(eq(outreach.contactEmail, draft.contactEmail), eq(outreach.bounceType, 'hard')))
      .limit(1);
    if (dead) blockers.push({ code: 'hard_bounce', message: 'ця адреса вже дала hard bounce' });
  }

  // Фолоу-ап рівно один. Другий це вже наполегливість, яка працює проти.
  if (draft.followupOf) {
    const [existing] = await db
      .select({ n: sql<number>`count(*)` })
      .from(outreach)
      .where(and(eq(outreach.followupOf, draft.followupOf), isNotNull(outreach.sentAt)));
    if ((existing?.n ?? 0) > 0) {
      blockers.push({ code: 'followup', message: 'фолоу-ап цій компанії вже пішов' });
    }
  }

  const counters = await sendCounters(now);
  if (counters.sentToday >= counters.limit) {
    blockers.push({
      code: 'daily_limit',
      message: `денний ліміт вичерпано: ${counters.sentToday} з ${counters.limit}`,
    });
  }
  if (counters.nextAllowedAt) {
    blockers.push({
      code: 'gap',
      message: 'від попереднього листа має минути 3 хвилини',
      retryAt: counters.nextAllowedAt,
    });
  }
  if (!isSendWindow(now)) {
    blockers.push({
      code: 'quiet_hours',
      message: 'зараз ніч або вихідний за Києвом, лист виглядатиме як бот',
    });
  }
  if (counters.bounceRate > BOUNCE_RATE_LIMIT) {
    blockers.push({
      code: 'bounce_rate',
      message: `баунси ${Math.round(counters.bounceRate * 100)} відсотків за останні ${BOUNCE_WINDOW} листів, відправка зупинена до ручного розблокування`,
    });
  }

  return blockers;
}

/** Фіксація факту відправки: денний лічильник і час останнього листа. */
export async function noteSent(now = new Date()): Promise<void> {
  const db = getDb();
  const day = kyivDay(now);
  await db
    .insert(sendLog)
    .values({ day, count: 1, lastSentAt: now.getTime() })
    .onConflictDoUpdate({
      target: sendLog.day,
      set: { count: sql`${sendLog.count} + 1`, lastSentAt: now.getTime() },
    });
}
