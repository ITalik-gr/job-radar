import { and, desc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { companies, companyState, contacts, outreach, vacancies, type Company } from '../db/schema.js';
import { scoreCompany, type CompanyBreakdown } from './company-score.js';
import { rules } from './rules.js';
import { HIDDEN_STATUSES } from './queue.js';

/**
 * Черга студій: кому писати з пропозицією послуг. Вакансія тут не потрібна,
 * тому це окремий список від черги вакансій, з тими самими діями над станом компанії.
 */

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  kind: string;
  /** Ознаки живості сайту. null означає, що enrichment ще не ходив. */
  copyrightYear: number | null;
  lastPostAt: number | null;
  tags: string[];
  techHints: string[];
  /** Репутація в каталозі. null означає, що каталог її не показував. */
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  /** Блок "Інше": усе, що каталог показав понад перелічені поля. */
  extra: Record<string, string>;
  description: string | null;
  careersUrl: string | null;
  /** Сторінка компанії в каталозі, звідки вона прийшла. */
  sourceUrl: string | null;
  sources: string[];
  status: string;
  openVacancies: number;
  score: number;
  why: { reason: string; weight: number }[];
  /** `id` потрібен, щоб контакт можна було правити прямо з картки. */
  contacts: {
    id: number;
    name: string | null;
    role: string | null;
    email: string | null;
    /** false означає hard bounce: адреса лишається, але писати на неї не можна. */
    emailValid: boolean;
  }[];
  lastContactedAt: number | null;
}

export interface StudioFilters {
  limit?: number;
  minScore?: number;
  /** Показати всіх, включно з тими, кому вже писали. */
  includeContacted?: boolean;
  country?: string;
  search?: string;
  /** studio | design | startup | product | outstaff. Порожнє означає всі, крім продуктових. */
  kind?: string;
  /** Тільки ті, де є контакт з іменем. Лист на hello@ читає менеджер, не техлід. */
  withNamedContact?: boolean;
  /** Мінімальна оцінка в каталозі. Компанії без оцінки вважаються такими, що не проходять. */
  minRating?: number;
}

export interface StudioPage {
  cards: StudioCard[];
  /** Скільком компаніям порахували рахунок після фільтрів пошуку і країни. */
  total: number;
  /** Скільки з них пройшли поріг. Різниця з total це те, що приховав поріг. */
  aboveThreshold: number;
  threshold: number;
}

/**
 * Порахувати рахунок усім компаніям, які проходять фільтри, без порога і без ліміту.
 * Поділ на цю функцію і `studioPage` потрібен, щоб інтерфейс міг сказати не лише
 * скільки студій показано, а й скільки приховав поріг: без цього порожній список
 * виглядає як зламаний збір, хоча компанії в базі є.
 */
async function scoreAll(filters: StudioFilters): Promise<StudioCard[]> {
  const db = getDb();
  const now = Date.now();

  /*
   * Відбір робить SQL, а не JavaScript.
   *
   * Раніше сюди зачитувалась уся таблиця компаній і вся таблиця контактів, а
   * фільтри застосовувались уже в памʼяті. На двох тисячах компаній це ще
   * працювало, але ціна не залежала від запиту: пошук по слову "design", який
   * лишає пʼятдесят рядків, коштував рівно стільки ж, скільки порожній список.
   * А оскільки поле пошуку слало запит на кожну літеру, одне слово коштувало
   * шість таких проходів.
   *
   * Тепер до JavaScript доїжджає вже відфільтроване, і ціна запиту нарешті
   * залежить від того, скільки рядків він насправді просить.
   */
  const conditions = [
    // Компанія без домену нікуди не веде: ні листа, ні сайту, ні обходу.
    ne(companies.domain, ''),
    filters.country ? eq(companies.country, filters.country) : undefined,
    /*
     * Без явного типу продуктові компанії зі списку прибираються: у них холодний
     * лист "можу допомогти з проєктом" не працює, для них є Черга з вакансіями.
     */
    filters.kind ? eq(companies.kind, filters.kind) : ne(companies.kind, 'product'),
    filters.minRating === undefined
      ? undefined
      : sql`coalesce(${companies.rating}, 0) >= ${filters.minRating}`,
    // Відкладена компанія не показується, поки не вийде строк.
    sql`(${companyState.snoozedUntil} is null or ${companyState.snoozedUntil} <= ${now})`,
    filters.includeContacted
      ? sql`coalesce(${companyState.status}, 'new') <> 'blacklist'`
      : notInArray(sql`coalesce(${companyState.status}, 'new')`, HIDDEN_STATUSES),
  ];

  if (filters.search) {
    /*
     * Теги лежать у колонці як JSON-масив, і пошук іде по ньому рядком. Це трохи
     * ширше за перебір елементів у памʼяті: збіг може випасти на межі двох тегів.
     * Ціна цієї неточності одна зайва компанія в списку, а виграш у тому, що
     * решта бази не піднімається в памʼять заради одного слова.
     */
    const needle = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${companies.name}) like ${needle}
        or lower(${companies.domain}) like ${needle}
        or lower(${companies.tags}) like ${needle})`,
    );
  }

  const where = and(...conditions.filter(Boolean));

  const rows = await db
    .select({
      company: companies,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      openVacancies: sql<number>`(
        select count(*) from ${vacancies}
        where ${vacancies.companyId} = ${companies.id} and ${vacancies.closedAt} is null
      )`,
      lastContactedAt: sql<number | null>`(
        select max(${outreach.sentAt}) from ${outreach} where ${outreach.companyId} = ${companies.id}
      )`,
    })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(where);

  /*
   * Контакти беруться тим самим відбором, підзапитом, а не списком номерів.
   *
   * Список номерів на дві тисячі компаній це дві тисячі параметрів в одному
   * запиті, і рано чи пізно він упирається в стелю драйвера. Підзапит цієї стелі
   * не має і на D1 поводиться так само, як локально.
   *
   * Порядок задає SQL: іменні контакти поперед загальних скриньок, бо лист на
   * hello@ читає менеджер, розділ 9 CLAUDE.md.
   */
  const chosen = db
    .select({ id: companies.id })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(where);

  const contactRows = await db
    .select()
    .from(contacts)
    .where(sql`${contacts.companyId} in ${chosen}`)
    .orderBy(sql`${contacts.name} is null`, contacts.name);

  const byCompany = new Map<number, typeof contactRows>();
  for (const row of contactRows) {
    // Через push, а не через новий масив: копія на кожен контакт це зайва робота
    // рівно там, де її найбільше, у компаній з довгим списком людей.
    const list = byCompany.get(row.companyId);
    if (list) list.push(row);
    else byCompany.set(row.companyId, [row]);
  }

  const cards = rows
    .map((row) => {
      const breakdown: CompanyBreakdown = scoreCompany({
        company: row.company,
        openVacancies: row.openVacancies,
        status: row.status,
      });

      return {
        companyId: row.company.id,
        name: row.company.name,
        domain: row.company.domain,
        country: row.company.country,
        city: row.company.city,
        sizeHint: row.company.sizeHint,
        kind: row.company.kind,
        copyrightYear: row.company.copyrightYear,
        lastPostAt: row.company.lastPostAt,
        tags: row.company.tags,
        techHints: row.company.techHints,
        rating: row.company.rating,
        reviewsCount: row.company.reviewsCount,
        minProject: row.company.minProject,
        hourlyRate: row.company.hourlyRate,
        foundedYear: row.company.foundedYear,
        extra: row.company.extra ?? {},
        description: row.company.description,
        careersUrl: row.company.careersUrl,
        sourceUrl: row.company.sourceUrl,
        sources: row.company.sources,
        status: row.status ?? 'new',
        openVacancies: row.openVacancies,
        score: breakdown.score,
        why: [...breakdown.positives, ...breakdown.negatives].sort((a, b) => b.weight - a.weight),
        contacts: (byCompany.get(row.company.id) ?? []).map((contact) => ({
          id: contact.id,
          name: contact.name,
          role: contact.role,
          email: contact.email,
          emailValid: contact.emailValid,
        })),
        lastContactedAt: row.lastContactedAt,
      } satisfies StudioCard;
    })
    .sort((a, b) => b.score - a.score);

  return cards;
}

/** Сторінка списку студій разом із лічильниками для інтерфейсу. */
export async function studioPage(filters: StudioFilters = {}): Promise<StudioPage> {
  const threshold = filters.minScore ?? rules().companies.threshold;
  const all = await scoreAll(filters);
  const passing = all
    .filter((card) => card.score >= threshold)
    .filter((card) => !filters.withNamedContact || card.contacts.some((contact) => contact.name));

  return {
    cards: passing.slice(0, filters.limit ?? 1000),
    total: all.length,
    aboveThreshold: passing.length,
    threshold,
  };
}

/** Тонка обгортка для тестів і для викликів, яким потрібен лише список. */
export async function studioQueue(filters: StudioFilters = {}): Promise<StudioCard[]> {
  return (await studioPage(filters)).cards;
}

export interface StudioActionInput {
  companyId: number;
  action: 'interesting' | 'not_interesting' | 'contacted' | 'blacklist' | 'snooze';
  note?: string | null;
  days?: number;
  channel?: string;
  /** Знімок контакту на момент листа. Потрібен, щоб через рік було видно, кому писали. */
  contactName?: string | null;
  contactEmail?: string | null;
  templateUsed?: string | null;
}

const STATUS_BY_ACTION: Record<StudioActionInput['action'], string> = {
  interesting: 'interesting',
  not_interesting: 'rejected_by_me',
  contacted: 'contacted',
  blacklist: 'blacklist',
  snooze: 'snoozed',
};

/** Дії над студією: те саме, що на картці вакансії, але без привʼязки до вакансії. */
export async function applyStudioAction(input: StudioActionInput): Promise<{ status: string; outreachId: number | null }> {
  const db = getDb();
  const status = STATUS_BY_ACTION[input.action];
  if (!status) throw new Error(`невідома дія: ${input.action}`);

  const snoozedUntil = input.action === 'snooze' ? Date.now() + (input.days ?? 30) * 86_400_000 : null;
  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, input.companyId));

  if (existing) {
    await db
      .update(companyState)
      .set({ status, snoozedUntil, reason: input.note ?? existing.reason, updatedAt: Date.now() })
      .where(eq(companyState.companyId, input.companyId));
  } else {
    await db
      .insert(companyState)
      .values({ companyId: input.companyId, status, snoozedUntil, reason: input.note ?? null });
  }

  let outreachId: number | null = null;
  if (input.action === 'contacted') {
    const [row] = await db
      .insert(outreach)
      .values({
        companyId: input.companyId,
        vacancyId: null,
        channel: input.channel ?? 'email',
        status: 'sent',
        sentAt: Date.now(),
        templateUsed: input.templateUsed ?? 'studio_pitch',
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        note: input.note ?? null,
      })
      .returning({ id: outreach.id });
    outreachId = row!.id;
  }

  return { status, outreachId };
}

/** Компанії, які варто обійти першими: високий рахунок і ще не обходились. */
export async function studiosToEnrich(limit = 25): Promise<Company[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(companies)
    .where(and(isNull(companies.lastChecked), notInArray(companies.careersKind, ['none'])))
    .orderBy(desc(companies.firstSeen))
    .limit(limit);
  return rows;
}
