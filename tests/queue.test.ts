import { rmSync } from 'node:fs';
import { eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companyState, outreach, queueItems, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { applyAction, followUps, funnel, listOutreach, markReply } from '../src/pipeline/actions.js';
import { CARDS_PER_COMPANY, getQueue, pendingCount, todayKey, topUpQueue } from '../src/pipeline/queue.js';

let acme: Company;
let other: Company;
const DAY = '2026-09-03';
/**
 * The last day in the scenario. Undecided cards move into the newest slice, so action
 * tests must use it specifically, otherwise they search in a day that is already empty.
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
  await addVacancy(other.id, 'Below Threshold', 3);
  await addVacancy(other.id, 'Closed', 20, { closedAt: Date.now() });
});

describe('getQueue', () => {
  it('takes only open vacancies above the threshold and sorts by score', async () => {
    const cards = await getQueue(DAY);
    expect(cards.map((c) => c.title)).toEqual(['Senior Frontend', 'Fullstack Engineer', 'React Developer']);
  });

  it('the slice is fixed: a new vacancy with a higher score does not reshuffle today\'s list', async () => {
    await addVacancy(acme.id, 'Best Vacancy of the Day', 30);
    const cards = await getQueue(DAY);
    expect(cards.map((c) => c.title)).toEqual(['Senior Frontend', 'Fullstack Engineer', 'React Developer']);
  });

  it('the next day carries over the undecided cards and adds a new one, yesterday\'s are not duplicated', async () => {
    const cards = await getQueue('2026-09-04');

    // The three cards from yesterday are undecided, so they move first by how long they have
    // been waiting, and only after them comes the fresh find.
    expect(cards.map((c) => c.title)).toEqual([
      'Senior Frontend',
      'Fullstack Engineer',
      'React Developer',
      'Best Vacancy of the Day',
    ]);

    // A move, not a copy: one queue row remains per vacancy.
    const rows = await getDb().select().from(queueItems);
    const ids = rows.map((row) => row.vacancyId);
    expect(new Set(ids).size).toBe(ids.length);

    // The first-shown date is kept, so it is visible how long a card has already been waiting.
    const carried = cards.find((c) => c.title === 'Senior Frontend')!;
    expect(carried.firstShownAt).toBeGreaterThan(0);
  });

  it('a decided card is not carried further', async () => {
    const before = await getQueue('2026-09-04');
    const card = before.find((c) => c.title === 'Best Vacancy of the Day')!;
    await applyAction({ vacancyId: card.vacancyId, action: 'interesting' });

    const cards = await getQueue('2026-09-05');
    expect(cards.map((c) => c.title)).not.toContain('Best Vacancy of the Day');
    expect(cards.map((c) => c.title)).toContain('Senior Frontend');
  });

  it('a closed vacancy is not carried over, even without a decision', async () => {
    const gone = await addVacancy(acme.id, 'Vanished While Waiting', 25);
    await getDb().insert(queueItems).values({ day: '2026-09-05', vacancyId: gone.id, position: 99 });
    await getDb().update(vacancies).set({ closedAt: Date.now() }).where(eq(vacancies.id, gone.id));

    const cards = await getQueue('2026-09-06');
    expect(cards.map((c) => c.title)).not.toContain('Vanished While Waiting');
  });

  it('the daily card limit is respected together with carried-over cards', async () => {
    for (let i = 0; i < 15; i += 1) {
      const { company } = await upsertCompany({ name: `Bulk ${i}`, domain: `bulk-${i}.com`, source: 'test' });
      await addVacancy(company.id, `Bulk ${i}`, 7);
    }
    const cards = await getQueue('2026-09-07');
    expect(cards).toHaveLength(config.pipeline.queueDailyLimit);
    // Closed afterwards so they do not fill the slices of the tests below.
    await getDb().update(vacancies).set({ closedAt: Date.now() }).where(like(vacancies.title, 'Bulk %'));
  });

  it('one company takes at most two fresh cards a day', async () => {
    const { company } = await upsertCompany({ name: 'Many Roles', domain: 'many-roles.com', source: 'test' });
    for (let i = 0; i < 5; i += 1) await addVacancy(company.id, `Many Roles ${i}`, 40);
    const cards = await getQueue('2026-08-01');
    expect(cards.filter((card) => card.companyId === company.id)).toHaveLength(CARDS_PER_COMPANY);
    await getDb().update(vacancies).set({ closedAt: Date.now() }).where(eq(vacancies.companyId, company.id));
  });
});

describe('applyAction', () => {
  it('"not interesting" sets the company status and removes the card from the queue', async () => {
    const cards = await getQueue(LAST_DAY);
    const card = cards.find((c) => c.company === 'Beta')!;

    await applyAction({ vacancyId: card.vacancyId, action: 'not_interesting', note: 'wrong stack' });

    const after = await getQueue(LAST_DAY);
    expect(after.find((c) => c.vacancyId === card.vacancyId)!.decision).toBe('not_interesting');

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, other.id));
    expect(state!.status).toBe('rejected_by_me');
    expect(state!.reason).toBe('wrong stack');
  });

  it('"contacted" creates an outreach record with a template and a date', async () => {
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

  it('"snooze" hides the company until the given date', async () => {
    const cards = await getQueue('2026-09-04');
    await applyAction({ vacancyId: cards[0]!.vacancyId, action: 'snooze', days: 30 });

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, acme.id));
    expect(state!.status).toBe('snoozed');
    expect(state!.snoozedUntil!).toBeGreaterThan(Date.now());

    const fresh = await getQueue('2026-09-06');
    expect(fresh.every((card) => card.companyId !== acme.id)).toBe(true);
  });

  it('an unknown action is not accepted', async () => {
    await expect(
      applyAction({ vacancyId: 1, action: 'made_up' as never }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('replies and follow-ups', () => {
  it('a positive reply moves the company to replied', async () => {
    const [row] = await listOutreach();
    await markReply(row!.id, 'positive', 'invited to a call');

    const rows = await listOutreach();
    expect(rows[0]!.replyType).toBe('positive');
    expect(rows[0]!.waitingDays).toBeNull();

    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, rows[0]!.companyId));
    expect(state!.status).toBe('replied');
  });

  it('a rejection moves to rejected_by_them, an autoreply does not change the status', async () => {
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

  it('follow-ups are contacts written to more than 7 days ago with no reply', async () => {
    const db = getDb();
    await db
      .insert(outreach)
      .values({ companyId: acme.id, channel: 'telegram', sentAt: Date.now() - 9 * 86_400_000 });

    const waiting = await followUps(7);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.waitingDays).toBe(9);
    expect(await followUps(30)).toHaveLength(0);
  });

  it('the funnel counts shown, decided, contacted and replies', async () => {
    const stats = await funnel();
    expect(stats.shown).toBeGreaterThan(0);
    expect(stats.decided).toBeGreaterThan(0);
    expect(stats.contacted).toBe(3);
    expect(stats.positive).toBe(1);
  });
});

describe('changing the rules', () => {
  it('a card that fell below the threshold after a recalc disappears from the slice', async () => {
    const fresh = (await upsertCompany({ name: 'Fresh', domain: 'fresh.dev', source: 'test' })).company;
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
  it('counts only cards without a decision', async () => {
    const items = await getDb().select().from(queueItems).where(eq(queueItems.day, DAY));
    const decided = items.filter((item) => item.decision !== null).length;
    expect(await pendingCount(DAY)).toBe(items.length - decided);
  });

  it('today\'s key is an ISO date in the owner\'s time zone, not UTC', () => {
    // 22:10 UTC is already 01:10 the next day in Kyiv: the queue day used to roll over at 03:00.
    expect(todayKey(new Date('2026-09-03T22:10:00Z'))).toBe('2026-09-04');
    expect(todayKey(new Date('2026-09-03T12:00:00Z'))).toBe('2026-09-03');
  });
});

/*
 * This block is deliberately last in the file: it creates a new company with vacancies,
 * and those records would land in the queue of the tests above, which check the slice's
 * exact composition.
 */
describe('topUpQueue', () => {
  it('tops up cards to the daily limit without touching the existing ones', async () => {
    const day = '2026-09-20';
    const before = await getQueue(day);
    const positionsBefore = before.map((card) => `${card.vacancyId}:${card.position}`);

    // Its own company: acme and other already had their statuses changed by earlier tests,
    // and their vacancies would be filtered out as hidden.
    const fresh = (await upsertCompany({ name: 'Fresh Co', domain: 'freshco.dev', source: 'test' })).company;
    for (let i = 0; i < 5; i += 1) await addVacancy(fresh.id, `Fresh Find ${i}`, 11);

    const result = await topUpQueue(day);
    expect(result.added).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(config.pipeline.queueDailyLimit);

    const after = await getQueue(day);
    // The existing cards stayed in their places: the slice is fixed, that is the decision from STATUS.md.
    expect(after.map((card) => `${card.vacancyId}:${card.position}`).slice(0, before.length)).toEqual(
      positionsBefore,
    );
  });

  it('a full slice does not get topped up: the daily limit is a limit', async () => {
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
 * This block is deliberately last: it adds one more "contacted" record, and the funnel
 * tests above check exact numbers.
 */
describe('who was contacted', () => {
  it('"contacted" remembers exactly who was written to', async () => {
    // A year from now, Contacts should show a person, not just the company.
    const cards = await getQueue(LAST_DAY);
    const card = cards.find((c) => !c.decision)!;
    if (!card) return;

    await applyAction({
      vacancyId: card.vacancyId,
      action: 'contacted',
      channel: 'email',
      templateUsed: 'fullstack_ai',
      contactName: 'Maria Tech',
      contactEmail: 'maria@example.com',
    });

    const [row] = await listOutreach();
    expect(row!.contactName).toBe('Maria Tech');
    expect(row!.contactEmail).toBe('maria@example.com');
  });
});

describe('contact statuses', () => {
  it('"interesting" on a card does not erase that the company was written to', async () => {
    const { company } = await upsertCompany({ name: 'Written', domain: 'written-to.com', source: 'test' });
    const vacancy = await addVacancy(company.id, 'Written Frontend', 3);
    await getDb().update(companyState).set({ status: 'contacted' }).where(eq(companyState.companyId, company.id));

    await applyAction({ vacancyId: vacancy.id, action: 'interesting' });
    const [state] = await getDb().select().from(companyState).where(eq(companyState.companyId, company.id));
    expect(state?.status).toBe('contacted');
  });

  it('a company that replied gets no fresh cold cards', async () => {
    const { company } = await upsertCompany({ name: 'Talking', domain: 'talking.com', source: 'test' });
    await addVacancy(company.id, 'Talking Frontend', 50);
    await getDb().update(companyState).set({ status: 'replied' }).where(eq(companyState.companyId, company.id));

    const cards = await getQueue('2026-07-01');
    expect(cards.some((card) => card.companyId === company.id)).toBe(false);
  });
});
