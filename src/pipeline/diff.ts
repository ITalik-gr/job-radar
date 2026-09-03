import type { PageBlock } from './normalize.js';

/**
 * Хеш усієї сторінки каже "щось змінилось", але не каже що. Тому порівнюємо множини
 * хешів блоків: нові хеші це нові вакансії, зниклі це закриті.
 */
export interface BlockDiff {
  added: PageBlock[];
  removed: string[];
  unchanged: number;
  changed: boolean;
}

export function diffBlocks(previousHashes: string[], next: PageBlock[]): BlockDiff {
  const before = new Set(previousHashes);
  const after = new Set(next.map((block) => block.hash));

  const added = next.filter((block) => !before.has(block.hash));
  const removed = previousHashes.filter((hash) => !after.has(hash));

  return {
    added,
    removed,
    unchanged: next.length - added.length,
    changed: added.length > 0 || removed.length > 0,
  };
}

export interface IdentifiedItem {
  externalId: string | null;
  url: string;
}

export interface IdDiff<T extends IdentifiedItem> {
  added: T[];
  removed: string[];
  unchanged: number;
  changed: boolean;
}

/**
 * ATS віддають стабільні id вакансій, тому там хешувати текст не треба:
 * поява і закриття видно порівнянням множин id. URL це запасний ключ,
 * якщо джерело id не дало.
 */
export function keyOf(item: IdentifiedItem): string {
  return item.externalId ?? item.url;
}

export function diffByExternalId<T extends IdentifiedItem>(
  previousKeys: string[],
  next: T[],
): IdDiff<T> {
  const before = new Set(previousKeys);
  const seen = new Set<string>();
  const added: T[] = [];

  for (const item of next) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!before.has(key)) added.push(item);
  }

  const removed = previousKeys.filter((key) => !seen.has(key));

  return {
    added,
    removed,
    unchanged: seen.size - added.length,
    changed: added.length > 0 || removed.length > 0,
  };
}
