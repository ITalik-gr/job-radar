import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, contacts, outreach, sendLog, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  BOUNCE_RATE_LIMIT,
  bounceRate,
  checkSend,
  countLinks,
  dailyLimit,
  daysBetween,
  hasUnfilledPlaceholder,
  isSendWindow,
  kyivDay,
  letterBlockers,
  noteSent,
  sendCounters,
  wordCount,
  MAX_LINKS,
} from '../src/pipeline/send-guards.js';
import { sendDraft } from '../src/pipeline/send.js';

/**
 * Gmail is stubbed: the test checks our own logic, not Google's mail. A live letter is sent with
 * `pnpm cli gmail:test`, and that is deliberately a manual action.
 */
const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock('../src/lib/gmail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/gmail.js')>()),
  sendMessage: sendMessageMock,
}));

/**
 * Every guard from section 9 of OUTREACH.md has its own test. The cost of a mistake here is not an
 * interface bug but the owner's blocked personal Gmail.
 */

let acme: Company;
let other: Company;

/** Tuesday, 12:00 Kyiv time. Working hours, every time check is open. */
const WORKDAY = new Date('2026-09-08T09:00:00Z');

async function makeDraft(over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await getDb()
    .insert(outreach)
    .values({
      companyId: acme.id,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: Date.now(),
      contactEmail: 'anton@acme.com',
      contactName: 'Anton',
      subjectFinal: 'Front-end for Acme',
      bodyFinal: 'Вітаю, Антоне.\n\nКоротко про справу.\n\nOlena',
      ...over,
    })
    .returning({ id: outreach.id });
  return row!.id;
}

async function reset(): Promise<void> {
  sendMessageMock.mockReset();
  const db = getDb();
  await db.delete(outreach);
  await db.delete(sendLog);
  await db.update(companyState).set({ status: 'new' });
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
  other = (await upsertCompany({ name: 'Beta', domain: 'beta.com', source: 'test' })).company;
  await getDb()
    .insert(contacts)
    .values({ companyId: acme.id, name: 'Anton', email: 'anton@acme.com' });
});

beforeEach(reset);

describe('send time', () => {
  it('a weekday noon in Kyiv is open', () => {
    expect(isSendWindow(WORKDAY)).toBe(true);
  });

  it('night is closed: 23:00 in Kyiv', () => {
    expect(isSendWindow(new Date('2026-09-08T20:00:00Z'))).toBe(false);
  });

  it('an early morning hour is closed: 07:00 in Kyiv', () => {
    expect(isSendWindow(new Date('2026-09-08T04:00:00Z'))).toBe(false);
  });

  it('Saturday is closed even in the daytime', () => {
    expect(isSendWindow(new Date('2026-09-12T09:00:00Z'))).toBe(false);
  });

  it('Sunday is closed', () => {
    expect(isSendWindow(new Date('2026-09-13T09:00:00Z'))).toBe(false);
  });

  it('the Kyiv day follows Kyiv time, not UTC', () => {
    // 22:30 UTC is already the next day in Kyiv, and the daily limit has to see that.
    expect(kyivDay(new Date('2026-09-08T22:30:00Z'))).toBe('2026-09-09');
  });
});

describe('limit warmup', () => {
  it.each([
    [1, 5],
    [3, 5],
    [4, 10],
    [7, 10],
    [8, 20],
    [90, 20],
  ])('day %i gives a limit of %i', (day, limit) => {
    expect(dailyLimit(day)).toBe(limit);
  });

  it('the first day counts as day 1, not 0', () => {
    expect(daysBetween('2026-09-08', '2026-09-08')).toBe(1);
    expect(daysBetween('2026-09-08', '2026-09-11')).toBe(4);
  });
});

describe('letter text', () => {
  it('a letter longer than 160 words does not go', () => {
    const long = 'word '.repeat(200);
    expect(letterBlockers('Subject', long).map((b) => b.code)).toContain('length');
    expect(wordCount(long)).toBe(200);
  });

  /*
   * The limit comes from the constant rather than a number written into the test: MAX_LINKS is a
   * matter of taste, and changing the threshold must not break the check of the mechanism itself.
   */
  it('more links than allowed, and the letter does not go', () => {
    const body = ['Portfolio olena.dev', 'https://github.com/olena-koval']
      .concat(Array.from({ length: MAX_LINKS }, (_, i) => `https://example${i}.com/case`))
      .join(' and also ');

    expect(countLinks(body)).toBeGreaterThan(MAX_LINKS);
    expect(letterBlockers('Subject', body).map((b) => b.code)).toContain('links');
  });

  it('exactly as many links as allowed is not a blocker', () => {
    const body = Array.from({ length: MAX_LINKS }, (_, i) => `https://example${i}.com`).join(' ');
    expect(countLinks(body)).toBe(MAX_LINKS);
    expect(letterBlockers('Subject', body).map((b) => b.code)).not.toContain('links');
  });

  it('a technology name does not count as a link', () => {
    expect(countLinks('Stack: next.js and node.js, portfolio olena.dev')).toBe(1);
  });

  it('an email in the signature does not count as a link', () => {
    expect(countLinks('olena.dev\nolena@example.com')).toBe(1);
  });

  it('an unfilled placeholder stops sending', () => {
    expect(hasUnfilledPlaceholder('Вітаю, {{first_name}}')).toBe(true);
    expect(hasUnfilledPlaceholder('[другий абзац]')).toBe(true);
    expect(hasUnfilledPlaceholder('Вітаю, Антоне')).toBe(false);
  });

  it('an empty subject and an empty body are two separate reasons', () => {
    expect(letterBlockers('', '').map((b) => b.code)).toEqual(
      expect.arrayContaining(['subject', 'body']),
    );
  });
});

describe('bounces', () => {
  it('two hard bounces over 50 letters is above the threshold', () => {
    const rows = [
      ...Array.from({ length: 48 }, () => ({ bounceType: null, status: 'sent' })),
      { bounceType: 'hard', status: 'bounced' },
      { bounceType: 'hard', status: 'bounced' },
    ];
    expect(bounceRate(rows)).toBeGreaterThan(BOUNCE_RATE_LIMIT);
  });

  it('an empty history is zero, not a division by zero', () => {
    expect(bounceRate([])).toBe(0);
  });
});

describe('checkSend', () => {
  it('a ready draft during working hours has no objections', async () => {
    expect(await checkSend(await makeDraft(), WORKDAY)).toEqual([]);
  });

  it('a blacklisted company', async () => {
    const id = await makeDraft();
    await getDb().update(companyState).set({ status: 'blacklist' }).where(eq(companyState.companyId, acme.id));
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('company_status');
  });

  it('a recent letter to the same company blocks a repeat', async () => {
    await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() - 7 * 86_400_000 });
    const id = await makeDraft();
    const codes = (await checkSend(id, WORKDAY)).map((b) => b.code);
    expect(codes).toContain('recontact');
  });

  it('a letter from long ago does not block a repeat', async () => {
    await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() - 200 * 86_400_000 });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).not.toContain('recontact');
  });

  it('an address with a hard bounce gets no more letters', async () => {
    await makeDraft({
      companyId: other.id,
      status: 'bounced',
      bounceType: 'hard',
      sentAt: WORKDAY.getTime() - 200 * 86_400_000,
    });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('hard_bounce');
  });

  it('the daily limit is reached', async () => {
    await getDb().insert(sendLog).values({ day: kyivDay(WORKDAY), count: 5, lastSentAt: WORKDAY.getTime() - 600_000 });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('daily_limit');
  });

  it('a three minute pause between letters', async () => {
    await getDb()
      .insert(sendLog)
      .values({ day: kyivDay(WORKDAY), count: 1, lastSentAt: WORKDAY.getTime() - 60_000 });
    const id = await makeDraft();
    const gap = (await checkSend(id, WORKDAY)).find((b) => b.code === 'gap');
    expect(gap?.retryAt).toBe(WORKDAY.getTime() - 60_000 + 180_000);
  });

  it('nothing is sent at night', async () => {
    const id = await makeDraft();
    const night = new Date('2026-09-08T21:00:00Z');
    expect((await checkSend(id, night)).map((b) => b.code)).toContain('quiet_hours');
  });

  it('a bounce rate above the threshold stops everything', async () => {
    for (let i = 0; i < 20; i += 1) {
      await makeDraft({
        companyId: other.id,
        status: i < 2 ? 'bounced' : 'sent',
        bounceType: i < 2 ? 'hard' : null,
        contactEmail: `person${i}@beta.com`,
        sentAt: WORKDAY.getTime() - 200 * 86_400_000,
      });
    }
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('bounce_rate');
  });

  it('a second follow-up is not allowed', async () => {
    const original = await makeDraft({
      status: 'sent',
      sentAt: WORKDAY.getTime() - 200 * 86_400_000,
    });
    await makeDraft({
      status: 'sent',
      followupOf: original,
      sentAt: WORKDAY.getTime() - 190 * 86_400_000,
    });
    const second = await makeDraft({ followupOf: original });
    expect((await checkSend(second, WORKDAY)).map((b) => b.code)).toContain('followup');
  });

  it('the first follow-up does not trip over the 90 day rule', async () => {
    const original = await makeDraft({
      status: 'sent',
      sentAt: WORKDAY.getTime() - 8 * 86_400_000,
    });
    const followup = await makeDraft({ followupOf: original });
    expect((await checkSend(followup, WORKDAY)).map((b) => b.code)).not.toContain('recontact');
  });

  it('a sent letter is not sent again', async () => {
    const id = await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() });
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('status');
  });

  it('a draft without an address does not exist for sending', async () => {
    const id = await makeDraft({ contactEmail: null });
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('address');
  });
});

describe('counters', () => {
  it('an empty day is zero out of the warmup limit', async () => {
    const counters = await sendCounters(WORKDAY);
    expect(counters).toMatchObject({ sentToday: 0, limit: 5, nextAllowedAt: null, windowOpen: true });
  });

  it('sending increments the counter and sets the pause', async () => {
    await noteSent(WORKDAY);
    const counters = await sendCounters(WORKDAY);
    expect(counters.sentToday).toBe(1);
    expect(counters.nextAllowedAt).toBe(WORKDAY.getTime() + 180_000);
    expect(counters.windowOpen).toBe(false);
  });

  it('at night the window is closed, even when the limit is not reached', async () => {
    expect((await sendCounters(new Date('2026-09-08T21:00:00Z'))).windowOpen).toBe(false);
  });
});

describe('sendDraft', () => {
  it('a blocked draft never reaches Gmail', async () => {
    const id = await makeDraft({ bodyFinal: 'Вітаю, {{first_name}}' });
    const outcome = await sendDraft(id, WORKDAY);
    expect(outcome.sent).toBe(false);
    expect(outcome.blockers.map((b) => b.code)).toContain('placeholder');

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row?.status).toBe('draft');
  });

  it('a successful send writes the ids, the counter and the company state', async () => {
    sendMessageMock.mockResolvedValue({
      messageId: 'm1',
      threadId: 't1',
      rfcMessageId: '<abc@mail.gmail.com>',
    });

    const id = await makeDraft();
    const outcome = await sendDraft(id, WORKDAY);
    expect(outcome.sent).toBe(true);

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row).toMatchObject({
      status: 'sent',
      gmailMessageId: 'm1',
      gmailThreadId: 't1',
      rfcMessageId: '<abc@mail.gmail.com>',
    });
    expect(row?.sentAt).toBe(WORKDAY.getTime());

    const [state] = await getDb()
      .select()
      .from(companyState)
      .where(eq(companyState.companyId, acme.id));
    expect(state?.status).toBe('contacted');
    expect((await sendCounters(WORKDAY)).sentToday).toBe(1);
  });

  it('a follow-up goes in the original thread with the right headers', async () => {
    sendMessageMock.mockResolvedValue({
      messageId: 'm2',
      threadId: 't1',
      rfcMessageId: '<second@mail.gmail.com>',
    });

    const original = await makeDraft({
      status: 'sent',
      sentAt: WORKDAY.getTime() - 8 * 86_400_000,
      gmailThreadId: 't1',
      rfcMessageId: '<first@mail.gmail.com>',
    });
    const followup = await makeDraft({ followupOf: original });

    await sendDraft(followup, WORKDAY);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't1',
        inReplyTo: '<first@mail.gmail.com>',
        references: ['<first@mail.gmail.com>'],
      }),
    );
  });

  it('a Gmail error leaves the letter failed with a reason, not silently among drafts', async () => {
    sendMessageMock.mockRejectedValue(new Error('403 quota'));

    const id = await makeDraft();
    const outcome = await sendDraft(id, WORKDAY);
    expect(outcome.sent).toBe(false);

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('403 quota');
  });
});
