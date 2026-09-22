import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companyState, outreach } from '../db/schema.js';
import { deliver } from '../lib/mailer.js';
import { log } from '../lib/log.js';
import { checkSend, noteSent, type Blocker } from './send-guards.js';

/**
 * Відправка одного листа. Тільки одного і тільки по явній команді людини.
 *
 * Режиму автопілота тут немає і не буде, розділ 0 OUTREACH.md. Це не спрощення
 * реалізації: масова автовідправка з особистого Gmail закінчується блокуванням
 * акаунта, і прапорець у конфізі, який це вмикає, рано чи пізно вмикають.
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
   * Перевірка стоїть тут, а не в роуті API. Той самий шлях використовує CLI, і
   * запобіжник, який знає лише кнопка, не є запобіжником.
   */
  const blockers = await checkSend(id, now);
  if (blockers.length > 0) return { sent: false, blockers };

  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) return { sent: false, blockers: [{ code: 'missing', message: 'чернетки немає' }] };

  // Фолоу-ап іде тим самим тредом, інакше він читається як друга розсилка.
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

    log.info({ id, to: draft.contactEmail }, 'лист відправлено');
    return { sent: true, blockers: [], messageId: result.messageId, threadId: result.threadId };
  } catch (error) {
    /*
     * Помилка відправки лишає лист у стані `failed` з текстом причини, а не
     * мовчки повертає чернетку в чергу. Інакше той самий лист піде на другу
     * спробу, і людина не дізнається, що перша впала.
     */
    const message = error instanceof Error ? error.message : String(error);
    await db.update(outreach).set({ status: 'failed', error: message }).where(eq(outreach.id, id));
    log.error({ id, err: message }, 'лист не відправлено');
    return { sent: false, blockers: [{ code: 'gmail', message }] };
  }
}

/** Після листа компанія стає contacted, інакше вона знову випливе в черзі. */
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

/** Повернути невдалий лист у чернетки після того, як причину усунули. */
export async function retryDraft(id: number): Promise<void> {
  const db = getDb();
  await db.update(outreach).set({ status: 'draft', error: null }).where(eq(outreach.id, id));
}
