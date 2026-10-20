/**
 * Model access for the whole radar: one client per provider, a daily call cap, spend tracking.
 *
 * The model classifies and extracts, it never writes letter text (CLAUDE.md rule 10 and
 * section 7). Callers own their prompts and Zod schemas; this file only moves text in and out.
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { llmUsage } from '../db/schema.js';
import { createHash } from 'node:crypto';
import { localDay } from './time.js';
import { aiAvailable, runWorkersAi, textFromAi } from './workers-ai.js';

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
  system: string,
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
 * The same call through Workers AI. The model is smaller than Haiku, so the JSON
 * requirement is repeated in the request itself through `response_format`: without it llama
 * regularly adds an explanation before the object, and each such answer would cost a retry.
 */
async function callWorkersAi(text: string, system: string, temperature = 0) {
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

export interface RawCall {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One model call with a system prompt. Every model use in the radar goes through here: the
 * same provider switch, the same spend tracking and the same daily cap.
 */
export async function callModelWith(
  system: string,
  user: string,
  temperature = 0,
  /** Model for this call. Empty means the configured default. */
  model?: string,
  /** Ask Anthropic to cache the system block. Workers AI has no cache, the flag does nothing there. */
  cacheSystem = false,
): Promise<RawCall> {
  return config.llm.provider === 'workers-ai'
    ? callWorkersAi(user, system, temperature)
    : callAnthropic(user, system, temperature, model, cacheSystem);
}

/** Spend tracking: every call counts against the daily cap. */
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

/** Short stable hash for cache keys. */
export function hash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
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

/** Whether the active provider has anything to call with. */
export function modelAvailable(): boolean {
  return config.llm.provider === 'workers-ai' ? aiAvailable() : Boolean(config.llm.apiKey);
}
