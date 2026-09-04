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
      bodyFinal: 'текст листа',
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

describe('затримка фолоу-апу', () => {
  it('завжди в діапазоні 7-9 днів', () => {
    for (let id = 1; id <= 30; id += 1) {
      const days = followupDelayDays(id);
      expect(days).toBeGreaterThanOrEqual(FOLLOWUP_MIN_DAYS);
      expect(days).toBeLessThanOrEqual(FOLLOWUP_MAX_DAYS);
    }
  });

  it('для одного листа вона стала, інакше строк то настає, то ні', () => {
    expect(followupDelayDays(7)).toBe(followupDelayDays(7));
  });
});

describe('кому час писати вдруге', () => {
  it('лист без відповіді старший за строк потрапляє в список', async () => {
    await sentLetter();
    expect(await dueFollowups(NOW)).toHaveLength(1);
  });

  it('свіжий лист ще не настав', async () => {
    await sentLetter({ sentAt: NOW.getTime() - 2 * DAY });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('є відповідь означає, що фолоу-ап не потрібен', async () => {
    await sentLetter({ replyAt: NOW.getTime() - DAY, replyType: 'rejection', status: 'replied' });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('після баунсу фолоу-ап не шлеться', async () => {
    await sentLetter({ status: 'bounced', bounceType: 'hard' });
    expect(await dueFollowups(NOW)).toHaveLength(0);
  });

  it('фолоу-ап рівно один: другого не буде', async () => {
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

describe('чернетка фолоу-апу', () => {
  it('успадковує тему оригіналу, інакше це окремий тред', async () => {
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

  it('каркасний шаблон лишає чернетку в "потребують уваги"', async () => {
    await sentLetter();
    await prepareFollowups(NOW);
    const [followup] = await getDb().select().from(outreach).where(eq(outreach.status, 'draft'));
    expect(followup?.error).toContain('мітки');
  });
});

describe('статистика розсилки', () => {
  it('рахує конверсію по шаблонах і відкати валідації', async () => {
    await sentLetter({ replyAt: NOW.getTime(), replyType: 'positive', status: 'replied', aiUsed: true });
    await sentLetter({ templateUsed: 'send_studio_generic_en', aiFallbackReason: 'слів 84' });
    await sentLetter({ templateUsed: 'send_studio_generic_en', aiFallbackReason: 'слів 12' });

    const stats = await outreachStats();
    const generic = stats.byTemplate.find((row) => row.template === 'send_studio_generic_en');
    expect(generic?.sent).toBe(2);
    expect(stats.ai).toMatchObject({ sent: 1, positive: 1 });

    // Дві однакові за суттю причини складаються в один рядок, а не в два по одному.
    expect(stats.fallbacks).toEqual([{ reason: 'слів', count: 2 }]);
    expect(stats.fallbackShare).toBeCloseTo(2 / 3);
  });

  it('медіанний час до відповіді рахується тільки по тих, хто відповів', async () => {
    await sentLetter({ sentAt: NOW.getTime() - 2 * 3_600_000, replyAt: NOW.getTime(), replyType: 'positive' });
    await sentLetter();
    expect((await outreachStats()).medianReplyHours).toBeCloseTo(2);
  });
});
