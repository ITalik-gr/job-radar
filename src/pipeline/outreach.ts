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
import { readSetting, writeSetting } from '../lib/settings-store.js';
import { rules } from './rules.js';
import { generateParagraph } from './ai-paragraph.js';
import { enrich } from './enrich.js';

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
  /** Спільний підпис. Порожнє означає, що листи йдуть без нього. */
  signature?: string | null,
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
    signature: signature ?? '',
  };

  const subject = renderLetter(template.subject ?? '', context);

  /*
   * Підпис дописується в кінець, якщо шаблон не ставить його сам міткою і якщо
   * його там ще немає. Мітка це правильний спосіб, але старі шаблони писались до
   * її появи, і лишати їх без підпису означало б мовчки відправляти листи, які
   * закінчуються на півслові.
   */
  const hasToken = /\{\{\s*signature\s*\}\}/i.test(template.body);
  const firstLine = (signature ?? '').split('\n')[0]?.trim() ?? '';
  const needsTail =
    Boolean(signature?.trim()) && !hasToken && (!firstLine || !template.body.includes(firstLine));

  const body = renderLetter(needsTail ? `${template.body}\n\n{{signature}}` : template.body, context);

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
export const SIGNATURE_KEY = 'outreach.signature';

/** Типовий підпис. Правиться на сторінці Шаблони і лягає в `settings`. */
export const DEFAULT_SIGNATURE = ['Alex Example', 'Front-end / Full-stack developer', 'example.dev'].join(
  '\n',
);

const SIGNATURE = DEFAULT_SIGNATURE;

export async function readSignature(): Promise<string> {
  return (await readSetting<string>(SIGNATURE_KEY, DEFAULT_SIGNATURE)) || '';
}

export async function saveSignature(value: string): Promise<string> {
  await writeSetting(SIGNATURE_KEY, value);
  return value;
}

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
  options: { limit?: number; dryRun?: boolean; ai?: boolean; enrichLimit?: number } = {},
): Promise<PrepareReport> {
  const db = getDb();
  const limit = options.limit ?? 20;
  const list = await outreachTemplates();
  const candidates = await draftCandidates(limit);

  /*
   * Скільки сайтів дозволено обійти за цей прохід. Обхід іде до складання листа,
   * а не після: чернетка без адреси лягала в чергу з позначкою "немає адреси, куди
   * писати", і власник бачив лист, який нікуди не піде, доки не запустить збір
   * контактів окремо. Тепер порядок зворотний, а бюджет не дає проходу впертись
   * у ліміт часу воркера на сотні компаній.
   */
  let enrichBudget = options.dryRun ? 0 : (options.enrichLimit ?? 5);

  // Один читач на весь прохід: підпис однаковий у всіх листах цієї партії.
  const signature = await readSignature();

  const report: PrepareReport = {
    candidates: candidates.length,
    created: 0,
    needsAttention: 0,
    skipped: [],
    drafts: [],
  };

  for (let candidate of candidates) {
    /*
     * Адреси немає означає, що сайт компанії ще не обходили, а не що писати нікуди.
     * Один сайт це кілька сторінок, тому дешевше сходити зараз, ніж класти в чергу
     * зіпсовану чернетку.
     */
    let walked = false;
    if (!candidate.contact?.email && enrichBudget > 0) {
      enrichBudget -= 1;
      walked = true;
      try {
        await enrich({ domain: candidate.domain, limit: 1 });
        const [refreshed] = await draftCandidatesFor([candidate.companyId]);
        if (refreshed) candidate = { ...refreshed, vacancyId: candidate.vacancyId, vacancyTitle: candidate.vacancyTitle, vacancyStack: candidate.vacancyStack };
      } catch (error) {
        log.warn({ domain: candidate.domain, err: String(error) }, 'обхід сайту перед листом не вдався');
      }
    }

    /*
     * Без адреси чернетка не створюється зовсім. Раніше вона лягала в чергу з
     * помилкою, і черга наповнювалась листами, які нікуди не підуть.
     */
    if (!candidate.contact?.email) {
      report.skipped.push({
        company: candidate.company,
        reason: walked
          ? 'обійшов сайт, адреси на ньому немає'
          : 'адреси немає, а обхід сайту не влазить у цей прохід',
      });
      continue;
    }

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
      ? await generateParagraph(candidate, language, { letter: template.body, subject: template.subject })
      : { paragraph: null, used: false, reason: null, confidence: null };

    const built = buildDraft(candidate, template, language, ai.paragraph, signature);
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
  /**
   * Усі адреси, які радар знайшов у цієї компанії.
   *
   * Їдуть разом з чернеткою навмисно: без них єдиним способом поставити іншу
   * адресу було вписати її руками, тобто згадати напамʼять те, що вже лежить у
   * базі. Мертві адреси теж тут, але позначені: список має пояснювати, чому
   * саме ця не годиться, а не мовчки її ховати.
   */
  companyContacts: { name: string | null; role: string | null; email: string; emailValid: boolean }[];
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

  /*
   * Контакти беруться одним запитом на всі чернетки, а не по одному на картку:
   * карток на екрані десятки, і запит на кожну перетворив би відкриття сторінки
   * на чергу з півсотні звернень до бази.
   */
  const companyIds = [...new Set(rows.map(({ row }) => row.companyId))];
  const people =
    companyIds.length > 0
      ? await db.select().from(contacts).where(inArray(contacts.companyId, companyIds))
      : [];

  const byCompany = new Map<number, DraftRow['companyContacts']>();
  for (const person of people) {
    if (!person.email) continue;
    const list = byCompany.get(person.companyId) ?? [];
    list.push({
      name: person.name,
      role: person.role,
      email: person.email,
      emailValid: person.emailValid,
    });
    byCompany.set(person.companyId, list);
  }

  // Іменні адреси першими: лист на hello@ читає менеджер, розділ 9 CLAUDE.md.
  for (const list of byCompany.values()) {
    list.sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)));
  }

  return rows.map(({ row, company, domain, title }) => ({
    id: row.id,
    companyId: row.companyId,
    companyContacts: byCompany.get(row.companyId) ?? [],
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
  patch: { subject?: string; body?: string; contactEmail?: string | null; contactName?: string | null },
): Promise<DraftRow | null> {
  const db = getDb();
  const [existing] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!existing) throw new Error(`чернетки ${id} немає`);
  if (existing.status !== 'draft') throw new Error('правити можна тільки чернетку');

  let subject = patch.subject ?? existing.subjectFinal ?? '';
  let body = patch.body ?? existing.bodyFinal ?? '';

  /*
   * Адресу можна вписати руками просто в чернетці, і вона не лишається всередині
   * листа: той самий контакт заводиться компанії. Інакше пошту, знайдену очима на
   * їхньому сайті, довелось би вписувати вдруге на сторінці студії, а наступного
   * разу радар знову вважав би, що адреси немає.
   */
  const email = patch.contactEmail === undefined ? existing.contactEmail : normalizeEmail(patch.contactEmail);
  const name = patch.contactName === undefined ? existing.contactName : patch.contactName?.trim() || null;

  if (email && email !== existing.contactEmail) {
    await rememberContact(existing.companyId, email, name);
  }

  /*
   * Зміна адреси це зміна людини, а імʼя вже вшите в готовий текст.
   *
   * Лист складається один раз, і `{{first_name}}` у ньому давно перетворився на
   * конкретне "Hi Anna". Перевести чернетку на іншу адресу і лишити текст як є
   * означає привітатись з Анною в листі до Ігоря, причому мовчки: у тексті все
   * гаразд, помилки немає, лист іде. Тому імʼя міняється разом з адресою, і це
   * саме заміна слова на слово, а не переписування листа моделлю.
   */
  const wasCalled = firstName(existing.contactName);
  const nowCalled = firstName(name);

  let renamed: string | null = null;
  if (wasCalled && wasCalled !== nowCalled) {
    const pattern = `\\b${escapeForRegExp(wasCalled)}\\b`;

    if (nowCalled) {
      subject = subject.replace(new RegExp(pattern, 'g'), nowCalled);
      body = body.replace(new RegExp(pattern, 'g'), nowCalled);
    } else if (new RegExp(pattern).test(`${subject}\n${body}`)) {
      /*
       * Нового імені немає, а старе в тексті лишилось. Мовчки залишити його не
       * можна, а вигадати звертання нема з чого, тому чернетка чесно стає
       * проблемною: власник або впише імʼя, або перебере лист іншим шаблоном.
       */
      renamed = `у тексті лишилось імʼя ${wasCalled}, а адреса тепер інша`;
    }
  }

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
  else if (!email) error = 'немає адреси, куди писати';
  else if (renamed) error = renamed;

  await db
    .update(outreach)
    .set({ subjectFinal: subject, bodyFinal: body, contactEmail: email, contactName: name, error })
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
  const ai = await generateParagraph(candidate, language, {
    letter: template.body,
    subject: template.subject,
  });
  const built = buildDraft(
    { ...candidate, vacancyId: draft.vacancyId },
    template,
    language,
    ai.paragraph,
    await readSignature(),
  );

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

/**
 * Інший шаблон для вже готової чернетки.
 *
 * Вибір шаблона в розсилці робить код, за парою роль плюс мова, і це правильно
 * за замовчуванням. Але людина бачить конкретну компанію і знає про неї те, чого
 * немає в базі, тому мусить мати змогу перекласти лист на інший текст, не збираючи
 * чернетку заново і не втрачаючи вже написаний першим абзац.
 *
 * До моделі тут звернень немає: абзац, якщо він від неї, переноситься як є.
 */
export async function retemplateDraft(id: number, slug: string): Promise<DraftRow | null> {
  const db = getDb();
  const [draft] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!draft) throw new Error(`чернетки ${id} немає`);
  if (draft.status !== 'draft') throw new Error('міняти шаблон можна тільки в чернетці');

  const [template] = await db.select().from(templates).where(eq(templates.slug, slug));
  if (!template) throw new Error(`шаблона ${slug} немає`);

  const [candidate] = await draftCandidatesFor([draft.companyId]);
  if (!candidate) throw new Error('компанію не знайдено');

  const language = (template.language as Language) ?? (draft.language as Language);
  const built = buildDraft(
    { ...candidate, vacancyId: draft.vacancyId },
    template,
    language,
    draft.aiParagraph,
    await readSignature(),
  );

  await db
    .update(outreach)
    .set({
      templateId: template.id,
      templateUsed: template.slug,
      language,
      subjectFinal: built.subject,
      bodyFinal: built.body,
      error: built.error,
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

/**
 * Чернетка для конкретної компанії, по кнопці з Черги або зі Студій.
 *
 * Це той самий шлях, що й нічна підготовка: ті самі шаблони, той самий вибір
 * мови і контакту, ті самі перевірки. Окрема логіка "швидкого листа" тут була б
 * другим набором правил, який з часом розійдеться з першим.
 */
export async function draftForCompany(
  companyId: number,
  vacancyId?: number | null,
  options: { ai?: boolean; enrich?: boolean; templateSlug?: string | null } = {},
): Promise<{ draft: PreparedDraft | null; id: number | null; reason: string | null }> {
  const db = getDb();

  const [existing] = await db
    .select({ id: outreach.id })
    .from(outreach)
    .where(and(eq(outreach.companyId, companyId), eq(outreach.status, 'draft')));
  if (existing) {
    return { draft: null, id: existing.id, reason: 'чернетка цій компанії вже лежить у черзі' };
  }

  let [candidate] = await draftCandidatesFor([companyId]);
  if (!candidate) return { draft: null, id: null, reason: 'компанію не знайдено' };

  /*
   * Немає адреси це ще не відмова: сайт компанії просто ще не обходили. Замість
   * того, щоб відправити людину запускати enrichment руками і повертатись, ходимо
   * на сайт прямо зараз. Одна компанія це кілька сторінок, не хвилини.
   *
   * Іменного контакту може і не знайтись, і це нормально: загальна скринька з
   * сайту теж адреса, під неї є окремий шаблон. Вигадувати hello@домен ми не
   * будемо, або воно є на сайті, або листа не буде.
   */
  let enriched = false;
  if (!candidate.contact?.email && options.enrich !== false) {
    await enrich({ domain: candidate.domain, limit: 1 });
    enriched = true;
    [candidate] = await draftCandidatesFor([companyId]);
    if (!candidate) return { draft: null, id: null, reason: 'компанію не знайдено' };
  }

  /*
   * Адреси немає навіть після обходу сайту. Чернетка все одно створюється, з порожнім
   * полем адреси: лист збирається, текст видно, і лишається вписати пошту руками на
   * сторінці До відправки. Раніше тут була відмова, і компанія просто зникала з поля
   * зору, хоча знайти адресу очима на їхньому сайті часто справа хвилини.
   *
   * Відправку це не відкриває: `checkSend` без адреси не дає натиснути кнопку.
   */
  const missingEmail = !candidate.contact?.email;

  if (vacancyId) {
    const [vacancy] = await db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
    if (vacancy) {
      candidate.vacancyId = vacancy.id;
      candidate.vacancyTitle = vacancy.title;
      candidate.vacancyStack = vacancy.stack;
    }
  }

  const language = pickLanguage(candidate.country);
  const target = pickTargetType({
    hasVacancy: candidate.vacancyId !== null,
    contactName: candidate.contact?.name,
    contactEmail: candidate.contact?.email,
  });

  /*
   * Шаблон, вибраний руками на картці, важливіший за підбір за роллю і мовою.
   * Раніше цей вибір нікуди не йшов: власник ставив шаблон у селекті, тиснув
   * "У чергу листів" і отримував чернетку зовсім іншим текстом, бо код підбирав
   * свій. Автоматичний підбір лишається тим, чим і був: значенням за замовчуванням.
   */
  const chosen = options.templateSlug
    ? (await db.select().from(templates).where(eq(templates.slug, options.templateSlug)))[0]
    : undefined;

  if (options.templateSlug && !chosen) {
    return { draft: null, id: null, reason: `шаблона ${options.templateSlug} немає` };
  }

  const template = chosen ?? matchTemplate(await outreachTemplates(), target, language);
  if (!template) {
    return { draft: null, id: null, reason: `немає шаблона ${target} мовою ${language}` };
  }

  // Мова йде за шаблоном: людина вибрала текст, і він написаний однією конкретною.
  const letterLanguage = chosen ? ((chosen.language as Language) ?? language) : language;

  const ai = options.ai
    ? await generateParagraph(candidate, letterLanguage, {
        letter: template.body,
        subject: template.subject,
      })
    : { paragraph: null, used: false, reason: null, confidence: null };

  const built = buildDraft(candidate, template, letterLanguage, ai.paragraph, await readSignature());
  const [row] = await db
    .insert(outreach)
    .values({
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      channel: 'email',
      status: 'draft',
      sentAt: null,
      queuedAt: Date.now(),
      templateId: built.templateId,
      templateUsed: built.templateSlug,
      language: built.language,
      subjectFinal: built.subject,
      bodyFinal: built.body,
      contactName: built.contactName,
      contactEmail: built.contactEmail,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      error: built.error,
    })
    .returning({ id: outreach.id });

  return {
    draft: {
      companyId: candidate.companyId,
      vacancyId: candidate.vacancyId,
      contactId: candidate.contact?.id ?? null,
      aiUsed: ai.used,
      aiParagraph: ai.paragraph,
      aiFallbackReason: ai.reason,
      ...built,
    },
    id: row!.id,
    reason: missingEmail
      ? enriched
        ? 'обійшов сайт, адреси не знайшов. Чернетка в черзі, впиши пошту руками'
        : 'адреси немає. Чернетка в черзі, впиши пошту руками'
      : null,
  };
}

/** Адреса приводиться до одного вигляду, інакше та сама пошта заведеться двічі. */
/** Перше слово імені: саме воно стоїть у листі як `{{first_name}}`. */
function firstName(value: string | null | undefined): string | null {
  return (value ?? '').trim().split(/\s+/)[0] || null;
}

/** Імʼя йде в регулярку, а в іменах трапляються крапки і дефіси. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/**
 * Запамʼятати адресу за компанією. Дублікат не заводиться, а мертва адреса
 * повертається до життя: якщо власник вписав її руками, значить перевірив.
 */
export async function rememberContact(
  companyId: number,
  email: string,
  name: string | null = null,
  role: string | null = null,
): Promise<{ created: boolean }> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), eq(contacts.email, email)));

  if (existing) {
    await db
      .update(contacts)
      .set({ emailValid: true, name: existing.name ?? name, role: existing.role ?? role })
      .where(eq(contacts.id, existing.id));
    return { created: false };
  }

  await db.insert(contacts).values({ companyId, email, name, role, emailValid: true });
  return { created: true };
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
