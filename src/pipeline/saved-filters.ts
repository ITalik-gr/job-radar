import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { savedFilters, type SavedFilter } from '../db/schema.js';
import { parseFilter, type CompanyFilter } from './filters.js';

/**
 * Named filters: "UA, clinics, slow site, has email". The query is stored in the same shape
 * `search_companies` takes, validated on the way in, so a saved filter can never hold a field the
 * list would silently ignore.
 */

export interface SavedFilterView {
  id: number;
  name: string;
  query: CompanyFilter;
  updatedAt: number;
}

function view(row: SavedFilter): SavedFilterView {
  // A filter saved by an older version may no longer parse; it shows up empty instead of breaking the list.
  let query: CompanyFilter = {};
  try {
    query = parseFilter(row.query);
  } catch {
    query = {};
  }
  return { id: row.id, name: row.name, query, updatedAt: row.updatedAt };
}

export async function listSavedFilters(): Promise<SavedFilterView[]> {
  const rows = await getDb().select().from(savedFilters).orderBy(asc(savedFilters.name));
  return rows.map(view);
}

export async function findSavedFilter(nameOrId: string | number): Promise<SavedFilterView | null> {
  const list = await listSavedFilters();
  return (
    list.find((row) => (typeof nameOrId === 'number' ? row.id === nameOrId : row.name.toLowerCase() === nameOrId.trim().toLowerCase())) ??
    null
  );
}

/** Saves under a name; the same name replaces the query. Returns what was there before. */
export async function saveFilter(
  name: string,
  query: unknown,
): Promise<{ before: SavedFilterView | null; after: SavedFilterView }> {
  const title = name.trim();
  if (!title) throw new Error('a saved filter needs a name');
  const parsed = parseFilter(query);

  const before = await findSavedFilter(title);
  const db = getDb();
  const [row] = before
    ? await db
        .update(savedFilters)
        .set({ name: title, query: parsed, updatedAt: Date.now() })
        .where(eq(savedFilters.id, before.id))
        .returning()
    : await db.insert(savedFilters).values({ name: title, query: parsed }).returning();

  return { before, after: view(row!) };
}

export async function deleteSavedFilter(id: number): Promise<{ deleted: SavedFilterView | null }> {
  const before = await findSavedFilter(id);
  if (before) await getDb().delete(savedFilters).where(eq(savedFilters.id, id));
  return { deleted: before };
}
