import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Часові мітки зберігаються як unix-мілісекунди (integer), щоб переїзд у Postgres
// був заміною типу колонки, а не переписуванням логіки.
const now = sql`(unixepoch() * 1000)`;

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    country: text('country'),
    city: text('city'),
    sizeHint: text('size_hint'),
    sources: text('sources', { mode: 'json' }).$type<string[]>().notNull().default([]),
    careersUrl: text('careers_url'),
    // html | greenhouse | lever | ashby | workable | recruitee | personio | rss | none | unknown
    careersKind: text('careers_kind').notNull().default('unknown'),
    careersSlug: text('careers_slug'),
    techHints: text('tech_hints', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Теги з каталогів: тип бізнесу, домен, послуги. Не стек, стек живе в tech_hints.
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    description: text('description'),
    // Сторінка компанії в каталозі, звідки вона прийшла: Clutch, DOU тощо.
    sourceUrl: text('source_url'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastChecked: integer('last_checked'),
    lastChangeAt: integer('last_change_at'),
  },
  (t) => [
    uniqueIndex('companies_domain_uq').on(t.domain),
    index('companies_last_checked_idx').on(t.lastChecked),
  ],
);

// status: new | interesting | contacted | replied | rejected_by_me
//         | rejected_by_them | blacklist | snoozed
export const companyState = sqliteTable(
  'company_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('new'),
    snoozedUntil: integer('snoozed_until'),
    reason: text('reason'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('company_state_company_uq').on(t.companyId),
    index('company_state_status_idx').on(t.status),
  ],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name'),
    role: text('role'),
    email: text('email'),
    telegram: text('telegram'),
    xHandle: text('x_handle'),
    linkedin: text('linkedin'),
    sourceUrl: text('source_url'),
    firstSeen: integer('first_seen').notNull().default(now),
  },
  (t) => [index('contacts_company_idx').on(t.companyId)],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    fetchedAt: integer('fetched_at').notNull().default(now),
    contentHash: text('content_hash').notNull(),
    textNormalized: text('text_normalized').notNull(),
    // хеші окремих блоків, для блочного дифу (Етап 3)
    blockHashes: text('block_hashes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('snapshots_company_fetched_idx').on(t.companyId, t.fetchedAt)],
);

export const vacancies = sqliteTable(
  'vacancies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id'),
    url: text('url').notNull(),
    title: text('title'),
    rawText: text('raw_text'),
    stack: text('stack', { mode: 'json' }).$type<string[]>().notNull().default([]),
    seniority: text('seniority'),
    remote: integer('remote', { mode: 'boolean' }),
    location: text('location'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    currency: text('currency'),
    englishLevelRequired: text('english_level_required'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastSeen: integer('last_seen').notNull().default(now),
    closedAt: integer('closed_at'),
    llmRelevance: integer('llm_relevance'),
    llmWhy: text('llm_why'),
    // null означає, що класифікація не вдалась і запис чекає ручного перегляду
    isVacancy: integer('is_vacancy', { mode: 'boolean' }),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    score: real('score'),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('vacancies_dedupe_uq').on(t.dedupeKey),
    index('vacancies_company_idx').on(t.companyId),
    index('vacancies_score_idx').on(t.score),
    index('vacancies_closed_idx').on(t.closedAt),
  ],
);

export const outreach = sqliteTable(
  'outreach',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vacancyId: integer('vacancy_id').references(() => vacancies.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    sentAt: integer('sent_at').notNull().default(now),
    templateUsed: text('template_used'),
    replyAt: integer('reply_at'),
    // positive | rejection | auto
    replyType: text('reply_type'),
    note: text('note'),
  },
  (t) => [
    index('outreach_company_idx').on(t.companyId),
    index('outreach_sent_idx').on(t.sentAt),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at').notNull().default(now),
    finishedAt: integer('finished_at'),
    source: text('source').notNull(),
    itemsFound: integer('items_found').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // running | ok | warn | error
    status: text('status').notNull().default('running'),
  },
  (t) => [index('runs_source_started_idx').on(t.source, t.startedAt)],
);

/**
 * Денний зріз черги. Без нього список щодня перемішується під тим, хто його читає:
 * нова вакансія з вищим рахунком витісняє ту, яку власник ще не встиг подивитись.
 * Порядок фіксується один раз на добу, рішення записується сюди ж.
 */
export const queueItems = sqliteTable(
  'queue_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    vacancyId: integer('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    scoreAtPick: real('score_at_pick'),
    // pending | interesting | not_interesting | contacted | blacklist | snoozed
    decision: text('decision'),
    decidedAt: integer('decided_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('queue_items_day_vacancy_uq').on(t.day, t.vacancyId),
    index('queue_items_day_idx').on(t.day, t.position),
  ],
);

/**
 * Кеш класифікацій. Ключ це хеш тексту, який реально пішов у модель, плюс модель і
 * версія промпта. Редизайн верстки міняє хеш блока, але не текст вакансії, тому
 * повторний виклик моделі не потрібен.
 */
export const llmCache = sqliteTable(
  'llm_cache',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    response: text('response', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('llm_cache_key_uq').on(t.key)],
);

/** Денний лічильник викликів, щоб не спалити бюджет мовчки. */
export const llmUsage = sqliteTable('llm_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  failures: integer('failures').notNull().default(0),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Vacancy = typeof vacancies.$inferSelect;
export type NewVacancy = typeof vacancies.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type QueueItem = typeof queueItems.$inferSelect;
export type Outreach = typeof outreach.$inferSelect;
export type CompanyState = typeof companyState.$inferSelect;
export type Run = typeof runs.$inferSelect;
