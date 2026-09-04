import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companyState, contacts, outreach } from '../db/schema.js';
import { threadMessages, type ThreadMessage } from '../lib/gmail.js';
import { log } from '../lib/log.js';
import { notify } from '../notify/telegram.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';

/**
 * Детекція відповідей і баунсів, розділ 5 OUTREACH.md.
 *
 * Дешеві перевірки стоять першими: відправник mailer-daemon, заголовок
 * автовідповідача, слова "out of office" в темі. Модель питається лише тоді,
 * коли лист справді схожий на живу відповідь людини, бо саме таких одиниці,
 * а автовідповідей і баунсів більшість.
 */

export const REPLY_TYPES = ['positive', 'rejection', 'autoreply', 'ooo', 'unclear'] as const;
export type ReplyKind = (typeof REPLY_TYPES)[number];

export type BounceKind = 'hard' | 'soft';

const BOUNCE_SENDERS = ['mailer-daemon@', 'postmaster@'];

const BOUNCE_SUBJECTS = [
  'delivery status notification',
  'undelivered',
  'returned mail',
  'delivery incomplete',
  'mail delivery failed',
  'undeliverable',
];

/** Формулювання, за якими hard і soft відрізняються без розбору SMTP-кодів. */
const HARD_BOUNCE_HINTS = [
  'address not found',
  'user unknown',
  'no such user',
  'does not exist',
  'recipient rejected',
  '550',
  '5.1.1',
];

export interface BounceCheck {
  isBounce: boolean;
  type: BounceKind | null;
}

export function detectBounce(message: ThreadMessage): BounceCheck {
  const from = message.from.toLowerCase();
  const subject = message.subject.toLowerCase();

  const looksLikeBounce =
    BOUNCE_SENDERS.some((sender) => from.includes(sender)) ||
    BOUNCE_SUBJECTS.some((phrase) => subject.includes(phrase));

  if (!looksLikeBounce) return { isBounce: false, type: null };

  const text = `${subject} ${message.snippet}`.toLowerCase();
  const hard = HARD_BOUNCE_HINTS.some((hint) => text.includes(hint));
  // Soft за замовчуванням: тимчасова помилка не привід ховати адресу назавжди.
  return { isBounce: true, type: hard ? 'hard' : 'soft' };
}

const OOO_HINTS = [
  'out of office',
  'ooo',
  'annual leave',
  'vacation',
  'у відпустці',
  'відпустка',
];

/** Автовідповідь видно з заголовків і теми, і за неї не треба платити моделі. */
export function detectAuto(message: ThreadMessage): ReplyKind | null {
  if (message.autoSubmitted && message.autoSubmitted.toLowerCase() !== 'no') return 'autoreply';
  const subject = message.subject.toLowerCase();
  if (OOO_HINTS.some((hint) => subject.includes(hint))) return 'ooo';
  if (subject.includes('automatic reply') || subject.includes('autoreply')) return 'autoreply';
  return null;
}

const CLASSIFY_PROMPT = [
  'Класифікуй відповідь на холодний лист розробника.',
  'Поверни СТРОГО JSON без markdown: {"type": "positive|rejection|autoreply|ooo|unclear"}',
  'positive це інтерес, запит деталей, пропозиція поговорити.',
  'rejection це відмова, "зараз не шукаємо", "не підходить".',
  'autoreply це автоматична відповідь, ooo це відсутність в офісі.',
  'unclear це все інше.',
].join('\n');

export type ReplyClassifier = (text: string) => Promise<ReplyKind>;

async function classifyWithModel(text: string): Promise<ReplyKind> {
  if ((await remainingBudget()) <= 0) return 'unclear';
  const raw = await callModelWith(CLASSIFY_PROMPT, text.slice(0, 1500));
  await noteLlmCall(raw.inputTokens, raw.outputTokens);

  const parsed = extractJson(raw.text) as { type?: string };
  return REPLY_TYPES.includes(parsed.type as ReplyKind) ? (parsed.type as ReplyKind) : 'unclear';
}

/**
 * Тип відповіді. Спершу детерміновані ознаки, і тільки потім модель: короткий
 * промпт дешевий, але виклик на кожну автовідповідь це рахунок ні за що.
 */
export async function classifyReply(
  message: ThreadMessage,
  classifier: ReplyClassifier = classifyWithModel,
): Promise<ReplyKind> {
  const auto = detectAuto(message);
  if (auto) return auto;

  try {
    return await classifier(`${message.subject}\n\n${message.snippet}`);
  } catch (error) {
    log.warn({ err: String(error) }, 'класифікація відповіді впала');
    return 'unclear';
  }
}

/** Стан компанії після відповіді. Автовідповідь нічого не означає, тому null. */
const STATUS_BY_REPLY: Record<ReplyKind, string | null> = {
  positive: 'replied',
  rejection: 'rejected_by_them',
  autoreply: null,
  ooo: null,
  unclear: null,
};

export interface CheckRepliesReport {
  checked: number;
  replies: number;
  bounces: number;
  errors: string[];
}

/**
 * Обхід усіх надісланих листів без відповіді. Крон раз на годину.
 *
 * Власні листи в треді пропускаються за адресою відправника: у треді фолоу-апу
 * їх двоє, і без цієї перевірки система порахувала б власний лист відповіддю.
 */
export async function checkReplies(
  options: {
    fetchThread?: (threadId: string) => Promise<ThreadMessage[]>;
    classifier?: ReplyClassifier;
    ownEmail?: string;
    now?: Date;
  } = {},
): Promise<CheckRepliesReport> {
  const db = getDb();
  const fetchThread = options.fetchThread ?? threadMessages;
  const now = options.now ?? new Date();
  const own = (options.ownEmail ?? '').toLowerCase();

  const pending = await db
    .select()
    .from(outreach)
    .where(
      and(
        eq(outreach.status, 'sent'),
        isNull(outreach.replyAt),
        isNotNull(outreach.gmailThreadId),
      ),
    );

  const report: CheckRepliesReport = { checked: 0, replies: 0, bounces: 0, errors: [] };

  for (const row of pending) {
    report.checked += 1;
    let messages: ThreadMessage[];
    try {
      messages = await fetchThread(row.gmailThreadId!);
    } catch (error) {
      report.errors.push(`${row.id}: ${String(error)}`);
      continue;
    }

    const incoming = messages.filter(
      (message) => !own || !message.from.toLowerCase().includes(own),
    );
    if (incoming.length === 0) continue;

    const message = incoming[incoming.length - 1]!;
    const bounce = detectBounce(message);

    if (bounce.isBounce) {
      report.bounces += 1;
      await db
        .update(outreach)
        .set({
          status: 'bounced',
          bounceType: bounce.type,
          replyAt: now.getTime(),
          replyType: null,
        })
        .where(eq(outreach.id, row.id));

      /*
       * Hard bounce вбиває адресу, але не компанію: у неї може бути інший
       * контакт, і блокувати всю компанію через одну мертву скриньку означало б
       * втратити її назавжди через чужу плинність кадрів.
       */
      if (bounce.type === 'hard' && row.contactEmail) {
        await db
          .update(contacts)
          .set({ emailValid: false })
          .where(eq(contacts.email, row.contactEmail));
        log.warn({ email: row.contactEmail }, 'адреса позначена мертвою після hard bounce');
      }
      continue;
    }

    const type = await classifyReply(message, options.classifier);
    report.replies += 1;

    await db
      .update(outreach)
      .set({ status: 'replied', replyAt: now.getTime(), replyType: type })
      .where(eq(outreach.id, row.id));

    const status = STATUS_BY_REPLY[type];
    if (status) {
      await db
        .update(companyState)
        .set({ status, updatedAt: now.getTime() })
        .where(eq(companyState.companyId, row.companyId));
    }

    // Позитивна відповідь це єдине, заради чого варто відволікати людину одразу.
    if (type === 'positive') {
      await notify.raw(`Позитивна відповідь: ${row.contactEmail ?? 'без адреси'}`);
    }
  }

  log.info(report, 'перевірка відповідей завершена');
  return report;
}

/** Частка баунсів за останні N листів. Основа стоп-крана і плашки в інтерфейсі. */
export async function recentBounceRate(window = 50): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ bounceType: outreach.bounceType, status: outreach.status })
    .from(outreach)
    .where(isNotNull(outreach.sentAt))
    .orderBy(sql`${outreach.sentAt} desc`)
    .limit(window);

  if (rows.length === 0) return 0;
  return rows.filter((row) => row.bounceType === 'hard' || row.status === 'bounced').length / rows.length;
}
