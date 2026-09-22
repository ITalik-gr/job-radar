import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companyState, outreach } from '../db/schema.js';
import { deliver } from '../lib/mailer.js';
import { log } from '../lib/log.js';
import { checkSend, noteSent, type Blocker } from './send-guards.js';

/**
 * Sending a single letter. Only one, and only on an explicit human command.
 *
 * There is no autopilot mode here and never will be, section 0 of OUTREACH.md. This
 * is not a simplification of the implementation: bulk auto-sending from a personal
 * Gmail account ends in the account getting blocked, and a config flag that turns
 * this on eventually gets turned on.
 */

export interface SendOutcome {
  sent: boolean;
  blockers: Blocker[];
  messageId?: string;
  threadId?: string;
}

export async function sendDraft(id: number, now = new Date()): Promise<SendOutcome> {
  const db = getDb();

  /*
   * The check sits here, not in the API route. The CLI uses this same path, and a
   * safeguard only the button knows about is not a safeguard.
   */
  const blockers = await checkSend(id, now);
  if (blockers.length > 0) return { sent: false, blockers };

  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) return { sent: false, blockers: [{ code: 'missing', message: 'no such draft' }] };

  // A follow-up goes in the same thread, otherwise it reads as a second mailing.
  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];

  if (draft.followupOf) {
    const [original] = await db.select().from(outreach).where(eq(outreach.id, draft.followupOf));
    threadId = original?.gmailThreadId ?? null;
    inReplyTo = original?.rfcMessageId ?? null;
    references = original?.rfcMessageId ? [original.rfcMessageId] : [];
  }

  try {
    const result = await deliver({
      to: draft.contactEmail!,
      subject: draft.subjectFinal ?? '',
      body: draft.bodyFinal ?? '',
      threadId,
      inReplyTo,
      references,
    });

    await db
      .update(outreach)
      .set({
        status: 'sent',
        sentAt: now.getTime(),
        gmailMessageId: result.messageId,
        gmailThreadId: result.threadId,
        rfcMessageId: result.rfcMessageId,
        error: null,
      })
      .where(eq(outreach.id, id));

    await noteSent(now);
    await markContacted(draft.companyId, now);

    log.info({ id, to: draft.contactEmail }, 'letter sent');
    return { sent: true, blockers: [], messageId: result.messageId, threadId: result.threadId };
  } catch (error) {
    /*
     * A send failure leaves the letter in a `failed` state with the reason text,
     * rather than silently returning the draft to the queue. Otherwise the same
     * letter would go out on a second attempt, and the person would never learn the
     * first one failed.
     */
    const message = error instanceof Error ? error.message : String(error);
    await db.update(outreach).set({ status: 'failed', error: message }).where(eq(outreach.id, id));
    log.error({ id, err: message }, 'letter not sent');
    return { sent: false, blockers: [{ code: 'gmail', message }] };
  }
}

/** After a letter the company becomes contacted, otherwise it resurfaces in the queue. */
async function markContacted(companyId: number, now: Date): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(companyState)
    .where(eq(companyState.companyId, companyId));

  if (existing) {
    await db
      .update(companyState)
      .set({ status: 'contacted', updatedAt: now.getTime() })
      .where(eq(companyState.companyId, companyId));
  } else {
    await db.insert(companyState).values({ companyId, status: 'contacted' });
  }
}

/** Return a failed letter to drafts after the cause has been fixed. */
export async function retryDraft(id: number): Promise<void> {
  const db = getDb();
  await db.update(outreach).set({ status: 'draft', error: null }).where(eq(outreach.id, id));
}
