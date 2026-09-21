import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, contacts, outreach, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  checkReplies,
  classifyReply,
  detectAuto,
  detectBounce,
  recentBounceRate,
} from '../src/pipeline/replies.js';
import type { ThreadMessage } from '../src/lib/gmail.js';

let acme: Company;

const OWN = 'olena@example.com';
const NOW = new Date('2026-09-10T09:00:00Z');

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'x1',
    from: 'Anton <anton@acme.com>',
    subject: 'Re: Front-end for Acme',
    date: 'Thu, 10 Sep 2026 12:00:00 +0300',
    snippet: 'Дякую, давайте поговоримо наступного тижня.',
    autoSubmitted: null,
    ...over,
  };
}

async function sentLetter(over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await getDb()
    .insert(outreach)
    .values({
      companyId: acme.id,
      channel: 'email',
      status: 'sent',
      sentAt: NOW.getTime() - 86_400_000,
      gmailThreadId: 't1',
      contactEmail: 'anton@acme.com',
      subjectFinal: 'Front-end for Acme',
      bodyFinal: 'текст',
      ...over,
    })
    .returning({ id: outreach.id });
  return row!.id;
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
  await getDb()
    .insert(contacts)
    .values({ companyId: acme.id, name: 'Anton', email: 'anton@acme.com' });
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(outreach);
  await db.update(contacts).set({ emailValid: true });
  await db.update(companyState).set({ status: 'new' });
});

describe('баунси', () => {
  it('mailer-daemon з "address not found" це hard', () => {
    expect(
      detectBounce(
        message({
          from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
          subject: 'Delivery Status Notification (Failure)',
          snippet: 'Address not found. Your message was not delivered',
        }),
      ),
    ).toEqual({ isBounce: true, type: 'hard' });
  });

  it('тимчасова помилка це soft, адреса лишається живою', () => {
    expect(
      detectBounce(
        message({
          from: 'postmaster@acme.com',
          subject: 'Undelivered Mail Returned to Sender',
          snippet: 'mailbox full, try again later',
        }),
      ),
    ).toEqual({ isBounce: true, type: 'soft' });
  });

  it('звичайна відповідь не баунс', () => {
    expect(detectBounce(message()).isBounce).toBe(false);
  });
});

describe('автовідповіді', () => {
  it('заголовок Auto-Submitted достатній, модель не потрібна', () => {
    expect(detectAuto(message({ autoSubmitted: 'auto-replied' }))).toBe('autoreply');
  });

  it('out of office у темі це ooo', () => {
    expect(detectAuto(message({ subject: 'Out of office until Monday' }))).toBe('ooo');
  });

  it('жива відповідь не має ознак автомата', () => {
    expect(detectAuto(message())).toBeNull();
  });

  it('автовідповідь не доходить до моделі', async () => {
    const classifier = vi.fn();
    expect(await classifyReply(message({ autoSubmitted: 'auto-generated' }), classifier)).toBe(
      'autoreply',
    );
    expect(classifier).not.toHaveBeenCalled();
  });

  it('падіння класифікатора дає unclear, а не помилку', async () => {
    const classifier = vi.fn().mockRejectedValue(new Error('502'));
    expect(await classifyReply(message(), classifier)).toBe('unclear');
  });
});

describe('checkReplies', () => {
  it('позитивна відповідь міняє статус листа і компанії', async () => {
    const id = await sentLetter();
    const report = await checkReplies({
      fetchThread: async () => [message({ from: OWN }), message()],
      classifier: async () => 'positive',
      ownEmail: OWN,
      now: NOW,
    });

    expect(report).toMatchObject({ checked: 1, replies: 1, bounces: 0 });

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row).toMatchObject({ status: 'replied', replyType: 'positive' });
    expect(row?.replyAt).toBe(NOW.getTime());

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, acme.id));
    expect(state?.status).toBe('replied');
  });

  it('відмова переводить компанію в rejected_by_them', async () => {
    await sentLetter();
    await checkReplies({
      fetchThread: async () => [message()],
      classifier: async () => 'rejection',
      ownEmail: OWN,
      now: NOW,
    });

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, acme.id));
    expect(state?.status).toBe('rejected_by_them');
  });

  it('автовідповідь не міняє стан компанії', async () => {
    await sentLetter();
    await checkReplies({
      fetchThread: async () => [message({ autoSubmitted: 'auto-replied' })],
      ownEmail: OWN,
      now: NOW,
    });

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, acme.id));
    expect(state?.status).toBe('new');
  });

  it('hard bounce вбиває адресу, але не компанію', async () => {
    const id = await sentLetter();
    await checkReplies({
      fetchThread: async () => [
        message({
          from: 'mailer-daemon@googlemail.com',
          subject: 'Delivery Status Notification',
          snippet: 'user unknown',
        }),
      ],
      ownEmail: OWN,
      now: NOW,
    });

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row).toMatchObject({ status: 'bounced', bounceType: 'hard' });

    const [contact] = await getDb()
      .select()
      .from(contacts)
      .where(eq(contacts.email, 'anton@acme.com'));
    expect(contact?.emailValid).toBe(false);

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, acme.id));
    expect(state?.status).toBe('new');
  });

  it('тред тільки з власними листами це ще не відповідь', async () => {
    await sentLetter();
    const report = await checkReplies({
      fetchThread: async () => [message({ from: `Olena <${OWN}>` })],
      ownEmail: OWN,
      now: NOW,
    });
    expect(report.replies).toBe(0);
  });

  it('лист із уже відомою відповіддю вдруге не перевіряється', async () => {
    await sentLetter({ replyAt: NOW.getTime(), replyType: 'positive', status: 'replied' });
    const report = await checkReplies({ fetchThread: async () => [message()], ownEmail: OWN, now: NOW });
    expect(report.checked).toBe(0);
  });

  it('помилка Gmail не зупиняє обхід решти листів', async () => {
    await sentLetter({ gmailThreadId: 't1' });
    await sentLetter({ gmailThreadId: 't2' });
    const report = await checkReplies({
      fetchThread: async (threadId) => {
        if (threadId === 't1') throw new Error('404');
        return [message()];
      },
      classifier: async () => 'positive',
      ownEmail: OWN,
      now: NOW,
    });
    expect(report).toMatchObject({ checked: 2, replies: 1 });
    expect(report.errors).toHaveLength(1);
  });
});

describe('баунс-рейт', () => {
  it('рахується по останніх листах', async () => {
    await sentLetter({ status: 'bounced', bounceType: 'hard' });
    await sentLetter();
    await sentLetter();
    await sentLetter();
    expect(await recentBounceRate(50)).toBeCloseTo(0.25);
  });

  it('без листів це нуль', async () => {
    expect(await recentBounceRate(50)).toBe(0);
  });
});
