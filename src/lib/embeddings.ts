import { runWorkersAi, setAiBinding } from './workers-ai.js';
import { log } from './log.js';

/**
 * Вектори тексту через Workers AI.
 *
 * Модель `@cf/baai/bge-m3` обрана саме через багатомовність: у базі поруч лежать
 * англійські описи студій і українські вакансії з DOU, і одномовна модель звела б
 * їх у різні кутки простору.
 *
 * Сам виклик живе в `lib/workers-ai.ts`, спільний з класифікацією.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

// Реекспорт заради сумісності: воркер ставить біндінг звідси з першого дня.
export { setAiBinding };

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

  return parseVectors(await runWorkersAi(EMBEDDING_MODEL, input));
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
