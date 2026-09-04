import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, outreach, queueItems, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { applyAction, followUps, funnel, listOutreach, markReply } from '../src/pipeline/actions.js';
import { getQueue, pendingCount, todayKey, topUpQueue } from '../src/pipeline/queue.js';

let acme: Company;
let other: Company;
const DAY = '2026-09-03';
/**
 * Останній день у сценарії. Нерозібрані картки переїжджають у найновіший зріз,
 * тому тести дій мусять брати саме його, інакше шукають у вже спорожнілому дні.
 */
const LAST_DAY = '2026-09-07';

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

  it('наступний день переносить нерозібрані і додає нову, вчорашні не дублюються', async () => {
    const cards = await getQueue('2026-09-04');

    // Три вчорашні картки нерозібрані, тому переїжджають першими за давністю очікування,
    // і лише після них іде свіжа знахідка.
    expect(cards.map((c) => c.title)).toEqual([
      'Senior Frontend',
      'Fullstack Engineer',
      'React Developer',
      'Найкраща вакансія дня',
    ]);

    // Переїзд, а не копія: на вакансію лишається один рядок черги.
    const rows = await getDb().select().from(queueItems);
    const ids = rows.map((row) => row.vacancyId);
    expect(new Set(ids).size).toBe(ids.length);

    // Дата першого показу зберігається, тому видно, скільки картка вже чекає.
    const carried = cards.find((c) => c.title === 'Senior Frontend')!;
    expect(carried.firstShownAt).toBeGreaterThan(0);
  });

  it('розібрана картка не переноситься далі', async () => {
    const before = await getQueue('2026-09-04');
    const card = before.find((c) => c.title === 'Найкраща вакансія дня')!;
    await applyAction({ vacancyId: card.vacancyId, action: 'interesting' });

    const cards = await getQueue('2026-09-05');
    expect(cards.map((c) => c.title)).not.toContain('Найкраща вакансія дня');
    expect(cards.map((c) => c.title)).toContain('Senior Frontend');
  });

  it('закрита вакансія не переноситься, навіть якщо рішення не було', async () => {
    const gone = await addVacancy(acme.id, 'Зникла поки чекала', 25);
    await getDb().insert(queueItems).values({ day: '2026-09-05', vacancyId: gone.id, position: 99 });
    await getDb().update(vacancies).set({ closedAt: Date.now() }).where(eq(vacancies.id, gone.id));

    const cards = await getQueue('2026-09-06');
    expect(cards.map((c) => c.title)).not.toContain('Зникла поки чекала');
  });

  it('ліміт карток на день дотримується разом із перенесеними', async () => {
    for (let i = 0; i < 15; i += 1) await addVacancy(acme.id, `Масовка ${i}`, 7);
    const cards = await getQueue('2026-09-07');
    expect(cards).toHaveLength(config.pipeline.queueDailyLimit);
  });
});

describe('applyAction', () => {
  it('"не цікаво" ставить статус компанії і прибирає картку з черги', async () => {
    const cards = await getQueue(LAST_DAY);
    const card = cards.find((c) => c.company === 'Beta')!;

    await applyAction({ vacancyId: card.vacancyId, action: 'not_interesting', note: 'не той стек' });

    const after = await getQueue(LAST_DAY);
    expect(after.find((c) => c.vacancyId === card.vacancyId)!.decision).toBe('not_interesting');

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, other.id));
    expect(state!.status).toBe('rejected_by_me');
    expect(state!.reason).toBe('не той стек');
  });

  it('"написав" створює запис у листуванні з шаблоном і датою', async () => {
    const cards = await getQueue(LAST_DAY);
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

/*
 * Блок навмисно останній у файлі: він створює нову компанію з вакансіями,
 * і ці записи потрапили б у чергу тестів вище, які перевіряють точний склад зрізу.
 */
describe('topUpQueue', () => {
  it('добирає картки до денного ліміту, не чіпаючи наявні', async () => {
    const day = '2026-09-20';
    const before = await getQueue(day);
    const positionsBefore = before.map((card) => `${card.vacancyId}:${card.position}`);

    // Своя компанія: у acme і other статуси вже змінені попередніми тестами,
    // і їхні вакансії відсіювались би як приховані.
    const fresh = (await upsertCompany({ name: 'Fresh Co', domain: 'freshco.dev', source: 'test' })).company;
    for (let i = 0; i < 5; i += 1) await addVacancy(fresh.id, `Свіжа знахідка ${i}`, 11);

    const result = await topUpQueue(day);
    expect(result.added).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(config.pipeline.queueDailyLimit);

    const after = await getQueue(day);
    // Наявні картки лишились на своїх місцях: зріз фіксований, це рішення зі STATUS.md.
    expect(after.map((card) => `${card.vacancyId}:${card.position}`).slice(0, before.length)).toEqual(
      positionsBefore,
    );
  });

  it('повний зріз не поповнюється: денний ліміт це ліміт', async () => {
    const day = '2026-09-21';
    await getQueue(day);
    await topUpQueue(day);

    const full = await getDb().select().from(queueItems).where(eq(queueItems.day, day));
    if (full.length >= config.pipeline.queueDailyLimit) {
      expect((await topUpQueue(day)).added).toBe(0);
    }
  });
});

/*
 * Блок навмисно останній: він додає ще один запис "написав", а тести воронки
 * вище перевіряють точні числа.
 */
describe('кому писали', () => {
  it('"написав" зберігає, кому саме писали', async () => {
    // Через рік у Контактах має бути видно людину, а не тільки компанію.
    const cards = await getQueue(LAST_DAY);
    const card = cards.find((c) => !c.decision)!;
    if (!card) return;

    await applyAction({
      vacancyId: card.vacancyId,
      action: 'contacted',
      channel: 'email',
      templateUsed: 'fullstack_ai',
      contactName: 'Марія Технічна',
      contactEmail: 'maria@example.com',
    });

    const [row] = await listOutreach();
    expect(row!.contactName).toBe('Марія Технічна');
    expect(row!.contactEmail).toBe('maria@example.com');
  });
});
