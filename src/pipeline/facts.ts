import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { facts, type Fact } from '../db/schema.js';

/**
 * A whitelist of facts about the owner, for personalization.
 *
 * The model has no right to mention anything that isn't on this list, and the
 * paragraph validator checks the result separately. The list lives in the database, not
 * in the prompt, so a fact can be turned off with a checkbox, without touching code.
 */

export interface FactInput {
  key: string;
  textUk: string;
  textEn: string;
  isActive?: boolean;
}

export async function listFacts(): Promise<Fact[]> {
  return getDb().select().from(facts).orderBy(asc(facts.key));
}

export async function createFact(input: FactInput): Promise<Fact> {
  const [row] = await getDb()
    .insert(facts)
    .values({
      key: input.key.trim(),
      textUk: input.textUk.trim(),
      textEn: input.textEn.trim(),
      isActive: input.isActive ?? true,
    })
    .returning();
  return row!;
}

export async function updateFact(id: number, patch: Partial<FactInput>): Promise<Fact> {
  const db = getDb();
  const next: Record<string, unknown> = {};
  if (patch.key !== undefined) next.key = patch.key.trim();
  if (patch.textUk !== undefined) next.textUk = patch.textUk.trim();
  if (patch.textEn !== undefined) next.textEn = patch.textEn.trim();
  if (patch.isActive !== undefined) next.isActive = patch.isActive;

  const [row] = await db.update(facts).set(next).where(eq(facts.id, id)).returning();
  if (!row) throw new Error(`fact ${id} does not exist`);
  return row;
}

export async function deleteFact(id: number): Promise<{ deleted: boolean }> {
  await getDb().delete(facts).where(eq(facts.id, id));
  return { deleted: true };
}
