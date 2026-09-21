import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { outreach, templates, type Template } from '../db/schema.js';
import { log } from '../lib/log.js';

/**
 * Letter and resume templates. The tool only stores them, records them in the contact history
 * and lets them be edited. Generating text is forbidden by section 11 of CLAUDE.md, so there is
 * no model call here and there never will be.
 *
 * The template list used to be an array of strings in the front end code, and only a label went
 * into the database. Changing a template meant editing code, and the text itself lived in someone's head.
 */

export type TemplateKind = 'vacancy' | 'studio' | 'resume';

export const TEMPLATE_KINDS: TemplateKind[] = ['vacancy', 'studio', 'resume'];

export interface TemplateInput {
  slug?: string;
  name: string;
  kind?: string;
  forKind?: string | null;
  subject?: string | null;
  body?: string;
  note?: string | null;
  archived?: boolean;
  /** uk | en. The text language, used to match the template to the company country. Defaults to en. */
  language?: string;
  /**
   * Sending role: vacancy | studio_named | studio_generic | followup.
   * Empty means the template takes no part in sending and is kept for copying.
   */
  targetType?: string | null;
  /** Static first paragraph. Inserted into the body through {{intro}}. */
  intro?: string | null;
}

/** The slug lands in outreach.template_used, so it must be stable and without spaces. Cyrillic names are kept as is. */
export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base || `template_${Date.now()}`;
}

/**
 * The starter set. These are the same labels that used to be hardcoded in the front end, so the
 * contact history keeps its link to the template. The texts are empty: the owner writes them.
 */
const SEED: { slug: string; name: string; kind: TemplateKind }[] = [
  { slug: 'fullstack_ai', name: 'Fullstack and AI', kind: 'vacancy' },
  { slug: 'frontend_react', name: 'Frontend React', kind: 'vacancy' },
  { slug: 'referral', name: 'Referral', kind: 'vacancy' },
  { slug: 'studio_pitch', name: 'Studio pitch', kind: 'studio' },
  { slug: 'agency_cold', name: 'Cold letter to an agency', kind: 'studio' },
  { slug: 'project_offer', name: 'Project offer', kind: 'studio' },
];

/**
 * A template together with how many letters were written with it. Without that number deletion
 * is blind: there is no telling whether this is a draft nobody used or a key present in fifty
 * history records.
 */
export interface TemplateWithUsage extends Template {
  usageCount: number;
}

export async function listTemplates(kind?: string): Promise<TemplateWithUsage[]> {
  const db = getDb();
  const rows = await db
    .select({
      template: templates,
      usageCount: sql<number>`(
        select count(*) from ${outreach} where ${outreach.templateUsed} = ${templates.slug}
      )`,
    })
    .from(templates)
    .orderBy(asc(templates.kind), asc(templates.name));

  return rows
    .filter((row) => !kind || row.template.kind === kind)
    .map((row) => ({ ...row.template, usageCount: row.usageCount }));
}

/**
 * A free slug based on the desired one. A duplicate gets a suffix, not an error: the person named
 * the template the way they like, and demanding another name because of a technical key would
 * shift onto them work the code does by itself.
 */
export async function uniqueSlug(desired: string, exceptId?: number): Promise<string> {
  const db = getDb();
  const base = slugify(desired);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`;
    const [taken] = await db
      .select({ id: templates.id })
      .from(templates)
      .where(
        exceptId === undefined
          ? eq(templates.slug, candidate)
          : and(eq(templates.slug, candidate), ne(templates.id, exceptId)),
      );
    if (!taken) return candidate;
  }

  return `${base}_${Date.now()}`;
}

export async function createTemplate(input: TemplateInput): Promise<Template> {
  const db = getDb();
  const [row] = await db
    .insert(templates)
    .values({
      slug: await uniqueSlug(input.slug?.trim() || input.name),
      name: input.name.trim(),
      kind: input.kind ?? 'vacancy',
      forKind: input.forKind ?? null,
      subject: input.subject ?? null,
      intro: input.intro ?? null,
      body: input.body ?? '',
      note: input.note ?? null,
      language: input.language ?? 'en',
      targetType: input.targetType || null,
    })
    .returning();
  return row!;
}

export async function updateTemplate(id: number, input: Partial<TemplateInput>): Promise<Template> {
  const db = getDb();
  const [existing] = await db.select().from(templates).where(eq(templates.id, id));
  if (!existing) throw new Error(`no template ${id}`);

  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  /*
   * The slug can be renamed, but it does not change by itself along with the name.
   *
   * Both rules have one reason: this key already sits in `outreach.template_used`. A silent rename
   * on every name edit would break the history, while an explicit rename rewrites the history too,
   * in one move. Without that a record "written with template studio_pitch" would point nowhere.
   */
  if (input.slug !== undefined) {
    const slug = await uniqueSlug(input.slug || existing.name, id);
    if (slug !== existing.slug) {
      patch.slug = slug;
      const moved = await db
        .update(outreach)
        .set({ templateUsed: slug })
        .where(eq(outreach.templateUsed, existing.slug))
        .returning({ id: outreach.id });
      if (moved.length > 0) {
        log.info({ from: existing.slug, to: slug, moved: moved.length }, 'template key renamed');
      }
    }
  }

  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.forKind !== undefined) patch.forKind = input.forKind || null;
  if (input.subject !== undefined) patch.subject = input.subject;
  if (input.body !== undefined) patch.body = input.body;
  if (input.note !== undefined) patch.note = input.note;
  if (input.intro !== undefined) patch.intro = input.intro;
  if (input.language !== undefined) patch.language = input.language;
  if (input.targetType !== undefined) patch.targetType = input.targetType || null;
  if (input.archived !== undefined) patch.archived = input.archived;

  const [row] = await db.update(templates).set(patch).where(eq(templates.id, id)).returning();
  return row!;
}

/**
 * Archiving means "out of sight": the template leaves the selection lists but stays and can be
 * restored. For drafts, and for text that may be needed some day.
 */
export async function archiveTemplate(id: number): Promise<Template> {
  return updateTemplate(id, { archived: true });
}

export async function restoreTemplate(id: number): Promise<Template> {
  return updateTemplate(id, { archived: false });
}

export interface DeleteResult {
  deleted: true;
  slug: string;
  /** How many history records mention this key. They stay, they are a snapshot. */
  keptInHistory: number;
}

/**
 * Deletion erases the template for good.
 *
 * The correspondence history does not suffer: `outreach.template_used` is a snapshot of the key
 * at send time, not a link to the table. So a record "written with template studio_pitch" stays
 * readable a year after the template itself was deleted. The number of such records is returned
 * separately, so the interface can warn before deletion rather than after.
 */
export async function deleteTemplate(id: number): Promise<DeleteResult> {
  const db = getDb();
  const [existing] = await db.select().from(templates).where(eq(templates.id, id));
  if (!existing) throw new Error(`no template ${id}`);

  const used = await db
    .select({ id: outreach.id })
    .from(outreach)
    .where(eq(outreach.templateUsed, existing.slug));

  await db.delete(templates).where(eq(templates.id, id));
  log.info({ slug: existing.slug, keptInHistory: used.length }, 'template deleted');

  return { deleted: true, slug: existing.slug, keptInHistory: used.length };
}

/** A copy of a template with its own key. The fastest way to make a variant of the text. */
export async function duplicateTemplate(id: number): Promise<Template> {
  const db = getDb();
  const [existing] = await db.select().from(templates).where(eq(templates.id, id));
  if (!existing) throw new Error(`no template ${id}`);

  return createTemplate({
    slug: `${existing.slug}_copy`,
    name: `${existing.name} (copy)`,
    kind: existing.kind,
    forKind: existing.forKind,
    subject: existing.subject,
    intro: existing.intro,
    body: existing.body,
    note: existing.note,
    language: existing.language,
    /*
     * The copy does not inherit the sending role: two active templates for the same case and
     * language pair would make the choice arbitrary. A copy is made to try another text, and a
     * person assigns it a role deliberately.
     */
    targetType: null,
  });
}

/**
 * Seeds the starter set exactly once, when the table is empty.
 *
 * Empty, not "whichever are missing". All missing ones from the list used to be added here, and a
 * deleted template came back by itself the next time the page opened.
 */
export async function seedTemplates(): Promise<number> {
  const db = getDb();
  const [existing] = await db.select({ id: templates.id }).from(templates).limit(1);
  if (existing) return 0;

  const missing = SEED;
  await db.insert(templates).values(missing);
  log.info({ added: missing.length }, 'starter templates added');
  return missing.length;
}
