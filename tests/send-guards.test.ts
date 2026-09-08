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
 * Gmail підмінений: тест перевіряє власну логіку, а не пошту Google. Живий лист
 * шлеться командою `pnpm cli gmail:test`, і це свідомо ручна дія.
 */
const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock('../src/lib/gmail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/gmail.js')>()),
  sendMessage: sendMessageMock,
}));

/**
 * Кожен запобіжник з розділу 9 OUTREACH.md має власний тест. Ціна помилки тут
 * не бага в інтерфейсі, а заблокований особистий Gmail власника.
 */

let acme: Company;
let other: Company;

/** Вівторок, 12:00 за Києвом. Робочий час, усі часові перевірки відкриті. */
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
      bodyFinal: 'Вітаю, Антоне.\n\nКоротко про справу.\n\nAlex',
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

describe('час відправки', () => {
  it('будній день опівдні за Києвом відкритий', () => {
    expect(isSendWindow(WORKDAY)).toBe(true);
  });

  it('ніч закрита: 23:00 за Києвом', () => {
    expect(isSendWindow(new Date('2026-09-08T20:00:00Z'))).toBe(false);
  });

  it('рання ранкова година закрита: 07:00 за Києвом', () => {
    expect(isSendWindow(new Date('2026-09-08T04:00:00Z'))).toBe(false);
  });

  it('субота закрита навіть удень', () => {
    expect(isSendWindow(new Date('2026-09-12T09:00:00Z'))).toBe(false);
  });

  it('неділя закрита', () => {
    expect(isSendWindow(new Date('2026-09-13T09:00:00Z'))).toBe(false);
  });

  it('київський день рахується за Києвом, а не за UTC', () => {
    // 22:30 UTC це вже наступна доба в Києві, і денний ліміт це має бачити.
    expect(kyivDay(new Date('2026-09-08T22:30:00Z'))).toBe('2026-09-09');
  });
});

describe('прогрів лімітів', () => {
  it.each([
    [1, 5],
    [3, 5],
    [4, 10],
    [7, 10],
    [8, 20],
    [90, 20],
  ])('день %i дає ліміт %i', (day, limit) => {
    expect(dailyLimit(day)).toBe(limit);
  });

  it('перший день рахується як день 1, а не 0', () => {
    expect(daysBetween('2026-09-08', '2026-09-08')).toBe(1);
    expect(daysBetween('2026-09-08', '2026-09-11')).toBe(4);
  });
});

describe('текст листа', () => {
  it('лист довший за 160 слів не йде', () => {
    const long = 'слово '.repeat(200);
    expect(letterBlockers('Тема', long).map((b) => b.code)).toContain('length');
    expect(wordCount(long)).toBe(200);
  });

  /*
   * Межа береться з константи, а не переписується числом у тесті: MAX_LINKS це
   * налаштування смаку, і зміна порога не має валити перевірку самої механіки.
   */
  it('посилань більше дозволеного, і лист не йде', () => {
    const body = ['Портфоліо example.dev', 'https://github.com/italik']
      .concat(Array.from({ length: MAX_LINKS }, (_, i) => `https://example${i}.com/case`))
      .join(' і ще ');

    expect(countLinks(body)).toBeGreaterThan(MAX_LINKS);
    expect(letterBlockers('Тема', body).map((b) => b.code)).toContain('links');
  });

  it('посилань рівно стільки, скільки дозволено, і це не блокер', () => {
    const body = Array.from({ length: MAX_LINKS }, (_, i) => `https://example${i}.com`).join(' ');
    expect(countLinks(body)).toBe(MAX_LINKS);
    expect(letterBlockers('Тема', body).map((b) => b.code)).not.toContain('links');
  });

  it('назва технології не рахується посиланням', () => {
    expect(countLinks('Стек: next.js і node.js, портфоліо example.dev')).toBe(1);
  });

  it('пошта в підписі не рахується посиланням', () => {
    expect(countLinks('example.dev\nyou@example.com')).toBe(1);
  });

  it('незаповнений плейсхолдер зупиняє відправку', () => {
    expect(hasUnfilledPlaceholder('Вітаю, {{first_name}}')).toBe(true);
    expect(hasUnfilledPlaceholder('[другий абзац]')).toBe(true);
    expect(hasUnfilledPlaceholder('Вітаю, Антоне')).toBe(false);
  });

  it('порожня тема і порожнє тіло це дві окремі причини', () => {
    expect(letterBlockers('', '').map((b) => b.code)).toEqual(
      expect.arrayContaining(['subject', 'body']),
    );
  });
});

describe('баунси', () => {
  it('два hard bounce на 50 листів це вище порогу', () => {
    const rows = [
      ...Array.from({ length: 48 }, () => ({ bounceType: null, status: 'sent' })),
      { bounceType: 'hard', status: 'bounced' },
      { bounceType: 'hard', status: 'bounced' },
    ];
    expect(bounceRate(rows)).toBeGreaterThan(BOUNCE_RATE_LIMIT);
  });

  it('порожня історія це нуль, а не ділення на нуль', () => {
    expect(bounceRate([])).toBe(0);
  });
});

describe('checkSend', () => {
  it('готова чернетка в робочий час не має жодної претензії', async () => {
    expect(await checkSend(await makeDraft(), WORKDAY)).toEqual([]);
  });

  it('компанія в блеклисті', async () => {
    const id = await makeDraft();
    await getDb().update(companyState).set({ status: 'blacklist' }).where(eq(companyState.companyId, acme.id));
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('company_status');
  });

  it('свіжий лист тій самій компанії блокує повтор', async () => {
    await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() - 7 * 86_400_000 });
    const id = await makeDraft();
    const codes = (await checkSend(id, WORKDAY)).map((b) => b.code);
    expect(codes).toContain('recontact');
  });

  it('лист столітньої давності повтору не заважає', async () => {
    await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() - 200 * 86_400_000 });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).not.toContain('recontact');
  });

  it('адреса з hard bounce більше не отримує листів', async () => {
    await makeDraft({
      companyId: other.id,
      status: 'bounced',
      bounceType: 'hard',
      sentAt: WORKDAY.getTime() - 200 * 86_400_000,
    });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('hard_bounce');
  });

  it('денний ліміт вичерпано', async () => {
    await getDb().insert(sendLog).values({ day: kyivDay(WORKDAY), count: 5, lastSentAt: WORKDAY.getTime() - 600_000 });
    const id = await makeDraft();
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('daily_limit');
  });

  it('пауза між листами три хвилини', async () => {
    await getDb()
      .insert(sendLog)
      .values({ day: kyivDay(WORKDAY), count: 1, lastSentAt: WORKDAY.getTime() - 60_000 });
    const id = await makeDraft();
    const gap = (await checkSend(id, WORKDAY)).find((b) => b.code === 'gap');
    expect(gap?.retryAt).toBe(WORKDAY.getTime() - 60_000 + 180_000);
  });

  it('вночі не відправляється', async () => {
    const id = await makeDraft();
    const night = new Date('2026-09-08T21:00:00Z');
    expect((await checkSend(id, night)).map((b) => b.code)).toContain('quiet_hours');
  });

  it('баунс-рейт вище порогу зупиняє все', async () => {
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

  it('другий фолоу-ап не дозволений', async () => {
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

  it('перший фолоу-ап не спотикається об правило 90 днів', async () => {
    const original = await makeDraft({
      status: 'sent',
      sentAt: WORKDAY.getTime() - 8 * 86_400_000,
    });
    const followup = await makeDraft({ followupOf: original });
    expect((await checkSend(followup, WORKDAY)).map((b) => b.code)).not.toContain('recontact');
  });

  it('надісланий лист не відправляється вдруге', async () => {
    const id = await makeDraft({ status: 'sent', sentAt: WORKDAY.getTime() });
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('status');
  });

  it('чернетки без адреси не існує для відправки', async () => {
    const id = await makeDraft({ contactEmail: null });
    expect((await checkSend(id, WORKDAY)).map((b) => b.code)).toContain('address');
  });
});

describe('лічильники', () => {
  it('порожній день це нуль з ліміту прогріву', async () => {
    const counters = await sendCounters(WORKDAY);
    expect(counters).toMatchObject({ sentToday: 0, limit: 5, nextAllowedAt: null, windowOpen: true });
  });

  it('відправка збільшує лічильник і ставить паузу', async () => {
    await noteSent(WORKDAY);
    const counters = await sendCounters(WORKDAY);
    expect(counters.sentToday).toBe(1);
    expect(counters.nextAllowedAt).toBe(WORKDAY.getTime() + 180_000);
    expect(counters.windowOpen).toBe(false);
  });

  it('вночі вікно закрите, навіть коли ліміт не вичерпано', async () => {
    expect((await sendCounters(new Date('2026-09-08T21:00:00Z'))).windowOpen).toBe(false);
  });
});

describe('sendDraft', () => {
  it('заблокована чернетка не доходить до Gmail', async () => {
    const id = await makeDraft({ bodyFinal: 'Вітаю, {{first_name}}' });
    const outcome = await sendDraft(id, WORKDAY);
    expect(outcome.sent).toBe(false);
    expect(outcome.blockers.map((b) => b.code)).toContain('placeholder');

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row?.status).toBe('draft');
  });

  it('успішна відправка пише ідентифікатори, лічильник і стан компанії', async () => {
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

  it('фолоу-ап іде тредом оригіналу з правильними заголовками', async () => {
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

  it('помилка Gmail лишає лист у failed з причиною, а не тихо в чернетках', async () => {
    sendMessageMock.mockRejectedValue(new Error('403 quota'));

    const id = await makeDraft();
    const outcome = await sendDraft(id, WORKDAY);
    expect(outcome.sent).toBe(false);

    const [row] = await getDb().select().from(outreach).where(eq(outreach.id, id));
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('403 quota');
  });
});
