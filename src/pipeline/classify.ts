import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { llmCache, llmUsage } from '../db/schema.js';
import { log } from '../lib/log.js';
import { hash } from './normalize.js';
import { localDay } from '../lib/time.js';
import { aiAvailable, runWorkersAi, textFromAi } from '../lib/workers-ai.js';

/**
 * Part of the cache key. v2 switched the prompt to English, so `why` comes back in English
 * rather than Ukrainian; answers cached under v1 stay readable but are not reused.
 */
export const PROMPT_VERSION = 'v2';

/** Response schema. Invalid JSON means one retry, then manual review. */
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

const SYSTEM_PROMPT = `You classify the text of a job posting. Reply STRICTLY with a single JSON object.
No preamble, no explanations, no markdown fence.

Format:
{"is_vacancy":true,"title":"...","stack":["react"],"seniority":"senior","remote":true,
"location":"Berlin, hybrid","salary_min":null,"salary_max":null,"currency":null,
"english_level_required":"B2","relevance":0,"why":"one sentence in English"}

Rules:
- Classify only the text you are given. Do not invent anything.
- Whatever is not in the text is null. Do not guess the salary, the location or the English level.
- stack is the technologies from the text in lower case, an empty array if there are none.
- seniority is one of: intern, junior, middle, senior, lead, or null.
- salary_min and salary_max are integers per month or per year exactly as stated in the text, otherwise null.
- relevance is an integer from 0 to 100: how much this is a front end or full-stack developer
  role on TypeScript, React, Next.js, Node. This is your opinion, not the final score.
- why is one short sentence in English.
- If the text is not a job posting (news, company description, navigation), return is_vacancy false
  and relevance 0.`;

export interface ClassifyOptions {
  /** Replaces the model call in tests. */
  caller?: (text: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  skipCache?: boolean;
}

export interface ClassifyResult {
  classification: Classification | null;
  /** cache | llm | budget | invalid | unavailable (no key for the active provider) */
  reason: 'cache' | 'llm' | 'budget' | 'invalid' | 'unavailable';
  needsReview: boolean;
}

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!config.llm.apiKey) throw new Error('ANTHROPIC_API_KEY is missing from .env');
  client ??= new Anthropic({
    apiKey: config.llm.apiKey,
    // An empty baseUrl means a direct call. A set one is the AI Gateway.
    ...(config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : {}),
    /*
     * An authenticated Gateway rejects a request without this header with 401, and from
     * the outside it looks like the model silently refusing: the Anthropic key is right,
     * the limits are fine, and there is no answer. So the header is always set when a token exists.
     */
    ...(config.cloudflare.gatewayToken
      ? { defaultHeaders: { 'cf-aig-authorization': `Bearer ${config.cloudflare.gatewayToken}` } }
      : {}),
  });
  return client;
}

/**
 * Cached system prompt.
 *
 * Anthropic keeps the parsed start of a request for a few minutes and charges a tenth of
 * the price for it. It pays off where that start is long and repeats: the company verdict
 * carries every letter template in its system block, and when going through a dozen
 * studios in a row that block does not change.
 *
 * The minimum block length depends on the model: on Haiku 4.5 it is 4096 tokens, and a
 * shorter block is silently not cached at all. So the flag is a request, not a guarantee,
 * and the code does not rely on it.
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
 * The same prompt through Workers AI. The model is smaller than Haiku, so the JSON
 * requirement is repeated in the request itself through `response_format`: without it llama
 * regularly adds an explanation before the object, and each such answer would cost a retry.
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

/** Model call through the current provider. */
async function callModel(text: string) {
  return config.llm.provider === 'workers-ai' ? callWorkersAi(text) : callAnthropic(text);
}

export interface RawCall {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A call with an arbitrary system prompt. Letter personalisation needs it: a different
 * prompt and temperature 0.7, but the same provider, the same spend tracking and the same
 * daily cap, so a second client would make no sense.
 */
export async function callModelWith(
  system: string,
  user: string,
  temperature = 0,
  /** Model for this call. Empty means the one that classifies vacancies. */
  model?: string,
  /** Ask Anthropic to cache the system block. Workers AI has no cache, the flag does nothing there. */
  cacheSystem = false,
): Promise<RawCall> {
  return config.llm.provider === 'workers-ai'
    ? callWorkersAi(user, system, temperature)
    : callAnthropic(user, system, temperature, model, cacheSystem);
}

/** Spend tracking for calls outside classification. */
export async function noteLlmCall(input: number, output: number, failed = false): Promise<void> {
  await recordUsage(today(), input, output, failed);
}

export function today(now = new Date()): string {
  return localDay(now);
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

/** The model sometimes still wraps JSON in ```json, stripping it is cheaper than a retry. */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in the response');

  return JSON.parse(cleaned.slice(start, end + 1));
}

export function cacheKey(text: string): string {
  return hash(`${config.llm.activeModel}|${PROMPT_VERSION}|${text}`);
}

/** Whether the active provider has anything to call with. */
export function modelAvailable(): boolean {
  return config.llm.provider === 'workers-ai' ? aiAvailable() : Boolean(config.llm.apiKey);
}

let warnedUnavailable = false;

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

  /*
   * No key is a setting, not a failure. Calling anyway made two attempts per vacancy, each
   * counted against the daily budget: a fresh install spent the whole day's limit on errors
   * in one pass, and a key added in the afternoon found nothing left. The vacancy stays
   * unclassified, without the review flag, and `classify:pending` picks it up once a key
   * exists.
   */
  if (!options.caller && !modelAvailable()) {
    if (!warnedUnavailable) {
      log.warn({ provider: config.llm.provider }, 'no model credentials, classification is skipped');
      warnedUnavailable = true;
    }
    return { classification: null, reason: 'unavailable', needsReview: false };
  }

  const day = today();
  if ((await remainingBudget(day)) <= 0) {
    log.warn({ day, limit: config.llm.dailyCallLimit }, 'daily model call limit reached');
    return { classification: null, reason: 'budget', needsReview: true };
  }

  const caller = options.caller ?? callModel;
  let lastError = '';

  // One retry, as CLAUDE.md requires: invalid JSON is no reason to run the model in circles.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: Awaited<ReturnType<typeof callAnthropic>>;
    try {
      raw = await caller(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await recordUsage(day, 0, 0, true);
      log.warn({ attempt, err: lastError }, 'model call failed');
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
      log.warn({ attempt, err: lastError }, 'model response failed validation');
    }
  }

  log.warn({ err: lastError }, 'classification failed, the record goes to manual review');
  return { classification: null, reason: 'invalid', needsReview: true };
}
