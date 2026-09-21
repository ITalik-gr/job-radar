import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companyState, contacts, outreach } from '../db/schema.js';
import { threadMessages, type ThreadMessage } from '../lib/gmail.js';
import { log } from '../lib/log.js';
import { notify } from '../notify/telegram.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';

/**
 * Detecting replies and bounces, section 5 of OUTREACH.md.
 *
 * Cheap checks go first: a mailer-daemon sender, the auto-responder header, "out of office" in the
 * subject. The model is asked only when a letter really looks like a live human reply, because
 * those are few, while auto-replies and bounces are the majority.
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

/** Phrasings that tell hard from soft without parsing SMTP codes. */
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
  // Soft by default: a temporary error is no reason to hide an address forever.
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

/** An auto-reply shows in the headers and subject, no need to pay a model for it. Ukrainian phrases included. */
export function detectAuto(message: ThreadMessage): ReplyKind | null {
  if (message.autoSubmitted && message.autoSubmitted.toLowerCase() !== 'no') return 'autoreply';
  const subject = message.subject.toLowerCase();
  if (OOO_HINTS.some((hint) => subject.includes(hint))) return 'ooo';
  if (subject.includes('automatic reply') || subject.includes('autoreply')) return 'autoreply';
  return null;
}

const CLASSIFY_PROMPT = [
  'Classify a reply to a cold letter from a developer.',
  'Return STRICTLY JSON with no markdown: {"type": "positive|rejection|autoreply|ooo|unclear"}',
  'positive is interest, a request for details, an offer to talk.',
  'rejection is a refusal, "not hiring right now", "not a fit".',
  'autoreply is an automatic reply, ooo is out of office.',
  'unclear is everything else.',
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
 * The reply type. Deterministic signs first, and only then the model: a short prompt is cheap, but
 * a call for every auto-reply is a bill for nothing.
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
    log.warn({ err: String(error) }, 'reply classification failed');
    return 'unclear';
  }
}

/** Company state after a reply. An auto-reply means nothing, hence null. */
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
 * Walks every sent letter without a reply. Cron runs it hourly.
 *
 * The owner's own letters in a thread are skipped by sender address: a follow-up thread has two of
 * them, and without this check the system would count its own letter as a reply.
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
       * A hard bounce kills the address, not the company: it may have another contact, and blocking
       * the whole company over one dead mailbox would lose it forever because of someone else's turnover.
       */
      if (bounce.type === 'hard' && row.contactEmail) {
        await db
          .update(contacts)
          .set({ emailValid: false })
          .where(eq(contacts.email, row.contactEmail));
        log.warn({ email: row.contactEmail }, 'address marked dead after a hard bounce');
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

    // A positive reply is the only thing worth interrupting a person for right away.
    if (type === 'positive') {
      await notify.raw(`Positive reply: ${row.contactEmail ?? 'no address'}`);
    }
  }

  log.info(report, 'reply check finished');
  return report;
}

/** Bounce share over the last N letters. The basis of the emergency stop and the interface banner. */
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
