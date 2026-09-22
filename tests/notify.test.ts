import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { outreach, runs, vacancies, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { HELP_TEXT, isConfigured, notify, statusText, WEB_URL } from '../src/notify/telegram.js';
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

describe('notifications', () => {
  it('an empty state produces no messages', async () => {
    expect(await notify.digest({ sender })).toBe(false);
    expect(await notify.highScore({ sender })).toBe(false);
    expect(await notify.followUps({ sender })).toBe(false);
    expect(await notify.broken({ sender })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('a score 12+ alert contains the company, the score and the link', async () => {
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

  it('a vacancy below the threshold does not trigger the alert', async () => {
    sent.length = 0;
    await getDb().insert(vacancies).values({
      companyId: acme.id,
      source: 'greenhouse',
      url: 'https://acme.com/jobs/2',
      title: 'Weak vacancy',
      score: 7,
      dedupeKey: 'acme|weak|w1',
    });

    await notify.highScore({ sender });
    expect(sent.at(-1)).not.toContain('Weak');
  });

  it('the digest shows the queue size and a link to the web', async () => {
    expect(await notify.digest({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('Queue for');
    expect(message).toContain(WEB_URL);
  });

  it('the follow-up reminder counts days without a reply', async () => {
    await getDb()
      .insert(outreach)
      .values({ companyId: acme.id, channel: 'email', sentAt: Date.now() - 9 * 86_400_000 });

    expect(await notify.followUps({ sender })).toBe(true);
    expect(sent.at(-1)).toContain('9d ago');
  });

  it('the broken source alert fires on warn and error', async () => {
    await getDb()
      .insert(runs)
      .values({ source: 'greenhouse', status: 'warn', itemsFound: 0, errors: ['zero records'] });

    expect(await notify.broken({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('greenhouse');
    expect(message).toContain('zero records');
  });

  it('HTML in names is escaped so Telegram does not fail', async () => {
    await upsertCompany({ name: '<b>Evil</b> company', domain: 'evil.com', source: 'test' });
    const [company] = await getDb().select().from(vacancies).limit(0);
    expect(company).toBeUndefined();

    const evil = await upsertCompany({ name: '<b>Evil</b> company', domain: 'evil.com', source: 'test' });
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

  it('the summary is one message with every non-empty section and a single link', async () => {
    const before = sent.length;
    expect(await notify.summary({ sender })).toBe(true);
    expect(sent.length).toBe(before + 1);

    const message = sent.at(-1)!;
    expect(message).toContain('Finds with score 12+');
    expect(message).toContain('Problem sources');
    expect(message.split(WEB_URL).length - 1).toBe(1);
  });
});

describe('test isolation', () => {
  it('the real bot is unreachable from tests, so a run never messages the owner', () => {
    expect(isConfigured()).toBe(false);
  });
});

describe('bot help', () => {
  it('explains every part of the system', () => {
    for (const topic of ['Sources', 'Company catalogs', 'Scoring', 'Queue', 'Stats', 'Bot commands']) {
      expect(HELP_TEXT).toContain(topic);
    }
    expect(HELP_TEXT).toContain('/status');
    expect(HELP_TEXT).toContain(WEB_URL);
  });

  it('the text is valid HTML for Telegram: every tag is closed', () => {
    const opened = [...HELP_TEXT.matchAll(/<(\w+)>/g)].map((match) => match[1]);
    const closed = [...HELP_TEXT.matchAll(/<\/(\w+)>/g)].map((match) => match[1]);
    expect(opened.sort()).toEqual(closed.sort());
  });

  it('status shows real numbers from the database', async () => {
    const text = await statusText();
    expect(text).toContain('companies: 2');
    expect(text).toContain('open vacancies');
    expect(text).toContain("in today's queue");
  });
});

describe('schedule', () => {
  it('every cron expression is valid', () => {
    for (const [name, expression] of Object.entries(SCHEDULE)) {
      expect(cron.validate(expression), `${name}: ${expression}`).toBe(true);
    }
  });

  it('summary on Monday and Thursday at 10:00, ATS every 6 hours', () => {
    expect(SCHEDULE.summary).toBe('0 10 * * 1,4');
    expect(SCHEDULE.ats).toBe('0 */6 * * *');
  });
});
