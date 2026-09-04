import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { templates, type Template } from '../db/schema.js';
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
  subject?: string | null;
  body?: string;
  note?: string | null;
  archived?: boolean;
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

export async function listTemplates(kind?: string): Promise<Template[]> {
  const db = getDb();
  const rows = await db.select().from(templates).orderBy(asc(templates.kind), asc(templates.name));
  return kind ? rows.filter((row) => row.kind === kind) : rows;
}

export async function createTemplate(input: TemplateInput): Promise<Template> {
  const db = getDb();
  const [row] = await db
    .insert(templates)
    .values({
      slug: input.slug?.trim() || slugify(input.name),
      name: input.name.trim(),
      kind: input.kind ?? 'vacancy',
      subject: input.subject ?? null,
      body: input.body ?? '',
      note: input.note ?? null,
    })
    .returning();
  return row!;
}

export async function updateTemplate(id: number, input: Partial<TemplateInput>): Promise<Template> {
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  // Slug навмисно не міняється разом з назвою: він уже стоїть у записах листування,
  // і перейменування розірвало б звʼязок з історією.
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.subject !== undefined) patch.subject = input.subject;
  if (input.body !== undefined) patch.body = input.body;
  if (input.note !== undefined) patch.note = input.note;
  if (input.archived !== undefined) patch.archived = input.archived;

  const [row] = await db.update(templates).set(patch).where(eq(templates.id, id)).returning();
  if (!row) throw new Error(`шаблону ${id} немає`);
  return row;
}

/**
 * Видалення архівує, а не стирає. Мітка шаблону лишається в `outreach.template_used`,
 * і без запису неможливо буде зрозуміти, чим саме писали пів року тому.
 */
export async function archiveTemplate(id: number): Promise<Template> {
  return updateTemplate(id, { archived: true });
}

/** Дозаливає стартовий набір, якщо таблиця порожня. Ідемпотентно. */
export async function seedTemplates(): Promise<number> {
  const db = getDb();
  const existing = await db.select({ slug: templates.slug }).from(templates);
  const known = new Set(existing.map((row) => row.slug));
  const missing = SEED.filter((item) => !known.has(item.slug));
  if (missing.length === 0) return 0;

  await db.insert(templates).values(missing);
  log.info({ added: missing.length }, 'стартові шаблони додано');
  return missing.length;
}
