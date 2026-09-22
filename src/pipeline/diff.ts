import type { PageBlock } from './normalize.js';

/**
 * A hash of the whole page says "something changed" but not what. So the sets of block
 * hashes are compared instead: new hashes are new vacancies, missing ones are closed ones.
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
 * ATS boards hand back stable vacancy ids, so there's no need to hash text there:
 * appearance and closure show up just by comparing the sets of ids. The URL is a
 * fallback key when the source didn't provide an id.
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
