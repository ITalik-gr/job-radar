import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, outreach, queueItems, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { applyAction, followUps, funnel, listOutreach, markReply } from '../src/pipeline/actions.js';
import { getQueue, pendingCount, todayKey } from '../src/pipeline/queue.js';

let acme: Company;
let other: Company;
const DAY = '2026-09-03';

async function addVacancy(companyId: number, title: string, score: number, over: Record<string, unknown> = {}) {
  const [row] = await getDb()
    .insert(vacancies)
    .values({
      companyId,
      source: 'test',
      url: `https://example.com/${title.replace(/\s+/g, '-')}`,
      title,
      rawText: 'react typescript next.js',
      score,
      dedupeKey: `${companyId}|${title}|w`,
      ...over,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
  other = (await upsertCompany({ name: 'Beta', domain: 'beta.com', source: 'test' })).company;

  await addVacancy(acme.id, 'Senior Frontend', 18);
  await addVacancy(acme.id, 'Fullstack Engineer', 12);
  await addVacancy(other.id, 'React Developer', 9);
  await addVacancy(other.id, 'Нижче порогу', 3);
  await addVacancy(other.id, 'Закрита', 20, { closedAt: Date.now() });
});

describe('getQueue', () => {
  it('бере тільки відкриті вакансії вище порогу і сортує за рахунком', async () => {
    const cards = await getQueue(DAY);
    expect(cards.map((c) => c.title)).toEqual(['Senior Frontend', 'Fullstack Engineer', 'React Developer']);
  });

  it('зріз фіксується: нова вакансія з вищим рахунком не перемішує сьогоднішній список', async () => {
    await addVacancy(acme.id, 'Найкраща вакансія дня', 30);
    const cards = await getQueue(DAY);
    expect(cards.map((c) => c.title)).toEqual(['Senior Frontend', 'Fullstack Engineer', 'React Developer']);
  });

  it('наступний день бачить нову вакансію і не повторює вчорашні', async () => {
    const cards = await getQueue('2026-09-04');
    expect(cards.map((c) => c.title)).toEqual(['Найкраща вакансія дня']);
  });

  it('ліміт карток на день дотримується', async () => {
    for (let i = 0; i < 15; i += 1) await addVacancy(acme.id, `Масовка ${i}`, 7);
    const cards = await getQueue('2026-09-05');
    expect(cards).toHaveLength(config.pipeline.queueDailyLimit);
  });
});

describe('applyAction', () => {
  it('"не цікаво" ставить статус компанії і прибирає картку з черги', async () => {
    const cards = await getQueue(DAY);
    const card = cards.find((c) => c.company === 'Beta')!;

    await applyAction({ vacancyId: card.vacancyId, action: 'not_interesting', note: 'не той стек' });

    const after = await getQueue(DAY);
    expect(after.find((c) => c.vacancyId === card.vacancyId)!.decision).toBe('not_interesting');

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, other.id));
    expect(state!.status).toBe('rejected_by_me');
    expect(state!.reason).toBe('не той стек');
  });

  it('"написав" створює запис у листуванні з шаблоном і датою', async () => {
    const cards = await getQueue(DAY);
    const card = cards.find((c) => c.company === 'Acme')!;

    const result = await applyAction({
      vacancyId: card.vacancyId,
      action: 'contacted',
      channel: 'email',
      templateUsed: 'fullstack_ai',
    });

    expect(result.status).toBe('contacted');
    const rows = await listOutreach();
    expect(rows[0]!.templateUsed).toBe('fullstack_ai');
    expect(rows[0]!.vacancyTitle).toBe(card.title);
    expect(rows[0]!.waitingDays).toBe(0);
  });

  it('"відкласти" ховає компанію до вказаної дати', async () => {
    const cards = await getQueue('2026-09-04');
    await applyAction({ vacancyId: cards[0]!.vacancyId, action: 'snooze', days: 30 });

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, acme.id));
    expect(state!.status).toBe('snoozed');
    expect(state!.snoozedUntil!).toBeGreaterThan(Date.now());

    const fresh = await getQueue('2026-09-06');
    expect(fresh.every((card) => card.companyId !== acme.id)).toBe(true);
  });

  it('невідома дія не приймається', async () => {
    await expect(
      applyAction({ vacancyId: 1, action: 'вигадана' as never }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('відповіді і фолоу-апи', () => {
  it('позитивна відповідь переводить компанію в replied', async () => {
    const [row] = await listOutreach();
    await markReply(row!.id, 'positive', 'кличуть на дзвінок');

    const rows = await listOutreach();
    expect(rows[0]!.replyType).toBe('positive');
    expect(rows[0]!.waitingDays).toBeNull();

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, rows[0]!.companyId));
    expect(state!.status).toBe('replied');
  });

  it('відмова переводить у rejected_by_them, автовідповідь не міняє статус', async () => {
    const db = getDb();
    const [sent] = await db
      .insert(outreach)
      .values({ companyId: other.id, channel: 'email', sentAt: Date.now() - 10 * 86_400_000 })
      .returning();

    await markReply(sent!.id, 'auto');
    const [afterAuto] = await db.select().from(companyState).where(eq(companyState.companyId, other.id));
    expect(afterAuto!.status).toBe('rejected_by_me');

    await markReply(sent!.id, 'rejection');
    const [afterRejection] = await db.select().from(companyState).where(eq(companyState.companyId, other.id));
    expect(afterRejection!.status).toBe('rejected_by_them');
  });

  it('фолоу-апи це ті, кому писали понад 7 днів тому без відповіді', async () => {
    const db = getDb();
    await db
      .insert(outreach)
      .values({ companyId: acme.id, channel: 'telegram', sentAt: Date.now() - 9 * 86_400_000 });

    const waiting = await followUps(7);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.waitingDays).toBe(9);
    expect(await followUps(30)).toHaveLength(0);
  });

  it('воронка рахує показане, вирішене, написане і відповіді', async () => {
    const stats = await funnel();
    expect(stats.shown).toBeGreaterThan(0);
    expect(stats.decided).toBeGreaterThan(0);
    expect(stats.contacted).toBe(3);
    expect(stats.positive).toBe(1);
  });
});

describe('зміна правил', () => {
  it('картка, яка після перерахунку впала нижче порогу, зникає зі зрізу', async () => {
    const fresh = (await upsertCompany({ name: 'Свіжа', domain: 'fresh.dev', source: 'test' })).company;
    await addVacancy(fresh.id, 'Frontend Engineer', 14);

    const before = await getQueue('2026-09-10');
    expect(before.length).toBeGreaterThan(0);

    const victim = before[0]!;
    await getDb().update(vacancies).set({ score: -50 }).where(eq(vacancies.id, victim.vacancyId));

    const after = await getQueue('2026-09-10');
    expect(after.some((card) => card.vacancyId === victim.vacancyId)).toBe(false);
    expect(after.length).toBe(before.length - 1);
  });
});

describe('pendingCount', () => {
  it('рахує тільки картки без рішення', async () => {
    const items = await getDb().select().from(queueItems).where(eq(queueItems.day, DAY));
    const decided = items.filter((item) => item.decision !== null).length;
    expect(await pendingCount(DAY)).toBe(items.length - decided);
  });

  it('сьогоднішній ключ це дата ISO', () => {
    expect(todayKey(new Date('2026-09-03T22:10:00Z'))).toBe('2026-09-03');
  });
});
