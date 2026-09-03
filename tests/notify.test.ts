import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { outreach, runs, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { HELP_TEXT, notify, statusText, WEB_URL } from '../src/notify/telegram.js';
import { SCHEDULE } from '../src/scheduler.js';
import cron from 'node-cron';

let acme: Company;
const sent: string[] = [];
const sender = async (text: string) => {
  sent.push(text);
};

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
});

describe('сповіщення', () => {
  it('порожній стан не породжує повідомлень', async () => {
    expect(await notify.digest({ sender })).toBe(false);
    expect(await notify.highScore({ sender })).toBe(false);
    expect(await notify.followUps({ sender })).toBe(false);
    expect(await notify.broken({ sender })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('алерт про score 12+ містить компанію, рахунок і посилання', async () => {
    await getDb().insert(vacancies).values({
      companyId: acme.id,
      source: 'greenhouse',
      url: 'https://acme.com/jobs/1',
      title: 'Senior Frontend Developer',
      score: 18,
      dedupeKey: 'acme|senior|w1',
    });

    expect(await notify.highScore({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('Acme');
    expect(message).toContain('18.0');
    expect(message).toContain('https://acme.com/jobs/1');
  });

  it('вакансія нижче порогу алерту не тригерить', async () => {
    sent.length = 0;
    await getDb().insert(vacancies).values({
      companyId: acme.id,
      source: 'greenhouse',
      url: 'https://acme.com/jobs/2',
      title: 'Слабка вакансія',
      score: 7,
      dedupeKey: 'acme|слабка|w1',
    });

    await notify.highScore({ sender });
    expect(sent.at(-1)).not.toContain('Слабка');
  });

  it('дайджест показує розмір черги і посилання на веб', async () => {
    expect(await notify.digest({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('Черга на');
    expect(message).toContain(WEB_URL);
  });

  it('нагадування про фолоу-апи рахує дні без відповіді', async () => {
    await getDb()
      .insert(outreach)
      .values({ companyId: acme.id, channel: 'email', sentAt: Date.now() - 9 * 86_400_000 });

    expect(await notify.followUps({ sender })).toBe(true);
    expect(sent.at(-1)).toContain('9 дн тому');
  });

  it('алерт про поламане джерело спрацьовує на warn і error', async () => {
    await getDb()
      .insert(runs)
      .values({ source: 'greenhouse', status: 'warn', itemsFound: 0, errors: ['нуль записів'] });

    expect(await notify.broken({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('greenhouse');
    expect(message).toContain('нуль записів');
  });

  it('HTML у назвах екранується, щоб телеграм не впав', async () => {
    await upsertCompany({ name: '<b>Зла</b> компанія', domain: 'evil.com', source: 'test' });
    const [company] = await getDb().select().from(vacancies).limit(0);
    expect(company).toBeUndefined();

    const evil = await upsertCompany({ name: '<b>Зла</b> компанія', domain: 'evil.com', source: 'test' });
    await getDb().insert(vacancies).values({
      companyId: evil.company.id,
      source: 'test',
      url: 'https://evil.com/1',
      title: '<script>alert(1)</script>',
      score: 20,
      dedupeKey: 'evil|1|w1',
    });

    await notify.highScore({ sender });
    const message = sent.at(-1)!;
    expect(message).toContain('&lt;script&gt;');
    expect(message).not.toContain('<script>');
  });
});

describe('довідка в боті', () => {
  it('пояснює всі частини системи', () => {
    for (const topic of ['Джерела', 'Каталоги', 'Скоринг', 'Черга', 'Статистика', 'Команди бота']) {
      expect(HELP_TEXT).toContain(topic);
    }
    expect(HELP_TEXT).toContain('/status');
    expect(HELP_TEXT).toContain(WEB_URL);
  });

  it('текст валідний HTML для телеграма: усі теги закриті', () => {
    const opened = [...HELP_TEXT.matchAll(/<(\w+)>/g)].map((match) => match[1]);
    const closed = [...HELP_TEXT.matchAll(/<\/(\w+)>/g)].map((match) => match[1]);
    expect(opened.sort()).toEqual(closed.sort());
  });

  it('статус показує реальні числа з бази', async () => {
    const text = await statusText();
    expect(text).toContain('компаній: 2');
    expect(text).toContain('відкритих вакансій');
    expect(text).toContain('у черзі сьогодні');
  });
});

describe('розклад', () => {
  it('усі вирази cron валідні', () => {
    for (const [name, expression] of Object.entries(SCHEDULE)) {
      expect(cron.validate(expression), `${name}: ${expression}`).toBe(true);
    }
  });

  it('дайджест о 10:00, фолоу-апи о 18:00, ATS кожні 6 годин', () => {
    expect(SCHEDULE.digest).toBe('0 10 * * *');
    expect(SCHEDULE.followUps).toBe('0 18 * * *');
    expect(SCHEDULE.ats).toBe('0 */6 * * *');
  });
});
