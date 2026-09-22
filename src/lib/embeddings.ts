import { runWorkersAi, setAiBinding } from './workers-ai.js';
import { log } from './log.js';

/**
 * Text vectors through Workers AI.
 *
 * The `@cf/baai/bge-m3` model was chosen specifically for its multilingual support:
 * the database holds English studio descriptions right next to Ukrainian vacancies
 * from DOU, and a single-language model would push them into different corners of
 * the space.
 *
 * The call itself lives in `lib/workers-ai.ts`, shared with classification.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

// Re-exported for compatibility: the worker has set the binding from here since day one.
export { setAiBinding };

function parseVectors(payload: unknown): number[][] {
  const data = (payload as { data?: number[][] })?.data;
  if (!Array.isArray(data)) throw new Error('Workers AI returned a response with no data field');
  return data;
}

/**
 * Vectors for a set of texts. The response order matches the request order. Long
 * texts get truncated: the model has its own ceiling anyway, and the first couple
 * thousand characters of a studio's description carry almost all the information
 * about it.
 */
export async function embedTexts(texts: string[], maxChars = 2000): Promise<number[][]> {
  if (texts.length === 0) return [];
  const input = { text: texts.map((text) => text.slice(0, maxChars)) };

  return parseVectors(await runWorkersAi(EMBEDDING_MODEL, input));
}

/**
 * Cosine similarity. bge vectors are already normalized, but dividing by the norms
 * stays in: it costs nothing, and it guards against a model that does not normalize.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compression for storage. 1024 numbers at full precision is about 20 KB per
 * company, four decimal places are enough: the difference in cosine similarity is
 * less than a thousandth.
 */
export function packVector(vector: number[]): string {
  return JSON.stringify(vector.map((value) => Math.round(value * 10_000) / 10_000));
}

export function unpackVector(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    log.warn('vector in the database is corrupted, ignoring');
    return null;
  }
}
