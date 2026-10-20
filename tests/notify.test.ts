import { rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { outreach, runs, type Company } from '../src/db/schema.js';
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

/** A company the default rules score well above the alert line: a Ukrainian web studio of 10 to 49. */
function strong(name: string, domain: string) {
  return upsertCompany({
    name,
    domain,
    source: 'test',
    country: 'UA',
    sizeHint: '10 - 49',
    tags: ['web development', 'ui/ux design'],
  });
}

describe('notifications', () => {
  it('an empty state produces no messages', async () => {
    expect(await notify.digest({ sender })).toBe(false);
    expect(await notify.highScore({ sender })).toBe(false);
    expect(await notify.followUps({ sender })).toBe(false);
    expect(await notify.broken({ sender })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('a new strong lead alert contains the company, the domain and the score', async () => {
    await strong('Strong Studio', 'strong.ua');

    expect(await notify.highScore({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('Strong Studio');
    expect(message).toContain('strong.ua');
    expect(message).toMatch(/\(\d+\.\d\)/);
  });

  it('a weak lead does not trigger the alert', async () => {
    sent.length = 0;
    await upsertCompany({ name: 'Weak Corp', domain: 'weak.com', source: 'test' });

    await notify.highScore({ sender });
    expect(sent.at(-1)).not.toContain('Weak');
  });

  it('the digest shows the leads and a link to the web', async () => {
    expect(await notify.digest({ sender })).toBe(true);
    const message = sent.at(-1)!;
    expect(message).toContain('Leads');
    expect(message).toContain('Strong Studio');
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
    await strong('<script>alert(1)</script>', 'evil.ua');

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
    expect(message).toContain('New leads with score 10+');
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
    for (const topic of ['Sources', 'Enrichment', 'Scoring', 'Letters', 'Bot commands']) {
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
    expect(text).toMatch(/companies: \d+, Ukrainian: \d+/);
    expect(text).toContain('leads above the threshold');
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
