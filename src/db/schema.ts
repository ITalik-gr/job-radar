import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Timestamps are stored as unix milliseconds (integer), so that moving to Postgres is a
// column type change rather than a logic rewrite.
const now = sql`(unixepoch() * 1000)`;

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /**
     * The site, and the main identity of a company. An empty string means no site: a clinic
     * from Google Places or a tender buyer is a lead without one (section 5), and then
     * `registry_code` or `place_id` identifies it. Not nullable on purpose: making it nullable
     * means rebuilding the table, and on D1 that cascades into every child table.
     */
    domain: text('domain').notNull(),
    /** ЄДРПОУ, the Ukrainian state register code. Prozorro buyers carry it. */
    registryCode: text('registry_code'),
    /** Google Places id. A business without a site is identified by it. */
    placeId: text('place_id'),
    /** ISO 3166 alpha-2, upper case, see `normalizeCountry`. */
    country: text('country'),
    city: text('city'),
    sizeHint: text('size_hint'),
    sources: text('sources', { mode: 'json' }).$type<string[]>().notNull().default([]),
    careersUrl: text('careers_url'),
    // html | greenhouse | lever | ashby | workable | recruitee | personio | rss | none | unknown
    careersKind: text('careers_kind').notNull().default('unknown'),
    careersSlug: text('careers_slug'),
    techHints: text('tech_hints', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Catalog tags: business type, domain, services. Not the stack, the stack lives in tech_hints.
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /**
     * The segment: studio | design | startup | product | outstaff | smb | ecommerce | public
     * | unknown. The main filter of the radar and the key a letter template is picked by: a
     * dental clinic, a design studio and a founder get very different letters.
     */
    kind: text('kind').notNull().default('unknown'),
    /** ua | intl. Derived from the country, stored so the most common filter is one index. */
    market: text('market'),
    /** clinic, dental, beauty, legal, restaurant, retail, saas, fintech... Free text, lower case. */
    industry: text('industry'),
    /** Businesses without a team page are reached by phone or a shared mailbox. */
    phone: text('phone'),
    address: text('address'),
    /**
     * The only thing kept from vacancies: the company is hiring developers right now. A team
     * that needs hands is a team that might take a contractor. `hiring_seen_at` lets the
     * signal fade: a role seen two months ago says nothing about today.
     */
    hiringDevs: integer('hiring_devs', { mode: 'boolean' }).notNull().default(false),
    hiringRoles: integer('hiring_roles'),
    hiringSeenAt: integer('hiring_seen_at'),
    /**
     * Signs of life on the site, collected by enrichment. An agency with a 2019 copyright and
     * a dead blog neither hires nor answers letters, and that shows before the owner spends
     * an evening on a letter.
     */
    copyrightYear: integer('copyright_year'),
    lastPostAt: integer('last_post_at'),
    /**
     * The site renders its content with script, and the server-side crawl got nothing from it.
     *
     * Such domains go into a separate queue for the extension: it opens the page in the owner's
     * real browser, where it is already rendered, and reads the finished DOM. The flag is
     * cleared as soon as data arrives from the browser.
     */
    needsBrowser: integer('needs_browser', { mode: 'boolean' }).notNull().default(false),
    /**
     * The company description vector for finding similar ones. A JSON array rather than a
     * separate vector database: there are hundreds of companies, a full in-memory scan takes
     * milliseconds, and Vectorize would be an extra dependency here.
     */
    embedding: text('embedding'),
    embeddedAt: integer('embedded_at'),
    description: text('description'),
    /**
     * Catalog reputation. Rating and review count are the fastest way to tell a living studio
     * from an empty profile: an agency with 40 reviews and 4.9 works with clients all the time,
     * a profile without a single review is often dead. Both fields are overwritten with fresh
     * values, because this is a current fact, not what it was at first sight.
     */
    rating: real('rating'),
    reviewsCount: integer('reviews_count'),
    /** "$5,000+", "$50 - $99 / hr", 2015. Strings, because catalogs write them differently. */
    minProject: text('min_project'),
    hourlyRate: text('hourly_rate'),
    foundedYear: integer('founded_year'),
    /**
     * The "Other" block: everything the catalog showed that has no column. Awards, languages,
     * industries, share of repeat clients, verified profile.
     *
     * Why a bag rather than columns: every catalog has its own set of fields, and a column for
     * each would mean a migration per new catalog. The data is simply stored and shown to a
     * person, scoring does not read it.
     */
    extra: text('extra', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // The company page in the catalog it came from: Clutch, DOU and so on.
    sourceUrl: text('source_url'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastChecked: integer('last_checked'),
    lastChangeAt: integer('last_change_at'),
  },
  (t) => [
    uniqueIndex('companies_domain_uq').on(t.domain).where(sql`domain <> ''`),
    uniqueIndex('companies_registry_code_uq').on(t.registryCode).where(sql`registry_code is not null`),
    uniqueIndex('companies_place_id_uq').on(t.placeId).where(sql`place_id is not null`),
    index('companies_last_checked_idx').on(t.lastChecked),
    index('companies_kind_idx').on(t.kind),
    index('companies_market_idx').on(t.market),
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
    phone: text('phone'),
    /**
     * An address that hard bounced stays in the database but is marked dead: it cannot be
     * deleted, because enrichment would find it again and a letter would go to the same
     * mailbox a second time.
     */
    emailValid: integer('email_valid', { mode: 'boolean' }).notNull().default(true),
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
    // hashes of individual blocks, for the block diff
    blockHashes: text('block_hashes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('snapshots_company_fetched_idx').on(t.companyId, t.fetchedAt)],
);

/**
 * Archive. The radar no longer collects vacancies (CLAUDE.md section 10), but the rows stay:
 * nothing is deleted, and old letters still point at them. No code writes here any more.
 */
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
    // null means classification failed and the record awaits manual review
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
    /** The lead the letter answers: a tender, a request. Empty for a plain cold letter. */
    leadId: integer('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    /**
     * The contact written to. Unlike `contact_name` and `contact_email`, this is a live link:
     * it is needed to mark the address invalid after a hard bounce. The name and email
     * snapshot stays alongside and survives deletion.
     */
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    /**
     * Empty means the letter has not gone out yet. A draft lives in this same table rather
     * than a separate one: otherwise sending would have to move the row and guarantee the
     * text snapshot does not change on the way.
     */
    sentAt: integer('sent_at'),
    templateUsed: text('template_used'),
    templateId: integer('template_id').references(() => templates.id, { onDelete: 'set null' }),
    /** uk | en. A snapshot at draft time, the template may be translated later. */
    language: text('language'),
    /** What actually went out, after all human edits. Never regenerated. */
    subjectFinal: text('subject_final'),
    bodyFinal: text('body_final'),
    /**
     * The model's first paragraph is stored apart from the letter body on purpose: after a
     * hundred letters it is the only way to compare conversion with and without
     * personalisation without parsing the text back into paragraphs.
     */
    aiUsed: integer('ai_used', { mode: 'boolean' }).notNull().default(false),
    aiParagraph: text('ai_paragraph'),
    /**
     * Why the model paragraph was not used. Empty with `ai_used` means everything passed.
     * Needed for fallback statistics: above 30 percent means a bad prompt, and without a
     * breakdown by reason that does not show.
     */
    aiFallbackReason: text('ai_fallback_reason'),
    /** draft | approved | sent | failed | bounced | replied */
    status: text('status').notNull().default('sent'),
    gmailMessageId: text('gmail_message_id'),
    /**
     * The Message-Id header of the letter itself. Not the same as `gmail_message_id`: that one
     * is internal to the API, while a follow-up's `In-Reply-To` expects exactly the RFC value in
     * angle brackets. Without this field the thread chain does not hold together.
     */
    rfcMessageId: text('rfc_message_id'),
    gmailThreadId: text('gmail_thread_id'),
    queuedAt: integer('queued_at'),
    /**
     * Who exactly was written to. Not a link to `contacts` but a snapshot of the name and email
     * at send time: the contact may change or disappear from the site, and the history has to
     * stay readable a year later.
     */
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    replyAt: integer('reply_at'),
    // positive | rejection | autoreply | ooo | unclear
    replyType: text('reply_type'),
    /** hard | soft. Hard means the address is dead and no longer used. */
    bounceType: text('bounce_type'),
    /** The letter this one continues. There is exactly one follow-up, so the chain is short. */
    followupOf: integer('followup_of'),
    followupDueAt: integer('followup_due_at'),
    /**
     * Why the draft is not ready: an empty required placeholder, no address, an empty template.
     * Such drafts sit in their own tab rather than silently disappearing.
     */
    error: text('error'),
    note: text('note'),
  },
  (t) => [
    index('outreach_company_idx').on(t.companyId),
    index('outreach_sent_idx').on(t.sentAt),
    index('outreach_status_idx').on(t.status),
    index('outreach_followup_idx').on(t.followupDueAt),
  ],
);

/**
 * Archive. Facts about the owner fed the model-written first paragraph, which is gone: letters
 * are the owner's templates with placeholders only. Kept so the owner's texts are not lost.
 */
export const facts = sqliteTable(
  'facts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    textUk: text('text_uk').notNull(),
    textEn: text('text_en').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('facts_key_uq').on(t.key)],
);

/**
 * The daily send counter. It lives apart from `outreach`, because the daily limit, the pause
 * between letters and the warmup all rest on it: computing it each time as an aggregate over
 * history would mean depending on nobody ever cleaning the history.
 */
export const sendLog = sqliteTable('send_log', {
  day: text('day').primaryKey(),
  count: integer('count').notNull().default(0),
  lastSentAt: integer('last_sent_at'),
});

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

/** Archive: the daily slice of the old vacancy queue. */
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
 * Classification cache. The key is a hash of the text actually sent to the model, plus the
 * model and the prompt version. A layout redesign changes the block hash but not the vacancy
 * text, so no repeat model call is needed.
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

/** Daily call counter, so the budget is not burned silently. */
export const llmUsage = sqliteTable('llm_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  failures: integer('failures').notNull().default(0),
});

/**
 * Settings the owner edits from the interface. `config/scoring.json` stays the default, and a
 * record here overrides it.
 *
 * Why a separate table rather than a file: Workers has no filesystem, the config is bundled.
 * Without this table production rules could only be changed by a new deploy.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Letter and resume templates. The owner writes the texts, the tool only stores them and
 * records them in the contact history. Generating letters here is forbidden, section 11 of
 * CLAUDE.md, so no model call is planned for this table.
 */
export const templates = sqliteTable(
  'templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** A stable key that lands in outreach.template_used. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** vacancy | studio | resume. Decides where the template is offered. */
    kind: text('kind').notNull().default('vacancy'),
    /**
     * Text language: uk | en. One template is never bilingual, because a translation is a
     * different text, not the same one in other words. The language choice is deterministic:
     * country UA means uk, everything else en.
     *
     * Defaults to en: Ukrainian companies are a minority in the database, so a new template is
     * more often written in English, and that option should need no extra click.
     */
    language: text('language').notNull().default('en'),
    /**
     * The sending case the template is written for:
     * vacancy | studio_named | studio_generic | followup.
     *
     * This is the field a draft picks its template by, and code makes the choice, not a model.
     * Empty means the template takes no part in sending and is kept for manual copying from
     * the Templates page.
     */
    targetType: text('target_type'),
    /**
     * The company kind the text is written for: design | startup | studio | outstaff.
     * Empty means universal. A design studio and a startup get very different letters, and
     * picking a template by hand every time is the same friction that keeps letters unwritten.
     */
    forKind: text('for_kind'),
    subject: text('subject'),
    /**
     * Archive. The old static first paragraph behind `{{intro}}`; migration 0018 folded it
     * into `body`. Nothing reads it any more.
     */
    intro: text('intro'),
    body: text('body').notNull().default(''),
    note: text('note'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('templates_slug_uq').on(t.slug)],
);

/**
 * A site check: the concrete reason to write. "Your site takes 9 seconds on a phone" lands,
 * "I build websites" does not. One row per check, the latest one is what the card shows.
 */
export const siteAudits = sqliteTable(
  'site_audits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    checkedAt: integer('checked_at').notNull().default(now),
    url: text('url').notNull(),
    https: integer('https', { mode: 'boolean' }),
    mobileOk: integer('mobile_ok', { mode: 'boolean' }),
    /** PageSpeed performance score, 0 to 100, mobile. */
    perfScore: integer('perf_score'),
    lcpMs: integer('lcp_ms'),
    cms: text('cms'),
    copyrightYear: integer('copyright_year'),
    /** Short, concrete, letter-ready: "loads 9 s on a phone", "no mobile layout". */
    issues: text('issues', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('site_audits_company_idx').on(t.companyId, t.checkedAt)],
);

/**
 * Explicit demand: a tender, a funding round, a public request. A lead belongs to a company
 * and has a deadline or a date, unlike the company itself, which lives for years.
 */
export const leads = sqliteTable(
  'leads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    text: text('text'),
    budget: real('budget'),
    currency: text('currency'),
    deadlineAt: integer('deadline_at'),
    firstSeen: integer('first_seen').notNull().default(now),
    closedAt: integer('closed_at'),
    /** The model's fit score, 0 to 100. Advice for sorting, not a verdict. */
    fit: integer('fit'),
    // new | interesting | contacted | skipped
    status: text('status').notNull().default('new'),
  },
  (t) => [
    uniqueIndex('leads_source_external_uq').on(t.source, t.externalId),
    index('leads_company_idx').on(t.companyId),
    index('leads_deadline_idx').on(t.deadlineAt),
  ],
);

/** A named filter: "UA, clinics, slow site, has email". The query is the shape `search_companies` takes. */
export const savedFilters = sqliteTable(
  'saved_filters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    query: text('query', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('saved_filters_name_uq').on(t.name)],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Vacancy = typeof vacancies.$inferSelect;
export type NewVacancy = typeof vacancies.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type QueueItem = typeof queueItems.$inferSelect;
export type Outreach = typeof outreach.$inferSelect;
export type CompanyState = typeof companyState.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Fact = typeof facts.$inferSelect;
export type SendLog = typeof sendLog.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
export type SiteAudit = typeof siteAudits.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type SavedFilter = typeof savedFilters.$inferSelect;
