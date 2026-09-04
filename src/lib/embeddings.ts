import { config } from '../config.js';
import { log } from './log.js';

/**
 * Вектори тексту через Workers AI.
 *
 * Модель `@cf/baai/bge-m3` обрана саме через багатомовність: у базі поруч лежать
 * англійські описи студій і українські вакансії з DOU, і одномовна модель звела б
 * їх у різні кутки простору.
 *
 * Два шляхи виклику навмисно. На Workers є біндінг `AI`, там ні токена, ні мережі
 * назовні не потрібно. Локально біндінга немає, тому REST і токен з `.env`.
 * Без жодного з них функція чесно кидає помилку, а не повертає порожні вектори:
 * мовчазний нуль тут гірший за падіння, бо схожість порахувалась би як однакова.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** Біндінг Workers AI. Ставиться в `worker.ts`, локально лишається порожнім. */
let binding: { run: (model: string, input: unknown) => Promise<unknown> } | null = null;

export function setAiBinding(value: typeof binding): void {
  binding = value;
}

function parseVectors(payload: unknown): number[][] {
  const data = (payload as { data?: number[][] })?.data;
  if (!Array.isArray(data)) throw new Error('Workers AI повернув відповідь без поля data');
  return data;
}

/**
 * Вектори для набору текстів. Порядок відповіді збігається з порядком запиту.
 * Довгі тексти обрізаються: модель однаково має власну стелю, а перші пара тисяч
 * символів опису студії несуть майже всю інформацію про неї.
 */
export async function embedTexts(texts: string[], maxChars = 2000): Promise<number[][]> {
  if (texts.length === 0) return [];
  const input = { text: texts.map((text) => text.slice(0, maxChars)) };

  if (binding) return parseVectors(await binding.run(EMBEDDING_MODEL, input));

  const { accountId, apiToken } = config.cloudflare;
  if (!accountId || !apiToken) {
    throw new Error(
      'немає CLOUDFLARE_ACCOUNT_ID або CLOUDFLARE_API_TOKEN у .env, а біндінга AI поза Workers не буває',
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    throw new Error(`Workers AI: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { result?: unknown; success?: boolean; errors?: unknown[] };
  if (!body.success) throw new Error(`Workers AI: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return parseVectors(body.result);
}

/**
 * Косинусна близькість. Вектори bge вже нормалізовані, але ділення на норми
 * лишається: воно коштує нічого, а захищає від моделі, яка нормалізації не робить.
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
 * Стиснення для зберігання. 1024 числа з повною точністю це близько 20 КБ на компанію,
 * чотирьох знаків після коми досить: різниця в косинусі менша за тисячну.
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
    log.warn('вектор у базі пошкоджений, ігнорую');
    return null;
  }
}
