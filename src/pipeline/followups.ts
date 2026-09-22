import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, outreach } from '../db/schema.js';
import { log } from '../lib/log.js';
import { renderLetter } from '../lib/letter.js';
import { matchTemplate, outreachTemplates, readSignature, type Language } from './outreach.js';

/**
 * Follow-ups, section 6 of OUTREACH.md.
 *
 * Exactly one per company, after 7-9 days, always in the same thread. A second
 * follow-up is no longer persistence, it's a reason to end up in spam, so it doesn't
 * even exist as an option.
 */

export const FOLLOWUP_MIN_DAYS = 7;
export const FOLLOWUP_MAX_DAYS = 9;

/**
 * A 7-9 day delay, but deterministic for a specific letter.
 *
 * A random number every time would mean the letter was due, then not due again,
 * depending on when it was checked. The spread is needed so follow-ups don't go out in
 * a batch on exactly the eighth day, and the remainder of the id works just as well for
 * that as a generator.
 */
export function followupDelayDays(outreachId: number): number {
  return FOLLOWUP_MIN_DAYS + (outreachId % (FOLLOWUP_MAX_DAYS - FOLLOWUP_MIN_DAYS + 1));
}

export interface FollowupCandidate {
  outreachId: number;
  companyId: number;
  company: string;
  contactEmail: string | null;
  contactName: string | null;
  subject: string;
  language: Language;
  sentAt: number;
  dueAt: number;
}

/**
 * Who it's time to write to a second time: no reply, no bounce, no follow-up sent yet.
 */
export async function dueFollowups(now = new Date()): Promise<FollowupCandidate[]> {
  const db = getDb();

  const rows = await db
    .select({ row: outreach, company: companies.name })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .where(
      and(
        eq(outreach.status, 'sent'),
        isNull(outreach.replyAt),
        isNull(outreach.bounceType),
        isNull(outreach.followupOf),
        isNotNull(outreach.gmailThreadId),
        // Neither sent nor ready: a follow-up draft counts too.
        sql`not exists (
          select 1 from ${outreach} as f where f.followup_of = ${outreach.id}
        )`,
      ),
    );

  return rows
    .map(({ row, company }) => ({
      outreachId: row.id,
      companyId: row.companyId,
      company,
      contactEmail: row.contactEmail,
      contactName: row.contactName,
      subject: row.subjectFinal ?? '',
      language: (row.language as Language) ?? 'en',
      sentAt: row.sentAt!,
      dueAt: row.sentAt! + followupDelayDays(row.id) * 86_400_000,
    }))
    .filter((item) => item.dueAt <= now.getTime());
}

export interface FollowupReport {
  due: number;
  created: number;
  skipped: { company: string; reason: string }[];
}

/**
 * Prepares follow-up drafts. They don't go out automatically: the same confirmation
 * queue, the same button for every letter.
 *
 * The subject is taken from the original unchanged. A new subject creates a separate
 * thread in mail clients, and then the follow-up reads like a second mailing instead of a reminder.
 */
export async function prepareFollowups(now = new Date()): Promise<FollowupReport> {
  const db = getDb();
  const list = await outreachTemplates();
  const candidates = await dueFollowups(now);
  const signature = await readSignature();
  const report: FollowupReport = { due: candidates.length, created: 0, skipped: [] };

  for (const candidate of candidates) {
    const template = matchTemplate(list, 'followup', candidate.language);
    if (!template) {
      report.skipped.push({
        company: candidate.company,
        reason: `no followup template for language ${candidate.language}`,
      });
      continue;
    }

    const rendered = renderLetter(template.body, {
      company: candidate.company,
      domain: '',
      contactName: candidate.contactName,
      language: candidate.language,
      intro: template.intro ?? '',
      signature,
    });

    await db.insert(outreach).values({
      companyId: candidate.companyId,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: now.getTime(),
      followupOf: candidate.outreachId,
      followupDueAt: candidate.dueAt,
      templateId: template.id,
      templateUsed: template.slug,
      language: candidate.language,
      subjectFinal: candidate.subject,
      bodyFinal: rendered.text,
      contactEmail: candidate.contactEmail,
      contactName: candidate.contactName,
      error:
        rendered.missing.length > 0
          ? `empty placeholders: ${rendered.missing.join(', ')}`
          : /\[[^\]\n]{3,}\]/.test(rendered.text)
            ? 'placeholder markers left in the followup template'
            : null,
    });

    report.created += 1;
  }

  log.info(report, 'followups prepared');
  return report;
}
