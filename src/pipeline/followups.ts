import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, outreach } from '../db/schema.js';
import { log } from '../lib/log.js';
import { renderLetter } from '../lib/letter.js';
import { matchTemplate, outreachTemplates, type Language } from './outreach.js';

/**
 * Фолоу-апи, розділ 6 OUTREACH.md.
 *
 * Рівно один на компанію, через 7-9 днів, обовʼязково в тому самому треді.
 * Другий фолоу-ап це вже не наполегливість, а причина потрапити в спам, тому
 * його немає навіть як опції.
 */

export const FOLLOWUP_MIN_DAYS = 7;
export const FOLLOWUP_MAX_DAYS = 9;

/**
 * Затримка 7-9 днів, але детермінована для конкретного листа.
 *
 * Випадкове число щоразу означало б, що лист то настав, то знову ні, залежно
 * від моменту перевірки. Розкид потрібен, щоб фолоу-апи не йшли пачкою рівно
 * на восьмий день, і залишок id для цього годиться не гірше за генератор.
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
 * Кому час писати вдруге: відповіді немає, баунсу не було, фолоу-ап ще не йшов.
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
        // Ні відправленого, ні готового: чернетка фолоу-апу теж рахується.
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
 * Готує чернетки фолоу-апів. Автоматично вони не летять: та сама черга
 * підтвердження, та сама кнопка на кожен лист.
 *
 * Тема береться з оригіналу без змін. Нова тема створює окремий тред у поштових
 * клієнтах, і тоді фолоу-ап читається як друга розсилка, а не як нагадування.
 */
export async function prepareFollowups(now = new Date()): Promise<FollowupReport> {
  const db = getDb();
  const list = await outreachTemplates();
  const candidates = await dueFollowups(now);
  const report: FollowupReport = { due: candidates.length, created: 0, skipped: [] };

  for (const candidate of candidates) {
    const template = matchTemplate(list, 'followup', candidate.language);
    if (!template) {
      report.skipped.push({
        company: candidate.company,
        reason: `немає шаблона followup мовою ${candidate.language}`,
      });
      continue;
    }

    const rendered = renderLetter(template.body, {
      company: candidate.company,
      domain: '',
      contactName: candidate.contactName,
      intro: template.intro ?? '',
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
          ? `порожні плейсхолдери: ${rendered.missing.join(', ')}`
          : /\[[^\]\n]{3,}\]/.test(rendered.text)
            ? 'у шаблоні фолоу-апу лишились мітки'
            : null,
    });

    report.created += 1;
  }

  log.info(report, 'фолоу-апи підготовлено');
  return report;
}
