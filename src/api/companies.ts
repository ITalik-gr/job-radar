import { Hono } from 'hono';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  companies,
  companyState,
  contacts,
  outreach,
  snapshots,
  vacancies,
} from '../db/schema.js';
import { scoreCompany } from '../pipeline/company-score.js';
import { normalizeEmail, rememberContact } from '../pipeline/outreach.js';
import { refreshCompany } from '../pipeline/refresh.js';

export const companiesRoutes = new Hono();

/** Порахувати відкриті вакансії підзапитом, щоб не тягнути їх усі в память. */
const openVacancies = sql<number>`(
  select count(*) from ${vacancies}
  where ${vacancies.companyId} = ${companies.id} and ${vacancies.closedAt} is null
)`;

companiesRoutes.get('/', async (c) => {
  const db = getDb();
  const status = c.req.query('status');
  const country = c.req.query('country');
  const ats = c.req.query('ats');
  const search = c.req.query('q');

  const filters = [
    status ? eq(companyState.status, status) : undefined,
    country ? eq(companies.country, country) : undefined,
    ats ? eq(companies.careersKind, ats) : undefined,
    search
      ? or(like(companies.name, `%${search}%`), like(companies.domain, `%${search}%`))
      : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      country: companies.country,
      city: companies.city,
      sizeHint: companies.sizeHint,
      tags: companies.tags,
      description: companies.description,
      sourceUrl: companies.sourceUrl,
      careersKind: companies.careersKind,
      careersUrl: companies.careersUrl,
      techHints: companies.techHints,
      sources: companies.sources,
      lastChecked: companies.lastChecked,
      /*
       * Поля, які читає скоринг компаній. Без них рахунок на цій сторінці рахувався
       * за неповною компанією і не збігався з тим самим рахунком у Студіях: тип,
       * ознаки покинутого сайту і репутація з каталогу просто не доїжджали сюди.
       */
      kind: companies.kind,
      copyrightYear: companies.copyrightYear,
      lastPostAt: companies.lastPostAt,
      rating: companies.rating,
      reviewsCount: companies.reviewsCount,
      hourlyRate: companies.hourlyRate,
      minProject: companies.minProject,
      foundedYear: companies.foundedYear,
      status: companyState.status,
      snoozedUntil: companyState.snoozedUntil,
      openVacancies: openVacancies.as('open_vacancies'),
    })
    .from(companies)
    .leftJoin(companyState, eq(companyState.companyId, companies.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(companies.name);

  // Сортуємо за рахунком студії, а не за кількістю вакансій: інакше вгорі назавжди
  // осідають гіганти з сотнями позицій, куди подаватись сенсу немає.
  const scored = rows.map((row) => ({
    ...row,
    score: scoreCompany({
      // Рядок уже містить усі колонки, які читає скоринг, тому перелічувати
      // їх удруге не треба: саме той перелік і розʼїхався зі схемою.
      company: row as never,
      openVacancies: row.openVacancies,
      status: row.status,
    }).score,
  }));

  const sort = c.req.query('sort') ?? 'score';
  scored.sort((a, b) =>
    sort === 'vacancies'
      ? b.openVacancies - a.openVacancies
      : sort === 'name'
        ? a.name.localeCompare(b.name)
        : b.score - a.score,
  );

  return c.json(scored);
});

companiesRoutes.get('/:id', async (c) => {
  const db = getDb();
  const id = Number(c.req.param('id'));

  const [company] = await db.select().from(companies).where(eq(companies.id, id));
  if (!company) return c.json({ error: 'компанії немає' }, 404);

  const [state] = await db.select().from(companyState).where(eq(companyState.companyId, id));

  return c.json({
    company,
    state: state ?? null,
    vacancies: await db
      .select()
      .from(vacancies)
      .where(eq(vacancies.companyId, id))
      .orderBy(desc(vacancies.firstSeen)),
    contacts: await db.select().from(contacts).where(eq(contacts.companyId, id)),
    outreach: await db
      .select()
      .from(outreach)
      .where(eq(outreach.companyId, id))
      .orderBy(desc(outreach.sentAt)),
    snapshots: await db
      .select({
        id: snapshots.id,
        url: snapshots.url,
        fetchedAt: snapshots.fetchedAt,
        contentHash: snapshots.contentHash,
        blocks: sql<number>`json_array_length(${snapshots.blockHashes})`,
      })
      .from(snapshots)
      .where(eq(snapshots.companyId, id))
      .orderBy(desc(snapshots.fetchedAt)),
  });
});

/**
 * Контакт, доданий руками зі сторінки студії.
 *
 * Пошта на сайті часто лежить там, куди парсер не дістає: у картинці, у формі,
 * у футері під скриптом. Побачити її очима і вписати це хвилина, а без цієї
 * кнопки компанія лишалась би назавжди без адреси і без листа.
 */
/**
 * Повний перегляд однієї компанії: заново на сайт, стек, контакти, career-сторінка.
 * Нічні проходи роблять те саме за розкладом, а тут це робиться зараз і без умов.
 */
companiesRoutes.post('/:id/refresh', async (c) =>
  c.json(await refreshCompany(Number(c.req.param('id')))),
);

companiesRoutes.post('/:id/contacts', async (c) => {
  const companyId = Number(c.req.param('id'));
  const body = await c.req
    .json<{ email?: string; name?: string; role?: string }>()
    .catch(() => ({}) as { email?: string; name?: string; role?: string });

  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: 'потрібна коректна адреса' }, 400);

  const result = await rememberContact(companyId, email, body.name?.trim() || null, body.role?.trim() || null);
  return c.json({ email, ...result });
});

companiesRoutes.post('/:id/state', async (c) => {
  const db = getDb();
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status: string; reason?: string; days?: number }>();

  const snoozedUntil = body.status === 'snoozed' ? Date.now() + (body.days ?? 30) * 86_400_000 : null;
  const [existing] = await db.select().from(companyState).where(eq(companyState.companyId, id));

  if (existing) {
    await db
      .update(companyState)
      .set({ status: body.status, reason: body.reason ?? existing.reason, snoozedUntil, updatedAt: Date.now() })
      .where(eq(companyState.companyId, id));
  } else {
    await db
      .insert(companyState)
      .values({ companyId: id, status: body.status, reason: body.reason ?? null, snoozedUntil });
  }

  return c.json({ ok: true });
});
