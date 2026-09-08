import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { facts } from '../db/schema.js';
import { log } from '../lib/log.js';
import { callModelWith, extractJson, noteLlmCall, remainingBudget } from './classify.js';
import type { DraftCandidate, Language } from './outreach.js';

/**
 * Персоналізація першого абзацу листа, розділ 4 OUTREACH.md.
 *
 * Модель пропонує, код вирішує. Усе, що вона повертає, проходить детерміновану
 * перевірку, і будь-яка підозра означає відкат на статичний абзац із шаблона.
 * Система ніколи не відправляє лист без першого абзацу і ніколи не блокується
 * через модель: вигаданий факт у холодному листі коштує дорожче, ніж шаблонний
 * текст замість персоналізованого.
 *
 * Персоналізується ТІЛЬКИ перший абзац. Другий містить факти про власника, і
 * генерувати його означало б ризикувати вигаданим досвідом у листі незнайомцю.
 */

export const AI_PROMPT_VERSION = 'outreach-intro-v2';

export const paragraphSchema = z.object({
  paragraph: z.string(),
  facts_used: z.array(z.string()).default([]),
  confidence: z.number(),
});

export type ParagraphResponse = z.infer<typeof paragraphSchema>;

export const MIN_WORDS = 20;
export const MAX_WORDS = 60;
export const MIN_CONFIDENCE = 60;

/** Слова, після яких лист читається як розсилка. Список з OUTREACH.md. */
export const STOP_PHRASES = [
  'excited',
  'passionate',
  'thrilled',
  'reach out',
  'i hope this finds you well',
  'delighted',
  'game changer',
  'cutting edge',
];

export interface CompanyFacts {
  name: string;
  domain: string;
  city: string | null;
  country: string | null;
  size: string | null;
  tech_hints: string[];
  tags: string[];
  description: string | null;
  vacancy_title: string | null;
  vacancy_stack: string[];
}

/**
 * Вхідні дані для моделі: тільки те, що вже є в базі по цій компанії.
 *
 * Опис обрізається до 400 символів навмисно. Довший текст не додає моделі
 * розуміння, зате дає більше матеріалу, з якого вона починає фантазувати.
 */
export function companyFacts(candidate: DraftCandidate): CompanyFacts {
  return {
    name: candidate.company,
    domain: candidate.domain,
    city: candidate.city,
    country: candidate.country,
    size: candidate.sizeHint ?? null,
    tech_hints: candidate.techHints.slice(0, 10),
    tags: (candidate.tags ?? []).slice(0, 10),
    description: candidate.description ? candidate.description.slice(0, 400) : null,
    vacancy_title: candidate.vacancyTitle,
    vacancy_stack: candidate.vacancyStack,
  };
}

export function buildPrompt(language: Language, ownerFacts: string[]): string {
  return [
    'Ти пишеш перший абзац холодного листа розробника до компанії.',
    '',
    'У блоці LETTER лежить увесь лист, у якому мітка {{intro}} це місце твого абзацу.',
    'Прочитай його: далі в листі відправник каже, хто він і що пропонує. Твій абзац',
    'мусить підводити саме до цього тексту і не повторювати того, що в ньому вже є.',
    '',
    'Що це за абзац:',
    '1. Це причина, чому лист пишеться саме цій компанії. Одне-два речення.',
    '2. Звертайся до читача на "ти або ви" ("you", "ваш"), це лист людині, а не довідка.',
    '3. НЕ переказуй опис компанії з їхнього сайту. Речення "X is a web development',
    '   company based in London that specializes in..." це не лист, це витяг з каталогу,',
    '   і читач знає про себе більше за тебе. Замість опису назви те, що робить',
    '   звернення доречним: їхній стек, тип роботи, ринок, розмір команди.',
    '4. Без компліментів і без оцінок їхньої роботи ("great work", "love your site"):',
    '   ти їхніх проєктів не бачив, і це чути.',
    '',
    'Обмеження:',
    '5. Використовуй ТІЛЬКИ факти з блоку COMPANY. Якщо фактів мало, напиши загальніше,',
    '   але НЕ вигадуй проєктів, клієнтів, нагород, цифр і новин.',
    '6. Заборонено: em dash, знак оклику, слова excited, passionate, thrilled,',
    '   reach out, I hope this finds you well, конструкції "not X but Y".',
    '7. Без привітання і без підпису, вони вже є в листі.',
    `8. Мова: ${language}.`,
    ...(ownerFacts.length > 0
      ? ['', 'Про відправника дозволено згадати тільки це:', ...ownerFacts.map((item) => `- ${item}`)]
      : []),
    '',
    'Поверни СТРОГО JSON без markdown і без преамбули:',
    '{"paragraph": "...", "facts_used": ["..."], "confidence": 0-100}',
  ].join('\n');
}

export interface Validation {
  ok: boolean;
  /** Причина відкату. Логується і потрапляє в статистику по причинах. */
  reason?: string;
  /** Текст після дозволених автоправок. Порожній, якщо відкат. */
  paragraph?: string;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentences(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
}

/**
 * Власні назви і числа з абзацу. Кожне мусить зустрічатись у вхідних даних,
 * інакше модель його вигадала.
 *
 * Перше слово речення пропускається: велика літера там означає початок речення,
 * а не назву, і без цієї поправки відкочувався б кожен другий валідний абзац.
 */
export function coinedTokens(paragraph: string, source: string): string[] {
  const haystack = source.toLowerCase();
  const coined: string[] = [];

  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.trim().split(/\s+/);
    tokens.forEach((rawToken, index) => {
      const token = rawToken.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!token) return;

      const isNumber = /^\d[\d.,%]*$/.test(token);
      const isProper = index > 0 && /^\p{Lu}/u.test(token) && token.length > 2;
      if (!isNumber && !isProper) return;
      if (!haystack.includes(token.toLowerCase())) coined.push(token);
    });
  }

  return [...new Set(coined)];
}

/**
 * Детермінована перевірка відповіді моделі. Порядок від найдешевшої до найдорожчої.
 *
 * Em dash не відкочує абзац, а замінюється комою: це єдина правка, після якої
 * текст лишається тим самим текстом. Решта порушень означає відкат, бо чинити
 * чужу вигадку кодом неможливо.
 */
/** Чи звертається абзац до читача. Лист без звертання це довідка про компанію. */
export function addressesReader(paragraph: string, language: Language): boolean {
  const lower = paragraph.toLowerCase();
  const markers =
    language === 'uk'
      ? [/\bви\b/, /\bвас\b/, /\bвам\b/, /\bваш/, /\bти\b/, /\bтво/]
      : [/\byou\b/, /\byour\b/, /\byou're\b/, /\byouve\b/, /\byou've\b/];
  return markers.some((marker) => marker.test(lower));
}

/** Найдовший спільний відрізок слів між абзацом і описом компанії. */
export function longestSharedRun(paragraph: string, description: string | null): number {
  if (!description) return 0;
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const a = clean(paragraph);
  const b = clean(description);
  let best = 0;

  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let run = 0;
      while (i + run < a.length && j + run < b.length && a[i + run] === b[j + run]) run += 1;
      if (run > best) best = run;
    }
  }

  return best;
}

/** Довший збіг означає, що абзац переписано з опису компанії, а не написано. */
export const MAX_SHARED_RUN = 7;

export function validateParagraph(
  response: ParagraphResponse,
  sourceJson: string,
  context: { language?: Language; description?: string | null } = {},
): Validation {
  const paragraph = response.paragraph.replace(/\s*—\s*/g, ', ').trim();

  if (!paragraph) return { ok: false, reason: 'порожній абзац' };
  if (response.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `низька впевненість: ${response.confidence}` };
  }

  const count = sentences(paragraph);
  if (count < 1 || count > 3) return { ok: false, reason: `речень ${count}, треба 1-3` };

  const length = words(paragraph);
  if (length < MIN_WORDS || length > MAX_WORDS) {
    return { ok: false, reason: `слів ${length}, треба ${MIN_WORDS}-${MAX_WORDS}` };
  }

  if (paragraph.includes('!')) return { ok: false, reason: 'знак оклику' };

  const lower = paragraph.toLowerCase();
  const stop = STOP_PHRASES.find((phrase) => lower.includes(phrase));
  if (stop) return { ok: false, reason: `стоп-слово: ${stop}` };

  if (/\bnot\s+[\w\s]{1,20}\bbut\b/i.test(paragraph)) {
    return { ok: false, reason: 'конструкція not X but Y' };
  }

  const coined = coinedTokens(paragraph, sourceJson);
  if (coined.length > 0) {
    return { ok: false, reason: `вигадані сутності: ${coined.join(', ')}` };
  }

  /*
   * Дві перевірки проти найчастішого браку: абзац, який переказує опис компанії
   * з каталогу. Формально він бездоганний, фактів не вигадує і всі попередні
   * перевірки проходить, але як лист не працює: читач знає про себе більше, ніж
   * там написано, і бачить, що перед ним автозаповнення.
   */
  if (context.language && !addressesReader(paragraph, context.language)) {
    return { ok: false, reason: 'абзац не звертається до читача, це опис компанії' };
  }

  const shared = longestSharedRun(paragraph, context.description ?? null);
  if (shared > MAX_SHARED_RUN) {
    return { ok: false, reason: `переказ опису компанії, ${shared} слів поспіль` };
  }

  return { ok: true, paragraph };
}

export interface ParagraphResult {
  /** Готовий текст або null, якщо відкат на шаблон. */
  paragraph: string | null;
  used: boolean;
  reason: string | null;
  confidence: number | null;
}

export type ModelCaller = (system: string, user: string) => Promise<string>;

async function defaultCaller(system: string, user: string): Promise<string> {
  /*
   * Температура 0.7: абзац має звучати як текст людини, а не як витяг з бази.
   * Модель окрема і сильніша за класифікаційну: тут один виклик на компанію,
   * якій справді пишеться лист, і його читатиме людина.
   */
  const raw = await callModelWith(system, user, 0.7, config.llm.outreachModel);
  await noteLlmCall(raw.inputTokens, raw.outputTokens);
  return raw.text;
}

/** Активні факти про власника, які модель має право згадати. */
export async function activeFacts(language: Language): Promise<string[]> {
  const rows = await getDb().select().from(facts).where(eq(facts.isActive, true));
  return rows.map((row) => (language === 'uk' ? row.textUk : row.textEn)).filter(Boolean);
}

/**
 * Один виклик на компанію. Результат кешується в `outreach.ai_paragraph`, і
 * повторна генерація буває тільки по явній кнопці: фонові перегенерації це
 * рахунок, який росте сам собою і нічого не покращує.
 */
export interface ParagraphContext {
  /** Тіло шаблона з міткою {{intro}}. Модель має бачити, у що вписується абзац. */
  letter?: string | null;
  subject?: string | null;
}

export async function generateParagraph(
  candidate: DraftCandidate,
  language: Language,
  context: ParagraphContext = {},
  caller: ModelCaller = defaultCaller,
): Promise<ParagraphResult> {
  if ((await remainingBudget()) <= 0) {
    return { paragraph: null, used: false, reason: 'денний ліміт викликів моделі', confidence: null };
  }

  const sourceJson = JSON.stringify(companyFacts(candidate), null, 2);
  const system = buildPrompt(language, await activeFacts(language));

  /*
   * Лист передається цілком. Без нього модель бачила лише картку компанії і
   * писала довідку про неї: формально за правилами, а як перший абзац листа
   * ні до чого. Абзац мусить підводити до тексту, який іде далі, а побачити
   * той текст можна тільки одним способом, показати його.
   */
  const user = [
    context.subject ? `SUBJECT:\n${context.subject}` : null,
    context.letter ? `LETTER:\n${context.letter}` : null,
    `COMPANY:\n${sourceJson}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Один ретрай на невалідний JSON, далі відкат. Ганяти модель по колу дорого.
  let lastReason = 'модель не відповіла';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const parsed = paragraphSchema.safeParse(extractJson(await caller(system, user)));
      if (!parsed.success) {
        lastReason = 'невалідний JSON';
        continue;
      }

      const validation = validateParagraph(parsed.data, sourceJson, {
        language,
        description: candidate.description,
      });
      if (validation.ok) {
        return {
          paragraph: validation.paragraph!,
          used: true,
          reason: null,
          confidence: parsed.data.confidence,
        };
      }

      // Валідація це не збій звʼязку: другий виклик дасть той самий клас проблеми.
      log.info({ company: candidate.company, reason: validation.reason }, 'відкат AI-абзацу');
      return {
        paragraph: null,
        used: false,
        reason: validation.reason ?? 'невідома причина',
        confidence: parsed.data.confidence,
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  log.warn({ company: candidate.company, reason: lastReason }, 'відкат AI-абзацу');
  return { paragraph: null, used: false, reason: lastReason, confidence: null };
}
