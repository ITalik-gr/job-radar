import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { outreach, templates, type Template } from '../db/schema.js';
import { log } from '../lib/log.js';

/**
 * Шаблони листів і резюме. Інструмент їх лише зберігає, підставляє в історію
 * контактів і дає редагувати. Генерація текстів заборонена розділом 11 CLAUDE.md,
 * тому тут немає жодного звернення до моделі і не буде.
 *
 * Раніше список шаблонів був масивом рядків у коді фронта, і в базу писалась лише
 * мітка. Тобто змінити шаблон означало правити код, а сам текст жив у голові.
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
  /** uk | en. Мова тексту, за нею шаблон підбирається під країну компанії. Типове en. */
  language?: string;
  /**
   * Роль у розсилці: vacancy | studio_named | studio_generic | followup.
   * Порожнє означає, що шаблон у розсилці не бере участі і лежить для копіювання.
   */
  targetType?: string | null;
  /** Статичний перший абзац. Підставляється в тіло через {{intro}}. */
  intro?: string | null;
}

/** Slug лягає в outreach.template_used, тому мусить бути стабільним і без пробілів. */
export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base || `template_${Date.now()}`;
}

/**
 * Стартовий набір. Це ті самі мітки, що були зашиті у фронті, тому історія контактів
 * не втрачає зв'язок зі шаблоном. Тексти порожні: їх пише власник.
 */
const SEED: { slug: string; name: string; kind: TemplateKind }[] = [
  { slug: 'fullstack_ai', name: 'Fullstack і AI', kind: 'vacancy' },
  { slug: 'frontend_react', name: 'Frontend React', kind: 'vacancy' },
  { slug: 'referral', name: 'Через знайомого', kind: 'vacancy' },
  { slug: 'studio_pitch', name: 'Пітч студії', kind: 'studio' },
  { slug: 'agency_cold', name: 'Холодний лист агенції', kind: 'studio' },
  { slug: 'project_offer', name: 'Пропозиція проєкту', kind: 'studio' },
];

/**
 * Шаблон разом з тим, скільки листів ним написано. Без цього числа видалення сліпе:
 * незрозуміло, чи це чернетка, яку ніхто не використовував, чи ключ, що стоїть
 * у півсотні записів історії.
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
 * Вільний slug на основі бажаного. Дублікат отримує суфікс, а не помилку: людина
 * назвала шаблон так, як їй зручно, і вимагати іншу назву через технічний ключ
 * означає перекласти на неї роботу, яку код робить сам.
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
  if (!existing) throw new Error(`шаблону ${id} немає`);

  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  /*
   * Slug можна перейменувати, але сам собою він не міняється разом з назвою.
   *
   * Причина обох правил одна: цей ключ уже стоїть у `outreach.template_used`.
   * Тому мовчазне перейменування при кожній правці назви розірвало б історію,
   * а явне перейменування переписує і історію теж, одним рухом. Без цього
   * запис "писали шаблоном studio_pitch" вказував би в нікуди.
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
        log.info({ from: existing.slug, to: slug, moved: moved.length }, 'ключ шаблона перейменовано');
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
 * Архів це "прибрати з очей": шаблон зникає зі списків вибору, але лишається
 * і його можна повернути. Для чернетки і для тексту, який колись знадобиться.
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
  /** Скільки записів історії згадують цей ключ. Вони лишаються, це знімок. */
  keptInHistory: number;
}

/**
 * Видалення стирає шаблон назовсім.
 *
 * Історія листування при цьому не страждає: `outreach.template_used` це знімок
 * ключа на момент листа, а не звʼязок із таблицею. Тобто запис "писали шаблоном
 * studio_pitch" лишається читабельним і через рік після того, як сам шаблон
 * видалили. Скільки таких записів, повертається окремим числом, щоб інтерфейс
 * міг попередити перед видаленням, а не після.
 */
export async function deleteTemplate(id: number): Promise<DeleteResult> {
  const db = getDb();
  const [existing] = await db.select().from(templates).where(eq(templates.id, id));
  if (!existing) throw new Error(`шаблону ${id} немає`);

  const used = await db
    .select({ id: outreach.id })
    .from(outreach)
    .where(eq(outreach.templateUsed, existing.slug));

  await db.delete(templates).where(eq(templates.id, id));
  log.info({ slug: existing.slug, keptInHistory: used.length }, 'шаблон видалено');

  return { deleted: true, slug: existing.slug, keptInHistory: used.length };
}

/** Копія шаблона з власним ключем. Найшвидший спосіб зробити варіант тексту. */
export async function duplicateTemplate(id: number): Promise<Template> {
  const db = getDb();
  const [existing] = await db.select().from(templates).where(eq(templates.id, id));
  if (!existing) throw new Error(`шаблону ${id} немає`);

  return createTemplate({
    slug: `${existing.slug}_copy`,
    name: `${existing.name} (копія)`,
    kind: existing.kind,
    forKind: existing.forKind,
    subject: existing.subject,
    intro: existing.intro,
    body: existing.body,
    note: existing.note,
    language: existing.language,
    /*
     * Роль у розсилці копії не дістається: два активні шаблони на ту саму пару
     * випадок-мова означали б, що вибір стає випадковим. Копія робиться, щоб
     * спробувати інший текст, і роль їй призначає людина свідомо.
     */
    targetType: null,
  });
}

/**
 * Заливає стартовий набір рівно один раз, коли таблиця порожня.
 *
 * Саме порожня, а не "яких немає". Раніше сюди доливались усі відсутні зі списку,
 * і видалений шаблон повертався сам собою на наступному ж відкритті сторінки.
 */
export async function seedTemplates(): Promise<number> {
  const db = getDb();
  const [existing] = await db.select({ id: templates.id }).from(templates).limit(1);
  if (existing) return 0;

  const missing = SEED;
  await db.insert(templates).values(missing);
  log.info({ added: missing.length }, 'стартові шаблони додано');
  return missing.length;
}
