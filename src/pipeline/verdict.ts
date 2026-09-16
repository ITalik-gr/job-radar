import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, llmCache, outreach, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';
import { listFacts } from './facts.js';
import { hash } from './normalize.js';
import {
  matchTemplate,
  outreachTemplates,
  pickContact,
  pickLanguage,
  pickTargetType,
  type Language,
  type OutreachTarget,
} from './outreach.js';
import { scoreCompany } from './company-score.js';

/**
 * Вердикт по компанії: яким шаблоном до неї заходити і за що зачепитись.
 *
 * Це порадник, а не частина розсилки. Вибір шаблону в `outreach.ts` лишається
 * детермінованим, і саме він вирішує, що піде в чернетку: модель на однакових
 * даних дає різні відповіді, і питання "чому цій студії пішов саме цей текст"
 * після цього не має відповіді. Тут інше завдання і інша ціна помилки: власник
 * дивиться картку, тисне кнопку і читає думку про конкретну контору разом з
 * детермінованим вибором поруч. Розходження між ними це сигнал подумати, а не
 * помилка, і вирішує все одно людина.
 *
 * Текстів листів тут не генерується, розділ 11 CLAUDE.md. Модель бачить шаблони,
 * щоб обрати серед них, і повертає ключ, а не текст.
 */

export const VERDICT_PROMPT_VERSION = 'verdict-v1';

export const verdictSchema = z.object({
  /** Ключ обраного шаблона. null означає, що жоден не підходить. */
  template_slug: z.string().nullable(),
  alternative_slug: z.string().nullable().default(null),
  language: z.enum(['uk', 'en']),
  confidence: z.number().min(0).max(100),
  /** За що зачепитись у листі, одне речення. Матеріал для власника, не текст листа. */
  angle: z.string(),
  why: z.string(),
  risks: z.array(z.string()).default([]),
  /** Кому з контактів писати. Ім'я зі списку або null. */
  contact: z.string().nullable().default(null),
  skip: z.boolean().default(false),
  skip_reason: z.string().nullable().default(null),
});

export type Verdict = z.infer<typeof verdictSchema>;

export interface VerdictReport {
  companyId: number;
  domain: string;
  /** cache | llm | budget | invalid. Порожній вердикт завжди має причину. */
  source: 'cache' | 'llm' | 'budget' | 'invalid';
  verdict: Verdict | null;
  /**
   * Що обрала б розсилка без моделі. Показується поруч навмисно: без цієї пари
   * незрозуміло, чи модель щось побачила, чи просто повторила очевидне.
   */
  fallbackSlug: string | null;
  fallbackTarget: OutreachTarget;
  language: Language;
  error: string | null;
}

/** Компанія очима моделі. Тільки те, що вже лежить у базі. */
interface CompanyBlock {
  name: string;
  domain: string;
  kind: string;
  country: string | null;
  city: string | null;
  size: string | null;
  founded_year: number | null;
  rating: number | null;
  reviews_count: number | null;
  min_project: string | null;
  hourly_rate: string | null;
  tech_hints: string[];
  /** Ознаки живості: рік у копірайті і дата останнього поста. */
  copyright_year: number | null;
  last_post_at: string | null;
  careers_url: string | null;
  careers_kind: string;
  description: string | null;
  catalogs: string[];
  status: string;
  score: number;
  score_reasons: string[];
  contacts: { name: string | null; role: string | null; email: string | null }[];
  open_vacancies: { title: string; stack: string[]; seniority: string | null; remote: boolean | null }[];
  previous_outreach: { sent_at: string; template: string | null; reply: string | null }[];
}

/**
 * Опис шаблона для моделі. Тіло обрізається: обирають за тоном і призначенням,
 * а тон видно з перших рядків. Цілі листи в промпті це просто дорожчий запит.
 */
const TEMPLATE_BODY_CHARS = 600;

interface TemplateBlock {
  slug: string;
  name: string;
  kind: string;
  for_kind: string | null;
  language: string;
  target_type: string | null;
  note: string | null;
  body: string;
}

export async function collectCompany(companyId: number): Promise<CompanyBlock> {
  const db = getDb();

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw new Error(`компанії ${companyId} немає`);

  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, companyId));
  const people = await db.select().from(contacts).where(eq(contacts.companyId, companyId));

  const open = await db
    .select()
    .from(vacancies)
    .where(and(eq(vacancies.companyId, companyId), isNull(vacancies.closedAt)))
    .orderBy(desc(vacancies.score))
    .limit(5);

  const history = await db
    .select()
    .from(outreach)
    .where(eq(outreach.companyId, companyId))
    .orderBy(desc(outreach.sentAt))
    .limit(3);

  const breakdown = scoreCompany({
    company,
    openVacancies: open.length,
    status: state?.status ?? null,
  });

  const day = (value: number | null) => (value ? new Date(value).toISOString().slice(0, 10) : null);

  return {
    name: company.name,
    domain: company.domain,
    kind: company.kind,
    country: company.country,
    city: company.city,
    size: company.sizeHint,
    founded_year: company.foundedYear,
    rating: company.rating,
    reviews_count: company.reviewsCount,
    min_project: company.minProject,
    hourly_rate: company.hourlyRate,
    tech_hints: company.techHints,
    copyright_year: company.copyrightYear,
    last_post_at: day(company.lastPostAt),
    careers_url: company.careersUrl,
    careers_kind: company.careersKind,
    description: company.description ? company.description.slice(0, 600) : null,
    catalogs: company.sources,
    status: state?.status ?? 'new',
    score: breakdown.score,
    score_reasons: [...breakdown.positives, ...breakdown.negatives].map(
      (item) => `${item.weight > 0 ? '+' : ''}${item.weight} ${item.reason}`,
    ),
    contacts: people
      .slice(0, 8)
      .map((row) => ({ name: row.name, role: row.role, email: row.email })),
    open_vacancies: open.map((row) => ({
      title: row.title ?? 'без назви',
      stack: row.stack,
      seniority: row.seniority,
      remote: row.remote,
    })),
    previous_outreach: history.map((row) => ({
      sent_at: day(row.sentAt) ?? 'невідомо',
      template: row.templateUsed,
      reply: row.replyType,
    })),
  };
}

/**
 * Системний блок: правила, шаблони і дозволені факти про власника.
 *
 * Він стабільний між компаніями, і саме тому шаблони лежать тут, а не в
 * користувацькій частині: при перегляді студій поспіль Anthropic віддає його з
 * кешу за десяту частину ціни. Порядок теж не випадковий: кеш це збіг початку
 * запиту байт у байт, тому все змінне мусить бути після цього блоку.
 */
export function buildSystem(list: TemplateBlock[], ownerFacts: string[]): string {
  return [
    'Ти радиш розробнику, яким шаблоном холодного листа заходити до конкретної компанії.',
    'Відповідай СТРОГО одним JSON-обʼєктом, без преамбули і без markdown-огорожі.',
    '',
    'Правила:',
    '1. Обирай ТІЛЬКИ серед шаблонів нижче і повертай їх `slug` дослівно. Не вигадуй ключів.',
    '2. Текст листа НЕ пиши. Твоя робота це вибір шаблона і одне речення про зачіпку.',
    '3. Спирайся тільки на блок COMPANY. Чого там немає, того не існує: не додумуй',
    '   проєктів, клієнтів, новин і технологій.',
    '4. `angle` це причина писати саме цій компанії: їхній стек, тип роботи, ринок,',
    '   відкрита вакансія. Без компліментів і без оцінок їхньої роботи.',
    '5. `language`: uk для компаній з України, en для решти.',
    '6. `contact` це імʼя зі списку контактів компанії або null. Іменна людина краща',
    '   за загальну скриньку, технічна роль краща за менеджерську.',
    '7. `risks` це те, через що лист може не спрацювати: мертвий сайт, чужий стек,',
    '   недавній контакт без відповіді. Порожній масив, якщо ризиків не видно.',
    '8. `skip` true, якщо писати не варто взагалі. Тоді `skip_reason` пояснює чому.',
    '9. `confidence` ціле від 0 до 100: наскільки ти впевнений у виборі.',
    '',
    ...(ownerFacts.length > 0
      ? ['Про відправника дозволено враховувати тільки це:', ...ownerFacts.map((item) => `- ${item}`), '']
      : []),
    'Шаблони:',
    JSON.stringify(list, null, 1),
    '',
    'Формат відповіді:',
    '{"template_slug":"...","alternative_slug":null,"language":"en","confidence":0,',
    '"angle":"...","why":"...","risks":[],"contact":null,"skip":false,"skip_reason":null}',
  ].join('\n');
}

async function templateBlocks(): Promise<TemplateBlock[]> {
  const rows = await outreachTemplates();

  /*
   * Порядок фіксований за ключем, а не за тим, як їх віддала база. Кеш промпта
   * це збіг байт у байт, і перестановка двох шаблонів місцями коштувала б повний
   * запит замість кешованого, причому мовчки.
   */
  return rows
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      for_kind: row.forKind,
      language: row.language,
      target_type: row.targetType,
      note: row.note,
      body: `${row.intro ? `${row.intro}\n` : ''}${row.body}`.slice(0, TEMPLATE_BODY_CHARS),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface VerdictOptions {
  /** Підміна виклику моделі у тестах. */
  caller?: (system: string, user: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  skipCache?: boolean;
}

export async function companyVerdict(
  companyId: number,
  options: VerdictOptions = {},
): Promise<VerdictReport> {
  const db = getDb();
  const company = await collectCompany(companyId);
  const list = await templateBlocks();

  /*
   * Детермінований вибір рахується завжди, навіть коли модель відповість. Він же
   * і запасний варіант: жоден шлях у цій функції не має права лишити власника без
   * відповіді на питання "яким шаблоном писати".
   */
  const language = pickLanguage(company.country);
  const people = await db.select().from(contacts).where(eq(contacts.companyId, companyId));
  const contact = pickContact(people);
  const fallbackTarget = pickTargetType({
    hasVacancy: company.open_vacancies.length > 0,
    contactName: contact?.name,
    contactEmail: contact?.email,
  });
  const rows = await outreachTemplates();
  const fallbackSlug = matchTemplate(rows, fallbackTarget, language)?.slug ?? null;

  const base: VerdictReport = {
    companyId,
    domain: company.domain,
    source: 'invalid',
    verdict: null,
    fallbackSlug,
    fallbackTarget,
    language,
    error: null,
  };

  if (list.length === 0) {
    return { ...base, error: 'немає жодного шаблона розсилки: нема з чого обирати' };
  }

  const facts = await listFacts();
  const ownerFacts = facts
    .filter((row) => row.isActive)
    .map((row) => (language === 'uk' ? row.textUk : row.textEn))
    .filter(Boolean);

  const system = buildSystem(list, ownerFacts);
  const user = `COMPANY:\n${JSON.stringify(company, null, 1)}`;

  /*
   * Ключ кешу це модель, версія промпта, шаблони і сама компанія. Тобто повторне
   * натискання кнопки нічого не коштує, а правка шаблона або нова знайдена пошта
   * дають новий вердикт самі, без кнопки "перерахувати".
   */
  const key = hash(`${config.llm.verdictModel}|${VERDICT_PROMPT_VERSION}|${system}|${user}`);

  if (!options.skipCache) {
    const [cached] = await db.select().from(llmCache).where(eq(llmCache.key, key));
    if (cached) {
      const parsed = verdictSchema.safeParse(cached.response);
      if (parsed.success) return { ...base, source: 'cache', verdict: parsed.data };
      await db.delete(llmCache).where(eq(llmCache.key, key));
    }
  }

  if ((await remainingBudget()) <= 0) {
    log.warn({ companyId, limit: config.llm.dailyCallLimit }, 'денний ліміт викликів моделі вичерпано');
    return { ...base, source: 'budget', error: 'денний ліміт викликів моделі вичерпано' };
  }

  const known = new Set(list.map((item) => item.slug));
  const caller =
    options.caller ??
    ((sys: string, text: string) => callModelWith(sys, text, 0, config.llm.verdictModel, true));

  let lastError = '';

  // Один ретрай, як і в класифікації: невалідна відповідь не привід ганяти модель по колу.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: { text: string; inputTokens: number; outputTokens: number };
    try {
      raw = await caller(system, user);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await noteLlmCall(0, 0, true);
      log.warn({ companyId, attempt, err: lastError }, 'виклик моделі за вердиктом впав');
      continue;
    }

    await noteLlmCall(raw.inputTokens, raw.outputTokens, false);

    try {
      const parsed = verdictSchema.parse(extractJson(raw.text));

      /*
       * Ключ перевіряється кодом, а не довірою. Модель регулярно повертає схожий,
       * але неіснуючий slug, і мовчки прийнятий вердикт вів би в шаблон, якого
       * немає: у цей момент кнопка виглядає робочою і не працює.
       */
      if (parsed.template_slug && !known.has(parsed.template_slug)) {
        lastError = `модель назвала неіснуючий шаблон ${parsed.template_slug}`;
        log.warn({ companyId, attempt, slug: parsed.template_slug }, lastError);
        continue;
      }
      if (parsed.alternative_slug && !known.has(parsed.alternative_slug)) parsed.alternative_slug = null;

      await db
        .insert(llmCache)
        .values({
          key,
          model: config.llm.verdictModel,
          promptVersion: VERDICT_PROMPT_VERSION,
          response: parsed,
        })
        .onConflictDoNothing();

      log.info(
        { companyId, domain: company.domain, slug: parsed.template_slug, fallbackSlug },
        'вердикт по компанії готовий',
      );
      return { ...base, source: 'llm', verdict: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn({ companyId, attempt, err: lastError }, 'вердикт не пройшов валідацію');
    }
  }

  /*
   * Правило 3 CLAUDE.md: порожній результат це помилка, не успіх. Кнопка мусить
   * сказати, що саме не вийшло, і лишити детермінований вибір як робочу відповідь.
   */
  log.warn({ companyId, err: lastError }, 'вердикт не вдався, лишається детермінований вибір');
  return { ...base, source: 'invalid', error: lastError || 'модель не відповіла' };
}
