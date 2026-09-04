import type { Company } from '../db/schema.js';

/**
 * Тип компанії. Визначається детерміновано з тегів, джерел і опису, без моделі.
 *
 * Навіщо: сценарії листів різні. Дизайн-студії пишеться "можу стати вашим
 * розробником і ви розширите послуги", стартапу "був у стартапі, можу закрити
 * фронт", аутстафу взагалі нічого. Без типу все це один список.
 */
export type CompanyKind = 'studio' | 'design' | 'startup' | 'product' | 'outstaff' | 'unknown';

export const COMPANY_KINDS: CompanyKind[] = [
  'studio',
  'design',
  'startup',
  'product',
  'outstaff',
  'unknown',
];

const DESIGN_TAGS = [
  'web design',
  'ui/ux design',
  'ux/ui design',
  'graphic design',
  'branding',
  'product design',
  'logo design',
];

const DEV_TAGS = [
  'web development',
  'custom software development',
  'mobile app development',
  'software development',
  'e-commerce development',
  'ai development',
];

const OUTSTAFF_TAGS = ['it staff augmentation', 'staff augmentation', 'outstaffing', 'outsourcing'];

/** Джерела, які за визначенням приносять стартапи. */
const STARTUP_SOURCES = ['getro', 'yc', 'wellfound', 'eu-startups', 'startups.gallery'];

/** Джерела, які за визначенням приносять агенції і студії. */
const AGENCY_SOURCES = ['clutch', 'goodfirms', 'designrush', 'sortlist', 'themanifest', 'upcity', 'techbehemoths'];

function has(haystack: string[], needles: string[]): number {
  return haystack.filter((item) => needles.some((needle) => item.includes(needle))).length;
}

/**
 * Порядок правил має значення і саме такий навмисно:
 * джерело сильніше за теги, бо каталог агенцій не показує стартапів і навпаки,
 * а вже всередині агенцій дизайн відділяється від розробки за перевагою тегів.
 */
export function detectKind(
  company: Pick<Company, 'tags' | 'sources' | 'description' | 'sizeHint'> & { careersKind?: string },
): CompanyKind {
  const sources = (company.sources ?? []).map((item) => item.toLowerCase());
  const tags = (company.tags ?? []).map((item) => item.toLowerCase());
  const text = `${company.description ?? ''}`.toLowerCase();

  if (sources.some((source) => STARTUP_SOURCES.some((known) => source.includes(known)))) return 'startup';

  const outstaff = has(tags, OUTSTAFF_TAGS);
  const design = has(tags, DESIGN_TAGS);
  const dev = has(tags, DEV_TAGS);

  // Аутстаф має бути помітною часткою профілю, а не одним тегом з двадцяти.
  if (outstaff > 0 && outstaff >= design && outstaff >= dev) return 'outstaff';
  if (design > 0 && design > dev) return 'design';
  if (dev > 0 || design > 0) return 'studio';

  if (sources.some((source) => AGENCY_SOURCES.some((known) => source.includes(known)))) return 'studio';

  /*
   * Продуктова компанія впізнається за власним ATS без тегів каталогу.
   * Саме `careersKind`, а не джерело: Vercel і Stripe потрапили в базу з CSV-сіда,
   * і за міткою джерела лишались би `unknown`, тобто показувались би в Студіях,
   * куди холодний лист "можу допомогти з проєктом" писати марно.
   */
  const ats = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio'];
  if (company.careersKind && ats.includes(company.careersKind)) return 'product';

  if (sources.some((source) => ['greenhouse', 'lever', 'ashby', 'rss'].some((known) => source.includes(known)))) {
    return 'product';
  }

  if (/\b(agency|studio|агенц|студі)\b/.test(text)) return 'studio';
  return 'unknown';
}

/**
 * Проставити тип усім компаніям, у яких він ще `unknown`. Потрібно один раз після
 * міграції, а далі тип виставляється сам при кожному `upsertCompany`.
 */
export async function backfillKinds(force = false): Promise<Record<CompanyKind, number>> {
  const { getDb } = await import('../db/client.js');
  const { companies } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  const rows = await db.select().from(companies);
  const counts: Record<CompanyKind, number> = {
    studio: 0,
    design: 0,
    startup: 0,
    product: 0,
    outstaff: 0,
    unknown: 0,
  };

  for (const row of rows) {
    const kind = detectKind(row);
    counts[kind] += 1;
    if (!force && row.kind === kind) continue;
    await db.update(companies).set({ kind }).where(eq(companies.id, row.id));
  }

  return counts;
}
