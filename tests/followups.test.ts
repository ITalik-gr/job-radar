import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { outreach, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import {
  FOLLOWUP_MAX_DAYS,
  FOLLOWUP_MIN_DAYS,
  dueFollowups,
  followupDelayDays,
  prepareFollowups,
} from '../src/pipeline/followups.js';
import { seedOutreachTemplates } from '../src/pipeline/outreach.js';
import { outreachStats } from '../src/pipeline/outreach-stats.js';

let acme: Company;
const NOW = new Date('2026-09-20T09:00:00Z');
const DAY = 86_400_000;

async function sentLetter(over: Record<string, unknown> = {}): Promise<number> {
  const [row] = await getDb()
    .insert(outreach)
    .values({
      companyId: acme.id,
      channel: 'email',
      status: 'sent',
      sentAt: NOW.getTime() - 12 * DAY,
      gmailThreadId: 't1',
      contactEmail: 'anton@acme.com',
      contactName: 'Anton',
      language: 'uk',
      templateUsed: 'send_vacancy_uk',
      subjectFinal: 'Senior Frontend, Acme',
      bodyFinal: 'letter text',
      ...over,
    })
    .returning({ id: outreach.id });
  return row!.id;
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();
  acme = (await upsertCompany({ name: 'Acme', domain: 'acme.com', source: 'test' })).company;
  await seedOutreachTemplates();
});

beforeEach(async () => {
  await getDb().delete(outreach);
});

describe('follow-up delay', () => {
  it('is always in the 7-9 day range', () => {
    for (let id = 1; id <= 30; id += 1) {
      const days = followupDelayDays(id);
      expect(days).toBeGreaterThanOrEqual(FOLLOWUP_MIN_DAYS);
      expect(days).toBeLessThanOrEqual(FOLLOWUP_MAX_DAYS);
    }
  });

  it('is stable for a given letter, otherwise the due date would flicker', () => {
    expect(followupDelayDays(7)).toBe(followupDelayDays(7));
  });
});

describe('who is due for a second message', () => {
  it('a letter without a reply older than the delay lands in the list', async () => {
    await sentLetter();
    expect(await dueFollowups(NOW)).toHaveLength(1);
  });

  it('a fresh letter is not due yet', async () => {
    await sentLetter({ sentAt: NOW.getTime() - 2 * DAY });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('a reply means no follow-up is needed', async () => {
    await sentLetter({ replyAt: NOW.getTime() - DAY, replyType: 'rejection', status: 'replied' });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('a follow-up is not sent after a bounce', async () => {
    await sentLetter({ status: 'bounced', bounceType: 'hard' });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('exactly one follow-up: there will not be a second one', async () => {
    const original = await sentLetter();
    await prepareFollowups(NOW);
    expect(await dueFollowups(NOW)).toHaveLength(0);

    const [followup] = await getDb()
      .select()
      .from(outreach)
      .where(eq(outreach.followupOf, original));
    expect(followup).toBeDefined();
  });
});

describe('follow-up draft', () => {
  it('inherits the original subject, otherwise it becomes a separate thread', async () => {
    const original = await sentLetter();
    const report = await prepareFollowups(NOW);
    expect(report).toMatchObject({ due: 1, created: 1 });

    const [followup] = await getDb()
      .select()
      .from(outreach)
      .where(eq(outreach.followupOf, original));
    expect(followup?.subjectFinal).toBe('Senior Frontend, Acme');
    expect(followup?.status).toBe('draft');
    expect(followup?.sentAt).toBeNull();
    expect(followup?.language).toBe('uk');
  });

  it('a skeleton template leaves the draft in "needs attention"', async () => {
    await sentLetter();
    await prepareFollowups(NOW);
    const [followup] = await getDb().select().from(outreach).where(eq(outreach.status, 'draft'));
    expect(followup?.error).toContain('markers');
  });
});

describe('outreach statistics', () => {
  it('counts conversion by template and validation fallbacks', async () => {
    await sentLetter({ replyAt: NOW.getTime(), replyType: 'positive', status: 'replied', aiUsed: true });
    await sentLetter({ templateUsed: 'send_studio_generic_en', aiFallbackReason: 'words 84' });
    await sentLetter({ templateUsed: 'send_studio_generic_en', aiFallbackReason: 'words 12' });

    const stats = await outreachStats();
    const generic = stats.byTemplate.find((row) => row.template === 'send_studio_generic_en');
    expect(generic?.sent).toBe(2);
    expect(stats.ai).toMatchObject({ sent: 1, positive: 1 });

    // Two reasons that are the same in substance collapse into one row, not two of one each.
    expect(stats.fallbacks).toEqual([{ reason: 'words', count: 2 }]);
    expect(stats.fallbackShare).toBeCloseTo(2 / 3);
  });

  it('the median reply time is counted only over those who replied', async () => {
    await sentLetter({ sentAt: NOW.getTime() - 2 * 3_600_000, replyAt: NOW.getTime(), replyType: 'positive' });
    await sentLetter();
    expect((await outreachStats()).medianReplyHours).toBeCloseTo(2);
  });
});
