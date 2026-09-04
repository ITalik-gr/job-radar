import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  templates,
  vacancies,
  type Contact,
  type Template,
} from '../db/schema.js';
import { renderLetter, type LetterContext } from '../lib/letter.js';
import { log } from '../lib/log.js';
import { rules } from './rules.js';
import { generateParagraph } from './ai-paragraph.js';

/**
 * Підготовка чернеток розсилки. Модуль описаний в OUTREACH.md.
 *
 * Тут немає ні відправки, ні звернень до моделі: чернетка збирається з шаблону,
 * який написав власник, і з фактів, які вже лежать у базі. Відправка це окремий
 * крок, і між нею і цим файлом завжди стоїть людина з кнопкою.
 *
 * Вибір шаблону детермінований навмисно. Модель, яка вибирає тон листа, дає
 * різний результат на однакових даних, і зрозуміти, чому конкретній студії пішов
 * саме такий текст, стає неможливо.
 */

export const OUTREACH_TARGETS = ['vacancy', 'studio_named', 'studio_generic', 'followup'] as const;
export type OutreachTarget = (typeof OUTREACH_TARGETS)[number];

export type Language = 'uk' | 'en';

/** Компанії з цими станами не пишемо взагалі, розділ 9 OUTREACH.md. */
export const BLOCKED_STATUSES = ['blacklist', 'rejected_by_me', 'rejected_by_them'];

/** Повторний контакт дозволений через квартал, не через тиждень. */
export const RECONTACT_DAYS = 90;

/**
 * Пошта, яку читає менеджер, а не техлід. Різниця не косметична: під іменний
 * контакт іде інший текст, тому це рішення, а не оформлення.
 */
const GENERIC_MAILBOXES = new Set([
  'hello',
  'info',
  'contact',
  'contacts',
  'office',
  'mail',
  'team',
  'sales',
  'support',
  'admin',
  'hr',
  'jobs',
  'career',
  'careers',
  'work',
  'recruiting',
  'talent',
  'pr',
  'marketing',
  'business',
  'bd',
  'partnership',
  'partnerships',
]);

/**
 * Мітка `[отак]` у шаблоні означає місце, куди власник ще не вписав свій текст.
 * Стартові шаблони приходять саме такими: структура від інструмента, слова від
 * людини. Лист із міткою в тілі не відправляється, він лежить у "Потребують уваги".
 */
const UNFILLED_MARKER = /\[[^\]\n]{3,}\]/g;

export function isGenericEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const local = email.split('@')[0]?.toLowerCase().replace(/[._-].*$/, '') ?? '';
  return GENERIC_MAILBOXES.has(local);
}

/**
 * Мова листа. Країна UA означає українську, решта англійську.
 *
 * Мову сайту навмисно не вгадуємо: студія з польським сайтом і англомовним
 * відділом продажів звичайна річ, а лист польською від людини, яка польської
 * не знає, закриває розмову на першому ж рядку.
 */
export function pickLanguage(country: string | null | undefined): Language {
  const value = (country ?? '').trim().toLowerCase();
  return value === 'ua' || value === 'ukraine' || value === 'україна' ? 'uk' : 'en';
}

export interface TargetInput {
  hasVacancy: boolean;
  contactName?: string | null;
  contactEmail?: string | null;
}

/** Три випадки, три шаблони. Ніяких проміжних станів і ніякої моделі в рішенні. */
export function pickTargetType(input: TargetInput): OutreachTarget {
  if (input.hasVacancy) return 'vacancy';
  const named = Boolean(input.contactName?.trim()) && !isGenericEmail(input.contactEmail);
  return named ? 'studio_named' : 'studio_generic';
}

/**
 * Іменний контакт цінніший за загальну пошту, розділ 9 CLAUDE.md, тому сортуємо
 * так: іменний з поштою, потім будь-який з поштою, потім будь-який.
 */
export function pickContact(list: Contact[]): Contact | null {
  // Адреса після hard bounce мертва: писати на неї означає псувати репутацію.
  const withEmail = list.filter((row) => row.email && row.emailValid);
  const named = withEmail.filter((row) => row.name && !isGenericEmail(row.email));
  return named[0] ?? withEmail[0] ?? null;
}

export interface DraftCandidate {
  companyId: number;
  company: string;
  domain: string;
  country: string | null;
  city: string | null;
  kind: string | null;
  sizeHint: string | null;
  techHints: string[];
  tags: string[];
  description: string | null;
  vacancyId: number | null;
  vacancyTitle: string | null;
  vacancyStack: string[];
  contact: Contact | null;
}

export interface PreparedDraft {
  companyId: number;
  vacancyId: number | null;
  contactId: number | null;
  templateId: number;
  templateSlug: string;
  targetType: OutreachTarget;
  language: Language;
  subject: string;
  body: string;
  contactName: string | null;
  contactEmail: string | null;
  /** Чи перший абзац написала модель. Зберігається окремо, це матеріал для порівняння. */
  aiUsed: boolean;
  aiParagraph: string | null;
  aiFallbackReason: string | null;
  /** Чому чернетка не готова до відправки. null означає готова. */
  error: string | null;
}

/**
 * Складання одного листа з шаблону. Винесено окремо від запису в базу, щоб
 * прев'ю на сторінці Шаблони і реальна чернетка йшли одним кодом: інакше власник
 * бачить у прев'ю один текст, а в пошту йде інший.
 */
export function buildDraft(
  candidate: DraftCandidate,
  template: Template,
  language: Language,
  /** Готовий перший абзац. Порожнє означає статичний текст із шаблона. */
  intro?: string | null,
): Omit<
  PreparedDraft,
  'companyId' | 'vacancyId' | 'contactId' | 'aiUsed' | 'aiParagraph' | 'aiFallbackReason'
> {
  const context: LetterContext = {
    company: candidate.company,
    domain: candidate.domain,
    contactName: candidate.contact?.name ?? null,
    kind: candidate.kind,
    stack: candidate.vacancyStack.length > 0 ? candidate.vacancyStack : candidate.techHints,
    vacancyTitle: candidate.vacancyTitle,
    city: candidate.city,
    country: candidate.country,
    intro: intro ?? template.intro ?? '',
  };

  const subject = renderLetter(template.subject ?? '', context);
  const body = renderLetter(template.body, context);

  const missing = [...new Set([...subject.missing, ...body.missing])];
  const unknown = [...new Set([...subject.unknown, ...body.unknown])];

  /*
   * Порядок перевірок від найгрубішої до найтоншої. Лист із текстом "Hi ," не має
   * існувати навіть як чернетка, тому порожній плейсхолдер це помилка, а не
   * попередження: інакше він доживе до відправки, бо на швидкому перегляді
   * порожнє місце в тексті непомітне.
   */
  const unfilled = body.text.match(UNFILLED_MARKER) ?? [];

  let error: string | null = null;
  if (!template.body.trim()) error = 'шаблон порожній, текст листа пише власник';
  else if (unfilled.length > 0) error = `у шаблоні лишились мітки: ${unfilled.join(' ')}`;
  else if (!candidate.contact?.email) error = 'немає адреси, куди писати';
  else if (missing.length > 0) error = `порожні плейсхолдери: ${missing.join(', ')}`;
  else if (unknown.length > 0) error = `невідомі плейсхолдери: ${unknown.join(', ')}`;
  else if (!subject.text.trim()) error = 'порожня тема листа';

  return {
    templateId: template.id,
    templateSlug: template.slug,
    targetType: (template.targetType as OutreachTarget) ?? 'studio_generic',
    language,
    subject: subject.text,
    body: body.text,
    contactName: candidate.contact?.name ?? null,
    contactEmail: candidate.contact?.email ?? null,
    error,
  };
}

/**
 * Стартові шаблони розсилки: чотири випадки на двох мовах.
 *
 * Тексту листа тут немає навмисно. Інструмент дає каркас: привітання, підпис,
 * плейсхолдери і місця в квадратних дужках, а слова пише власник. Причина в
 * розділі 11 CLAUDE.md і в тому, що другий абзац холодного листа це факти про
 * людину, і згенерований він означав би вигаданий досвід у листі незнайомцю.
 */
const SIGNATURE = ['Alex Example', 'Front-end / Full-stack developer', 'example.dev'].join('\n');

interface OutreachSeed {
  slug: string;
  name: string;
  targetType: OutreachTarget;
  language: Language;
  subject: string;
  greeting: string;
  hint: string;
}

const OUTREACH_SEEDS: OutreachSeed[] = [
  {
    slug: 'send_vacancy_uk',
    name: 'Вакансія, українською',
    targetType: 'vacancy',
    language: 'uk',
    subject: '{{vacancy_title}}, {{company}}',
    greeting: 'Вітаю.',
    hint: 'вакансія {{vacancy_title}}, стек {{their_stack}}',
  },
  {
    slug: 'send_vacancy_en',
    name: 'Vacancy, English',
    targetType: 'vacancy',
    language: 'en',
    subject: '{{vacancy_title}} at {{company}}',
    greeting: 'Hello,',
    hint: 'role {{vacancy_title}}, stack {{their_stack}}',
  },
  {
    slug: 'send_studio_named_uk',
    name: 'Студія, іменний контакт, українською',
    targetType: 'studio_named',
    language: 'uk',
    subject: 'Фронтенд для {{company}}',
    greeting: 'Вітаю, {{first_name}}.',
    hint: 'студія {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_named_en',
    name: 'Studio, named contact, English',
    targetType: 'studio_named',
    language: 'en',
    subject: 'Front-end help for {{company}}',
    greeting: 'Hi {{first_name}},',
    hint: 'studio {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_generic_uk',
    name: 'Студія, загальна пошта, українською',
    targetType: 'studio_generic',
    language: 'uk',
    subject: 'Фронтенд для {{company}}',
    greeting: 'Вітаю.',
    hint: 'студія {{company}}, {{domain}}',
  },
  {
    slug: 'send_studio_generic_en',
    name: 'Studio, shared inbox, English',
    targetType: 'studio_generic',
    language: 'en',
    subject: 'Front-end help for {{company}}',
    greeting: 'Hello,',
    hint: 'studio {{company}}, {{domain}}',
  },
  {
    slug: 'send_followup_uk',
    name: 'Фолоу-ап, українською',
    targetType: 'followup',
    language: 'uk',
    // Тема порожня навмисно: фолоу-ап іде тим самим тредом і темою оригіналу.
    subject: '',
    greeting: 'Вітаю ще раз.',
    hint: 'два речення, не більше',
  },
  {
    slug: 'send_followup_en',
    name: 'Follow-up, English',
    targetType: 'followup',
    language: 'en',
    subject: '',
    greeting: 'Hello again,',
    hint: 'two sentences, no more',
  },
];

function seedBody(seed: OutreachSeed): { intro: string; body: string } {
  const first =
    seed.language === 'uk'
      ? `[перший абзац про компанію, 2 речення: ${seed.hint}]`
      : `[first paragraph about the company, 2 sentences: ${seed.hint}]`;
  const second =
    seed.language === 'uk'
      ? '[другий абзац: ваш досвід і стек. Пишеться один раз і далі не міняється]'
      : '[second paragraph: your experience and stack. Written once, then left alone]';
  const third =
    seed.language === 'uk'
      ? '[третій абзац: одне посилання і одне питання]'
      : '[third paragraph: one link and one question]';

  /*
   * Перший абзац стоїть у тілі плейсхолдером, а не текстом. Саме його і тільки
   * його переписує модель на Етапі 4, тому підміняти доводиться одне значення,
   * а не шматок рядка пошуком за збігом.
   */
  const parts =
    seed.targetType === 'followup'
      ? [seed.greeting, '{{intro}}']
      : [seed.greeting, '{{intro}}', second, third];

  return { intro: first, body: `${parts.join('\n\n')}\n\n${SIGNATURE}\n` };
}

/**
 * Доливає відсутні шаблони розсилки за ключем.
 *
 * На відміну від `seedTemplates`, тут саме "яких немає", а не "коли таблиця
 * порожня": шаблони листів власник уже завів руками, і набір розсилки має лягти
 * поруч. Видалений шаблон повернеться, і це свідомий компроміс: без хоча б
 * одного шаблона на випадок чернетки просто не створюються.
 */
export async function seedOutreachTemplates(): Promise<number> {
  const db = getDb();
  const existing = await db.select({ slug: templates.slug }).from(templates);
  const known = new Set(existing.map((row) => row.slug));
  const missing = OUTREACH_SEEDS.filter((seed) => !known.has(seed.slug));
  if (missing.length === 0) return 0;

  await db.insert(templates).values(
    missing.map((seed) => ({
      slug: seed.slug,
      name: seed.name,
      kind: seed.targetType === 'vacancy' ? 'vacancy' : 'studio',
      targetType: seed.targetType,
      language: seed.language,
      subject: seed.subject,
      ...seedBody(seed),
      note: 'Стартовий каркас. Текст в квадратних дужках замінити своїм.',
    })),
  );

  log.info({ added: missing.length }, 'шаблони розсилки додано');
  return missing.length;
}

/** Активні шаблони розсилки, згруповані за випадком і мовою. */
export async function outreachTemplates(): Promise<Template[]> {
  const db = getDb();
  return db
    .select()
    .from(templates)
    .where(and(eq(templates.archived, false), sql`${templates.targetType} is not null`));
}

export function matchTemplate(
  list: Template[],
  target: OutreachTarget,
  language: Language,
): Template | null {
  const byTarget = list.filter((row) => row.targetType === target);
  return byTarget.find((row) => row.language === language) ?? null;
}

/**
 * Кандидати на лист: компанія, якій ще не писали і яку не відхилили.
 *
 * Вакансія береться найкраща відкрита і вище порогу. Якщо такої немає, це не
 * привід пропускати компанію: студії пишуть і без вакансії, для цього і є
 * окремі шаблони.
 */
export async function draftCandidates(limit = 20): Promise<DraftCandidate[]> {
  const db = getDb();
  const threshold = rules().threshold;
  const since = Date.now() - RECONTACT_DAYS * 86_400_000;

  const rows = await db
    .select({ company: companies, state: companyState })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(
      and(
        or(
          isNull(companyState.status),
          and(
            notInArray(companyState.status, BLOCKED_STATUSES),
            or(
              isNull(companyState.snoozedUntil),
              sql`${companyState.snoozedUntil} < ${Date.now()}`,
            ),
          ),
        ),
        // Ні свіжого листа, ні чернетки, що вже лежить і чекає натискання.
        sql`not exists (
          select 1 from ${outreach}
          where ${outreach.companyId} = ${companies.id}
            and (${outreach.status} = 'draft' or coalesce(${outreach.sentAt}, 0) > ${since})
        )`,
        /*
         * Компанія без жодної адреси відсіюється тут, а не позначкою на чернетці.
         * Такий лист нікуди слати, і сотня нечитабельних заготовок у вкладці
         * "Потребують уваги" ховає в собі ті кілька, які справді треба дописати.
         */
        sql`exists (
          select 1 from ${contacts}
          where ${contacts.companyId} = ${companies.id} and ${contacts.email} is not null
        )`,
      ),
    )
    // Компанія з відкритою вакансією вище порогу цікавіша за холодну студію.
    .orderBy(
      sql`exists (
        select 1 from ${vacancies}
        where ${vacancies.companyId} = ${companies.id}
          and ${vacancies.closedAt} is null
          and coalesce(${vacancies.score}, -100) >= ${threshold}
      ) desc`,
    )
    .limit(limit);

  const result: DraftCandidate[] = [];
  for (const { company } of rows) {
    const [vacancy] = await db
      .select()
      .from(vacancies)
      .where(
        and(
          eq(vacancies.companyId, company.id),
          isNull(vacancies.closedAt),
          // null означає, що класифікація не дійшла: така вакансія ще кандидат.
          sql`coalesce(${vacancies.isVacancy}, 1) = 1`,
          sql`coalesce(${vacancies.score}, -100) >= ${threshold}`,
        ),
      )
      .orderBy(desc(vacancies.score))
      .limit(1);

    const list = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

    result.push({
      companyId: company.id,
      company: company.name,
      domain: company.domain,
      country: company.country,
      city: company.city,
      kind: company.kind,
      sizeHint: company.sizeHint,
      techHints: company.techHints,
      tags: company.tags,
      description: company.description,
      vacancyId: vacancy?.id ?? null,
      vacancyTitle: vacancy?.title ?? null,
      vacancyStack: vacancy?.stack ?? [],
      contact: pickContact(list),
    });
  }

  return result;
}

export interface PrepareReport {
  candidates: number;
  created: number;
  needsAttention: number;
  skipped: { company: string; reason: string }[];
  drafts: PreparedDraft[];
}

/**
 * Готує чернетки і кладе їх у `outreach` зі `status = draft`.
 *
 * `dryRun` потрібен не для тестів, а для роботи: перед першим прогоном власник
 * хоче побачити, що саме піде людям, і не отримати сотню рядків у базі, якщо
 * шаблон виявився не тим.
 */
export async function prepareDrafts(
  options: { limit?: number; dryRun?: boolean; ai?: boolean } = {},
): Promise<PrepareReport> {
  const db = getDb();
  const limit = options.limit ?? 20;
  const list = await outreachTemplates();
  const candidates = await draftCandidates(limit);

  const report: PrepareReport = {
    candidates: candidates.length,
    created: 0,
    needsAttention: 0,
    skipped: [],
    drafts: [],
  };

  for (const candidate of candidates) {
    const language = pickLanguage(candidate.country);
    const target = pickTargetType({
      hasVacancy: candidate.vacancyId !== null,
      contactName: candidate.contact?.name,
      contactEmail: candidate.contact?.email,
    });

    const template = matchTemplate(list, target, language);
    if (!template) {
      report.skipped.push({
        company: candidate.company,
        reason: `немає шаблона ${target} мовою ${language}`,
      });
      continue;
    }

    /*
     * Абзац від моделі береться до складання листа, і рівно один раз на компанію.
     * Відкат не блокує нічого: у шаблоні лежить статичний перший абзац, і лист
     * піде з ним.
     */
    const ai = options.ai
      ? await generateParagraph(candidate, language)
      : { paragraph: null, used: false, reason: null, confidence: null };

    const built = buildDraft(candidate, template, language, ai.paragraph);
    const draft: PreparedDraft = {
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      ...built,
    };
    report.drafts.push(draft);
    if (draft.error) report.needsAttention += 1;

    if (options.dryRun) continue;

    await db.insert(outreach).values({
      companyId: draft.companyId,
      vacancyId: draft.vacancyId,
      contactId: draft.contactId,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: Date.now(),
      templateId: draft.templateId,
      templateUsed: draft.templateSlug,
      language: draft.language,
      subjectFinal: draft.subject,
      bodyFinal: draft.body,
      contactName: draft.contactName,
      contactEmail: draft.contactEmail,
      aiUsed: draft.aiUsed,
      aiParagraph: draft.aiParagraph,
      aiFallbackReason: draft.aiFallbackReason,
      error: draft.error,
    });
    report.created += 1;
  }

  log.info(
    { candidates: report.candidates, created: report.created, attention: report.needsAttention },
    'чернетки підготовлено',
  );
  return report;
}

export interface DraftRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  vacancyTitle: string | null;
  contactName: string | null;
  contactEmail: string | null;
  templateUsed: string | null;
  language: string | null;
  subject: string | null;
  body: string | null;
  aiUsed: boolean;
  aiFallbackReason: string | null;
  error: string | null;
  queuedAt: number | null;
}

/** Чернетки для сторінки "До відправки". Готові і проблемні разом, розділяє UI. */
export async function listDrafts(): Promise<DraftRow[]> {
  const db = getDb();
  const rows = await db
    .select({ row: outreach, company: companies.name, domain: companies.domain, title: vacancies.title })
    .from(outreach)
    .innerJoin(companies, eq(companies.id, outreach.companyId))
    .leftJoin(vacancies, eq(vacancies.id, outreach.vacancyId))
    .where(inArray(outreach.status, ['draft', 'approved']))
    .orderBy(desc(outreach.queuedAt));

  return rows.map(({ row, company, domain, title }) => ({
    id: row.id,
    companyId: row.companyId,
    company,
    domain,
    vacancyTitle: title,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    templateUsed: row.templateUsed,
    language: row.language,
    subject: row.subjectFinal,
    body: row.bodyFinal,
    aiUsed: row.aiUsed,
    aiFallbackReason: row.aiFallbackReason,
    error: row.error,
    queuedAt: row.queuedAt,
  }));
}

/** Правка тексту людиною. Те, що збережено тут, і піде в пошту без змін. */
export async function updateDraft(
  id: number,
  patch: { subject?: string; body?: string },
): Promise<DraftRow | null> {
  const db = getDb();
  const [existing] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!existing) throw new Error(`чернетки ${id} немає`);
  if (existing.status !== 'draft') throw new Error('правити можна тільки чернетку');

  const subject = patch.subject ?? existing.subjectFinal ?? '';
  const body = patch.body ?? existing.bodyFinal ?? '';

  /*
   * Після ручної правки помилка перераховується заново: власник міг дописати
   * імʼя руками, і тоді чернетка вже готова. Тримати стару позначку означало б
   * лишити готовий лист у вкладці "Потребують уваги" назавжди.
   */
  const leftover = [...`${subject}\n${body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]);
  let error: string | null = null;
  if (!body.trim()) error = 'порожнє тіло листа';
  else if (!subject.trim()) error = 'порожня тема листа';
  else if (leftover.length > 0) error = `незаповнені плейсхолдери: ${leftover.join(', ')}`;
  else if (!existing.contactEmail) error = 'немає адреси, куди писати';

  await db
    .update(outreach)
    .set({ subjectFinal: subject, bodyFinal: body, error })
    .where(eq(outreach.id, id));

  const list = await listDrafts();
  return list.find((row) => row.id === id) ?? null;
}

/**
 * Перегенерувати перший абзац для наявної чернетки. Тільки по явній кнопці:
 * фонових перегенерацій немає, бо кожна це виклик моделі за гроші і жодного
 * способу побачити, що новий текст кращий за старий.
 */
export async function regenerateIntro(id: number): Promise<DraftRow | null> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) throw new Error(`чернетки ${id} немає`);
  if (draft.status !== 'draft') throw new Error('перегенерувати можна тільки чернетку');
  if (!draft.templateId) throw new Error('чернетка не памʼятає шаблона');

  const [template] = await db.select().from(templates).where(eq(templates.id, draft.templateId));
  if (!template) throw new Error('шаблон видалено, чернетку треба зібрати заново');

  const [candidate] = (await draftCandidatesFor([draft.companyId])) ?? [];
  if (!candidate) throw new Error('компанію не знайдено');

  const language = (draft.language as Language) ?? pickLanguage(candidate.country);
  const ai = await generateParagraph(candidate, language);
  const built = buildDraft({ ...candidate, vacancyId: draft.vacancyId }, template, language, ai.paragraph);

  await db
    .update(outreach)
    .set({
      subjectFinal: built.subject,
      bodyFinal: built.body,
      error: built.error,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
    })
    .where(eq(outreach.id, id));

  const list = await listDrafts();
  return list.find((row) => row.id === id) ?? null;
}

/** Ті самі дані кандидата, але для вже відомих компаній: потрібно перегенерації. */
export async function draftCandidatesFor(companyIds: number[]): Promise<DraftCandidate[]> {
  const db = getDb();
  const result: DraftCandidate[] = [];

  for (const companyId of companyIds) {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) continue;

    const [vacancy] = await db
      .select()
      .from(vacancies)
      .where(and(eq(vacancies.companyId, company.id), isNull(vacancies.closedAt)))
      .orderBy(desc(vacancies.score))
      .limit(1);

    const list = await db.select().from(contacts).where(eq(contacts.companyId, company.id));

    result.push({
      companyId: company.id,
      company: company.name,
      domain: company.domain,
      country: company.country,
      city: company.city,
      kind: company.kind,
      sizeHint: company.sizeHint,
      techHints: company.techHints,
      tags: company.tags,
      description: company.description,
      vacancyId: vacancy?.id ?? null,
      vacancyTitle: vacancy?.title ?? null,
      vacancyStack: vacancy?.stack ?? [],
      contact: pickContact(list),
    });
  }

  return result;
}

/** Пропустити компанію: чернетка стирається, історія не чіпається. */
export async function discardDraft(id: number): Promise<{ deleted: boolean }> {
  const db = getDb();
  const [existing] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!existing) return { deleted: false };
  if (existing.status !== 'draft') throw new Error('видаляти можна тільки чернетку');
  await db.delete(outreach).where(eq(outreach.id, id));
  return { deleted: true };
}
