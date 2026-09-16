import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { llmCache, llmUsage } from '../db/schema.js';
import { log } from '../lib/log.js';
import { hash } from './normalize.js';
import { runWorkersAi, textFromAi } from '../lib/workers-ai.js';

export const PROMPT_VERSION = 'v1';

/** Схема відповіді. Невалідний JSON означає один ретрай, потім ручний перегляд. */
export const classificationSchema = z.object({
  is_vacancy: z.boolean(),
  title: z.string().nullable(),
  stack: z.array(z.string()).default([]),
  seniority: z.string().nullable(),
  remote: z.boolean().nullable(),
  location: z.string().nullable(),
  salary_min: z.number().int().nullable(),
  salary_max: z.number().int().nullable(),
  currency: z.string().nullable(),
  english_level_required: z.string().nullable(),
  relevance: z.number().min(0).max(100),
  why: z.string(),
});

export type Classification = z.infer<typeof classificationSchema>;

const SYSTEM_PROMPT = `Ти класифікуєш текст вакансії. Відповідай СТРОГО одним JSON-обʼєктом.
Без преамбули, без пояснень, без markdown-огорожі.

Формат:
{"is_vacancy":true,"title":"...","stack":["react"],"seniority":"senior","remote":true,
"location":"Berlin, hybrid","salary_min":null,"salary_max":null,"currency":null,
"english_level_required":"B2","relevance":0,"why":"одне речення українською"}

Правила:
- Класифікуй тільки той текст, який дано. Нічого не додумуй.
- Чого немає в тексті, те null. Не вгадуй вилку, не вгадуй локацію, не вгадуй рівень англійської.
- stack це технології з тексту в нижньому регістрі, порожній масив якщо їх немає.
- seniority одне з: intern, junior, middle, senior, lead, або null.
- salary_min і salary_max цілі числа на місяць або рік так, як указано в тексті, інакше null.
- relevance ціле від 0 до 100: наскільки це вакансія фронтенд або full-stack розробника
  на TypeScript, React, Next.js, Node. Це твоя думка, вона не є фінальним рахунком.
- why одне коротке речення українською.
- Якщо текст це не вакансія (новина, опис компанії, навігація), поверни is_vacancy false
  і relevance 0.`;

export interface ClassifyOptions {
  /** Підміна виклику моделі у тестах. */
  caller?: (text: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  skipCache?: boolean;
}

export interface ClassifyResult {
  classification: Classification | null;
  /** cache | llm | budget | invalid */
  reason: 'cache' | 'llm' | 'budget' | 'invalid';
  needsReview: boolean;
}

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!config.llm.apiKey) throw new Error('немає ANTHROPIC_API_KEY у .env');
  client ??= new Anthropic({
    apiKey: config.llm.apiKey,
    // Порожній baseUrl означає прямий виклик. Заданий це шлюз AI Gateway.
    ...(config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : {}),
    /*
     * Authenticated Gateway відбиває запит без цього заголовка з 401, і збоку
     * це виглядає як мовчазна відмова моделі: ключ Anthropic правильний, ліміти
     * цілі, а відповіді немає. Тому заголовок ставиться завжди, коли токен є.
     */
    ...(config.cloudflare.gatewayToken
      ? { defaultHeaders: { 'cf-aig-authorization': `Bearer ${config.cloudflare.gatewayToken}` } }
      : {}),
  });
  return client;
}

/**
 * Кешований системний промпт.
 *
 * Anthropic тримає розібраний початок запиту кілька хвилин і бере за нього
 * десяту частину ціни. Сенс є там, де цей початок довгий і однаковий підряд:
 * вердикт по компанії возить у системному блоці всі шаблони листів, і при
 * перегляді десятка студій поспіль цей блок незмінний.
 *
 * Мінімальна довжина блоку залежить від моделі: на Haiku 4.5 це 4096 токенів,
 * і коротший блок не кешується взагалі, мовчки. Тому прапорець це прохання, а
 * не гарантія, і код на нього не спирається.
 */
function systemBlocks(system: string, cached: boolean) {
  return cached
    ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
    : system;
}

async function callAnthropic(
  text: string,
  system = SYSTEM_PROMPT,
  temperature = 0,
  model?: string,
  cacheSystem = false,
) {
  const response = await anthropic().messages.create({
    model: model ?? config.llm.model,
    max_tokens: 1024,
    temperature,
    system: systemBlocks(system, cacheSystem),
    messages: [{ role: 'user', content: text }],
  });

  const body = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    text: body,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Той самий промпт через Workers AI. Модель менша за Haiku, тому вимога до JSON
 * дублюється в самому запиті полем `response_format`: без нього llama регулярно
 * додає пояснення перед обʼєктом, і кожна така відповідь коштувала б ретрай.
 */
async function callWorkersAi(text: string, system = SYSTEM_PROMPT, temperature = 0) {
  const payload = await runWorkersAi(config.llm.workersModel, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    max_tokens: 1024,
    temperature,
    response_format: { type: 'json_object' },
  });

  return textFromAi(payload);
}

/** Виклик моделі за поточним провайдером. */
async function callModel(text: string) {
  return config.llm.provider === 'workers-ai' ? callWorkersAi(text) : callAnthropic(text);
}

export interface RawCall {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Виклик з довільним системним промптом. Потрібен персоналізації листів: там
 * інший промпт і температура 0.7, але той самий провайдер, той самий облік
 * витрат і та сама денна стеля, тому другого клієнта заводити нема сенсу.
 */
export async function callModelWith(
  system: string,
  user: string,
  temperature = 0,
  /** Модель на цей виклик. Порожнє означає ту, якою класифікуються вакансії. */
  model?: string,
  /** Попросити Anthropic кешувати системний блок. У Workers AI кешу немає, там прапорець мовчить. */
  cacheSystem = false,
): Promise<RawCall> {
  return config.llm.provider === 'workers-ai'
    ? callWorkersAi(user, system, temperature)
    : callAnthropic(user, system, temperature, model, cacheSystem);
}

/** Облік витрат для викликів поза класифікацією. */
export async function noteLlmCall(input: number, output: number, failed = false): Promise<void> {
  await recordUsage(today(), input, output, failed);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function usageRow(day: string) {
  const db = getDb();
  const [row] = await db.select().from(llmUsage).where(eq(llmUsage.day, day));
  if (row) return row;
  await db.insert(llmUsage).values({ day }).onConflictDoNothing();
  const [created] = await db.select().from(llmUsage).where(eq(llmUsage.day, day));
  return created!;
}

export async function remainingBudget(day = today()): Promise<number> {
  const row = await usageRow(day);
  return Math.max(0, config.llm.dailyCallLimit - row.calls);
}

async function recordUsage(day: string, input: number, output: number, failed: boolean) {
  const db = getDb();
  await db
    .update(llmUsage)
    .set({
      calls: sql`${llmUsage.calls} + 1`,
      inputTokens: sql`${llmUsage.inputTokens} + ${input}`,
      outputTokens: sql`${llmUsage.outputTokens} + ${output}`,
      failures: failed ? sql`${llmUsage.failures} + 1` : llmUsage.failures,
    })
    .where(eq(llmUsage.day, day));
}

/** Модель іноді все ж обгортає JSON у ```json, це дешевше зняти, ніж ретраїти. */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('у відповіді немає JSON-обʼєкта');

  return JSON.parse(cleaned.slice(start, end + 1));
}

export function cacheKey(text: string): string {
  return hash(`${config.llm.activeModel}|${PROMPT_VERSION}|${text}`);
}

export async function classifyText(text: string, options: ClassifyOptions = {}): Promise<ClassifyResult> {
  const db = getDb();
  const key = cacheKey(text);

  if (!options.skipCache) {
    const [cached] = await db.select().from(llmCache).where(eq(llmCache.key, key));
    if (cached) {
      const parsed = classificationSchema.safeParse(cached.response);
      if (parsed.success) return { classification: parsed.data, reason: 'cache', needsReview: false };
      await db.delete(llmCache).where(eq(llmCache.key, key));
    }
  }

  const day = today();
  if ((await remainingBudget(day)) <= 0) {
    log.warn({ day, limit: config.llm.dailyCallLimit }, 'денний ліміт викликів моделі вичерпано');
    return { classification: null, reason: 'budget', needsReview: true };
  }

  const caller = options.caller ?? callModel;
  let lastError = '';

  // Один ретрай, як вимагає CLAUDE.md: невалідний JSON це не привід ганяти модель по колу.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: Awaited<ReturnType<typeof callAnthropic>>;
    try {
      raw = await caller(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await recordUsage(day, 0, 0, true);
      log.warn({ attempt, err: lastError }, 'виклик моделі впав');
      continue;
    }

    await recordUsage(day, raw.inputTokens, raw.outputTokens, false);

    try {
      const parsed = classificationSchema.parse(extractJson(raw.text));
      await db
        .insert(llmCache)
        .values({ key, model: config.llm.activeModel, promptVersion: PROMPT_VERSION, response: parsed })
        .onConflictDoNothing();
      return { classification: parsed, reason: 'llm', needsReview: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn({ attempt, err: lastError }, 'відповідь моделі не пройшла валідацію');
    }
  }

  log.warn({ err: lastError }, 'класифікація не вдалась, запис піде на ручний перегляд');
  return { classification: null, reason: 'invalid', needsReview: true };
}
