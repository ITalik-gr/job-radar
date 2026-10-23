import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { llmCache } from '../db/schema.js';
import { chunk } from './chunk.js';
import { callModelWith, extractJson, hash, noteLlmCall, remainingBudget } from './llm.js';
import { log } from './log.js';
import { aiAvailable, runWorkersAi } from './workers-ai.js';

/**
 * Decisions over given options: the only kind of model call classification needs.
 *
 * Clef (Cloudflare decision models on Workers AI) answers typed questions over a state with
 * calibrated probabilities instead of text: `choice` picks one of the options we list, `noul` is
 * a yes probability, `score` a weighted level on our rubric. It cannot name or write anything,
 * which is exactly the guarantee rule 6 asks for.
 *
 * Without Workers AI (a fork with only an Anthropic key) Haiku answers the same questions in the
 * same shape. Its confidence is self-reported, not calibrated, so thresholds tuned on Clef are
 * looser there. The cache key holds the model id, so the two never serve each other's answers.
 */

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

const probabilities = z.record(z.string(), z.number()).default({});

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: z.number().min(0).max(1) }),
  z.object({ type: z.literal('score'), score: z.number(), probabilities, confidence: z.number().min(0).max(1) }),
]);

export type Answer = z.infer<typeof answerSchema>;

const decisionSchema = z.object({ answers: z.record(z.string(), answerSchema) });

export interface Decision {
  model: string;
  answers: Record<string, Answer>;
  source: 'model' | 'cache';
}

export class BudgetExhaustedError extends Error {}

/** Bumped when the request shape changes, so old cached answers are not reused. */
const PROMPT_VERSION = 'decide-1';

export function activeDecisionModel(): string {
  return aiAvailable() ? config.llm.clefModel : config.llm.model;
}

/** Whether there is anything to decide with: Workers AI, or an Anthropic key as the fallback. */
export function decisionsAvailable(): boolean {
  return aiAvailable() || Boolean(config.llm.apiKey);
}

export function decisionKey(model: string, state: unknown, questions: Record<string, Question>): string {
  return `decide:${model}:${hash(JSON.stringify({ state, questions }))}`;
}

async function askClef(state: unknown, questions: Record<string, Question>) {
  const model = config.llm.clefModel;
  // The body names the model again, by its short name: `clef-flash` for `@cf/cloudflare/clef-flash`.
  const payload = (await runWorkersAi(model, { model: model.split('/').pop(), state, questions })) as {
    answers?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    parsed: decisionSchema.parse(payload),
    inputTokens: payload.usage?.input_tokens ?? 0,
    outputTokens: payload.usage?.output_tokens ?? 0,
  };
}

const FALLBACK_SYSTEM = `You classify a record by answering typed questions. Use only the record, never outside knowledge.
Answer with one JSON object {"answers": {...}} holding one entry per question id:
- noul: {"type":"noul","noul":<probability of yes, 0..1>}
- choice: {"type":"choice","choice":"<one of the criteria keys>","confidence":<0..1>}
- score: {"type":"score","score":<level index, 0 is the first level>,"confidence":<0..1>}
No text outside the JSON.`;

async function askHaiku(state: unknown, questions: Record<string, Question>) {
  const raw = await callModelWith(FALLBACK_SYSTEM, JSON.stringify({ record: state, questions }));
  return { parsed: decisionSchema.parse(extractJson(raw.text)), inputTokens: raw.inputTokens, outputTokens: raw.outputTokens };
}

/**
 * One decision call, cached by model and input. A cache hit costs nothing and does not count
 * against the daily cap; a miss with the cap reached throws `BudgetExhaustedError`.
 */
export async function decide(state: unknown, questions: Record<string, Question>): Promise<Decision> {
  if (!decisionsAvailable()) {
    throw new Error('no model to classify with: set CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN, or ANTHROPIC_API_KEY');
  }
  const model = activeDecisionModel();
  const key = decisionKey(model, state, questions);
  const db = getDb();

  const [cached] = await db.select().from(llmCache).where(eq(llmCache.key, key));
  if (cached) {
    const parsed = decisionSchema.safeParse(cached.response);
    if (parsed.success) return { model, answers: parsed.data.answers, source: 'cache' };
    await db.delete(llmCache).where(eq(llmCache.key, key));
  }

  if ((await remainingBudget()) <= 0) {
    throw new BudgetExhaustedError(`daily model call limit reached (${config.llm.dailyCallLimit})`);
  }

  try {
    const { parsed, inputTokens, outputTokens } = aiAvailable() ? await askClef(state, questions) : await askHaiku(state, questions);
    await noteLlmCall(inputTokens, outputTokens);

    // A question the model skipped is an error, not a silent "no answer": the caller would treat it as low confidence.
    const missing = Object.keys(questions).filter((id) => !parsed.answers[id]);
    if (missing.length > 0) throw new Error(`model skipped questions: ${missing.join(', ')}`);

    await db
      .insert(llmCache)
      .values({ key, model, promptVersion: PROMPT_VERSION, response: parsed })
      .onConflictDoNothing();
    return { model, answers: parsed.answers, source: 'model' };
  } catch (error) {
    await noteLlmCall(0, 0, true);
    log.warn({ model, err: String(error).slice(0, 300) }, 'decision call failed');
    throw error;
  }
}

/**
 * Cached answers for these keys, one query per ninety. A batch skips what was asked before and
 * re-applies those answers for free, so a changed threshold reaches old answers too.
 */
export async function cachedAnswers(keys: string[]): Promise<Map<string, Record<string, Answer>>> {
  const found = new Map<string, Record<string, Answer>>();
  for (const slice of chunk(keys, 90)) {
    const rows = await getDb().select().from(llmCache).where(inArray(llmCache.key, slice));
    for (const row of rows) {
      const parsed = decisionSchema.safeParse(row.response);
      if (parsed.success) found.set(row.key, parsed.data.answers);
    }
  }
  return found;
}
